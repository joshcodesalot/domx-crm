const pool = require('../../../db/pool');
const xaiClient = require('../providers/xaiClient');
const { extractJsonObject } = require('../providers/jsonExtract');
const { withTimeout } = require('../generation/generateReply');
const { getCreatorProfile, mergeCreatorProfile } = require('../profile');
const { RULE_SCOPES } = require('../contracts');
const {
  BrainError,
  MAX_RULE_TEXT,
  insertApprovedRule,
  listApprovedRules,
} = require('./rules');

const SOP_SCOPES = {
  GLOBAL: 'GLOBAL',
  CREATOR: 'CREATOR',
};

const DOCUMENT_TYPES = {
  SOP: 'sop',
  INFOSHEET: 'infosheet',
};

const IMPORT_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

const OVERLAP_SEVERITIES = new Set(['duplicate', 'conflict', 'related']);
const OVERLAP_SUGGESTIONS = new Set([
  'keep_new',
  'keep_existing',
  'merge',
  'human_decide',
]);

const MAX_RAW_TEXT = 80000;
const MAX_MODEL_TEXT = 24000;
const MAX_SOP_CONTEXT = 8;
/** Truncate each SOP body sent into generate context (not the stored body). */
const MAX_SOP_CONTEXT_BODY = 4000;
const OVERLAP_EXCERPT = 400;
const STRUCTURE_TIMEOUT_MS = 45000;
const OVERLAP_TIMEOUT_MS = 30000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROPOSED_SHAPE = `{
  "documentType": "sop" or "infosheet",
  "sops": [{ "title": "string", "body": "string", "scope": "GLOBAL" or "CREATOR", "creatorId": null }],
  "profilePatch": {
    "persona": "string",
    "tone": "string",
    "languages": ["string"],
    "biography": "string",
    "preferredTerminology": {},
    "prohibitedClaims": ["string"],
    "salesStyle": "string",
    "instructions": "string"
  } or null,
  "shortRules": [{ "text": "string", "scope": "GLOBAL" or "CREATOR" }]
}`;

const SOP_STRUCTURE_PROMPT = `You extract chatting process SOPs from a pasted CRM/Notion guide.
Return JSON only (no markdown, no explanation) with this exact shape:
${PROPOSED_SHAPE}
Rules:
- Set documentType to "sop".
- Extract titled process guides: Tone, Chatting, Objections, Upsell, Price ladder STYLE.
- Do not invent prices, media IDs, ages, kinks, cities, or account secrets.
- Do not include passwords, tokens, cookies, or API keys.
- shortRules must be concise (max 500 characters).
- SOP bodies can be long; keep them faithful to the source.
- If a section is missing, omit it rather than inventing.
- Use CREATOR scope only when the guide is clearly for one creator; otherwise GLOBAL.`.trim();

const INFOSHEET_STRUCTURE_PROMPT = `You extract a per-creator identity infosheet from pasted CRM/Notion notes.
Return JSON only (no markdown, no explanation) with this exact shape:
${PROPOSED_SHAPE}
Rules:
- Set documentType to "infosheet".
- Map identity/facts into profilePatch (persona, tone, languages, biography, terminology, claims, salesStyle, instructions).
- Optional CREATOR-scoped SOP only if the paste includes process for that creator. Do not emit a GLOBAL tone/process SOP.
- Do not invent age, kinks, prices, cities, media IDs, or facts not in the paste.
- Do not include passwords, tokens, cookies, or API keys.
- shortRules max 500 characters; omit unless the paste states a hard rule.`.trim();

const AUTO_STRUCTURE_PROMPT = `You classify a pasted CRM/Notion document then extract CRM-shaped drafts.
Return JSON only (no markdown, no explanation) with this exact shape:
${PROPOSED_SHAPE}
Classification:
- documentType "infosheet" if it is identity/facts about one model (bio, city, languages, presence).
- documentType "sop" if it is a process guide (Tone, Chatting, Objections, Upsell, Price ladder).
Rules:
- Infosheet: fill profilePatch; do not emit a GLOBAL tone SOP unless the paste is clearly also a process guide.
- SOP: titled sops for process sections.
- Do not invent prices, media IDs, ages, kinks, cities, or secrets not in the paste.
- shortRules max 500 characters.`.trim();

