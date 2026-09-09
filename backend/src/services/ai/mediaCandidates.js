const pool = require('../../db/pool');
const maloumClient = require('../maloumClient');
const fourBasedClient = require('../fourBasedClient');
const {
  loadMaloumCreator,
  loadFourBasedCreator,
} = require('../platformCreatorSession');
const { OUTPUT_ACTIONS } = require('./contracts');

const MEDIA_CANDIDATE_LIMIT = 20;
const MALOUM_FOLDER_LIMIT = 3;
const MALOUM_MEDIA_PER_FOLDER = 20;
const PLATFORMS = new Set(['maloum', '4based', 'telegram']);

const SECRET_KEYS = new Set([
  'encryptedloginpassword',
  'accesstoken',
  'refreshtoken',
  'proxy',
  'customproxy',
  'token',
  'password',
  'cookies',
  'cookie',
  'jwt',
  'previewurl',
]);

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.media)) return payload.media;
  return [];
}

function toCandidate(partial = {}) {
  const mediaId = asText(partial.mediaId).trim();
  if (!mediaId) return null;
  const source = partial.source === 'script' ? 'script' : 'vault';
  let price = null;
  if (source === 'script' && partial.price != null && partial.price !== '') {
    const n = Number(partial.price);
    if (Number.isFinite(n)) price = n;
  }
  return {
    source,
    mediaId,
    type: asText(partial.type).trim() || null,
    note: asText(partial.note).trim() || null,
    price,
    scriptId: asText(partial.scriptId).trim() || null,
    title: asText(partial.title).trim() || null,
  };
}

function sanitizeCandidateInput(item) {
  const next = {};
  for (const [key, value] of Object.entries(item)) {
    if (SECRET_KEYS.has(String(key).toLowerCase())) continue;
    next[key] = value;
  }
  return next;
}

function findCandidate(candidates, mediaId) {
  const id = asText(mediaId).trim();
  if (!id) return null;
  const list = Array.isArray(candidates) ? candidates : [];
  return list.find((item) => item && asText(item.mediaId).trim() === id) || null;
}

function bindPpvFromCandidates(output, candidates) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return output;
  }

  if (output.action !== OUTPUT_ACTIONS.SEND_PPV) {
    return {
      ...output,
      mediaId: null,
      price: null,
    };
  }

  const candidate = findCandidate(candidates, output.mediaId);
  if (!candidate) {
    return {
      ...output,
      action: OUTPUT_ACTIONS.SEND_PPV,
      mediaId: asText(output.mediaId).trim() || null,
      price: null,
      scriptId: null,
    };
  }

  let price = null;
  if (candidate.price != null && candidate.price !== '') {
    const n = Number(candidate.price);
    if (Number.isFinite(n)) price = n;
  }

  return {
    ...output,
    action: OUTPUT_ACTIONS.SEND_PPV,
    mediaId: candidate.mediaId,
    price,
    scriptId: candidate.scriptId || null,
  };
}

function normalizeMediaCandidates(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const cand = toCandidate(sanitizeCandidateInput(item));
    if (!cand || seen.has(cand.mediaId)) continue;
    seen.add(cand.mediaId);
    out.push(cand);
    if (out.length >= MEDIA_CANDIDATE_LIMIT) break;
  }
  return out;
}

function subtractSent(candidates, sentIds) {
  const sent = new Set(
    [...(sentIds || [])].map((id) => String(id || '').trim()).filter(Boolean)
  );
  if (sent.size === 0) return Array.isArray(candidates) ? candidates.slice() : [];
  return (Array.isArray(candidates) ? candidates : []).filter(
    (cand) => cand && !sent.has(cand.mediaId)
  );
}

