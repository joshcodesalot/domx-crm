const pool = require('../../db/pool');
const { getAiFlags } = require('../appSettings');
const { getCreatorProfile } = require('./profile');
const { buildAiContext } = require('./context/builder');
const { resolveEffectiveAiMode } = require('./flags');
const { MODES, ROUTES, defaultCreatorAiSettings } = require('./contracts');
const { withConversationLock } = require('./locks');
const { generateReply, unwrapGenerated } = require('./generation/generateReply');
const { validateAiOutput } = require('./validation/deterministic');
const { criticReply, shouldCritic, mergeCriticFlags } = require('./validation/critic');
const { applyModeration } = require('../contentModeration');
const {
  persistPendingSuggestion,
  emitSuggestionEvent,
} = require('./review/suggestionService');
const { normalizeUsage, sumUsage, upsertAiUsage } = require('./usage');
const {
  emptyMemory,
  getFanMemory,
  maybeCopySourceNotes,
  loadOptionalPlatformNotes,
} = require('./memory');
const {
  maybeWriteSessionSummary,
  getLatestSessionSummary,
} = require('./summary');
const { applyRecommendedState } = require('./stateMachine');
const { bindPpvFromCandidates, loadMediaCandidates } = require('./mediaCandidates');
const { loadApprovedRules } = require('./brain/rules');
const { loadActiveSops } = require('./brain/sopImport');
const { canAutoSend } = require('./send/canAutoSend');
const { executeApprovedSend } = require('./send/executeApprovedSend');
const { notifyAlertChats } = require('./alerts/telegramAlertBot');

const TRIGGERS = {
  INBOUND: 'inbound',
  MANUAL: 'manual',
};

const RUN_STATUSES = {
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  REJECTED: 'rejected',
};

function shouldSkipGenerate({ effectiveMode, paused, ignored } = {}) {
  if (ignored) return { skip: true, reason: 'ignored' };
  if (paused) return { skip: true, reason: 'paused' };
  if (effectiveMode === MODES.OFF) return { skip: true, reason: 'off' };
  if (effectiveMode === MODES.HUMAN_TAKEOVER) {
    return { skip: true, reason: 'human_takeover' };
  }
  return { skip: false, reason: null };
}

function toRunDto(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    status: row.status,
    skipReason: row.skipReason || null,
    route: row.route || null,
    output: row.output || null,
    error: row.error || null,
    revision: row.revision ?? null,
    anchorInboundMessageId: row.anchorInboundMessageId || null,
    conversationId: row.conversationId || null,
    mode: row.mode || null,
    trigger: row.trigger || null,
  };
}

function skippedResult(reason, extras = {}) {
  return toRunDto({
    status: RUN_STATUSES.SKIPPED,
    skipReason: reason,
    ...extras,
  });
}

function applyForcedRoute(output) {
  if (!output || typeof output !== 'object') return output;
  return {
    ...output,
    requiresHumanReview: true,
    suggestedRoute: output.suggestedRoute || ROUTES.HUMAN_REVIEW,
  };
}

async function defaultLoadCreator(creatorId, client = pool) {
  const result = await client.query(
    `SELECT id, platform, "connectionStatus"
     FROM creators
     WHERE id = $1`,
    [creatorId]
  );
  return result.rows[0] || null;
}

async function defaultLoadCreatorSettings(creatorId, client = pool) {
  const result = await client.query(
    `SELECT mode, paused, "takeoverByUserId", "takeoverAt"
     FROM ai_creator_settings
     WHERE "creatorId" = $1`,
    [creatorId]
  );
  return result.rows[0] || null;
}

async function defaultLoadConversation(
  { creatorId, platform, platformChatId },
  client = pool
) {
  const result = await client.query(
    `SELECT *
     FROM ai_conversations
     WHERE "creatorId" = $1 AND platform = $2 AND "platformChatId" = $3`,
    [creatorId, platform, platformChatId]
  );
  return result.rows[0] || null;
}

async function defaultLoadMessages(conversationId, client = pool) {
  const result = await client.query(
    `SELECT "platformMessageId", direction, "senderRole", text,
            "hasMedia", "isPpv", "priceNet", "sentAt"
     FROM ai_messages
     WHERE "conversationId" = $1
     ORDER BY "sentAt" DESC NULLS LAST, "createdAt" DESC
     LIMIT 40`,
    [conversationId]
  );
  return result.rows.slice().reverse();
}

