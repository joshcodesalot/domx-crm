const pool = require('../../../db/pool');
const { RULE_SCOPES, isRuleScope } = require('../contracts');

const RULE_SUGGESTION_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

const APPROVED_RULE_LIMIT = 20;
const MAX_RULE_TEXT = 500;

class BrainError extends Error {
  constructor(status, message, extras = {}) {
    super(message);
    this.status = status;
    this.code = extras.code || message;
  }
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function hasMeaningfulDiff(before, after) {
  const left = asText(before).trim();
  const right = asText(after).trim();
  return Boolean(right) && left !== right;
}

function buildProposedRule(before, after) {
  return `Prefer: ${asText(after).trim()}`.slice(0, MAX_RULE_TEXT);
}

function normalizeRules(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const scope = isRuleScope(item.scope) ? item.scope : null;
    const text = asText(item.text).trim().slice(0, MAX_RULE_TEXT);
    if (!scope || !text) continue;
    out.push({ scope, text });
    if (out.length >= APPROVED_RULE_LIMIT) break;
  }
  return out;
}

function toSuggestionDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    suggestionId: row.suggestionId || null,
    conversationId: row.conversationId || null,
    creatorId: row.creatorId || null,
    platform: row.platform || null,
    platformFanId: row.platformFanId || null,
    beforeText: row.beforeText || '',
    afterText: row.afterText || '',
    proposedRule: row.proposedRule || '',
    proposedScope: row.proposedScope || RULE_SCOPES.CREATOR,
    status: row.status,
    createdBy: row.createdBy || null,
    reviewedBy: row.reviewedBy || null,
    reviewedAt: row.reviewedAt || null,
    createdAt: row.createdAt || null,
  };
}

function toRuleDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    creatorId: row.creatorId || null,
    platform: row.platform || null,
    platformFanId: row.platformFanId || null,
    text: row.text || '',
    sourceSuggestionId: row.sourceSuggestionId || null,
    approvedBy: row.approvedBy || null,
    approvedAt: row.approvedAt || null,
    active: row.active !== false,
    createdAt: row.createdAt || null,
  };
}

function scopeFields(scope, source = {}) {
  if (scope === RULE_SCOPES.GLOBAL) {
    return { creatorId: null, platform: null, platformFanId: null };
  }
  if (scope === RULE_SCOPES.PLATFORM) {
    return {
      creatorId: null,
      platform: source.platform || null,
      platformFanId: null,
    };
  }
  if (scope === RULE_SCOPES.CREATOR) {
    return {
      creatorId: source.creatorId || null,
      platform: source.platform || null,
      platformFanId: null,
    };
  }
  return {
    creatorId: source.creatorId || null,
    platform: source.platform || null,
    platformFanId: source.platformFanId || null,
  };
}

function assertScopeKeys(scope, fields) {
  if (scope === RULE_SCOPES.GLOBAL) return;
  if (scope === RULE_SCOPES.PLATFORM && fields.platform) return;
  if (scope === RULE_SCOPES.CREATOR && fields.creatorId && fields.platform) return;
  if (scope === RULE_SCOPES.FAN && fields.creatorId && fields.platform && fields.platformFanId) {
    return;
  }
  throw new BrainError(400, 'Invalid scope fields', { code: 'invalid_scope' });
}

async function maybeSuggestRuleFromEdit(
  {
    suggestion,
    conversation,
    beforeText,
    afterText,
    createdBy,
  } = {},
  client = pool
) {
  if (!hasMeaningfulDiff(beforeText, afterText)) return null;
  const creatorId = suggestion?.creatorId || conversation?.creatorId || null;
  const platform = suggestion?.platform || conversation?.platform || null;
  if (!creatorId || !platform) return null;

  const result = await client.query(
    `INSERT INTO ai_rule_suggestions (
       "suggestionId", "conversationId", "creatorId", platform, "platformFanId",
       "beforeText", "afterText", "proposedRule", "proposedScope",
       status, "createdBy"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT ("suggestionId") DO NOTHING
     RETURNING *`,
    [
      suggestion?.id || null,
      suggestion?.conversationId || conversation?.id || null,
      creatorId,
      platform,
      conversation?.platformFanId || suggestion?.platformFanId || null,
      asText(beforeText).trim(),
      asText(afterText).trim(),
      buildProposedRule(beforeText, afterText),
      RULE_SCOPES.CREATOR,
      RULE_SUGGESTION_STATUSES.PENDING,
      createdBy || null,
    ]
  );
  return toSuggestionDto(result.rows[0] || null);
}

async function listRuleSuggestions({ status } = {}, client = pool) {
  const wanted = String(status || RULE_SUGGESTION_STATUSES.PENDING).trim();
  const result = await client.query(
    `SELECT * FROM ai_rule_suggestions
     WHERE status = $1
     ORDER BY "createdAt" DESC
     LIMIT 100`,
    [wanted]
  );
  return result.rows.map(toSuggestionDto);
}

async function listApprovedRules(client = pool) {
  const result = await client.query(
    `SELECT * FROM ai_rules
     WHERE active = true
     ORDER BY "approvedAt" DESC
     LIMIT 100`
  );
  return result.rows.map(toRuleDto);
}

