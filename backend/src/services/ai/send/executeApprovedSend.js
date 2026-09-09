const { randomUUID } = require('crypto');
const pool = require('../../../db/pool');
const fourBasedClient = require('../../fourBasedClient');
const maloumClient = require('../../maloumClient');
const telegramWorker = require('../../telegramWorker');
const {
  loadFourBasedCreator,
  loadMaloumCreator,
} = require('../../platformCreatorSession');
const { applyModeration } = require('../../contentModeration');
const { withConversationLock } = require('../locks');
const { getAiFlags } = require('../../appSettings');
const { MODES, OUTPUT_ACTIONS, defaultCreatorAiSettings } = require('../contracts');
const { resolveEffectiveAiMode } = require('../flags');
const {
  SUGGESTION_STATUSES,
  getSuggestionById,
  updateSuggestionStatus,
  emitSuggestionEvent,
} = require('../review/suggestionService');
const { findCandidate, loadMediaCandidates } = require('../mediaCandidates');
const { maybeSuggestRuleFromEdit } = require('../brain/rules');

class ReviewError extends Error {
  constructor(status, message, extras = {}) {
    super(message);
    this.status = status;
    this.code = extras.code || message;
    Object.assign(this, extras);
  }
}

function isSuggestionStale(suggestion, conversation) {
  if (!suggestion || !conversation) return true;
  const draftAnchor = suggestion.anchorInboundMessageId || null;
  const liveAnchor = conversation.lastInboundPlatformMessageId || null;
  if (draftAnchor !== liveAnchor) return true;
  const draftRev = Number(suggestion.revision);
  const liveRev = Number(conversation.revision);
  if (Number.isFinite(draftRev) && Number.isFinite(liveRev) && draftRev < liveRev) {
    return true;
  }
  return false;
}

function asMessageId(result) {
  if (typeof result === 'string' && result.trim()) return result.trim();
  if (result && typeof result === 'object') {
    const id = result._id || result.id || result.messageId;
    if (id != null && String(id).trim()) return String(id).trim();
  }
  return null;
}

const SENDABLE_PLATFORMS = new Set(['maloum', '4based', 'telegram']);

function isSendablePlatform(platform) {
  return SENDABLE_PLATFORMS.has(String(platform || '').trim());
}

function dashboardMaloumMessageId(platform, messageId) {
  const id = String(messageId || '').trim();
  if (!id) return id;
  if (platform === '4based') {
    return id.startsWith('4based:') ? id : `4based:${id}`;
  }
  if (platform === 'telegram') {
    return id.startsWith('telegram:') ? id : `telegram:${id}`;
  }
  return id;
}

function platformNotSupportedError() {
  return {
    kind: 'error',
    status: 400,
    message: 'Approve is only available for Maloum, 4based, and Telegram',
    code: 'platform_not_supported',
  };
}

async function defaultLoadConversation(conversationId, client = pool) {
  const result = await client.query(
    `SELECT * FROM ai_conversations WHERE id = $1`,
    [conversationId]
  );
  return result.rows[0] || null;
}

function suggestionOutput(suggestion) {
  return suggestion?.output && typeof suggestion.output === 'object'
    ? suggestion.output
    : {};
}

function suggestionAction(suggestion) {
  const output = suggestionOutput(suggestion);
  if (
    suggestion?.action === OUTPUT_ACTIONS.SEND_PPV ||
    output.action === OUTPUT_ACTIONS.SEND_PPV
  ) {
    return OUTPUT_ACTIONS.SEND_PPV;
  }
  return OUTPUT_ACTIONS.TEXT_REPLY;
}

function collectMediaIdsFromJson(mediaJson, into) {
  if (!mediaJson) return;
  const items = Array.isArray(mediaJson)
    ? mediaJson
    : typeof mediaJson === 'object' && Array.isArray(mediaJson.items)
      ? mediaJson.items
      : null;
  if (!items) return;
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const mediaId =
      (typeof entry.mediaId === 'string' && entry.mediaId.trim()) ||
      (typeof entry.uploadId === 'string' && entry.uploadId.trim()) ||
      '';
    if (mediaId) into.add(mediaId);
  }
}

function mediaCountsForType(type) {
  const kind = String(type || '').toLowerCase();
  const isVideo = kind === 'video';
  return {
    mediaCount: 1,
    pictureCount: isVideo ? 0 : 1,
    videoCount: isVideo ? 1 : 0,
  };
}

