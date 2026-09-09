const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const { userCanAccessCreator } = require('../services/creatorAccess');
const {
  getAiFlags,
  setAiFlags,
  AiFlagsError,
  toAiFlagsPayload,
  assertCanPatchAutoSend,
} = require('../services/appSettings');
const {
  isAiMode,
  MODES,
  CONVERSATION_STATE_VALUES,
  defaultCreatorAiSettings,
} = require('../services/ai/contracts');
const { summarizeUsage } = require('../services/ai/usage');
const { resolveEffectiveAiMode } = require('../services/ai/flags');
const {
  INGEST_PLATFORMS,
  ingestConversation,
} = require('../services/ai/ingest');
const { processManualSuggest } = require('../services/ai/orchestrator');
const {
  getPendingSuggestion,
  getPendingSuggestionByChat,
  getSuggestionById,
  updateSuggestionStatus,
  toSuggestionDto,
  emitSuggestionEvent,
  takeoverConversation,
  resumeConversation,
  pauseConversation,
  ignoreConversation,
  unignoreConversation,
  ignoreConversationByChat,
  getConversationByChat,
  SUGGESTION_STATUSES,
} = require('../services/ai/review/suggestionService');
const { executeApprovedSend, ReviewError } = require('../services/ai/send/executeApprovedSend');
const {
  listQueue,
  QUEUE_BUCKET_VALUES,
} = require('../services/ai/review/queue');
const {
  getCreatorProfile,
  upsertCreatorProfile,
} = require('../services/ai/profile');
const {
  MEMORY_PLATFORMS,
  getFanMemory,
  upsertFanMemory,
} = require('../services/ai/memory');
const {
  BrainError,
  listRuleSuggestions,
  listApprovedRules,
  approveRuleSuggestion,
  rejectRuleSuggestion,
} = require('../services/ai/brain/rules');
const {
  SopImportError,
  importSopGuide,
  getSopImportDraft,
  approveSopImport,
  rejectSopImport,
} = require('../services/ai/brain/sopImport');

const router = express.Router();

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function toSettingsPayload(row, globalFlags) {
  const settings = row
    ? {
        mode: row.mode,
        paused: Boolean(row.paused),
        takeoverByUserId: row.takeoverByUserId || null,
        takeoverAt: row.takeoverAt || null,
        updatedAt: row.updatedAt || null,
      }
    : {
        ...defaultCreatorAiSettings(),
        updatedAt: null,
      };

  return {
    ...settings,
    globalEnabled: Boolean(globalFlags?.enabled),
    effectiveMode: resolveEffectiveAiMode({
      global: globalFlags,
      creator: settings,
    }),
  };
}