async function getRuleSuggestionById(id, client = pool) {
  const result = await client.query(
    `SELECT * FROM ai_rule_suggestions WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function approveRuleSuggestion(
  id,
  { scope, text, user } = {},
  client = pool
) {
  const row = await getRuleSuggestionById(id, client);
  if (!row) throw new BrainError(404, 'Rule suggestion not found');
  if (row.status !== RULE_SUGGESTION_STATUSES.PENDING) {
    throw new BrainError(409, 'not_pending', { code: 'not_pending' });
  }

  const nextScope = isRuleScope(scope) ? scope : row.proposedScope;
  if (!isRuleScope(nextScope)) {
    throw new BrainError(400, 'Invalid scope', { code: 'invalid_scope' });
  }
  const fields = scopeFields(nextScope, row);
  assertScopeKeys(nextScope, fields);

  const ruleText = asText(text).trim() || asText(row.proposedRule).trim();
  if (!ruleText) {
    throw new BrainError(400, 'Rule text is required');
  }

  const inserted = await insertApprovedRule(
    {
      scope: nextScope,
      text: ruleText,
      creatorId: fields.creatorId,
      platform: fields.platform,
      platformFanId: fields.platformFanId,
      sourceSuggestionId: row.id,
      approvedBy: user?.id || null,
    },
    client
  );

  await client.query(
    `UPDATE ai_rule_suggestions
     SET status = $2, "reviewedBy" = $3, "reviewedAt" = NOW()
     WHERE id = $1`,
    [row.id, RULE_SUGGESTION_STATUSES.APPROVED, user?.id || null]
  );

  return inserted;
}

async function insertApprovedRule(
  {
    scope,
    text,
    creatorId,
    platform,
    platformFanId,
    sourceSuggestionId,
    approvedBy,
  } = {},
  client = pool
) {
  if (!isRuleScope(scope)) {
    throw new BrainError(400, 'Invalid scope', { code: 'invalid_scope' });
  }
  const fields = scopeFields(scope, { creatorId, platform, platformFanId });
  assertScopeKeys(scope, fields);
  const ruleText = asText(text).trim();
  if (!ruleText) {
    throw new BrainError(400, 'Rule text is required');
  }

  const inserted = await client.query(
    `INSERT INTO ai_rules (
       scope, "creatorId", platform, "platformFanId", text,
       "sourceSuggestionId", "approvedBy", "approvedAt", active
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), true)
     RETURNING *`,
    [
      scope,
      fields.creatorId,
      fields.platform,
      fields.platformFanId,
      ruleText.slice(0, MAX_RULE_TEXT),
      sourceSuggestionId || null,
      approvedBy || null,
    ]
  );
  return toRuleDto(inserted.rows[0]);
}

async function rejectRuleSuggestion(id, user, client = pool) {
  const row = await getRuleSuggestionById(id, client);
  if (!row) throw new BrainError(404, 'Rule suggestion not found');
  if (row.status !== RULE_SUGGESTION_STATUSES.PENDING) {
    throw new BrainError(409, 'not_pending', { code: 'not_pending' });
  }
  const updated = await client.query(
    `UPDATE ai_rule_suggestions
     SET status = $2, "reviewedBy" = $3, "reviewedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [row.id, RULE_SUGGESTION_STATUSES.REJECTED, user?.id || null]
  );
  return toSuggestionDto(updated.rows[0]);
}

async function loadApprovedRules(
  { creatorId, platform, platformFanId } = {},
  client = pool
) {
  try {
    const result = await client.query(
      `SELECT scope, text
       FROM ai_rules
       WHERE active = true
         AND (
           scope = 'GLOBAL'
           OR (scope = 'PLATFORM' AND platform = $1)
           OR (scope = 'CREATOR' AND "creatorId" = $2 AND platform = $1)
           OR (
             scope = 'FAN'
             AND "creatorId" = $2
             AND platform = $1
             AND "platformFanId" = $3
           )
         )
       ORDER BY
         CASE scope
           WHEN 'FAN' THEN 0
           WHEN 'CREATOR' THEN 1
           WHEN 'PLATFORM' THEN 2
           ELSE 3
         END,
         "approvedAt" DESC
       LIMIT ${APPROVED_RULE_LIMIT}`,
      [
        String(platform || '').trim() || null,
        String(creatorId || '').trim() || null,
        String(platformFanId || '').trim() || null,
      ]
    );
    return normalizeRules(result.rows);
  } catch (err) {
    console.error('AI approved rules load error:', err);
    return [];
  }
}

module.exports = {
  RULE_SUGGESTION_STATUSES,
  APPROVED_RULE_LIMIT,
  MAX_RULE_TEXT,
  BrainError,
  hasMeaningfulDiff,
  buildProposedRule,
  normalizeRules,
  scopeFields,
  maybeSuggestRuleFromEdit,
  listRuleSuggestions,
  listApprovedRules,
  approveRuleSuggestion,
  rejectRuleSuggestion,
  loadApprovedRules,
  insertApprovedRule,
  toSuggestionDto,
  toRuleDto,
};
