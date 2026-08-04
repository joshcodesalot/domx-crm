const pool = require('../db/pool');
const { emitToUser, emitToUsers } = require('./userEventBus');

const VALID_ACTIONS = new Set([
  'block_warn',
  'notify_management',
  'log_for_review',
]);

const VALID_MATCH_MODES = new Set(['contains', 'whole_word']);

let rulesCache = null;
let rulesCacheAt = 0;
const RULES_CACHE_TTL_MS = 5000;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function invalidateRulesCache() {
  rulesCache = null;
  rulesCacheAt = 0;
}

function normalizeKeywords(input) {
  if (Array.isArray(input)) {
    return [
      ...new Set(
        input
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      ),
    ];
  }

  if (typeof input === 'string') {
    return [
      ...new Set(
        input
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      ),
    ];
  }

  return [];
}

function normalizeActions(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return [
    ...new Set(
      input.map((item) => String(item || '').trim()).filter((a) => VALID_ACTIONS.has(a))
    ),
  ];
}

function toRule(row) {
  const englishKeywords = Array.isArray(row.englishKeywords)
    ? row.englishKeywords
    : Array.isArray(row.keywords)
      ? row.keywords
      : [];
  const germanKeywords = Array.isArray(row.germanKeywords) ? row.germanKeywords : [];

  return {
    id: row.id,
    name: row.name || '',
    englishKeywords,
    germanKeywords,
    // Legacy combined view for older clients
    keywords: [...englishKeywords, ...germanKeywords],
    matchMode: row.matchMode || 'whole_word',
    caseSensitive: Boolean(row.caseSensitive),
    actions: Array.isArray(row.actions) ? row.actions : [],
    enabled: Boolean(row.enabled),
    createdBy: row.createdBy || null,
    updatedBy: row.updatedBy || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function keywordMatches(text, keyword, matchMode, caseSensitive) {
  if (!text || !keyword) {
    return false;
  }

  const flags = caseSensitive ? 'u' : 'iu';
  const escaped = escapeRegExp(keyword);

  if (matchMode === 'contains') {
    return new RegExp(escaped, flags).test(text);
  }

  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, flags).test(
    text
  );
}

async function loadEnabledRules() {
  const now = Date.now();
  if (rulesCache && now - rulesCacheAt < RULES_CACHE_TTL_MS) {
    return rulesCache;
  }

  const result = await pool.query(
    `SELECT id, name, keywords, "englishKeywords", "germanKeywords",
            "matchMode", "caseSensitive", actions, enabled,
            "createdBy", "updatedBy", "createdAt", "updatedAt"
     FROM keyword_rules
     WHERE enabled = TRUE
     ORDER BY "createdAt" ASC`
  );

  rulesCache = result.rows.map(toRule);
  rulesCacheAt = now;
  return rulesCache;
}

/**
 * Evaluate pre-translation (english) and post-translation (german/outbound) text.
 * @param {{ englishText?: string, germanText?: string } | string} input
 */
async function evaluate(input) {
  let englishText = '';
  let germanText = '';

  if (typeof input === 'string') {
    germanText = input;
    englishText = input;
  } else if (input && typeof input === 'object') {
    englishText = typeof input.englishText === 'string' ? input.englishText : '';
    germanText = typeof input.germanText === 'string' ? input.germanText : '';
  }

  if (!englishText.trim() && !germanText.trim()) {
    return {
      matched: false,
      matches: [],
      actions: [],
      shouldBlock: false,
      primaryKeyword: null,
      primaryStage: null,
    };
  }

  const rules = await loadEnabledRules();
  const matches = [];
  const actionSet = new Set();

  for (const rule of rules) {
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      continue;
    }

    const enList = Array.isArray(rule.englishKeywords) ? rule.englishKeywords : [];
    const deList = Array.isArray(rule.germanKeywords) ? rule.germanKeywords : [];
    if (enList.length === 0 && deList.length === 0) {
      continue;
    }

    // English keywords: pre-translation draft; fall back to outbound if english empty
    const enTarget = englishText.trim() ? englishText : germanText;
    let hit = null;

    for (const keyword of enList) {
      if (keywordMatches(enTarget, keyword, rule.matchMode, rule.caseSensitive)) {
        hit = { rule, keyword, stage: 'english' };
        break;
      }
    }

    if (!hit) {
      for (const keyword of deList) {
        if (keywordMatches(germanText, keyword, rule.matchMode, rule.caseSensitive)) {
          hit = { rule, keyword, stage: 'german' };
          break;
        }
      }
    }

    if (hit) {
      matches.push(hit);
      for (const action of rule.actions) {
        if (VALID_ACTIONS.has(action)) {
          actionSet.add(action);
        }
      }
    }
  }

  const actions = [...actionSet];
  return {
    matched: matches.length > 0,
    matches,
    actions,
    shouldBlock: actionSet.has('block_warn'),
    primaryKeyword: matches[0]?.keyword || null,
    primaryStage: matches[0]?.stage || null,
  };
}