const OVERLAP_PROMPT = `You compare a proposed CRM import against an existing catalog.
Return JSON only (no markdown) with this exact shape:
{
  "overlaps": [
    {
      "severity": "duplicate" or "conflict" or "related",
      "newItem": "title or field",
      "existingItem": "existing SOP title / rule id / profile field",
      "existingId": "uuid or profile:biography",
      "summary": "one sentence",
      "suggestion": "keep_new" or "keep_existing" or "merge" or "human_decide"
    }
  ]
}
Rules:
- duplicate: same instruction (e.g. two “don’t say would you like”).
- conflict: opposite instruction (e.g. “use baby” vs “never baby”). Complementary tone vs “soften if disengaged” is related, not conflict.
- related: same topic, complementary (tone vs infosheet persona).
- Do not flag infosheet biography vs global tone as duplicate.
- Do not invent extra overlaps. Empty overlaps is valid.
- Use existingId from the catalog exactly.`.trim();

class SopImportError extends Error {
  constructor(status, message, extras = {}) {
    super(message);
    this.status = status;
    this.code = extras.code || message;
  }
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function isValidUuid(value) {
  return UUID_RE.test(String(value || ''));
}

function isSopScope(value) {
  return value === SOP_SCOPES.GLOBAL || value === SOP_SCOPES.CREATOR;
}

function isDocumentType(value) {
  return value === DOCUMENT_TYPES.SOP || value === DOCUMENT_TYPES.INFOSHEET;
}

function normalizeRequestedType(value) {
  const raw = asText(value).trim().toLowerCase();
  if (raw === DOCUMENT_TYPES.SOP || raw === DOCUMENT_TYPES.INFOSHEET) return raw;
  return 'auto';
}

function excerpt(value) {
  return asText(value).trim().slice(0, OVERLAP_EXCERPT);
}

function emptyProposedJson() {
  return {
    documentType: DOCUMENT_TYPES.SOP,
    sops: [],
    profilePatch: null,
    shortRules: [],
  };
}

function emptyOverlapJson() {
  return { overlaps: [] };
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => asText(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function asPlainObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeProfilePatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(raw, 'persona')) {
    patch.persona = asText(raw.persona);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'tone')) {
    patch.tone = asText(raw.tone);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'languages')) {
    patch.languages = asStringList(raw.languages);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'biography')) {
    patch.biography = asText(raw.biography);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'preferredTerminology')) {
    patch.preferredTerminology = asPlainObject(raw.preferredTerminology);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'salesStyle')) {
    patch.salesStyle = asText(raw.salesStyle);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'instructions')) {
    patch.instructions = asText(raw.instructions);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'prohibitedClaims')) {
    patch.prohibitedClaims = asStringList(raw.prohibitedClaims);
  }
  return Object.keys(patch).length ? patch : null;
}