function candidatesFromScripts(scripts, sentScriptIds) {
  const sent = new Set(
    [...(sentScriptIds || [])].map((id) => String(id || '').trim()).filter(Boolean)
  );
  const out = [];
  for (const script of Array.isArray(scripts) ? scripts : []) {
    if (!script || sent.has(String(script.id || ''))) continue;
    const media = Array.isArray(script.media) ? script.media : [];
    for (const item of media) {
      const cand = toCandidate({
        source: 'script',
        mediaId: item?.mediaKey,
        type: item?.type,
        price: script.price,
        scriptId: script.id,
        title: script.title,
      });
      if (cand) out.push(cand);
    }
  }
  return out;
}

function maloumUploadId(item) {
  if (!item || typeof item !== 'object') return '';
  return asText(
    item.media?.uploadId || item.uploadId || item.thumbnail?.uploadId
  ).trim();
}

function fourBasedItemId(item) {
  if (!item || typeof item !== 'object') return '';
  return asText(item._id || item.id).trim();
}

function vaultType(item, platform) {
  if (!item || typeof item !== 'object') return null;
  if (platform === 'telegram') return asText(item.kind).trim() || null;
  const raw =
    item.media?.type ||
    item.thumbnail?.type ||
    item.file_type ||
    item.fileType ||
    item.type ||
    item.contentType;
  return asText(raw).trim() || null;
}

async function loadScriptRows({ creatorId, platform, platformFanId }, client) {
  const scripts = await client.query(
    `SELECT id, title, price, media
     FROM creator_scripts
     WHERE "creatorId" = $1 AND platform = $2
     ORDER BY "sortOrder" ASC, title ASC, "createdAt" ASC`,
    [creatorId, platform]
  );
  if (!platformFanId || scripts.rows.length === 0) {
    return { scripts: scripts.rows, sentScriptIds: [] };
  }
  const sent = await client.query(
    `SELECT "scriptId"
     FROM creator_script_sends
     WHERE "creatorId" = $1 AND platform = $2 AND "fanId" = $3
       AND "scriptId" = ANY($4::uuid[])`,
    [creatorId, platform, platformFanId, scripts.rows.map((row) => row.id)]
  );
  return {
    scripts: scripts.rows,
    sentScriptIds: sent.rows.map((row) => row.scriptId),
  };
}

async function loadMaloumSentIds({ creatorId, platformFanId }, client) {
  if (!platformFanId) return [];
  const result = await client.query(
    `SELECT "uploadId"
     FROM maloum_vault_sent
     WHERE "creatorId" = $1 AND "fanId" = $2`,
    [creatorId, platformFanId]
  );
  return result.rows.map((row) => row.uploadId).filter(Boolean);
}

async function loadMaloumVault(d, { creatorId, platformFanId }) {
  const loaded = await d.loadMaloumCreator(creatorId);
  if (loaded?.error || !loaded?.creator) return [];
  const foldersPayload = await d.listVaultFolders(loaded.creator, { limit: 15 });
  const folders = asList(foldersPayload).slice(0, MALOUM_FOLDER_LIMIT);
  const items = [];
  for (const folder of folders) {
    const folderId = asText(folder?._id || folder?.id).trim();
    if (!folderId) continue;
    const mediaPayload = await d.listVaultMedia(loaded.creator, folderId, {
      fanId: platformFanId || undefined,
      limit: MALOUM_MEDIA_PER_FOLDER,
    });
    items.push(...asList(mediaPayload));
  }
  return items
    .map((item) =>
      toCandidate({
        source: 'vault',
        mediaId: maloumUploadId(item),
        type: vaultType(item, 'maloum'),
      })
    )
    .filter(Boolean);
}

async function loadFourBasedVault(d, { creatorId, platformFanId }) {
  const loaded = await d.loadFourBasedCreator(creatorId);
  if (loaded?.error || !loaded?.creator) return [];
  const opts = { limit: MEDIA_CANDIDATE_LIMIT };
  if (platformFanId) {
    opts.fanId = platformFanId;
    opts.sent = false;
  }
  const payload = await d.listFourBasedVault(loaded.creator, opts);
  return asList(payload)
    .map((item) =>
      toCandidate({
        source: 'vault',
        mediaId: fourBasedItemId(item),
        type: vaultType(item, '4based'),
      })
    )
    .filter(Boolean);
}

