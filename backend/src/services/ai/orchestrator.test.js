const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldSkipGenerate,
  processIncomingMessage,
  processManualSuggest,
} = require('./orchestrator');
const { MODES, ROUTES } = require('./contracts');
const { emptyMemory } = require('./memory');
const { conversationLockKey } = require('./locks');
const { formatRelativeAge } = require('./context/builder');
const {
  generateReply,
  normalizeGeneratedOutput,
  withTimeout,
  SYSTEM_PROMPT,
} = require('./generation/generateReply');
const { requirePermission } = require('../../middleware/authorize');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function autoSendDraft(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    reply: 'hallo',
    replyEnglish: 'hello',
    intent: 'rapport',
    action: 'TEXT_REPLY',
    confidence: 0.85,
    suggestedRoute: 'AUTO_SEND',
    requiresHumanReview: false,
    ...overrides,
  });
}

function createHarness(options = {}) {
  const runs = [];
  let seq = 0;
  const conversation =
    options.conversation === undefined
      ? {
          id: 'conv-1',
          creatorId: 'cr-1',
          platform: 'maloum',
          platformChatId: 'chat-1',
          revision: 2,
          lastInboundPlatformMessageId: 'in-1',
          lastInboundAt: '2026-09-09T12:00:00.000Z',
          historyBackfilledAt: '2026-09-09T00:00:00.000Z',
        }
      : options.conversation;

  const provider = {
    calls: 0,
    outputText: options.outputText ?? autoSendDraft(),
    async createResponse() {
      this.calls += 1;
      if (options.providerDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.providerDelayMs));
      }
      return { outputText: this.outputText };
    },
  };

  const persistCalls = [];
  const criticCalls = [];
  const autoSendCalls = [];
  const deps = {
    pool: {},
    getAiFlags: async () => ({
      enabled: options.enabled !== false,
      shadowAllowed: true,
      suggestAllowed: true,
      autoSendAllowed: Boolean(options.autoSendAllowed),
      ...options.global,
    }),
    loadCreatorSettings: async () =>
      options.settings === null
        ? null
        : {
            mode: options.mode || MODES.SUGGEST_ONLY,
            paused: Boolean(options.paused),
          },
    loadConversation: async () => conversation,
    loadMessages: async () =>
      options.messages || [
        {
          platformMessageId: 'in-1',
          direction: 'inbound',
          senderRole: 'fan',
          text: 'hey',
          sentAt: '2026-09-09T12:00:00.000Z',
        },
      ],
    getCreatorProfile: async () => ({ persona: 'Naomi', version: 1 }),
    loadCreator: async () =>
      options.creator === undefined
        ? { id: 'cr-1', platform: 'maloum', connectionStatus: 'connected' }
        : options.creator,
    applyModeration:
      options.applyModeration || (async () => ({ blocked: false })),
    persistPendingSuggestion:
      options.persistPendingSuggestion ||
      (async (row) => {
        persistCalls.push(row);
        return null;
      }),
    criticReply:
      options.criticReply ||
      (async (args) => {
        criticCalls.push(args);
        return { ok: true, flags: [] };
      }),
    emitSuggestionEvent: options.emitSuggestionEvent || (async () => ({
      emitted: false,
    })),
    upsertAiUsage: options.upsertAiUsage || (async () => null),
    getFanMemory:
      options.getFanMemory ||
      (async () =>
        emptyMemory({
          creatorId: conversation?.creatorId,
          platform: conversation?.platform,
          platformFanId: conversation?.platformFanId || null,
        })),
    maybeCopySourceNotes:
      options.maybeCopySourceNotes ||
      (async (input) => emptyMemory(input)),
    loadOptionalPlatformNotes:
      options.loadOptionalPlatformNotes || (async () => null),
    maybeWriteSessionSummary:
      options.maybeWriteSessionSummary ||
      (async () => options.lastSessionSummary || null),
    getLatestSessionSummary:
      options.getLatestSessionSummary ||
      (async () => options.lastSessionSummary || null),
    applyRecommendedState:
      options.applyRecommendedState || (async () => ({ applied: false })),
    loadMediaCandidates:
      options.loadMediaCandidates || (async () => options.mediaCandidates || []),
    loadApprovedRules:
      options.loadApprovedRules || (async () => options.rules || []),
    loadActiveSops:
      options.loadActiveSops || (async () => options.sops || []),
    executeApprovedSend:
      options.executeApprovedSend ||
      (async (args) => {
        autoSendCalls.push(args);
        return {
          suggestion: { id: args.suggestionId, status: 'sent' },
          messageId: 'msg-auto',
        };
      }),
    notifyAlertChats: options.notifyAlertChats || (async () => ({ sent: 0 })),
    maybeBackfillHistory:
      options.maybeBackfillHistory || (async () => ({ skipped: true })),
    extractAndSyncFanMemory: options.extractAndSyncFanMemory || (async () => null),
    loadLastUnsentText: options.loadLastUnsentText || (async () => null),
    findInboundRun: async (conversationId, inboundId) =>
      runs.find(
        (row) =>
          row.conversationId === conversationId &&
          row.trigger === 'inbound' &&
          row.inboundPlatformMessageId === inboundId
      ) || null,
    insertRun: async (row) => {
      const created = { ...row, id: row.id || `run-${++seq}` };
      runs.push(created);
      return created;
    },
    completeRun: async (id, patch) => {
      const run = runs.find((row) => row.id === id);
      if (!run || run.status !== 'pending') return run || null;
      Object.assign(run, patch);
      return run;
    },
    withConversationLock: async (_db, _key, fn) => fn(null),
    provider,
  };

  return { deps, runs, provider, persistCalls, criticCalls, autoSendCalls };
}