function normalizeProposedJson(raw, creatorId = null, requestedType = 'auto') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  let documentType = isDocumentType(raw.documentType)
    ? raw.documentType
    : requestedType === 'auto'
      ? DOCUMENT_TYPES.SOP
      : requestedType;
  if (!isDocumentType(documentType)) documentType = DOCUMENT_TYPES.SOP;
  if (requestedType === DOCUMENT_TYPES.SOP || requestedType === DOCUMENT_TYPES.INFOSHEET) {
    documentType = requestedType;
  }

  const sops = [];
  for (const item of Array.isArray(raw.sops) ? raw.sops : []) {
    if (!item || typeof item !== 'object') continue;
    const title = asText(item.title).trim();
    const body = asText(item.body).trim();
    if (!title || !body) continue;
    let scope = isSopScope(item.scope) ? item.scope : SOP_SCOPES.GLOBAL;
    if (documentType === DOCUMENT_TYPES.INFOSHEET && scope === SOP_SCOPES.GLOBAL) {
      continue;
    }
    const next = {
      title,
      body,
      scope,
      creatorId: null,
    };
    if (scope === SOP_SCOPES.CREATOR) {
      const stamped =
        (isValidUuid(item.creatorId) && item.creatorId) || creatorId || null;
      if (!stamped) continue;
      next.creatorId = stamped;
    }
    sops.push(next);
  }

  const shortRules = [];
  for (const item of Array.isArray(raw.shortRules) ? raw.shortRules : []) {
    if (!item || typeof item !== 'object') continue;
    const text = asText(item.text).trim().slice(0, MAX_RULE_TEXT);
    if (!text) continue;
    const scope =
      item.scope === SOP_SCOPES.CREATOR
        ? SOP_SCOPES.CREATOR
        : SOP_SCOPES.GLOBAL;
    shortRules.push({ text, scope });
  }

  return {
    documentType,
    sops,
    profilePatch: normalizeProfilePatch(raw.profilePatch),
    shortRules,
  };
}

function normalizeOverlapJson(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const overlaps = [];
  for (const item of Array.isArray(raw.overlaps) ? raw.overlaps : []) {
    if (!item || typeof item !== 'object') continue;
    const severity = OVERLAP_SEVERITIES.has(item.severity)
      ? item.severity
      : null;
    const suggestion = OVERLAP_SUGGESTIONS.has(item.suggestion)
      ? item.suggestion
      : 'human_decide';
    const newItem = asText(item.newItem).trim();
    const existingItem = asText(item.existingItem).trim();
    const existingId = asText(item.existingId).trim();
    const summary = asText(item.summary).trim();
    if (!severity || !newItem || !existingId) continue;
    overlaps.push({
      severity,
      newItem,
      existingItem: existingItem || existingId,
      existingId,
      summary,
      suggestion,
    });
  }
  return { overlaps };
}

function toDraftDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    rawText: row.rawText,
    status: row.status,
    documentType: isDocumentType(row.documentType)
      ? row.documentType
      : DOCUMENT_TYPES.SOP,
    proposedJson: row.proposedJson,
    overlapJson: row.overlapJson || emptyOverlapJson(),
    creatorId: row.creatorId || null,
    createdBy: row.createdBy || null,
    reviewedBy: row.reviewedBy || null,
    reviewedAt: row.reviewedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function toSopDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    scope: row.scope,
    documentType: isDocumentType(row.documentType)
      ? row.documentType
      : DOCUMENT_TYPES.SOP,
    creatorId: row.creatorId || null,
    active: row.active !== false,
    sortOrder: Number(row.sortOrder) || 0,
    sourceDraftId: row.sourceDraftId || null,
    createdBy: row.createdBy || null,
    updatedBy: row.updatedBy || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function normalizeSopsForContext(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const scope = isSopScope(item.scope) ? item.scope : null;
    const title = asText(item.title).trim();
    const body = asText(item.body).trim().slice(0, MAX_SOP_CONTEXT_BODY);
    if (!scope || !title || !body) continue;
    out.push({ title, body, scope });
    if (out.length >= MAX_SOP_CONTEXT) break;
  }
  return out;
}

function structurePromptFor(requestedType) {
  if (requestedType === DOCUMENT_TYPES.INFOSHEET) return INFOSHEET_STRUCTURE_PROMPT;
  if (requestedType === DOCUMENT_TYPES.SOP) return SOP_STRUCTURE_PROMPT;
  return AUTO_STRUCTURE_PROMPT;
}

function buildStructureInput(rawText, requestedType) {
  return [
    { role: 'system', content: structurePromptFor(requestedType) },
    { role: 'user', content: rawText },
  ];
}

function buildOverlapInput(proposedJson, catalog) {
  return [
    { role: 'system', content: OVERLAP_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({ proposed: proposedJson, catalog }),
    },
  ];
}