async function loadTelegramVault({ creatorId, platformFanId }, client) {
  const params = [creatorId];
  let sentJoin = '';
  let sentWhere = '';
  if (platformFanId) {
    params.push(platformFanId);
    sentJoin = `LEFT JOIN telegram_vault_sent s
      ON s."itemId" = i.id AND s."creatorId" = i."creatorId" AND s."fanId" = $2`;
    sentWhere = 'AND s.id IS NULL';
  }
  const result = await client.query(
    `SELECT i.id, i.kind
     FROM telegram_vault_items i
     ${sentJoin}
     WHERE i."creatorId" = $1 ${sentWhere}
     ORDER BY i."createdAt" DESC
     LIMIT ${MEDIA_CANDIDATE_LIMIT}`,
    params
  );
  return result.rows
    .map((row) =>
      toCandidate({
        source: 'vault',
        mediaId: row.id,
        type: row.kind,
      })
    )
    .filter(Boolean);
}

async function loadNotes({ creatorId, platform, mediaIds }, client) {
  if (!mediaIds.length) return new Map();
  const result = await client.query(
    `SELECT "mediaKey", note
     FROM vault_media_notes
     WHERE "creatorId" = $1 AND platform = $2 AND "mediaKey" = ANY($3::text[])`,
    [creatorId, platform, mediaIds]
  );
  const notes = new Map();
  for (const row of result.rows) {
    const key = asText(row.mediaKey).trim();
    const note = asText(row.note).trim();
    if (key && note) notes.set(key, note);
  }
  return notes;
}

function resolveDeps(deps = {}) {
  return {
    pool: deps.pool || pool,
    loadMaloumCreator: deps.loadMaloumCreator || loadMaloumCreator,
    loadFourBasedCreator: deps.loadFourBasedCreator || loadFourBasedCreator,
    listVaultFolders: deps.listVaultFolders || maloumClient.listVaultFolders,
    listVaultMedia: deps.listVaultMedia || maloumClient.listVaultMedia,
    listFourBasedVault: deps.listFourBasedVault || fourBasedClient.listVault,
  };
}

async function loadMediaCandidates(input = {}, deps) {
  const creatorId = String(input.creatorId || '').trim();
  const platform = String(input.platform || '').trim();
  const platformFanId = String(input.platformFanId || '').trim() || null;
  if (!creatorId || !PLATFORMS.has(platform)) return [];

  const d = resolveDeps(deps);
  try {
    const { scripts, sentScriptIds } = await loadScriptRows(
      { creatorId, platform, platformFanId },
      d.pool
    );
    const scriptCandidates = candidatesFromScripts(scripts, sentScriptIds);

    let vaultCandidates = [];
    if (platform === 'maloum') {
      vaultCandidates = subtractSent(
        await loadMaloumVault(d, { creatorId, platformFanId }),
        await loadMaloumSentIds({ creatorId, platformFanId }, d.pool)
      );
    } else if (platform === '4based') {
      vaultCandidates = await loadFourBasedVault(d, { creatorId, platformFanId });
    } else if (platform === 'telegram') {
      vaultCandidates = await loadTelegramVault(
        { creatorId, platformFanId },
        d.pool
      );
    }

    const merged = normalizeMediaCandidates([
      ...scriptCandidates,
      ...vaultCandidates,
    ]);
    const notes = await loadNotes(
      { creatorId, platform, mediaIds: merged.map((item) => item.mediaId) },
      d.pool
    );
    return merged.map((item) => ({
      ...item,
      note: notes.get(item.mediaId) || item.note || null,
    }));
  } catch (err) {
    console.error('AI media candidates load error:', err);
    return [];
  }
}

module.exports = {
  MEDIA_CANDIDATE_LIMIT,
  toCandidate,
  findCandidate,
  bindPpvFromCandidates,
  normalizeMediaCandidates,
  subtractSent,
  candidatesFromScripts,
  loadMediaCandidates,
};