async function loadCreator(id) {
  const result = await pool.query(`SELECT id FROM creators WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function loadCreatorSettings(creatorId) {
  const result = await pool.query(
    `SELECT "creatorId", mode, paused, "takeoverByUserId", "takeoverAt", "updatedAt"
     FROM ai_creator_settings
     WHERE "creatorId" = $1`,
    [creatorId]
  );
  return result.rows[0] || null;
}

async function requireAccessibleCreator(req, res) {
  const { id } = req.params;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid creator ID' });
    return null;
  }

  const creator = await loadCreator(id);
  if (!creator) {
    res.status(404).json({ error: 'Creator not found' });
    return null;
  }

  const allowed = await userCanAccessCreator(req.user, id);
  if (!allowed) {
    res.status(403).json({ error: 'You do not have access to this creator' });
    return null;
  }

  return creator;
}

router.get(
  '/flags',
  authenticate,
  requirePermission('ai.settings.manage'),
  async (req, res) => {
    try {
      const flags = await getAiFlags();
      return res.json(toAiFlagsPayload(flags, req.user));
    } catch (err) {
      console.error('Get AI flags error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch(
  '/flags',
  authenticate,
  requirePermission('ai.settings.manage'),
  async (req, res) => {
    try {
      const body = req.body || {};
      if (!assertCanPatchAutoSend(req.user, body)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      const flags = await setAiFlags(body, req.user.id);
      return res.json(toAiFlagsPayload(flags, req.user));
    } catch (err) {
      if (err instanceof AiFlagsError) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      console.error('Patch AI flags error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get('/creators/:id/settings', authenticate, async (req, res) => {
  try {
    const creator = await requireAccessibleCreator(req, res);
    if (!creator) return;

    const [row, globalFlags] = await Promise.all([
      loadCreatorSettings(creator.id),
      getAiFlags(),
    ]);
    return res.json(toSettingsPayload(row, globalFlags));
  } catch (err) {
    console.error('Get AI creator settings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch(
  '/creators/:id/settings',
  authenticate,
  requirePermission('ai.settings.manage'),
  async (req, res) => {
    try {
      const creator = await requireAccessibleCreator(req, res);
      if (!creator) return;

      const body = req.body || {};
      const hasMode = Object.prototype.hasOwnProperty.call(body, 'mode');
      const hasPaused = Object.prototype.hasOwnProperty.call(body, 'paused');

      if (!hasMode && !hasPaused) {
        return res.status(400).json({ error: 'Provide mode and/or paused' });
      }

      if (hasMode && !isAiMode(body.mode)) {
        return res.status(400).json({ error: 'Invalid mode' });
      }

      if (hasPaused && typeof body.paused !== 'boolean') {
        return res.status(400).json({ error: 'paused must be a boolean' });
      }

      const existing = await loadCreatorSettings(creator.id);
      const defaults = defaultCreatorAiSettings();
      const nextMode = hasMode ? body.mode : existing?.mode || defaults.mode;
      const nextPaused = hasPaused
        ? body.paused
        : existing
          ? Boolean(existing.paused)
          : defaults.paused;

      const upserted = await pool.query(
        `INSERT INTO ai_creator_settings ("creatorId", mode, paused)
         VALUES ($1, $2, $3)
         ON CONFLICT ("creatorId") DO UPDATE SET
           mode = EXCLUDED.mode,
           paused = EXCLUDED.paused,
           "updatedAt" = NOW()
         RETURNING "creatorId", mode, paused, "takeoverByUserId", "takeoverAt", "updatedAt"`,
        [creator.id, nextMode, nextPaused]
      );

      const globalFlags = await getAiFlags();
      return res.json(toSettingsPayload(upserted.rows[0], globalFlags));
    } catch (err) {
      console.error('Patch AI creator settings error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/creators/:id/profile',
  authenticate,
  requirePermission('ai.suggest.use', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const creator = await requireAccessibleCreator(req, res);
      if (!creator) return;
      return res.json(await getCreatorProfile(creator.id));
    } catch (err) {
      console.error('Get AI creator profile error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put(
  '/creators/:id/profile',
  authenticate,
  requirePermission('ai.settings.manage'),
  async (req, res) => {
    try {
      const creator = await requireAccessibleCreator(req, res);
      if (!creator) return;
      return res.json(
        await upsertCreatorProfile(creator.id, req.body || {}, req.user.id)
      );
    } catch (err) {
      console.error('Put AI creator profile error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

function memoryRequestKey(req) {
  const platform = String(req.query.platform || '').trim();
  const platformFanId = String(req.params.fanId || '').trim();
  return { platform, platformFanId };
}

router.get(
  '/creators/:id/fans/:fanId/memory',
  authenticate,
  requirePermission('ai.suggest.use', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const creator = await requireAccessibleCreator(req, res);
      if (!creator) return;

      const { platform, platformFanId } = memoryRequestKey(req);
      if (!MEMORY_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
      }
      if (!platformFanId) {
        return res.status(400).json({ error: 'fanId is required' });
      }

      return res.json(
        await getFanMemory({
          creatorId: creator.id,
          platform,
          platformFanId,
        })
      );
    } catch (err) {
      console.error('Get AI fan memory error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put(
  '/creators/:id/fans/:fanId/memory',
  authenticate,
  requirePermission('ai.settings.manage'),
  async (req, res) => {
    try {
      const creator = await requireAccessibleCreator(req, res);
      if (!creator) return;

      const { platform, platformFanId } = memoryRequestKey(req);
      if (!MEMORY_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
      }
      if (!platformFanId) {
        return res.status(400).json({ error: 'fanId is required' });
      }

      const body = req.body || {};
      if (body.facts != null && !Array.isArray(body.facts)) {
        return res.status(400).json({ error: 'facts must be an array' });
      }
      if (body.nickname != null && typeof body.nickname !== 'string') {
        return res.status(400).json({ error: 'nickname must be a string' });
      }

      return res.json(
        await upsertFanMemory({
          creatorId: creator.id,
          platform,
          platformFanId,
          nickname: body.nickname,
          facts: body.facts,
        })
      );
    } catch (err) {
      console.error('Put AI fan memory error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/ingest',
  authenticate,
  requirePermission('creators.view'),
  async (req, res) => {
    try {
      const body = req.body || {};
      const creatorId = String(body.creatorId || '').trim();
      const platform = String(body.platform || '').trim();
      const platformChatId = String(body.platformChatId || '').trim();
      const platformFanId =
        body.platformFanId == null || body.platformFanId === ''
          ? null
          : String(body.platformFanId);
      const source =
        typeof body.source === 'string' && body.source.trim()
          ? body.source.trim()
          : 'poll';

      if (!isValidUuid(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID' });
      }
      if (!INGEST_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
      }
      if (!platformChatId) {
        return res.status(400).json({ error: 'platformChatId is required' });
      }
      if (!Array.isArray(body.messages)) {
        return res.status(400).json({ error: 'messages must be an array' });
      }

      const creator = await loadCreator(creatorId);
      if (!creator) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const allowed = await userCanAccessCreator(req.user, creatorId);
      if (!allowed) {
        return res.status(403).json({
          error: 'You do not have access to this creator',
        });
      }

      const fanNotes =
        typeof body.fanNotes === 'string' ? body.fanNotes : undefined;

      const result = await ingestConversation({
        creatorId,
        platform,
        platformChatId,
        platformFanId,
        fanNotes,
        source,
        messages: body.messages,
      });
      return res.json(result);
    } catch (err) {
      console.error('AI ingest error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/suggest',
  authenticate,
  requirePermission('ai.suggest.use'),
  async (req, res) => {
    try {
      const body = req.body || {};
      const creatorId = String(body.creatorId || '').trim();
      const platform = String(body.platform || '').trim();
      const platformChatId = String(body.platformChatId || '').trim();

      if (!isValidUuid(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID' });
      }
      if (!INGEST_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
      }
      if (!platformChatId) {
        return res.status(400).json({ error: 'platformChatId is required' });
      }

      const creator = await loadCreator(creatorId);
      if (!creator) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const allowed = await userCanAccessCreator(req.user, creatorId);
      if (!allowed) {
        return res.status(403).json({
          error: 'You do not have access to this creator',
        });
      }

      const result = await processManualSuggest({
        creatorId,
        platform,
        platformChatId,
        fanNotes: body.fanNotes,
        fanNickname: body.fanNickname,
        requestedByUserId: req.user.id,
      });
      return res.json(result);
    } catch (err) {
      console.error('AI suggest error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

function sendReviewError(res, err) {
  if (err instanceof ReviewError || err?.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code || undefined,
      matchedKeyword: err.matchedKeyword,
      matchedStage: err.matchedStage,
      suggestion: err.suggestion ? toSuggestionDto(err.suggestion) : undefined,
    });
  }
  return null;
}

async function isShadowCreator(creatorId) {
  const [flags, row] = await Promise.all([
    getAiFlags(),
    loadCreatorSettings(creatorId),
  ]);
  const effective = resolveEffectiveAiMode({
    global: flags,
    creator: row || defaultCreatorAiSettings(),
  });
  return effective === MODES.SHADOW;
}

async function requireSuggestionAccess(req, res, suggestionId) {
  if (!isValidUuid(suggestionId)) {
    res.status(400).json({ error: 'Invalid suggestion ID' });
    return null;
  }

  const suggestion = await getSuggestionById(suggestionId);
  if (!suggestion) {
    res.status(404).json({ error: 'Suggestion not found' });
    return null;
  }

  const allowed = await userCanAccessCreator(req.user, suggestion.creatorId);
  if (!allowed) {
    res.status(403).json({
      error: 'You do not have access to this creator',
    });
    return null;
  }

  return suggestion;
}

async function requireConversationAccess(req, res, conversationId) {
  if (!isValidUuid(conversationId)) {
    res.status(400).json({ error: 'Invalid conversation ID' });
    return null;
  }

  const found = await pool.query(
    `SELECT id, "creatorId", platform, "platformChatId"
     FROM ai_conversations
     WHERE id = $1`,
    [conversationId]
  );
  const conversation = found.rows[0];
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return null;
  }

  const allowed = await userCanAccessCreator(req.user, conversation.creatorId);
  if (!allowed) {
    res.status(403).json({
      error: 'You do not have access to this creator',
    });
    return null;
  }

  return conversation;
}

router.get(
  '/conversations/:id/suggestion',
  authenticate,
  requirePermission('ai.suggest.use'),
  async (req, res) => {
    try {
      const conversation = await requireConversationAccess(req, res, req.params.id);
      if (!conversation) return;
      if (await isShadowCreator(conversation.creatorId)) {
        return res.json({ suggestion: null });
      }
      const row = await getPendingSuggestion(conversation.id);
      return res.json({ suggestion: toSuggestionDto(row) });
    } catch (err) {
      console.error('Get AI conversation suggestion error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/suggestion',
  authenticate,
  requirePermission('ai.suggest.use'),
  async (req, res) => {
    try {
      const creatorId = String(req.query.creatorId || '').trim();
      const platform = String(req.query.platform || '').trim();
      const platformChatId = String(req.query.platformChatId || '').trim();

      if (!isValidUuid(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID' });
      }
      if (!INGEST_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
      }
      if (!platformChatId) {
        return res.status(400).json({ error: 'platformChatId is required' });
      }

      const creator = await loadCreator(creatorId);
      if (!creator) {
        return res.status(404).json({ error: 'Creator not found' });
      }

      const allowed = await userCanAccessCreator(req.user, creatorId);
      if (!allowed) {
        return res.status(403).json({
          error: 'You do not have access to this creator',
        });
      }

      if (await isShadowCreator(creatorId)) {
        return res.json({ suggestion: null });
      }

      const row = await getPendingSuggestionByChat({
        creatorId,
        platform,
        platformChatId,
      });
      return res.json({ suggestion: toSuggestionDto(row) });
    } catch (err) {
      console.error('Get AI suggestion by chat error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/suggestions/:id/approve',
  authenticate,
  requirePermission('ai.suggest.use'),
  async (req, res) => {
    try {
      const suggestion = await requireSuggestionAccess(req, res, req.params.id);
      if (!suggestion) return;

      const result = await executeApprovedSend({
        suggestionId: suggestion.id,
        user: req.user,
        edited: false,
      });
      return res.json({
        suggestion: toSuggestionDto(result.suggestion),
        messageId: result.messageId,
      });
    } catch (err) {
      if (sendReviewError(res, err)) return;
      console.error('AI suggestion approve error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/suggestions/:id/edit-send',
  authenticate,
  requirePermission('ai.suggest.use'),
  async (req, res) => {
    try {
      const suggestion = await requireSuggestionAccess(req, res, req.params.id);
      if (!suggestion) return;

      const text = String(req.body?.text || '').trim();
      if (!text) {
        return res.status(400).json({ error: 'text is required' });
      }
      const englishText =
        req.body?.englishText == null ? undefined : String(req.body.englishText);

      const result = await executeApprovedSend({
        suggestionId: suggestion.id,
        text,
        englishText,
        user: req.user,
        edited: true,
      });
      return res.json({
        suggestion: toSuggestionDto(result.suggestion),
        messageId: result.messageId,
      });
    } catch (err) {
      if (sendReviewError(res, err)) return;
      console.error('AI suggestion edit-send error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/suggestions/:id/reject',
  authenticate,
  requirePermission('ai.suggest.use'),
  async (req, res) => {
    try {
      const suggestion = await requireSuggestionAccess(req, res, req.params.id);
      if (!suggestion) return;

      if (suggestion.status !== SUGGESTION_STATUSES.PENDING) {
        return res.status(409).json({
          error: 'not_pending',
          code: 'not_pending',
        });
      }

      const updated = await updateSuggestionStatus(suggestion.id, {
        status: SUGGESTION_STATUSES.REJECTED,
        reviewedBy: req.user.id,
        reviewedAt: new Date().toISOString(),
      });
      await emitSuggestionEvent(updated, { mode: null });
      return res.json({ suggestion: toSuggestionDto(updated) });
    } catch (err) {
      console.error('AI suggestion reject error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/suggestions/:id/regenerate',
  authenticate,
  requirePermission('ai.suggest.use'),
  async (req, res) => {
    try {
      const suggestion = await requireSuggestionAccess(req, res, req.params.id);
      if (!suggestion) return;

      const result = await processManualSuggest({
        creatorId: suggestion.creatorId,
        platform: suggestion.platform,
        platformChatId: suggestion.platformChatId,
        requestedByUserId: req.user.id,
      });
      return res.json(result);
    } catch (err) {
      console.error('AI suggestion regenerate error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/conversations/:id/takeover',
  authenticate,
  requirePermission('ai.moderate', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const conversation = await requireConversationAccess(req, res, req.params.id);
      if (!conversation) return;
      const updated = await takeoverConversation({
        conversationId: conversation.id,
        userId: req.user.id,
      });
      return res.json({ conversation: updated });
    } catch (err) {
      console.error('AI conversation takeover error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/conversations/:id/resume',
  authenticate,
  requirePermission('ai.moderate', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const conversation = await requireConversationAccess(req, res, req.params.id);
      if (!conversation) return;
      const updated = await resumeConversation({
        conversationId: conversation.id,
      });
      return res.json({ conversation: updated });
    } catch (err) {
      console.error('AI conversation resume error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/conversations/:id/pause',
  authenticate,
  requirePermission('ai.moderate', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const conversation = await requireConversationAccess(req, res, req.params.id);
      if (!conversation) return;
      const updated = await pauseConversation({
        conversationId: conversation.id,
      });
      return res.json({ conversation: updated });
    } catch (err) {
      console.error('AI conversation pause error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/conversation',
  authenticate,
  requirePermission('ai.moderate', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const creatorId = String(req.query.creatorId || '').trim();
      const platform = String(req.query.platform || '').trim();
      const platformChatId = String(req.query.platformChatId || '').trim();
      if (!isValidUuid(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID' });
      }
      if (!INGEST_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
      }
      if (!platformChatId) {
        return res.status(400).json({ error: 'platformChatId is required' });
      }
      const allowed = await userCanAccessCreator(req.user, creatorId);
      if (!allowed) {
        return res.status(403).json({
          error: 'You do not have access to this creator',
        });
      }
      const conversation = await getConversationByChat({
        creatorId,
        platform,
        platformChatId,
      });
      return res.json({ conversation });
    } catch (err) {
      console.error('Get AI conversation by chat error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/conversations/ignore',
  authenticate,
  requirePermission('ai.moderate', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const creatorId = String(req.body?.creatorId || '').trim();
      const platform = String(req.body?.platform || '').trim();
      const platformChatId = String(req.body?.platformChatId || '').trim();
      if (!isValidUuid(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID' });
      }
      if (!INGEST_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
      }
      if (!platformChatId) {
        return res.status(400).json({ error: 'platformChatId is required' });
      }
      const allowed = await userCanAccessCreator(req.user, creatorId);
      if (!allowed) {
        return res.status(403).json({
          error: 'You do not have access to this creator',
        });
      }
      const updated = await ignoreConversationByChat({
        creatorId,
        platform,
        platformChatId,
        userId: req.user.id,
      });
      return res.json({ conversation: updated });
    } catch (err) {
      console.error('AI conversation ignore-by-chat error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/conversations/:id/ignore',
  authenticate,
  requirePermission('ai.moderate', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const conversation = await requireConversationAccess(req, res, req.params.id);
      if (!conversation) return;
      const updated = await ignoreConversation({
        conversationId: conversation.id,
        userId: req.user.id,
      });
      return res.json({ conversation: updated });
    } catch (err) {
      console.error('AI conversation ignore error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/conversations/:id/unignore',
  authenticate,
  requirePermission('ai.moderate', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const conversation = await requireConversationAccess(req, res, req.params.id);
      if (!conversation) return;
      const updated = await unignoreConversation({
        conversationId: conversation.id,
      });
      return res.json({ conversation: updated });
    } catch (err) {
      console.error('AI conversation unignore error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/queue',
  authenticate,
  requirePermission('ai.moderate', 'ai.settings.manage'),
  async (req, res) => {
    try {
      const bucket = String(req.query.bucket || '').trim();
      if (bucket && !QUEUE_BUCKET_VALUES.includes(bucket)) {
        return res.status(400).json({ error: 'Invalid bucket' });
      }

      const creatorId = String(req.query.creatorId || '').trim();
      if (creatorId && !isValidUuid(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID' });
      }
      if (creatorId) {
        const allowed = await userCanAccessCreator(req.user, creatorId);
        if (!allowed) {
          return res.status(403).json({
            error: 'You do not have access to this creator',
          });
        }
      }

      const platform = String(req.query.platform || '').trim();
      if (platform && !INGEST_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
      }

      const state = String(req.query.state || '').trim();
      if (state && !CONVERSATION_STATE_VALUES.includes(state)) {
        return res.status(400).json({ error: 'Invalid state' });
      }

      const result = await listQueue({
        bucket: bucket || null,
        state: state || null,
        creatorId: creatorId || null,
        platform: platform || null,
        user: req.user,
        limit: req.query.limit,
      });
      return res.json(result);
    } catch (err) {
      console.error('Get AI queue error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/metrics',
  authenticate,
  requirePermission('ai.settings.manage'),
  async (req, res) => {
    try {
      const creatorId = String(req.query.creatorId || '').trim();
      if (creatorId && !isValidUuid(creatorId)) {
        return res.status(400).json({ error: 'Invalid creator ID' });
      }
      if (creatorId) {
        const allowed = await userCanAccessCreator(req.user, creatorId);
        if (!allowed) {
          return res.status(403).json({
            error: 'You do not have access to this creator',
          });
        }
      }

      const metrics = await summarizeUsage({
        from: req.query.from || null,
        to: req.query.to || null,
        creatorId: creatorId || null,
      });
      return res.json(metrics);
    } catch (err) {
      console.error('Get AI metrics error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

function sendBrainError(res, err) {
  if (!(err instanceof BrainError)) return false;
  return res.status(err.status).json({
    error: err.message,
    code: err.code,
  });
}

function sendSopImportError(res, err) {
  if (!(err instanceof SopImportError)) return false;
  return res.status(err.status).json({
    error: err.message,
    code: err.code,
  });
}

router.get(
  '/rules/suggestions',
  authenticate,
  requirePermission('ai.rules.manage'),
  async (req, res) => {
    try {
      const status = String(req.query.status || 'pending').trim();
      const suggestions = await listRuleSuggestions({ status });
      return res.json({ suggestions });
    } catch (err) {
      console.error('List AI rule suggestions error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/rules',
  authenticate,
  requirePermission('ai.rules.manage'),
  async (req, res) => {
    try {
      const rules = await listApprovedRules();
      return res.json({ rules });
    } catch (err) {
      console.error('List AI rules error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/rules/suggestions/:id/approve',
  authenticate,
  requirePermission('ai.rules.manage'),
  async (req, res) => {
    try {
      if (!isValidUuid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid suggestion ID' });
      }
      const rule = await approveRuleSuggestion(req.params.id, {
        scope: req.body?.scope,
        text: req.body?.text,
        user: req.user,
      });
      return res.json({ rule });
    } catch (err) {
      if (sendBrainError(res, err)) return;
      console.error('Approve AI rule suggestion error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/rules/suggestions/:id/reject',
  authenticate,
  requirePermission('ai.rules.manage'),
  async (req, res) => {
    try {
      if (!isValidUuid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid suggestion ID' });
      }
      const suggestion = await rejectRuleSuggestion(req.params.id, req.user);
      return res.json({ suggestion });
    } catch (err) {
      if (sendBrainError(res, err)) return;
      console.error('Reject AI rule suggestion error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/sops/import',
  authenticate,
  requirePermission('ai.rules.manage'),
  async (req, res) => {
    try {
      const draft = await importSopGuide({
        rawText: req.body?.rawText,
        creatorId: req.body?.creatorId,
        documentType: req.body?.documentType,
        user: req.user,
      });
      return res.status(201).json({ draft });
    } catch (err) {
      if (sendSopImportError(res, err)) return;
      console.error('Import SOP guide error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/sops/import/:id',
  authenticate,
  requirePermission('ai.rules.manage'),
  async (req, res) => {
    try {
      const draft = await getSopImportDraft(req.params.id);
      return res.json({ draft });
    } catch (err) {
      if (sendSopImportError(res, err)) return;
      console.error('Get SOP import draft error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/sops/import/:id/approve',
  authenticate,
  requirePermission('ai.rules.manage'),
  async (req, res) => {
    try {
      const result = await approveSopImport(req.params.id, {
        proposedJson: req.body?.proposedJson,
        overlapResolutions: req.body?.overlapResolutions,
        user: req.user,
      });
      return res.json(result);
    } catch (err) {
      if (sendSopImportError(res, err)) return;
      console.error('Approve SOP import error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/sops/import/:id/reject',
  authenticate,
  requirePermission('ai.rules.manage'),
  async (req, res) => {
    try {
      const draft = await rejectSopImport(req.params.id, { user: req.user });
      return res.json({ draft });
    } catch (err) {
      if (sendSopImportError(res, err)) return;
      console.error('Reject SOP import error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