async function resolveCreatorId(creatorId, client) {
  if (creatorId == null || creatorId === '') return null;
  if (!isValidUuid(creatorId)) {
    throw new SopImportError(400, 'Invalid creator ID', { code: 'invalid_creator' });
  }
  const result = await client.query(`SELECT id FROM creators WHERE id = $1`, [
    creatorId,
  ]);
  if (!result.rows[0]) {
    throw new SopImportError(404, 'Creator not found', { code: 'creator_not_found' });
  }
  return creatorId;
}

async function defaultLoadCreatorPlatform(creatorId, client) {
  if (!creatorId) return null;
  const result = await client.query(
    `SELECT platform FROM creators WHERE id = $1`,
    [creatorId]
  );
  return result.rows[0]?.platform || null;
}

async function loadOverlapCatalog(
  { creatorId, client = pool, listRules = listApprovedRules, getProfile = getCreatorProfile } = {}
) {
  const catalog = [];
  try {
    const sops = await client.query(
      `SELECT id, title, body, scope
       FROM ai_sops
       WHERE active = true
         AND (
           scope = 'GLOBAL'
           OR (scope = 'CREATOR' AND "creatorId" = $1)
         )
       ORDER BY "updatedAt" DESC
       LIMIT 40`,
      [creatorId || null]
    );
    for (const row of sops.rows) {
      catalog.push({
        kind: 'sop',
        id: row.id,
        title: row.title,
        excerpt: excerpt(row.body),
      });
    }
  } catch (err) {
    console.error('SOP overlap catalog sops error:', err);
  }

  try {
    const rules = await listRules(client);
    for (const rule of Array.isArray(rules) ? rules : []) {
      const text = asText(rule.text).trim();
      if (!text || !rule.id) continue;
      catalog.push({
        kind: 'rule',
        id: rule.id,
        title: text.slice(0, 80),
        excerpt: excerpt(text),
      });
    }
  } catch (err) {
    console.error('SOP overlap catalog rules error:', err);
  }

  if (creatorId) {
    try {
      const profile = await getProfile(creatorId, client);
      for (const field of [
        'persona',
        'tone',
        'biography',
        'salesStyle',
        'instructions',
      ]) {
        const value = asText(profile?.[field]).trim();
        if (!value) continue;
        catalog.push({
          kind: 'profile',
          id: `profile:${field}`,
          title: field,
          excerpt: excerpt(value),
        });
      }
    } catch (err) {
      console.error('SOP overlap catalog profile error:', err);
    }
  }

  return catalog;
}

async function runOverlapCheck({
  proposedJson,
  catalog,
  overlapProvider,
  timeoutMs = OVERLAP_TIMEOUT_MS,
}) {
  try {
    const response = await withTimeout(
      overlapProvider.createResponse({
        input: buildOverlapInput(proposedJson, catalog),
      }),
      timeoutMs,
      'overlap_timeout'
    );
    const parsed = extractJsonObject(response?.outputText);
    const normalized = normalizeOverlapJson(parsed);
    if (!normalized) {
      return { overlaps: [], error: 'overlap_parse_failed' };
    }
    return normalized;
  } catch (err) {
    console.error('SOP overlap check error:', err);
    return { overlaps: [], error: 'overlap_parse_failed' };
  }
}