async function defaultHasVaultSent({ creatorId, fanId, uploadId }, client = pool) {
  if (!creatorId || !fanId || !uploadId) return false;
  const result = await client.query(
    `SELECT 1
     FROM maloum_vault_sent
     WHERE "creatorId" = $1 AND "fanId" = $2 AND "uploadId" = $3
     LIMIT 1`,
    [creatorId, fanId, uploadId]
  );
  return result.rows.length > 0;
}

async function defaultHasPurchasedMedia(
  { creatorId, fanId, mediaId },
  client = pool
) {
  if (!creatorId || !fanId || !mediaId) return false;
  const result = await client.query(
    `SELECT "mediaJson"
     FROM messaging_dashboard_entries
     WHERE "creatorId" = $1
       AND "fanId" = $2
       AND purchased = true
       AND "mediaJson" IS NOT NULL`,
    [creatorId, fanId]
  );
  for (const row of result.rows) {
    const ids = new Set();
    collectMediaIdsFromJson(row.mediaJson, ids);
    if (ids.has(mediaId)) return true;
  }
  return false;
}

async function defaultRecordVaultSent(
  { creatorId, fanId, chatId, uploadId, sentByUserId },
  client = pool
) {
  await client.query(
    `INSERT INTO maloum_vault_sent (
       "creatorId", "fanId", "chatId", "uploadId", "sentByUserId", "sentAt"
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT ("creatorId", "fanId", "uploadId") DO UPDATE SET
       "chatId" = COALESCE(EXCLUDED."chatId", maloum_vault_sent."chatId"),
       "sentByUserId" = COALESCE(EXCLUDED."sentByUserId", maloum_vault_sent."sentByUserId"),
       "sentAt" = maloum_vault_sent."sentAt"`,
    [creatorId, fanId, chatId, uploadId, sentByUserId || null]
  );
}

async function defaultRecordScriptSend(
  { scriptId, creatorId, platform, fanId, chatId, sentBy },
  client = pool
) {
  if (!scriptId || !fanId) return;
  await client.query(
    `INSERT INTO creator_script_sends
       (id, "scriptId", "creatorId", platform, "fanId", "chatId", "sentBy", "sentAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT ("scriptId", "fanId")
     DO UPDATE SET
       "chatId" = COALESCE(EXCLUDED."chatId", creator_script_sends."chatId"),
       "sentBy" = EXCLUDED."sentBy",
       "sentAt" = NOW()`,
    [randomUUID(), scriptId, creatorId, platform, fanId, chatId, sentBy || null]
  );
}

async function defaultInsertDashboard(entry, client = pool) {
  await client.query(
    `INSERT INTO messaging_dashboard_entries (
       id, "creatorId", "creatorName", "creatorUsername", "creatorAvatarUrl",
       platform, "chatterId", "chatterName", "chatterEmail",
       "chatId", "fanId", "fanUsername",
       "maloumMessageId", "optimisticMessageId", "contentType",
       "englishMessage", "germanTranslatedMessage", "actualSentText",
       "priceNet", currency, purchased,
       "mediaCount", "pictureCount", "videoCount",
       "mediaJson",
       "sentAt"
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23, $24, $25, NOW()
     )
     ON CONFLICT ("maloumMessageId") DO NOTHING`,
    [
      entry.id,
      entry.creatorId,
      entry.creatorName,
      entry.creatorUsername,
      entry.creatorAvatarUrl,
      entry.platform || 'maloum',
      entry.chatterId,
      entry.chatterName,
      entry.chatterEmail,
      entry.chatId,
      entry.fanId,
      entry.fanUsername,
      entry.maloumMessageId,
      entry.optimisticMessageId,
      entry.contentType || 'text',
      entry.englishMessage,
      entry.germanTranslatedMessage,
      entry.actualSentText,
      entry.priceNet ?? null,
      entry.currency || 'EUR',
      entry.purchased === true,
      entry.mediaCount ?? 0,
      entry.pictureCount ?? 0,
      entry.videoCount ?? 0,
      entry.mediaJson != null ? JSON.stringify(entry.mediaJson) : null,
    ]
  );
}