async function defaultFindInboundRun(
  conversationId,
  inboundPlatformMessageId,
  client = pool
) {
  if (!conversationId || !inboundPlatformMessageId) return null;
  const result = await client.query(
    `SELECT *
     FROM ai_runs
     WHERE "conversationId" = $1
       AND trigger = 'inbound'
       AND "inboundPlatformMessageId" = $2
     LIMIT 1`,
    [conversationId, inboundPlatformMessageId]
  );
  return result.rows[0] || null;
}

async function defaultInsertRun(row, client = pool) {
  const result = await client.query(
    `INSERT INTO ai_runs (
       "conversationId", "creatorId", platform, "platformChatId",
       trigger, "inboundPlatformMessageId", revision, "anchorInboundMessageId",
       mode, status, "skipReason", route, "suggestedRoute", output, error,
       "completedAt"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      row.conversationId || null,
      row.creatorId,
      row.platform,
      row.platformChatId,
      row.trigger,
      row.inboundPlatformMessageId || null,
      row.revision ?? null,
      row.anchorInboundMessageId || null,
      row.mode || null,
      row.status,
      row.skipReason || null,
      row.route || null,
      row.suggestedRoute || null,
      row.output ? JSON.stringify(row.output) : null,
      row.error || null,
      row.status === RUN_STATUSES.PENDING ? null : new Date().toISOString(),
    ]
  );
  return result.rows[0];
}

async function defaultCompleteRun(id, patch, client = pool) {
  const result = await client.query(
    `UPDATE ai_runs
     SET status = $2,
         route = $3,
         "suggestedRoute" = $4,
         output = $5,
         error = $6,
         "skipReason" = $7,
         "promptTokens" = COALESCE($8, "promptTokens"),
         "completionTokens" = COALESCE($9, "completionTokens"),
         "costUsd" = COALESCE($10, "costUsd"),
         "completedAt" = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [
      id,
      patch.status,
      patch.route || null,
      patch.suggestedRoute || null,
      patch.output ? JSON.stringify(patch.output) : null,
      patch.error || null,
      patch.skipReason || null,
      patch.promptTokens ?? null,
      patch.completionTokens ?? null,
      patch.costUsd ?? null,
    ]
  );
  if (result.rows[0]) return result.rows[0];

  const existing = await client.query(`SELECT * FROM ai_runs WHERE id = $1`, [id]);
  return existing.rows[0] || null;
}

function resolveDeps(deps = {}) {
  return {
    pool: deps.pool || pool,
    getAiFlags: deps.getAiFlags || getAiFlags,
    loadCreator: deps.loadCreator || defaultLoadCreator,
    loadCreatorSettings: deps.loadCreatorSettings || defaultLoadCreatorSettings,
    loadConversation: deps.loadConversation || defaultLoadConversation,
    loadMessages: deps.loadMessages || defaultLoadMessages,
    getCreatorProfile: deps.getCreatorProfile || getCreatorProfile,
    findInboundRun: deps.findInboundRun || defaultFindInboundRun,
    insertRun: deps.insertRun || defaultInsertRun,
    completeRun: deps.completeRun || defaultCompleteRun,
    withConversationLock: deps.withConversationLock || withConversationLock,
    generateReply: deps.generateReply || generateReply,
    validateAiOutput: deps.validateAiOutput || validateAiOutput,
    shouldCritic: deps.shouldCritic || shouldCritic,
    criticReply: deps.criticReply || criticReply,
    applyModeration: deps.applyModeration || applyModeration,
    persistPendingSuggestion:
      deps.persistPendingSuggestion || persistPendingSuggestion,
    emitSuggestionEvent: deps.emitSuggestionEvent || emitSuggestionEvent,
    upsertAiUsage: deps.upsertAiUsage || upsertAiUsage,
    getFanMemory: deps.getFanMemory || getFanMemory,
    maybeCopySourceNotes: deps.maybeCopySourceNotes || maybeCopySourceNotes,
    loadOptionalPlatformNotes:
      deps.loadOptionalPlatformNotes || loadOptionalPlatformNotes,
    maybeWriteSessionSummary:
      deps.maybeWriteSessionSummary || maybeWriteSessionSummary,
    getLatestSessionSummary:
      deps.getLatestSessionSummary || getLatestSessionSummary,
    applyRecommendedState:
      deps.applyRecommendedState || applyRecommendedState,
    loadMediaCandidates: deps.loadMediaCandidates || loadMediaCandidates,
    loadApprovedRules: deps.loadApprovedRules || loadApprovedRules,
    loadActiveSops: deps.loadActiveSops || loadActiveSops,
    canAutoSend: deps.canAutoSend || canAutoSend,
    executeApprovedSend: deps.executeApprovedSend || executeApprovedSend,
    notifyAlertChats: deps.notifyAlertChats || notifyAlertChats,
    provider: deps.provider || null,
  };
}