async function importSopGuide({
  rawText,
  creatorId,
  documentType,
  user,
  provider,
  overlapProvider,
  client = pool,
  listRules,
  getProfile,
} = {}) {
  const text = asText(rawText).trim();
  if (!text) {
    throw new SopImportError(400, 'rawText is required', { code: 'raw_text_required' });
  }
  const clipped = text.slice(0, MAX_RAW_TEXT);
  const requestedType = normalizeRequestedType(documentType);
  const targetCreatorId = await resolveCreatorId(creatorId, client);

  const impl = provider || xaiClient;
  let response;
  try {
    response = await withTimeout(
      impl.createResponse({
        input: buildStructureInput(clipped.slice(0, MAX_MODEL_TEXT), requestedType),
      }),
      STRUCTURE_TIMEOUT_MS,
      'structure_timeout'
    );
  } catch (err) {
    if (err?.code === 'timeout' || err?.message === 'structure_timeout') {
      throw new SopImportError(504, 'Structure timed out', { code: 'timeout' });
    }
    throw new SopImportError(502, err?.message || 'Provider error', {
      code: 'provider_error',
    });
  }

  const parsed = extractJsonObject(response?.outputText);
  const proposedJson = normalizeProposedJson(
    parsed,
    targetCreatorId,
    requestedType
  );
  if (!proposedJson) {
    throw new SopImportError(400, 'Invalid structured JSON', {
      code: 'invalid_json',
    });
  }

  const catalog = await loadOverlapCatalog({
    creatorId: targetCreatorId,
    client,
    listRules,
    getProfile,
  });
  const overlapJson = await runOverlapCheck({
    proposedJson,
    catalog,
    overlapProvider: overlapProvider || impl,
  });

  const inserted = await client.query(
    `INSERT INTO ai_sop_import_drafts (
       "rawText", status, "proposedJson", "overlapJson", "documentType",
       "creatorId", "createdBy"
     )
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
     RETURNING *`,
    [
      clipped,
      IMPORT_STATUSES.PENDING,
      JSON.stringify(proposedJson),
      JSON.stringify(overlapJson),
      proposedJson.documentType,
      targetCreatorId,
      user?.id || null,
    ]
  );
  return toDraftDto(inserted.rows[0]);
}