describe('shouldSkipGenerate', () => {
  it('skips off, takeover, and paused', () => {
    assert.deepEqual(shouldSkipGenerate({ effectiveMode: MODES.OFF }), {
      skip: true,
      reason: 'off',
    });
    assert.deepEqual(
      shouldSkipGenerate({ effectiveMode: MODES.HUMAN_TAKEOVER }),
      { skip: true, reason: 'human_takeover' }
    );
    assert.deepEqual(
      shouldSkipGenerate({
        effectiveMode: MODES.SUGGEST_ONLY,
        paused: true,
      }),
      { skip: true, reason: 'paused' }
    );
  });

  it('allows suggest_only', () => {
    assert.deepEqual(
      shouldSkipGenerate({ effectiveMode: MODES.SUGGEST_ONLY }),
      { skip: false, reason: null }
    );
  });

  it('skips ignored before paused, off, and takeover', () => {
    assert.deepEqual(
      shouldSkipGenerate({
        effectiveMode: MODES.SUGGEST_ONLY,
        paused: true,
        ignored: true,
      }),
      { skip: true, reason: 'ignored' }
    );
    assert.deepEqual(
      shouldSkipGenerate({
        effectiveMode: MODES.OFF,
        ignored: true,
      }),
      { skip: true, reason: 'ignored' }
    );
    assert.deepEqual(
      shouldSkipGenerate({
        effectiveMode: MODES.HUMAN_TAKEOVER,
        ignored: true,
      }),
      { skip: true, reason: 'ignored' }
    );
  });

  it('allows generate after unignore when suggest_only and not paused', () => {
    assert.deepEqual(
      shouldSkipGenerate({
        effectiveMode: MODES.SUGGEST_ONLY,
        paused: false,
        ignored: false,
      }),
      { skip: false, reason: null }
    );
  });
});

describe('conversationLockKey', () => {
  it('normalizes creator+platform+chat', () => {
    assert.deepEqual(
      conversationLockKey({
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
      }),
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
      }
    );
  });
});

describe('generateReply helpers', () => {
  it('asks for short time-aware replies and bans em dashes', () => {
    assert.match(SYSTEM_PROMPT, /240 characters/);
    assert.match(SYSTEM_PROMPT, /em dash/i);
    assert.match(SYSTEM_PROMPT, /inboundIsLiveSession/);
    assert.match(SYSTEM_PROMPT, /givenName/);
    assert.match(SYSTEM_PROMPT, /no pet name/i);
    assert.match(SYSTEM_PROMPT, /braver Junge/);
  });

  it('fails closed on timeout', async () => {
    await assert.rejects(
      () =>
        generateReply({
          context: {},
          provider: { createResponse: () => new Promise(() => {}) },
          timeoutMs: 15,
        }),
      (err) => err.code === 'timeout'
    );
  });

  it('rejects bad JSON', async () => {
    await assert.rejects(
      () =>
        generateReply({
          context: {},
          provider: { createResponse: async () => ({ outputText: 'not-json' }) },
        }),
      (err) => err.code === 'invalid_json'
    );
  });

  it('keeps model suggestedRoute as a hint and forces review on the output', () => {
    const output = normalizeGeneratedOutput({
      reply: 'hi',
      suggestedRoute: ROUTES.AUTO_SEND,
      requiresHumanReview: false,
    });
    assert.equal(output.suggestedRoute, ROUTES.AUTO_SEND);
    assert.equal(output.requiresHumanReview, true);
    assert.equal(output.action, 'TEXT_REPLY');
  });

  it('keeps SEND_PPV and coerces unknown actions to TEXT_REPLY', () => {
    assert.equal(
      normalizeGeneratedOutput({ action: 'SEND_PPV', reply: 'hi' }).action,
      'SEND_PPV'
    );
    assert.equal(
      normalizeGeneratedOutput({ action: 'OTHER', reply: 'hi' }).action,
      'TEXT_REPLY'
    );
  });

  it('drops unknown recommendedState', () => {
    const output = normalizeGeneratedOutput({
      reply: 'hi',
      replyEnglish: 'hi',
      recommendedState: 'NOPE',
    });
    assert.equal(output.recommendedState, null);
  });

  it('keeps a known recommendedState', () => {
    const output = normalizeGeneratedOutput({
      reply: 'hi',
      replyEnglish: 'hi',
      recommendedState: 'WARMUP',
    });
    assert.equal(output.recommendedState, 'WARMUP');
  });

  it('withTimeout rejects after the limit', async () => {
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 10, 'generate_timeout'),
      (err) => err.code === 'timeout'
    );
  });
});