async function getManagerUserIds() {
  const result = await pool.query(
    `SELECT id FROM users
     WHERE role IN ('owner', 'manager')
       AND status = 'active'`
  );
  return result.rows.map((row) => row.id);
}

async function recordEvent({
  ruleId,
  matchedKeyword,
  matchedStage,
  actionsTaken,
  userId,
  creatorId,
  platform,
  chatId,
  fanId,
  fanUsername,
  messageText,
  englishMessageText,
  blocked,
  notified,
}) {
  const result = await pool.query(
    `INSERT INTO moderation_events (
       "ruleId", "matchedKeyword", "matchedStage", "actionsTaken", "userId", "creatorId",
       platform, "chatId", "fanId", "fanUsername", "messageText", "englishMessageText",
       blocked, notified, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'open')
     RETURNING *`,
    [
      ruleId || null,
      matchedKeyword || '',
      matchedStage || null,
      actionsTaken || [],
      userId || null,
      creatorId || null,
      platform,
      chatId || null,
      fanId || null,
      fanUsername || null,
      typeof messageText === 'string' ? messageText : '',
      typeof englishMessageText === 'string' ? englishMessageText : '',
      Boolean(blocked),
      Boolean(notified),
    ]
  );
  return result.rows[0];
}

async function notifyManagers(payload) {
  const managerIds = await getManagerUserIds();
  if (managerIds.length === 0) {
    return;
  }
  emitToUsers(managerIds, {
    type: 'moderation:alert',
    ...payload,
  });
}

function warnChatter(userId, payload) {
  if (!userId) {
    return;
  }
  emitToUser(userId, {
    type: 'moderation:warned',
    ...payload,
  });
}

/**
 * Apply matched moderation: persist events, notify, optionally block.
 * Call before platform send. Returns { blocked, matchedKeyword, message } when blocked.
 */
async function applyModeration({
  text,
  englishText,
  germanText,
  userId,
  creatorId,
  platform,
  chatId,
  fanId,
  fanUsername,
  creatorName,
  chatterName,
}) {
  const outbound =
    typeof germanText === 'string'
      ? germanText
      : typeof text === 'string'
        ? text
        : '';
  const preTranslate =
    typeof englishText === 'string' && englishText.trim()
      ? englishText
      : outbound;

  const evaluation = await evaluate({
    englishText: preTranslate,
    germanText: outbound,
  });

  if (!evaluation.matched) {
    return { blocked: false, evaluation };
  }

  const shouldNotify = evaluation.actions.includes('notify_management');
  const shouldLog =
    evaluation.actions.includes('log_for_review') ||
    shouldNotify ||
    evaluation.shouldBlock;
  const blocked = evaluation.shouldBlock;

  let primaryEventId = null;

  if (shouldLog) {
    for (const match of evaluation.matches) {
      const eventRow = await recordEvent({
        ruleId: match.rule.id,
        matchedKeyword: match.keyword,
        matchedStage: match.stage,
        actionsTaken: match.rule.actions,
        userId,
        creatorId,
        platform,
        chatId,
        fanId,
        fanUsername,
        messageText: outbound,
        englishMessageText: preTranslate,
        blocked,
        notified: shouldNotify,
      });
      if (!primaryEventId) {
        primaryEventId = eventRow.id;
      }
    }
  }

  if (shouldNotify) {
    await notifyManagers({
      eventId: primaryEventId,
      matchedKeyword: evaluation.primaryKeyword,
      matchedStage: evaluation.primaryStage,
      chatterName: chatterName || null,
      creatorName: creatorName || null,
      platform,
      fanUsername: fanUsername || null,
      messageText: typeof outbound === 'string' ? outbound.slice(0, 280) : '',
      englishMessageText:
        typeof preTranslate === 'string' ? preTranslate.slice(0, 280) : '',
    });
  }

  if (blocked) {
    const stageLabel =
      evaluation.primaryStage === 'german' ? 'German' : 'English';
    const message = `Message blocked: prohibited ${stageLabel} word "${evaluation.primaryKeyword}".`;
    warnChatter(userId, {
      matchedKeyword: evaluation.primaryKeyword,
      matchedStage: evaluation.primaryStage,
      message,
    });
    return {
      blocked: true,
      matchedKeyword: evaluation.primaryKeyword,
      matchedStage: evaluation.primaryStage,
      message,
      evaluation,
    };
  }

  return { blocked: false, evaluation };
}

module.exports = {
  VALID_ACTIONS,
  VALID_MATCH_MODES,
  normalizeKeywords,
  normalizeActions,
  toRule,
  invalidateRulesCache,
  loadEnabledRules,
  evaluate,
  applyModeration,
  recordEvent,
  notifyManagers,
  warnChatter,
  getManagerUserIds,
  keywordMatches,
};