async function getSopImportDraft(id, client = pool) {
  if (!isValidUuid(id)) {
    throw new SopImportError(400, 'Invalid draft ID', { code: 'invalid_id' });
  }
  const result = await client.query(
    `SELECT * FROM ai_sop_import_drafts WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    throw new SopImportError(404, 'Draft not found', { code: 'not_found' });
  }
  return toDraftDto(row);
}

function normalizeResolutions(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const existingId = asText(item.existingId).trim();
    const newItem = asText(item.newItem).trim();
    const suggestion = OVERLAP_SUGGESTIONS.has(item.suggestion)
      ? item.suggestion
      : null;
    if (!existingId || !newItem || !suggestion) continue;
    out.push({ existingId, newItem, suggestion });
  }
  return out;
}

function findResolution(resolutions, overlap) {
  return resolutions.find(
    (item) =>
      item.existingId === overlap.existingId && item.newItem === overlap.newItem
  );
}

function assertConflictsResolved(overlapJson, resolutions) {
  const overlaps = Array.isArray(overlapJson?.overlaps) ? overlapJson.overlaps : [];
  for (const overlap of overlaps) {
    if (overlap.severity !== 'conflict') continue;
    const matched = findResolution(resolutions, overlap);
    const suggestion = matched?.suggestion || overlap.suggestion;
    if (!suggestion || suggestion === 'human_decide') {
      throw new SopImportError(400, 'Unresolved conflict', {
        code: 'conflict_unresolved',
      });
    }
  }
}

function keepExistingSet(overlapJson, resolutions) {
  const skipped = new Set();
  const overlaps = Array.isArray(overlapJson?.overlaps) ? overlapJson.overlaps : [];
  for (const overlap of overlaps) {
    const matched = findResolution(resolutions, overlap);
    const suggestion = matched?.suggestion || overlap.suggestion;
    if (suggestion !== 'keep_existing') continue;
    skipped.add(overlap.newItem.trim().toLowerCase());
    skipped.add(`${overlap.existingId}::${overlap.newItem}`.toLowerCase());
  }
  return skipped;
}

function isSkipped(skipped, value) {
  if (!value) return false;
  return skipped.has(String(value).trim().toLowerCase());
}

function filterProposed(proposed, skipped) {
  const sops = proposed.sops.filter(
    (sop) => !isSkipped(skipped, sop.title) && !isSkipped(skipped, sop.body)
  );
  const shortRules = proposed.shortRules.filter(
    (rule) => !isSkipped(skipped, rule.text)
  );
  let profilePatch = proposed.profilePatch;
  if (profilePatch) {
    const next = { ...profilePatch };
    for (const key of Object.keys(next)) {
      if (isSkipped(skipped, key) || isSkipped(skipped, `profile:${key}`)) {
        delete next[key];
      }
    }
    profilePatch = Object.keys(next).length ? next : null;
  }
  return { ...proposed, sops, shortRules, profilePatch };
}

async function persistSops(draft, proposed, userId, client) {
  const written = [];
  const documentType = isDocumentType(proposed.documentType)
    ? proposed.documentType
    : draft.documentType || DOCUMENT_TYPES.SOP;
  for (const sop of proposed.sops) {
    const scope = isSopScope(sop.scope) ? sop.scope : SOP_SCOPES.GLOBAL;
    let creatorId = null;
    if (scope === SOP_SCOPES.CREATOR) {
      creatorId = sop.creatorId || draft.creatorId || null;
      if (!creatorId) continue;
    }
    const inserted = await client.query(
      `INSERT INTO ai_sops (
         title, body, scope, "creatorId", active, "sourceDraftId", "createdBy",
         "documentType", "sortOrder", "updatedBy"
       )
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, 0, $6)
       RETURNING *`,
      [
        sop.title,
        sop.body,
        scope,
        creatorId,
        draft.id,
        userId || null,
        documentType,
      ]
    );
    written.push(toSopDto(inserted.rows[0]));
  }
  return written;
}

async function persistShortRules(
  draft,
  proposed,
  userId,
  client,
  loadCreatorPlatform
) {
  const written = [];
  let platform = null;
  const needsPlatform = proposed.shortRules.some(
    (rule) => rule.scope === SOP_SCOPES.CREATOR
  );
  if (needsPlatform && draft.creatorId) {
    platform = await loadCreatorPlatform(draft.creatorId, client);
  }

  for (const rule of proposed.shortRules) {
    const scope = rule.scope === SOP_SCOPES.CREATOR ? RULE_SCOPES.CREATOR : RULE_SCOPES.GLOBAL;
    try {
      if (scope === RULE_SCOPES.CREATOR) {
        if (!draft.creatorId || !platform) continue;
        const inserted = await insertApprovedRule(
          {
            scope,
            text: rule.text,
            creatorId: draft.creatorId,
            platform,
            approvedBy: userId || null,
          },
          client
        );
        written.push(inserted);
        continue;
      }
      const inserted = await insertApprovedRule(
        {
          scope: RULE_SCOPES.GLOBAL,
          text: rule.text,
          approvedBy: userId || null,
        },
        client
      );
      written.push(inserted);
    } catch (err) {
      if (err instanceof BrainError) continue;
      throw err;
    }
  }
  return written;
}

async function approveSopImport(
  id,
  {
    proposedJson,
    overlapResolutions,
    user,
    client = pool,
    mergeProfile = mergeCreatorProfile,
    loadCreatorPlatform = defaultLoadCreatorPlatform,
  } = {}
) {
  const draft = await getSopImportDraft(id, client);
  if (draft.status !== IMPORT_STATUSES.PENDING) {
    throw new SopImportError(409, 'Draft is not pending', { code: 'not_pending' });
  }

  const source =
    proposedJson === undefined ? draft.proposedJson : proposedJson;
  const proposed = normalizeProposedJson(
    source,
    draft.creatorId,
    draft.documentType
  );
  if (!proposed) {
    throw new SopImportError(400, 'Invalid structured JSON', {
      code: 'invalid_json',
    });
  }

  const resolutions = normalizeResolutions(overlapResolutions);
  assertConflictsResolved(draft.overlapJson, resolutions);
  const skipped = keepExistingSet(draft.overlapJson, resolutions);
  const filtered = filterProposed(proposed, skipped);

  const sops = await persistSops(draft, filtered, user?.id, client);

  let profile = null;
  if (filtered.profilePatch && draft.creatorId) {
    profile = await mergeProfile(
      draft.creatorId,
      filtered.profilePatch,
      user?.id,
      client
    );
  }

  const rules = await persistShortRules(
    draft,
    filtered,
    user?.id,
    client,
    loadCreatorPlatform
  );

  const updated = await client.query(
    `UPDATE ai_sop_import_drafts
     SET status = $2,
         "proposedJson" = $3::jsonb,
         "reviewedBy" = $4,
         "reviewedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      draft.id,
      IMPORT_STATUSES.APPROVED,
      JSON.stringify(filtered),
      user?.id || null,
    ]
  );

  return {
    draft: toDraftDto(updated.rows[0]),
    sops,
    profile,
    rules,
  };
}