async function resolveFanMemory(d, { creatorId, platform, conversation, input }) {
  const platformFanId = String(conversation?.platformFanId || '').trim();
  const fallback = { creatorId, platform, platformFanId: platformFanId || null };
  if (!platformFanId) return emptyMemory(fallback);

  try {
    let memory = await d.getFanMemory({ creatorId, platform, platformFanId });

    const incomingNotes = typeof input.fanNotes === 'string' ? input.fanNotes.trim() : '';
    if (incomingNotes && !memory?.sourceNotes) {
      memory =
        (await d.maybeCopySourceNotes({
          creatorId,
          platform,
          platformFanId,
          notes: incomingNotes,
        })) || memory;
    }

    if (platform === 'telegram' && !memory?.sourceNotes) {
      const notes = await d.loadOptionalPlatformNotes({ platform, platformFanId });
      if (notes) {
        memory =
          (await d.maybeCopySourceNotes({
            creatorId,
            platform,
            platformFanId,
            notes,
          })) || memory;
      }
    }

    return memory || emptyMemory(fallback);
  } catch (err) {
    console.error('AI fan memory load error:', err);
    return emptyMemory(fallback);
  }
}

function usagePatch(usage) {
  const normalized = normalizeUsage(usage);
  if (!normalized) return {};
  return {
    promptTokens: normalized.promptTokens,
    completionTokens: normalized.completionTokens,
    costUsd: normalized.costUsd,
  };
}

async function recordUsage(d, completed, usage, meta) {
  const normalized = normalizeUsage(usage);
  if (!normalized || !completed?.id) return;
  try {
    await d.upsertAiUsage({
      runId: completed.id,
      creatorId: meta.creatorId,
      platform: meta.platform,
      mode: meta.mode || completed.mode || null,
      ...normalized,
    });
  } catch (err) {
    console.error('AI usage upsert error:', err);
  }
}

async function writeRunUnderLock(d, key, row) {
  try {
    return await d.withConversationLock(d.pool, key, async (client) => {
      if (row.trigger === TRIGGERS.INBOUND && row.inboundPlatformMessageId) {
        const existing = await d.findInboundRun(
          row.conversationId,
          row.inboundPlatformMessageId,
          client
        );
        if (existing) return existing;
      }
      return d.insertRun(row, client);
    });
  } catch (err) {
    if (err?.code === '23505' && row.inboundPlatformMessageId) {
      return d.findInboundRun(row.conversationId, row.inboundPlatformMessageId);
    }
    throw err;
  }
}

async function completeRunUnderLock(d, key, id, patch) {
  return d.withConversationLock(d.pool, key, async (client) =>
    d.completeRun(id, patch, client)
  );
}