describe('processIncomingMessage', () => {
  it('skips generate when mode is off', async () => {
    const { deps, provider } = createHarness({ mode: MODES.OFF });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'off');
    assert.equal(provider.calls, 0);
  });

  it('skips generate during human takeover', async () => {
    const { deps, provider } = createHarness({ mode: MODES.HUMAN_TAKEOVER });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'human_takeover');
    assert.equal(provider.calls, 0);
  });

  it('skips generate when paused', async () => {
    const { deps, provider } = createHarness({
      mode: MODES.SUGGEST_ONLY,
      paused: true,
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'paused');
    assert.equal(provider.calls, 0);
  });

  it('skips generate when the conversation is ignored', async () => {
    const { deps, provider, persistCalls } = createHarness({
      mode: MODES.SUGGEST_ONLY,
      paused: false,
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        revision: 2,
        lastInboundPlatformMessageId: 'in-1',
        aiIgnored: true,
        aiPaused: true,
        humanTakeover: true,
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'ignored');
    assert.equal(provider.calls, 0);
    assert.equal(persistCalls.length, 0);
  });

  it('generates after unignore when suggest_only is not paused', async () => {
    const { deps, provider } = createHarness({
      mode: MODES.SUGGEST_ONLY,
      paused: false,
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        revision: 2,
        lastInboundPlatformMessageId: 'in-1',
        aiIgnored: false,
        aiPaused: false,
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.skipReason, null);
    assert.ok(provider.calls > 0);
  });

  it('skips generate when the conversation is aiPaused', async () => {
    const { deps, provider } = createHarness({
      mode: MODES.SUGGEST_ONLY,
      paused: false,
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        revision: 2,
        lastInboundPlatformMessageId: 'in-1',
        aiPaused: true,
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'paused');
    assert.equal(provider.calls, 0);
  });

  it('fails closed on bad JSON', async () => {
    const { deps, provider } = createHarness({ outputText: '<<<not json>>>' });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'invalid_json');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(provider.calls, 1);
  });

  it('is idempotent on the same inbound id', async () => {
    const { deps, provider } = createHarness();
    const args = {
      creatorId: 'cr-1',
      platform: 'maloum',
      platformChatId: 'chat-1',
      inboundPlatformMessageId: 'in-1',
    };
    const first = await processIncomingMessage(args, deps);
    const second = await processIncomingMessage(args, deps);
    assert.equal(first.status, 'succeeded');
    assert.equal(second.id, first.id);
    assert.equal(provider.calls, 1);
  });

  it('forces HUMAN_REVIEW even if the model suggests AUTO_SEND', async () => {
    const { deps } = createHarness();
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(result.output.requiresHumanReview, true);
    assert.equal(result.output.suggestedRoute, ROUTES.AUTO_SEND);
    assert.equal(result.output.reply, 'hallo');
  });

  it('rejects a generated reply that fails validation', async () => {
    const { deps, runs } = createHarness({
      applyModeration: async () => ({
        blocked: true,
        matchedKeyword: 'forbidden',
      }),
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.error, 'moderation');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(runs.some((row) => row.status === 'succeeded'), false);
  });

  it('upserts usage after a successful generate', async () => {
    const upserts = [];
    const { deps } = createHarness({
      upsertAiUsage: async (row) => {
        upserts.push(row);
        return row;
      },
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hallo',
        replyEnglish: 'hello',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
      usage: { promptTokens: 11, completionTokens: 5, costUsd: 0.02 },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].runId, result.id);
    assert.equal(upserts[0].promptTokens, 11);
    assert.equal(upserts[0].completionTokens, 5);
    assert.equal(upserts[0].costUsd, 0.02);
    assert.equal(upserts[0].mode, 'suggest_only');
  });

  it('loads fan memories into generate context', async () => {
    const captured = [];
    const { deps } = createHarness({
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        platformFanId: 'fan-1',
        revision: 2,
        lastInboundPlatformMessageId: 'in-1',
      },
      getFanMemory: async () => ({
        nickname: 'Alex',
        facts: [{ kind: 'preference', text: 'likes voice notes' }],
        sourceNotes: 'lives nearby',
      }),
    });
    deps.generateReply = async ({ context }) => {
      captured.push(context);
      return {
        output: {
          schemaVersion: 1,
          reply: 'hallo',
          replyEnglish: 'hello',
          intent: 'rapport',
          action: 'TEXT_REPLY',
          suggestedRoute: 'HUMAN_REVIEW',
          requiresHumanReview: true,
          flags: [],
        },
      };
    };
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(captured[0].fan.nickname, 'Alex');
    assert.equal(captured[0].fan.notes, 'lives nearby');
    assert.deepEqual(captured[0].fan.memories, [
      { kind: 'preference', text: 'likes voice notes' },
    ]);
  });

  it('loads lastSessionSummary into generate context', async () => {
    const captured = [];
    const { deps } = createHarness({
      lastSessionSummary: 'Previous session: fan said hi',
    });
    deps.generateReply = async ({ context }) => {
      captured.push(context);
      return {
        output: {
          schemaVersion: 1,
          reply: 'hallo',
          replyEnglish: 'hello',
          intent: 'rapport',
          action: 'TEXT_REPLY',
          suggestedRoute: 'HUMAN_REVIEW',
          requiresHumanReview: true,
          flags: [],
        },
      };
    };
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(captured[0].lastSessionSummary, 'Previous session: fan said hi');
    assert.equal(captured[0].messages.length <= 20, true);
  });

  it('applies recommendedState after a successful generate', async () => {
    const applied = [];
    const { deps } = createHarness({
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        state: 'NEW',
        revision: 2,
        lastInboundPlatformMessageId: 'in-1',
      },
      applyRecommendedState: async (row) => {
        applied.push(row);
        return { applied: true, fromState: 'NEW', toState: row.recommendedState };
      },
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hallo',
        replyEnglish: 'hello',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        recommendedState: 'WARMUP',
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(applied.length, 1);
    assert.equal(applied[0].conversationId, 'conv-1');
    assert.equal(applied[0].currentState, 'NEW');
    assert.equal(applied[0].recommendedState, 'WARMUP');
    assert.equal(applied[0].source, 'model');
    assert.equal(applied[0].runId, result.id);
  });

  it('loads mediaCandidates into generate context', async () => {
    const captured = [];
    const { deps } = createHarness({
      mediaCandidates: [
        {
          source: 'script',
          mediaId: 'up-1',
          type: 'video',
          note: null,
          price: 12,
          scriptId: 'sc-1',
          title: 'Clip',
        },
      ],
    });
    deps.generateReply = async ({ context }) => {
      captured.push(context);
      return {
        output: {
          schemaVersion: 1,
          reply: 'hallo',
          replyEnglish: 'hello',
          intent: 'rapport',
          action: 'TEXT_REPLY',
          suggestedRoute: 'HUMAN_REVIEW',
          requiresHumanReview: true,
          flags: [],
        },
      };
    };
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(captured[0].mediaCandidates.length, 1);
    assert.equal(captured[0].mediaCandidates[0].mediaId, 'up-1');
    assert.equal(captured[0].mediaCandidates[0].price, 12);
  });

  it('binds SEND_PPV price from the candidate and keeps the run', async () => {
    const { deps, runs } = createHarness({
      mediaCandidates: [
        {
          source: 'script',
          mediaId: 'up-1',
          type: 'video',
          note: null,
          price: 12,
          scriptId: 'sc-1',
          title: 'Clip',
        },
      ],
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hier ist ein clip',
        replyEnglish: 'here is a clip',
        intent: 'upsell',
        action: 'SEND_PPV',
        mediaId: 'up-1',
        price: 99,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(runs[0].output.action, 'SEND_PPV');
    assert.equal(runs[0].output.mediaId, 'up-1');
    assert.equal(runs[0].output.price, 12);
    assert.equal(runs[0].output.scriptId, 'sc-1');
    assert.equal(runs[0].output.requiresHumanReview, true);
  });

  it('rejects the run when SEND_PPV mediaId is not a candidate', async () => {
    const { deps, runs } = createHarness({
      mediaCandidates: [
        {
          source: 'script',
          mediaId: 'up-1',
          type: 'video',
          note: null,
          price: 12,
          scriptId: 'sc-1',
          title: 'Clip',
        },
      ],
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hier ist ein clip',
        replyEnglish: 'here is a clip',
        intent: 'upsell',
        action: 'SEND_PPV',
        mediaId: 'invented',
        price: 12,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'rejected');
    assert.equal(runs[0].error, 'ppv_media');
    assert.equal(runs[0].output.action, 'SEND_PPV');
  });

  it('skips critic for simple rapport TEXT_REPLY', async () => {
    const { deps, criticCalls, runs } = createHarness();
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hallo',
        replyEnglish: 'hello',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        confidence: 0.85,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(criticCalls.length, 0);
    assert.deepEqual(runs[0].output.critic, { ran: false });
  });

  it('calls critic once for SEND_PPV', async () => {
    const { deps, criticCalls } = createHarness({
      mediaCandidates: [
        {
          source: 'script',
          mediaId: 'up-1',
          type: 'video',
          note: null,
          price: 12,
          scriptId: 'sc-1',
          title: 'Clip',
        },
      ],
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hier ist ein clip',
        replyEnglish: 'here is a clip',
        intent: 'upsell',
        action: 'SEND_PPV',
        mediaId: 'up-1',
        price: 12,
        confidence: 0.95,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(criticCalls.length, 1);
    assert.deepEqual(result.output.critic, { ran: true, ok: true });
  });

  it('rejects the run when the critic returns ok false', async () => {
    const persistCalls = [];
    const { deps } = createHarness({
      persistPendingSuggestion: async (row) => {
        persistCalls.push(row);
        return null;
      },
      criticReply: async () => ({ ok: false, flags: ['bad_ppv'], reason: 'unsafe' }),
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hallo',
        replyEnglish: 'hello',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        confidence: 0.2,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.error, 'unsafe');
    assert.equal(persistCalls.length, 0);
  });

  it('rejects the run when the critic times out', async () => {
    const persistCalls = [];
    const { deps } = createHarness({
      persistPendingSuggestion: async (row) => {
        persistCalls.push(row);
        return null;
      },
      criticReply: async () => {
        const err = new Error('critic_timeout');
        err.code = 'timeout';
        throw err;
      },
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hallo',
        replyEnglish: 'hello',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        confidence: 0.2,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.error, 'critic_failed');
    assert.equal(persistCalls.length, 0);
  });

  it('sums generate and critic usage when the critic runs', async () => {
    const upserts = [];
    const { deps } = createHarness({
      upsertAiUsage: async (row) => {
        upserts.push(row);
        return row;
      },
      criticReply: async () => ({
        ok: true,
        flags: ['reviewed'],
        usage: { promptTokens: 4, completionTokens: 3, costUsd: 0.01 },
      }),
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hallo',
        replyEnglish: 'hello',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        confidence: 0.2,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
      usage: { promptTokens: 11, completionTokens: 5, costUsd: 0.02 },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].promptTokens, 15);
    assert.equal(upserts[0].completionTokens, 8);
    assert.equal(upserts[0].costUsd, 0.03);
    assert.deepEqual(result.output.flags, ['reviewed']);
  });

  it('loads approved rules into generate context', async () => {
    const captured = [];
    const { deps } = createHarness({
      rules: [{ scope: 'CREATOR', text: 'Stay in character' }],
    });
    deps.generateReply = async ({ context }) => {
      captured.push(context);
      return {
        output: {
          schemaVersion: 1,
          reply: 'hallo',
          replyEnglish: 'hello',
          intent: 'rapport',
          action: 'TEXT_REPLY',
          confidence: 0.85,
          suggestedRoute: 'HUMAN_REVIEW',
          requiresHumanReview: true,
          flags: [],
        },
      };
    };
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(captured[0].rules, [
      { scope: 'CREATOR', text: 'Stay in character' },
    ]);
  });

  it('loads active SOPs into generate context', async () => {
    const captured = [];
    const { deps } = createHarness({
      sops: [{ title: 'Tone', body: 'Stay dominant.', scope: 'GLOBAL' }],
    });
    deps.generateReply = async ({ context }) => {
      captured.push(context);
      return {
        output: {
          schemaVersion: 1,
          reply: 'hallo',
          replyEnglish: 'hello',
          intent: 'rapport',
          action: 'TEXT_REPLY',
          confidence: 0.85,
          suggestedRoute: 'HUMAN_REVIEW',
          requiresHumanReview: true,
          flags: [],
        },
      };
    };
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-sop-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(captured[0].sops, [
      { title: 'Tone', body: 'Stay dominant.', scope: 'GLOBAL' },
    ]);
  });

  const inbound = {
    creatorId: 'cr-1',
    platform: 'maloum',
    platformChatId: 'chat-1',
    inboundPlatformMessageId: 'in-1',
  };

  function persistSuggestion() {
    return async (row) => ({ id: 'sug-1', ...row });
  }

  it('auto-sends TEXT_REPLY when limited auto-send gates pass', async () => {
    const { deps, autoSendCalls, persistCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO_LOW_RISK,
      persistPendingSuggestion: async (row) => {
        persistCalls.push(row);
        return { id: 'sug-1' };
      },
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.AUTO_SEND);
    assert.equal(result.output.requiresHumanReview, false);
    assert.equal(result.output.action, 'TEXT_REPLY');
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].run.route, ROUTES.AUTO_SEND);
    assert.equal(autoSendCalls.length, 1);
    assert.equal(autoSendCalls[0].suggestionId, 'sug-1');
    assert.equal(autoSendCalls[0].user, null);
    assert.equal(autoSendCalls[0].edited, false);
  });

  it('does not auto-send SEND_PPV', async () => {
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO_LOW_RISK,
      persistPendingSuggestion: persistSuggestion(),
      mediaCandidates: [
        {
          source: 'script',
          mediaId: 'up-1',
          type: 'video',
          note: null,
          price: 12,
          scriptId: 'sc-1',
          title: 'Clip',
        },
      ],
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hier ist ein clip',
        replyEnglish: 'here is a clip',
        intent: 'upsell',
        action: 'SEND_PPV',
        mediaId: 'up-1',
        price: 12,
        confidence: 0.95,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(result.output.requiresHumanReview, true);
    assert.equal(autoSendCalls.length, 0);
  });

  it('does not auto-send when flags are present', async () => {
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO_LOW_RISK,
      persistPendingSuggestion: persistSuggestion(),
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hallo',
        replyEnglish: 'hello',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        confidence: 0.95,
        suggestedRoute: 'AUTO_SEND',
        requiresHumanReview: false,
        flags: ['review'],
      },
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(autoSendCalls.length, 0);
  });

  it('does not auto-send below high confidence', async () => {
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO_LOW_RISK,
      persistPendingSuggestion: persistSuggestion(),
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hallo',
        replyEnglish: 'hello',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        confidence: 0.5,
        suggestedRoute: 'AUTO_SEND',
        requiresHumanReview: false,
        flags: [],
      },
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(autoSendCalls.length, 0);
  });

  it('auto-sends TEXT_REPLY in wider auto mode', async () => {
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO,
      persistPendingSuggestion: persistSuggestion(),
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.AUTO_SEND);
    assert.equal(result.output.requiresHumanReview, false);
    assert.equal(autoSendCalls.length, 1);
    assert.equal(autoSendCalls[0].suggestionId, 'sug-1');
  });

  it('does not auto-send SEND_PPV in wider auto mode', async () => {
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO,
      persistPendingSuggestion: persistSuggestion(),
      mediaCandidates: [
        {
          source: 'script',
          mediaId: 'up-1',
          type: 'video',
          note: null,
          price: 12,
          scriptId: 'sc-1',
          title: 'Clip',
        },
      ],
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'hier ist ein clip',
        replyEnglish: 'here is a clip',
        intent: 'upsell',
        action: 'SEND_PPV',
        mediaId: 'up-1',
        price: 12,
        confidence: 0.95,
        suggestedRoute: 'HUMAN_REVIEW',
        requiresHumanReview: true,
        flags: [],
      },
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(autoSendCalls.length, 0);
  });

  it('auto-sends TEXT_REPLY on 4based when gates pass', async () => {
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO_LOW_RISK,
      persistPendingSuggestion: persistSuggestion(),
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: '4based',
        platformChatId: 'chat-1',
        revision: 2,
        lastInboundPlatformMessageId: 'in-1',
      },
      creator: { id: 'cr-1', platform: '4based', connectionStatus: 'connected' },
    });
    const result = await processIncomingMessage(
      { ...inbound, platform: '4based' },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.AUTO_SEND);
    assert.equal(autoSendCalls.length, 1);
  });

  it('does not auto-send when the conversation went stale during generate', async () => {
    let loads = 0;
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO_LOW_RISK,
      persistPendingSuggestion: persistSuggestion(),
    });
    const original = deps.loadConversation;
    deps.loadConversation = async (...args) => {
      loads += 1;
      const row = await original(...args);
      if (loads > 1) {
        return {
          ...row,
          lastInboundPlatformMessageId: 'in-2',
          revision: 3,
        };
      }
      return row;
    };
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(autoSendCalls.length, 0);
  });

  it('does not auto-send when global auto-send is off', async () => {
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: false,
      mode: MODES.AUTO_LOW_RISK,
      persistPendingSuggestion: persistSuggestion(),
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
    assert.equal(autoSendCalls.length, 0);
  });

  it('does not auto-send when persist returns no suggestion id', async () => {
    const { deps, autoSendCalls } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO_LOW_RISK,
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.AUTO_SEND);
    assert.equal(autoSendCalls.length, 0);
  });

  it('keeps the run succeeded when executeApprovedSend throws', async () => {
    const alerts = [];
    const { deps } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO_LOW_RISK,
      persistPendingSuggestion: persistSuggestion(),
      executeApprovedSend: async () => {
        throw new Error('send_failed');
      },
      notifyAlertChats: async (text) => {
        alerts.push(text);
        return { sent: 1 };
      },
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.AUTO_SEND);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /send_failed/);
  });

  it('keeps the run succeeded when notifyAlertChats throws', async () => {
    const { deps } = createHarness({
      autoSendAllowed: true,
      mode: MODES.AUTO,
      persistPendingSuggestion: persistSuggestion(),
      executeApprovedSend: async () => {
        throw new Error('send_failed');
      },
      notifyAlertChats: async () => {
        throw new Error('telegram down');
      },
    });
    const result = await processIncomingMessage(inbound, deps);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.route, ROUTES.AUTO_SEND);
  });
});