async function resolvePpvGate({ suggestion, conversation, deps, client }) {
  const output = suggestionOutput(suggestion);
  const mediaId = String(output.mediaId || '').trim();
  if (!mediaId) {
    return {
      kind: 'error',
      status: 409,
      message: 'PPV media is required',
      code: 'ppv_media',
    };
  }

  const fanId = String(conversation?.platformFanId || '').trim();
  if (!fanId) {
    return {
      kind: 'error',
      status: 409,
      message: 'Fan id required for PPV',
      code: 'ppv_fan',
    };
  }

  const candidates = await deps.loadMediaCandidates({
    creatorId: suggestion.creatorId,
    platform: suggestion.platform,
    platformFanId: fanId,
  });
  const candidate = findCandidate(candidates, mediaId);
  if (!candidate) {
    return {
      kind: 'error',
      status: 409,
      message: 'PPV media is not available',
      code: 'ppv_media',
    };
  }

  const price = Number(candidate.price);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      kind: 'error',
      status: 403,
      message: 'PPV price is required',
      code: 'ppv_price',
    };
  }

  if (
    await deps.hasVaultSent(
      { creatorId: suggestion.creatorId, fanId, uploadId: mediaId },
      client
    )
  ) {
    return {
      kind: 'error',
      status: 409,
      message: 'PPV already sent',
      code: 'ppv_sent',
    };
  }

  if (
    await deps.hasPurchasedMedia(
      { creatorId: suggestion.creatorId, fanId, mediaId },
      client
    )
  ) {
    return {
      kind: 'error',
      status: 409,
      message: 'PPV already purchased',
      code: 'ppv_purchased',
    };
  }

  return { kind: 'ok', candidate, price, mediaId, fanId };
}

function throwReview(result) {
  throw new ReviewError(result.status, result.message, {
    code: result.code,
    matchedKeyword: result.matchedKeyword,
    matchedStage: result.matchedStage,
    suggestion: result.suggestion,
  });
}

async function maybeMarkReadAfterSend(d, { platform, creatorId, platformChatId }) {
  try {
    if (platform === 'maloum') {
      const loaded = await d.loadMaloumCreator(creatorId);
      if (loaded?.creator) {
        await d.markMaloumRead(loaded.creator, platformChatId);
      }
    } else if (platform === '4based') {
      const loaded = await d.loadFourBasedCreator(creatorId);
      if (loaded?.creator) {
        await d.markFourBasedReceived(loaded.creator, platformChatId);
      }
    }
  } catch (err) {
    console.error('AI mark-read error:', err);
  }
}