async function rejectSopImport(id, { user, client = pool } = {}) {
  const draft = await getSopImportDraft(id, client);
  if (draft.status !== IMPORT_STATUSES.PENDING) {
    throw new SopImportError(409, 'Draft is not pending', { code: 'not_pending' });
  }
  const updated = await client.query(
    `UPDATE ai_sop_import_drafts
     SET status = $2,
         "reviewedBy" = $3,
         "reviewedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [draft.id, IMPORT_STATUSES.REJECTED, user?.id || null]
  );
  return toDraftDto(updated.rows[0]);
}

async function loadActiveSops({ creatorId } = {}, client = pool) {
  try {
    const result = await client.query(
      `SELECT title, body, scope
       FROM ai_sops
       WHERE active = true
         AND (
           scope = 'GLOBAL'
           OR (scope = 'CREATOR' AND "creatorId" = $1)
         )
       ORDER BY
         CASE scope WHEN 'CREATOR' THEN 0 ELSE 1 END,
         "sortOrder" ASC,
         "updatedAt" DESC
       LIMIT ${MAX_SOP_CONTEXT}`,
      [creatorId || null]
    );
    return normalizeSopsForContext(result.rows);
  } catch (err) {
    console.error('AI active SOPs load error:', err);
    return [];
  }
}

async function listActiveSops(client = pool) {
  const result = await client.query(
    `SELECT id, title, body, scope, "creatorId", active, "updatedAt", "createdAt"
     FROM ai_sops
     WHERE active = true
     ORDER BY "updatedAt" DESC
     LIMIT 100`
  );
  return result.rows.map(toSopDto);
}

async function createSop(input = {}, client = pool) {
  const title = asText(input.title).trim();
  const body = asText(input.body).trim().slice(0, MAX_RAW_TEXT);
  if (!title) {
    throw new SopImportError(400, 'Title is required', { code: 'invalid_title' });
  }
  if (!body) {
    throw new SopImportError(400, 'Body is required', { code: 'invalid_body' });
  }
  if (!isSopScope(input.scope)) {
    throw new SopImportError(400, 'Invalid scope', { code: 'invalid_scope' });
  }

  let creatorId = null;
  if (input.scope === SOP_SCOPES.CREATOR) {
    creatorId = await resolveCreatorId(input.creatorId, client);
    if (!creatorId) {
      throw new SopImportError(400, 'Creator is required', { code: 'invalid_scope' });
    }
  }

  const userId = input.user?.id || null;
  const inserted = await client.query(
    `INSERT INTO ai_sops (
       title, body, scope, "creatorId", active, "sourceDraftId", "createdBy",
       "documentType", "sortOrder", "updatedBy"
     )
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, 0, $6)
     RETURNING *`,
    [title, body, input.scope, creatorId, null, userId, DOCUMENT_TYPES.SOP]
  );
  return toSopDto(inserted.rows[0]);
}

async function getSopById(id, client = pool) {
  const sopId = String(id || '').trim();
  if (!UUID_RE.test(sopId)) {
    throw new SopImportError(400, 'Invalid SOP ID', { code: 'invalid_id' });
  }
  const result = await client.query(`SELECT * FROM ai_sops WHERE id = $1`, [sopId]);
  if (!result.rows[0]) {
    throw new SopImportError(404, 'SOP not found', { code: 'not_found' });
  }
  return toSopDto(result.rows[0]);
}

async function updateSop(id, patch = {}, client = pool) {
  const sopId = String(id || '').trim();
  if (!UUID_RE.test(sopId)) {
    throw new SopImportError(400, 'Invalid SOP ID', { code: 'invalid_id' });
  }
  const existing = await client.query(`SELECT * FROM ai_sops WHERE id = $1`, [sopId]);
  const row = existing.rows[0];
  if (!row) {
    throw new SopImportError(404, 'SOP not found', { code: 'not_found' });
  }

  let nextTitle = asText(row.title).trim();
  if (patch.title != null) {
    nextTitle = asText(patch.title).trim();
    if (!nextTitle) {
      throw new SopImportError(400, 'Title is required', { code: 'invalid_title' });
    }
  }

  let nextBody = asText(row.body).trim();
  if (patch.body != null) {
    nextBody = asText(patch.body).trim();
    if (!nextBody) {
      throw new SopImportError(400, 'Body is required', { code: 'invalid_body' });
    }
  }
  nextBody = nextBody.slice(0, MAX_RAW_TEXT);

  let nextScope = row.scope;
  if (patch.scope != null) {
    if (!isSopScope(patch.scope)) {
      throw new SopImportError(400, 'Invalid scope', { code: 'invalid_scope' });
    }
    nextScope = patch.scope;
  }

  let nextCreatorId = row.creatorId || null;
  if (nextScope === SOP_SCOPES.GLOBAL) {
    nextCreatorId = null;
  } else {
    const wanted = patch.creatorId !== undefined ? patch.creatorId : nextCreatorId;
    nextCreatorId = await resolveCreatorId(wanted, client);
    if (!nextCreatorId) {
      throw new SopImportError(400, 'Creator is required', { code: 'invalid_scope' });
    }
  }

  const nextActive =
    patch.active == null ? row.active !== false : Boolean(patch.active);

  const updated = await client.query(
    `UPDATE ai_sops
     SET title = $2,
         body = $3,
         scope = $4,
         "creatorId" = $5,
         active = $6,
         "updatedBy" = $7,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      sopId,
      nextTitle,
      nextBody,
      nextScope,
      nextCreatorId,
      nextActive,
      patch.user?.id || null,
    ]
  );
  return toSopDto(updated.rows[0]);
}