async function runOrchestration(input, trigger, deps) {
  const d = resolveDeps(deps);
  const creatorId = String(input.creatorId || '').trim();
  const platform = String(input.platform || '').trim();
  const platformChatId = String(input.platformChatId || '').trim();
  const inboundPlatformMessageId = String(
    input.inboundPlatformMessageId || ''
  ).trim();
  const lockKey = { creatorId, platform, platformChatId };

  const [globalFlags, settingsRow] = await Promise.all([
    d.getAiFlags(),
    d.loadCreatorSettings(creatorId),
  ]);
  const settings = settingsRow || defaultCreatorAiSettings();
  const effectiveMode = resolveEffectiveAiMode({
    global: globalFlags,
    creator: settings,
  });

  const conversation = await d.loadConversation({
    creatorId,
    platform,
    platformChatId,
  });

  const skip = shouldSkipGenerate({
    effectiveMode,
    paused: Boolean(settings.paused || conversation?.aiPaused),
    ignored: Boolean(conversation?.aiIgnored),
  });

  if (skip.skip) {
    if (!conversation) {
      return skippedResult(skip.reason, { mode: effectiveMode, trigger });
    }
    const inboundId =
      trigger === TRIGGERS.INBOUND
        ? inboundPlatformMessageId || conversation.lastInboundPlatformMessageId
        : null;
    const row = await writeRunUnderLock(d, lockKey, {
      conversationId: conversation.id,
      creatorId,
      platform,
      platformChatId,
      trigger,
      inboundPlatformMessageId: inboundId,
      revision: conversation.revision,
      anchorInboundMessageId:
        inboundId || conversation.lastInboundPlatformMessageId || null,
      mode: effectiveMode,
      status: RUN_STATUSES.SKIPPED,
      skipReason: skip.reason,
    });
    return toRunDto(row);
  }

  if (!conversation) {
    return skippedResult('conversation_missing', {
      mode: effectiveMode,
      trigger,
    });
  }

  const inboundId =
    trigger === TRIGGERS.INBOUND
      ? inboundPlatformMessageId || conversation.lastInboundPlatformMessageId
      : null;

  if (trigger === TRIGGERS.INBOUND && inboundId) {
    const existing = await d.findInboundRun(conversation.id, inboundId);
    if (existing) return toRunDto(existing);
  }

  const [messages, profile, memory, mediaCandidates, approvedRules, activeSops] =
    await Promise.all([
    d.loadMessages(conversation.id),
    d.getCreatorProfile(creatorId),
    resolveFanMemory(d, { creatorId, platform, conversation, input }),
    d
      .loadMediaCandidates({
        creatorId,
        platform,
        platformFanId: conversation.platformFanId,
      })
      .catch((err) => {
        console.error('AI media candidates load error:', err);
        return [];
      }),
    d
      .loadApprovedRules({
        creatorId,
        platform,
        platformFanId: conversation.platformFanId,
      })
      .catch((err) => {
        console.error('AI approved rules load error:', err);
        return [];
      }),
    d
      .loadActiveSops({ creatorId })
      .catch((err) => {
        console.error('AI active SOPs load error:', err);
        return [];
      }),
  ]);

  const fanNotes =
    (typeof input.fanNotes === 'string' && input.fanNotes.trim()) ||
    memory.sourceNotes ||
    null;
  const fanNickname =
    (typeof input.fanNickname === 'string' && input.fanNickname.trim()) ||
    memory.nickname ||
    null;

  let lastSessionSummary = null;
  try {
    lastSessionSummary = await d.maybeWriteSessionSummary({
      conversationId: conversation.id,
      messages,
    });
  } catch (err) {
    console.error('AI session summary load error:', err);
    try {
      lastSessionSummary = await d.getLatestSessionSummary(conversation.id);
    } catch {
      lastSessionSummary = null;
    }
  }

  const context = buildAiContext({
    conversation,
    messages,
    profile,
    fanNotes,
    fanNickname,
    fanMemories: memory.facts,
    mediaCandidates,
    rules: approvedRules,
    sops: activeSops,
    lastSessionSummary,
    mode: effectiveMode,
  });

  const pending = await writeRunUnderLock(d, lockKey, {
    conversationId: conversation.id,
    creatorId,
    platform,
    platformChatId,
    trigger,
    inboundPlatformMessageId: inboundId,
    revision: context.revision,
    anchorInboundMessageId: context.anchorInboundMessageId,
    mode: effectiveMode,
    status: RUN_STATUSES.PENDING,
  });

  if (pending.status !== RUN_STATUSES.PENDING) {
    return toRunDto(pending);
  }

  try {
    const generated = await d.generateReply({
      context,
      provider: d.provider || undefined,
    });
    const unwrapped = unwrapGenerated(generated);
    const bound = bindPpvFromCandidates(unwrapped.output, mediaCandidates);
    const output = applyForcedRoute(bound);
    const usage = unwrapped.usage;
    const creator = await d.loadCreator(creatorId);
    const validation = await d.validateAiOutput({
      output,
      conversation,
      creator,
      mediaCandidates,
      applyModeration: d.applyModeration,
      moderationContext: {
        creatorId,
        platform,
        chatId: platformChatId,
        userId: input.requestedByUserId || null,
      },
    });

    const usageMeta = { creatorId, platform, mode: effectiveMode };

    if (!validation.ok) {
      const completed = await completeRunUnderLock(d, lockKey, pending.id, {
        status: RUN_STATUSES.REJECTED,
        route: ROUTES.HUMAN_REVIEW,
        suggestedRoute: output.suggestedRoute,
        output,
        error: validation.reason,
        ...usagePatch(usage),
      });
      await recordUsage(d, completed, usage, usageMeta);
      return toRunDto(completed);
    }

    let finalOutput = { ...output, critic: { ran: false } };
    let combinedUsage = usage;

    if (d.shouldCritic(output)) {
      let criticized;
      try {
        criticized = await d.criticReply({
          context,
          output,
          provider: d.provider || undefined,
        });
      } catch {
        const completed = await completeRunUnderLock(d, lockKey, pending.id, {
          status: RUN_STATUSES.REJECTED,
          route: ROUTES.HUMAN_REVIEW,
          suggestedRoute: output.suggestedRoute,
          output: { ...output, critic: { ran: true, ok: false } },
          error: 'critic_failed',
          ...usagePatch(usage),
        });
        await recordUsage(d, completed, usage, usageMeta);
        return toRunDto(completed);
      }

      combinedUsage = sumUsage(usage, criticized.usage) || usage;
      if (!criticized.ok) {
        const completed = await completeRunUnderLock(d, lockKey, pending.id, {
          status: RUN_STATUSES.REJECTED,
          route: ROUTES.HUMAN_REVIEW,
          suggestedRoute: output.suggestedRoute,
          output: {
            ...output,
            flags: mergeCriticFlags(output.flags, criticized.flags),
            critic: { ran: true, ok: false },
          },
          error: criticized.reason || 'critic_rejected',
          ...usagePatch(combinedUsage),
        });
        await recordUsage(d, completed, combinedUsage, usageMeta);
        return toRunDto(completed);
      }

      finalOutput = {
        ...output,
        flags: mergeCriticFlags(output.flags, criticized.flags),
        critic: { ran: true, ok: true },
      };
    }

    let liveConversation = conversation;
    try {
      const reloaded = await d.loadConversation({
        creatorId,
        platform,
        platformChatId,
      });
      if (reloaded) liveConversation = reloaded;
    } catch (err) {
      console.error('AI conversation reload error:', err);
    }

    const autoSend = d.canAutoSend({
      globalFlags,
      settings,
      effectiveMode,
      output: finalOutput,
      platform,
      conversation: liveConversation,
      suggestionOrRun: pending,
    });
    if (autoSend) {
      finalOutput = { ...finalOutput, requiresHumanReview: false };
    }

    const completed = await completeRunUnderLock(d, lockKey, pending.id, {
      status: RUN_STATUSES.SUCCEEDED,
      route: autoSend ? ROUTES.AUTO_SEND : ROUTES.HUMAN_REVIEW,
      suggestedRoute: finalOutput.suggestedRoute,
      output: finalOutput,
      ...usagePatch(combinedUsage),
    });
    await recordUsage(d, completed, combinedUsage, usageMeta);

    try {
      await d.applyRecommendedState({
        conversationId: conversation.id,
        currentState: conversation.state,
        recommendedState: finalOutput.recommendedState,
        runId: completed.id,
        source: 'model',
      });
    } catch (err) {
      console.error('AI conversation state apply error:', err);
    }

    let suggestion = null;
    try {
      suggestion = await d.persistPendingSuggestion({
        conversation,
        run: completed,
        output: finalOutput,
      });
      await d.emitSuggestionEvent(suggestion, { mode: effectiveMode });
    } catch (err) {
      console.error('AI suggestion persist/emit error:', err);
    }

    if (autoSend && suggestion?.id) {
      try {
        await d.executeApprovedSend({
          suggestionId: suggestion.id,
          user: null,
          edited: false,
        });
      } catch (err) {
        console.error('AI auto-send error:', err);
        try {
          await d.notifyAlertChats(
            `AI auto-send failed creator=${creatorId} chat=${platformChatId} suggestion=${suggestion.id}: ${err?.message || err}`
          );
        } catch (notifyErr) {
          console.error('AI alert bot notify error:', notifyErr);
        }
      }
    }

    return toRunDto(completed);
  } catch (err) {
    const usage = err?.usage || null;
    const completed = await completeRunUnderLock(d, lockKey, pending.id, {
      status: RUN_STATUSES.FAILED,
      route: ROUTES.HUMAN_REVIEW,
      error: err?.code || err?.message || 'generate_failed',
      ...usagePatch(usage),
    });
    await recordUsage(d, completed, usage, {
      creatorId,
      platform,
      mode: effectiveMode,
    });
    return toRunDto(completed);
  }
}

async function processIncomingMessage(input = {}, deps) {
  return runOrchestration(input, TRIGGERS.INBOUND, deps);
}

async function processManualSuggest(input = {}, deps) {
  return runOrchestration(input, TRIGGERS.MANUAL, deps);
}

module.exports = {
  TRIGGERS,
  RUN_STATUSES,
  shouldSkipGenerate,
  toRunDto,
  processIncomingMessage,
  processManualSuggest,
};