async function executeApprovedSend(
  {
    suggestionId,
    text,
    englishText,
    user,
    edited = false,
  } = {},
  deps = {}
) {
  const d = {
    pool: deps.pool || pool,
    getSuggestionById: deps.getSuggestionById || getSuggestionById,
    loadConversation: deps.loadConversation || defaultLoadConversation,
    updateSuggestionStatus: deps.updateSuggestionStatus || updateSuggestionStatus,
    applyModeration: deps.applyModeration || applyModeration,
    loadMaloumCreator: deps.loadMaloumCreator || loadMaloumCreator,
    loadFourBasedCreator: deps.loadFourBasedCreator || loadFourBasedCreator,
    sendText: deps.sendText || maloumClient.sendText.bind(maloumClient),
    sendFourBasedMessage:
      deps.sendFourBasedMessage ||
      fourBasedClient.sendMessage.bind(fourBasedClient),
    sendTelegramText:
      deps.sendTelegramText || telegramWorker.sendText.bind(telegramWorker),
    sendMedia: deps.sendMedia || maloumClient.sendMedia.bind(maloumClient),
    markMaloumRead:
      deps.markMaloumRead || maloumClient.markRead.bind(maloumClient),
    markFourBasedReceived:
      deps.markFourBasedReceived ||
      fourBasedClient.markReceived.bind(fourBasedClient),
    loadMediaCandidates: deps.loadMediaCandidates || loadMediaCandidates,
    hasVaultSent: deps.hasVaultSent || defaultHasVaultSent,
    hasPurchasedMedia: deps.hasPurchasedMedia || defaultHasPurchasedMedia,
    recordVaultSent: deps.recordVaultSent || defaultRecordVaultSent,
    recordScriptSend: deps.recordScriptSend || defaultRecordScriptSend,
    insertDashboard: deps.insertDashboard || defaultInsertDashboard,
    maybeSuggestRuleFromEdit:
      deps.maybeSuggestRuleFromEdit || maybeSuggestRuleFromEdit,
    emitSuggestionEvent: deps.emitSuggestionEvent || emitSuggestionEvent,
    withConversationLock: deps.withConversationLock || withConversationLock,
    loadCreatorRow:
      deps.loadCreatorRow ||
      (async (creatorId, client = pool) => {
        const result = await client.query(
          `SELECT id, "displayName", username, "avatarUrl" FROM creators WHERE id = $1`,
          [creatorId]
        );
        return result.rows[0] || null;
      }),
    getAiFlags: deps.getAiFlags || getAiFlags,
    loadCreatorSettings:
      deps.loadCreatorSettings ||
      (async (creatorId, client = pool) => {
        const result = await client.query(
          `SELECT mode, paused, "takeoverByUserId", "takeoverAt"
           FROM ai_creator_settings
           WHERE "creatorId" = $1`,
          [creatorId]
        );
        return result.rows[0] || null;
      }),
  };

  const suggestion = await d.getSuggestionById(suggestionId);
  if (!suggestion) {
    throw new ReviewError(404, 'Suggestion not found');
  }
  if (suggestion.status !== SUGGESTION_STATUSES.PENDING) {
    throw new ReviewError(409, 'not_pending', { code: 'not_pending' });
  }
  if (!isSendablePlatform(suggestion.platform)) {
    throw new ReviewError(
      400,
      'Approve is only available for Maloum, 4based, and Telegram',
      { code: 'platform_not_supported' }
    );
  }

  const [flags, settingsRow] = await Promise.all([
    d.getAiFlags(),
    d.loadCreatorSettings(suggestion.creatorId),
  ]);
  const settings = settingsRow || defaultCreatorAiSettings();
  const effectiveMode = resolveEffectiveAiMode({
    global: flags,
    creator: settings,
  });
  if (settings.mode === MODES.SHADOW || effectiveMode === MODES.SHADOW) {
    throw new ReviewError(403, 'Shadow mode cannot send', {
      code: 'SHADOW_MODE',
    });
  }

  const originalReply = String(suggestion.reply || '').trim();
  const germanText = String(text || suggestion.reply || '').trim();
  const englishDraft = String(
    englishText != null ? englishText : suggestion.replyEnglish || ''
  ).trim();
  if (!germanText) {
    throw new ReviewError(400, 'Message text is required');
  }

  const lockKey = {
    creatorId: suggestion.creatorId,
    platform: suggestion.platform,
    platformChatId: suggestion.platformChatId,
  };

  const locked = await d.withConversationLock(d.pool, lockKey, async (client) => {
    const live = await d.getSuggestionById(suggestionId, client);
    if (!live) {
      return { kind: 'error', status: 404, message: 'Suggestion not found' };
    }
    if (live.status !== SUGGESTION_STATUSES.PENDING) {
      return { kind: 'error', status: 409, message: 'not_pending', code: 'not_pending' };
    }
    if (!isSendablePlatform(live.platform)) {
      return platformNotSupportedError();
    }

    const conversation = await d.loadConversation(live.conversationId, client);
    if (!conversation) {
      return { kind: 'error', status: 404, message: 'Conversation not found' };
    }

    if (isSuggestionStale(live, conversation)) {
      const stale = await d.updateSuggestionStatus(
        live.id,
        { status: SUGGESTION_STATUSES.STALE },
        client
      );
      return { kind: 'stale', suggestion: stale };
    }

    let loaded = { creator: { id: live.creatorId } };
    if (live.platform === 'maloum') {
      loaded = await d.loadMaloumCreator(live.creatorId);
    } else if (live.platform === '4based') {
      loaded = await d.loadFourBasedCreator(live.creatorId);
    }
    if (loaded?.error) {
      return {
        kind: 'error',
        status: loaded.error.status || 400,
        message: loaded.error.message,
      };
    }

    const moderation = await d.applyModeration({
      germanText,
      englishText: englishDraft,
      userId: user?.id || null,
      creatorId: live.creatorId,
      platform: live.platform,
      chatId: live.platformChatId,
      creatorName: loaded.creator?.displayName || null,
      chatterName: user?.name || null,
    });
    if (moderation?.blocked) {
      return {
        kind: 'error',
        status: 403,
        message: moderation.message || 'Message blocked',
        code: 'CONTENT_BLOCKED',
        matchedKeyword: moderation.matchedKeyword,
        matchedStage: moderation.matchedStage,
      };
    }

    const action = suggestionAction(live);

    if (action === OUTPUT_ACTIONS.SEND_PPV) {
      if (live.platform !== 'maloum') {
        return {
          kind: 'error',
          status: 400,
          message: 'PPV send is only available for Maloum',
          code: 'platform_not_supported',
        };
      }
      const gate = await resolvePpvGate({
        suggestion: live,
        conversation,
        deps: d,
        client,
      });
      if (gate.kind === 'error') return gate;

      const optimisticMessageId = randomUUID();
      let sentResult;
      try {
        sentResult = await d.sendMedia(loaded.creator, live.platformChatId, {
          media: [{ mediaId: gate.mediaId, type: gate.candidate.type || 'picture' }],
          text: germanText,
          priceNet: gate.price,
          optimisticMessageId,
        });
      } catch (err) {
        const failed = await d.updateSuggestionStatus(
          live.id,
          {
            status: SUGGESTION_STATUSES.FAILED,
            reviewedBy: user?.id || null,
          },
          client
        );
        return {
          kind: 'send_failed',
          message: err?.message || 'Send failed',
          suggestion: failed,
        };
      }

      const messageId = asMessageId(sentResult);
      if (!messageId) {
        const failed = await d.updateSuggestionStatus(
          live.id,
          {
            status: SUGGESTION_STATUSES.FAILED,
            reviewedBy: user?.id || null,
          },
          client
        );
        return {
          kind: 'send_failed',
          message: 'Send returned no message id',
          suggestion: failed,
        };
      }

      try {
        await d.recordVaultSent(
          {
            creatorId: live.creatorId,
            fanId: gate.fanId,
            chatId: live.platformChatId,
            uploadId: gate.mediaId,
            sentByUserId: user?.id || null,
          },
          client
        );
        if (gate.candidate.scriptId) {
          await d.recordScriptSend(
            {
              scriptId: gate.candidate.scriptId,
              creatorId: live.creatorId,
              platform: live.platform,
              fanId: gate.fanId,
              chatId: live.platformChatId,
              sentBy: user?.id || null,
            },
            client
          );
        }
      } catch (err) {
        console.error('AI PPV sent-record error:', err);
      }

      if (edited) {
        await d.updateSuggestionStatus(
          live.id,
          {
            status: SUGGESTION_STATUSES.EDITED,
            reply: germanText,
            replyEnglish: englishDraft || undefined,
            reviewedBy: user?.id || null,
            reviewedAt: new Date().toISOString(),
          },
          client
        );
      }

      const sent = await d.updateSuggestionStatus(
        live.id,
        {
          status: SUGGESTION_STATUSES.SENT,
          reply: edited ? germanText : undefined,
          replyEnglish: edited ? englishDraft || undefined : undefined,
          sentPlatformMessageId: messageId,
          reviewedBy: user?.id || null,
          reviewedAt: new Date().toISOString(),
        },
        client
      );

      const dashboardExtras = {
        contentType: 'chat_product',
        priceNet: gate.price,
        purchased: false,
        ...mediaCountsForType(gate.candidate.type),
        mediaJson: [{ mediaId: gate.mediaId, type: gate.candidate.type || 'picture' }],
      };

      if (user?.id) {
        const creatorRow = await d.loadCreatorRow(live.creatorId, client);
        try {
          await d.insertDashboard(
            {
              id: randomUUID(),
              creatorId: live.creatorId,
              creatorName: creatorRow?.displayName || loaded.creator?.displayName || '',
              creatorUsername: creatorRow?.username || null,
              creatorAvatarUrl: creatorRow?.avatarUrl || null,
              chatterId: user.id,
              chatterName: user.name || 'AI',
              chatterEmail: user.email || null,
              chatId: live.platformChatId,
              fanId: conversation.platformFanId || null,
              fanUsername: null,
              platform: live.platform,
              maloumMessageId: dashboardMaloumMessageId(live.platform, messageId),
              optimisticMessageId,
              englishMessage: englishDraft || null,
              germanTranslatedMessage: germanText,
              actualSentText: germanText,
              ...dashboardExtras,
            },
            client
          );
        } catch (err) {
          console.error('AI dashboard insert error:', err);
        }
      }

      return {
        kind: 'ok',
        suggestion: sent,
        messageId,
        optimisticMessageId,
        conversation,
      };
    }

    const optimisticMessageId = randomUUID();
    let sentResult;
    try {
      if (live.platform === '4based') {
        sentResult = await d.sendFourBasedMessage(loaded.creator, live.platformChatId, {
          message: germanText,
          localId: optimisticMessageId,
        });
      } else if (live.platform === 'telegram') {
        sentResult = await d.sendTelegramText(
          live.creatorId,
          live.platformChatId,
          germanText
        );
      } else {
        sentResult = await d.sendText(loaded.creator, live.platformChatId, {
          text: germanText,
          optimisticMessageId,
        });
      }
    } catch (err) {
      const failed = await d.updateSuggestionStatus(
        live.id,
        {
          status: SUGGESTION_STATUSES.FAILED,
          reviewedBy: user?.id || null,
        },
        client
      );
      return {
        kind: 'send_failed',
        message: err?.message || 'Send failed',
        suggestion: failed,
      };
    }

    const messageId = asMessageId(sentResult);
    if (!messageId) {
      const failed = await d.updateSuggestionStatus(
        live.id,
        {
          status: SUGGESTION_STATUSES.FAILED,
          reviewedBy: user?.id || null,
        },
        client
      );
      return {
        kind: 'send_failed',
        message: 'Send returned no message id',
        suggestion: failed,
      };
    }

    if (edited) {
      await d.updateSuggestionStatus(
        live.id,
        {
          status: SUGGESTION_STATUSES.EDITED,
          reply: germanText,
          replyEnglish: englishDraft || undefined,
          reviewedBy: user?.id || null,
          reviewedAt: new Date().toISOString(),
        },
        client
      );
    }

    const sent = await d.updateSuggestionStatus(
      live.id,
      {
        status: SUGGESTION_STATUSES.SENT,
        reply: edited ? germanText : undefined,
        replyEnglish: edited ? englishDraft || undefined : undefined,
        sentPlatformMessageId: messageId,
        reviewedBy: user?.id || null,
        reviewedAt: new Date().toISOString(),
      },
      client
    );

    const creatorRow = await d.loadCreatorRow(live.creatorId, client);
    try {
      await d.insertDashboard(
        {
          id: randomUUID(),
          creatorId: live.creatorId,
          creatorName: creatorRow?.displayName || loaded.creator?.displayName || '',
          creatorUsername: creatorRow?.username || null,
          creatorAvatarUrl: creatorRow?.avatarUrl || null,
          chatterId: user?.id || null,
          chatterName: user?.name || 'AI',
          chatterEmail: user?.email || null,
          chatId: live.platformChatId,
          fanId: conversation.platformFanId || null,
          fanUsername: null,
          platform: live.platform,
          maloumMessageId: dashboardMaloumMessageId(live.platform, messageId),
          optimisticMessageId,
          englishMessage: englishDraft || null,
          germanTranslatedMessage: germanText,
          actualSentText: germanText,
        },
        client
      );
    } catch (err) {
      console.error('AI dashboard insert error:', err);
    }

    return {
      kind: 'ok',
      suggestion: sent,
      messageId,
      optimisticMessageId,
      conversation,
    };
  });

  if (locked.kind === 'stale') {
    await d.emitSuggestionEvent(locked.suggestion, { mode: null });
    throw new ReviewError(409, 'stale', {
      code: 'stale',
      suggestion: locked.suggestion,
    });
  }
  if (locked.kind === 'send_failed') {
    if (locked.suggestion) {
      await d.emitSuggestionEvent(locked.suggestion, { mode: null });
    }
    throw new ReviewError(502, locked.message, {
      code: 'send_failed',
      suggestion: locked.suggestion,
    });
  }
  if (locked.kind === 'error') {
    throwReview(locked);
  }

  if (locked.kind === 'ok') {
    await maybeMarkReadAfterSend(d, {
      platform: suggestion.platform,
      creatorId: suggestion.creatorId,
      platformChatId: suggestion.platformChatId,
    });
  }

  if (edited && originalReply !== germanText) {
    try {
      await d.maybeSuggestRuleFromEdit({
        suggestion,
        conversation: locked.conversation,
        beforeText: originalReply,
        afterText: germanText,
        createdBy: user?.id || null,
      });
    } catch (err) {
      console.error('AI rule suggestion error:', err);
    }
  }

  await d.emitSuggestionEvent(locked.suggestion, { mode: null });
  return {
    suggestion: locked.suggestion,
    messageId: locked.messageId,
    optimisticMessageId: locked.optimisticMessageId,
  };
}

module.exports = {
  ReviewError,
  isSuggestionStale,
  asMessageId,
  suggestionAction,
  dashboardMaloumMessageId,
  isSendablePlatform,
  executeApprovedSend,
};