describe('processManualSuggest', () => {
  it('skips when conversation is missing', async () => {
    const { deps, provider } = createHarness({
      conversation: null,
      mode: MODES.SUGGEST_ONLY,
    });
    const result = await processManualSuggest(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
      },
      deps
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'conversation_missing');
    assert.equal(provider.calls, 0);
  });
});

describe('POST /api/ai/conversations ignore permission', () => {
  const mw = requirePermission('ai.moderate', 'ai.settings.manage');

  it('returns 403 for a chatter with only ai.suggest.use', () => {
    const res = mockRes();
    let nextCalled = false;
    mw(
      { user: { role: 'chatter', permissions: ['ai.suggest.use'] } },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('allows ai.moderate or ai.settings.manage', () => {
    const res = mockRes();
    let nextCalled = false;
    mw(
      { user: { role: 'manager', permissions: ['ai.moderate'] } },
      res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, true);

    const res2 = mockRes();
    let next2 = false;
    mw(
      { user: { role: 'manager', permissions: ['ai.settings.manage'] } },
      res2,
      () => {
        next2 = true;
      }
    );
    assert.equal(next2, true);
  });
});

describe('POST /api/ai/suggest permission', () => {
  const mw = requirePermission('ai.suggest.use');

  it('returns 403 without ai.suggest.use', () => {
    const req = {
      user: { role: 'chatter', permissions: ['creators.view'] },
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('allows a manager with ai.suggest.use', () => {
    const req = {
      user: { role: 'manager', permissions: ['ai.suggest.use'] },
    };
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});

describe('quality, time, and names in generate context', () => {
  it('passes relativeAge and does not treat old sadness as live', async () => {
    const captured = [];
    const { deps } = createHarness({
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        revision: 2,
        lastInboundPlatformMessageId: 'sad-1',
        lastInboundAt: '2026-08-15T12:00:00.000Z',
        historyBackfilledAt: '2026-09-09T00:00:00.000Z',
      },
      messages: [
        {
          platformMessageId: 'sad-1',
          direction: 'inbound',
          senderRole: 'fan',
          text: 'Nein bin ganz traurig',
          sentAt: '2026-08-15T12:00:00.000Z',
        },
      ],
    });
    deps.generateReply = async ({ context }) => {
      captured.push(context);
      return {
        output: {
          schemaVersion: 1,
          reply: 'hey boy, whats up',
          replyEnglish: 'hey boy, whats up',
          intent: 'rapport',
          action: 'TEXT_REPLY',
          suggestedRoute: 'HUMAN_REVIEW',
          requiresHumanReview: true,
          flags: [],
        },
      };
    };
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'sad-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(
      captured[0].messages[0].relativeAge,
      formatRelativeAge('2026-08-15T12:00:00.000Z', captured[0].nowBerlin.iso)
    );
    assert.equal(captured[0].inboundIsLiveSession, false);
    assert.ok(captured[0].constraints.some((rule) => rule.includes('do not use heute')));
    assert.equal(JSON.stringify(captured[0]).includes('heute'), true);
    assert.equal(captured[0].constraints.join(' ').includes('what makes you sad today'), false);
  });

  it('flags a matcha/selfie follow-up as duplicate_outbound', async () => {
    const { deps } = createHarness({
      messages: [
        {
          platformMessageId: 'in-1',
          direction: 'inbound',
          senderRole: 'fan',
          text: 'hey',
          sentAt: '2026-09-09T11:47:00.000Z',
        },
        {
          platformMessageId: 'out-1',
          direction: 'outbound',
          senderRole: 'creator',
          text: 'Schick mir ein Selfie mit deinem Matcha',
          sentAt: '2026-09-09T11:48:00.000Z',
        },
      ],
    });
    deps.generateReply = async () => ({
      output: {
        schemaVersion: 1,
        reply: 'Mach ein Selfie mit dem Matcha, baby',
        replyEnglish: 'Take a selfie with the matcha baby',
        intent: 'rapport',
        action: 'TEXT_REPLY',
        suggestedRoute: 'AUTO_SEND',
        requiresHumanReview: false,
        flags: [],
        confidence: 0.9,
      },
    });
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.ok(result.output.flags.includes('duplicate_outbound'));
    assert.equal(result.route, ROUTES.HUMAN_REVIEW);
  });

  it('does not put username on fan.givenName', async () => {
    const captured = [];
    const { deps } = createHarness({
      conversation: {
        id: 'conv-1',
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        platformFanId: 'abc123abc123abc123abc123',
        fanUsername: 'sugar_daddy99',
        revision: 2,
        lastInboundPlatformMessageId: 'in-1',
        lastInboundAt: '2026-09-09T12:00:00.000Z',
        historyBackfilledAt: '2026-09-09T00:00:00.000Z',
      },
    });
    deps.generateReply = async ({ context }) => {
      captured.push(context);
      return {
        output: {
          schemaVersion: 1,
          reply: 'hallo',
          replyEnglish: 'hello',
          intent: 'rapport',
          action: 'TEXT_REPLY',
          suggestedRoute: 'HUMAN_REVIEW',
          requiresHumanReview: true,
          flags: [],
        },
      };
    };
    await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(captured[0].fan.username, 'sugar_daddy99');
    assert.equal(captured[0].fan.givenName, null);
  });

  it('reloads conversation after backfill so the suggestion uses live revision', async () => {
    const captured = [];
    const persist = [];
    const base = {
      id: 'conv-1',
      creatorId: 'cr-1',
      platform: 'maloum',
      platformChatId: 'chat-1',
      lastInboundPlatformMessageId: 'in-1',
      lastInboundAt: '2026-09-09T12:00:00.000Z',
      historyBackfilledAt: null,
    };
    let loads = 0;
    const { deps } = createHarness({
      conversation: { ...base, revision: 1 },
      maybeBackfillHistory: async () => ({ skipped: false }),
      persistPendingSuggestion: async (row) => {
        persist.push(row);
        return { id: 'sug-1' };
      },
    });
    deps.loadConversation = async () => {
      loads += 1;
      if (loads === 1) return { ...base, revision: 1 };
      return { ...base, revision: 9, lastInboundPlatformMessageId: 'in-1' };
    };
    deps.generateReply = async ({ context }) => {
      captured.push(context);
      return {
        output: {
          schemaVersion: 1,
          reply: 'hallo',
          replyEnglish: 'hello',
          intent: 'rapport',
          action: 'TEXT_REPLY',
          suggestedRoute: 'HUMAN_REVIEW',
          requiresHumanReview: true,
          flags: [],
        },
      };
    };
    const result = await processIncomingMessage(
      {
        creatorId: 'cr-1',
        platform: 'maloum',
        platformChatId: 'chat-1',
        inboundPlatformMessageId: 'in-1',
      },
      deps
    );
    assert.equal(result.status, 'succeeded');
    assert.ok(loads >= 2);
    assert.equal(captured[0].revision, 9);
    assert.equal(captured[0].anchorInboundMessageId, 'in-1');
    assert.equal(persist[0].conversation.revision, 9);
    assert.equal(persist[0].run.revision, 9);
  });
});