async function deactivateSop(id, client = pool) {
  return updateSop(id, { active: false }, client);
}

async function deleteSop(id, client = pool) {
  const sopId = String(id || '').trim();
  if (!UUID_RE.test(sopId)) {
    throw new SopImportError(400, 'Invalid SOP ID', { code: 'invalid_id' });
  }
  const deleted = await client.query(
    `DELETE FROM ai_sops WHERE id = $1 RETURNING *`,
    [sopId]
  );
  if (!deleted.rows[0]) {
    throw new SopImportError(404, 'SOP not found', { code: 'not_found' });
  }
  return toSopDto(deleted.rows[0]);
}

module.exports = {
  SOP_SCOPES,
  DOCUMENT_TYPES,
  IMPORT_STATUSES,
  MAX_RAW_TEXT,
  MAX_MODEL_TEXT,
  MAX_SOP_CONTEXT,
  MAX_SOP_CONTEXT_BODY,
  OVERLAP_EXCERPT,
  SOP_STRUCTURE_PROMPT,
  INFOSHEET_STRUCTURE_PROMPT,
  AUTO_STRUCTURE_PROMPT,
  OVERLAP_PROMPT,
  SopImportError,
  emptyProposedJson,
  emptyOverlapJson,
  normalizeProposedJson,
  normalizeOverlapJson,
  normalizeSopsForContext,
  toDraftDto,
  importSopGuide,
  getSopImportDraft,
  approveSopImport,
  rejectSopImport,
  loadActiveSops,
  listActiveSops,
  getSopById,
  createSop,
  updateSop,
  deactivateSop,
  deleteSop,
  loadOverlapCatalog,
};
