const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const maloumClient = require('./maloumClient');
const fourBasedClient = require('./fourBasedClient');
const { decryptJson, decryptSecret } = require('./crypto');
const { decryptAccessToken } = require('./maloumAuthTokens');
const {
  BUSINESS_TZ,
  calendarDateString,
  monthStartDateString,
} = require('./businessTimezone');

const RECONCILE_THROTTLE_MS = 5 * 60 * 1000;
const MALOUM_PAGE_LIMIT = 20;
const MALOUM_MAX_PAGES = 40;
const FOURBASED_PAGE_LIMIT = 40;
const FOURBASED_MAX_PAGES = 40;
const SWEEP_CAP_MONTHS = 6;
const FOURBASED_PRICE_EPSILON = 0.05;
const FOURBASED_GROUP_WINDOW_MS = 5 * 60 * 1000;

/** @type {Map<string, number>} */
const lastReconcileAtByCreator = new Map();

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function parseYearMonth(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  return calendarDateString(new Date(), BUSINESS_TZ).slice(0, 7);
}

/**
 * Month bounds in BUSINESS_TZ as ISO timestamps.
 * @param {string} yearMonth YYYY-MM
 */
function monthBounds(yearMonth) {
  const ym = parseYearMonth(yearMonth);
  const [y, m] = ym.split('-').map(Number);
  const monthFromDate = `${ym}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const nextMonthStart = `${nextY}-${String(nextM).padStart(2, '0')}-01`;

  // Approximate TZ midnight via UTC offset guess is fragile; use noon-anchor
  // then shift to local calendar via existing helpers. For DB filters we use
  // timestamptz comparisons against ISO constructed at Berlin midnight via
  // Temporal-less approach: treat date strings with Europe/Berlin offset.
  const fromMs = zonedMidnightMs(monthFromDate, BUSINESS_TZ);
  const toExclusiveMs = zonedMidnightMs(nextMonthStart, BUSINESS_TZ);
  const nowMs = Date.now();
  const monthToMs = Math.min(nowMs, toExclusiveMs - 1);

  return {
    yearMonth: ym,
    monthFrom: new Date(fromMs).toISOString(),
    monthTo: new Date(monthToMs).toISOString(),
    monthFromDate,
    nextMonthStart,
  };
}

/**
 * Best-effort local midnight → UTC ms for a YYYY-MM-DD in an IANA zone.
 * Uses the offset at local noon to avoid most DST edge flips.
 */
function zonedMidnightMs(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(new Date(utcNoon));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const tzName = get('timeZoneName') || 'GMT';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  let offsetMin = 0;
  if (match) {
    const sign = match[1] === '-' ? -1 : 1;
    offsetMin =
      sign * (Number(match[2]) * 60 + Number(match[3] || 0));
  }
  // Local midnight = UTC midnight - offset
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60 * 1000;
}

function monthsBefore(yearMonth, count) {
  const [y, m] = parseYearMonth(yearMonth).split('-').map(Number);
  const total = y * 12 + (m - 1) - count;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const normalized =
    typeof value === 'string' ? value.replace(' ', 'T') : value;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function parseAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/**
 * Load creator metadata + decrypted platform auth (same shape chat routes use).
 * Raw DB rows have encrypted tokens and cannot call Maloum/4based APIs.
 */
async function loadAuthedCreator(creatorId) {
  const result = await pool.query(
    `SELECT id, platform, "displayName", username, "avatarUrl", "providerUserId",
            "encryptedSession", "encryptedAccessToken", "encryptedProxy", "accountId"
     FROM creators
     WHERE id = $1`,
    [creatorId]
  );
  if (result.rows.length === 0) {
    return { error: 'creator_not_found' };
  }

  const row = result.rows[0];
  const platform = row.platform === '4based' ? '4based' : 'maloum';
  const meta = {
    id: row.id,
    platform,
    displayName: row.displayName,
    username: row.username || null,
    avatarUrl: row.avatarUrl || null,
    accountId: row.accountId || null,
    providerUserId: row.providerUserId || null,
  };

  let session = {};
  try {
    if (row.encryptedSession) {
      session = decryptJson(row.encryptedSession) || {};
    }
  } catch {
    return { error: `Failed to decrypt ${platform} session` };
  }

  if (platform === 'maloum') {
    const accessToken =
      decryptAccessToken(row.encryptedAccessToken) ||
      decryptSecret(row.encryptedAccessToken) ||
      null;
    let proxyUrl = decryptSecret(row.encryptedProxy) || null;
    if (!proxyUrl) {
      try {
        proxyUrl = maloumClient.resolveMaloumProxyUrl(null);
      } catch {
        proxyUrl = null;
      }
    }
    if (!accessToken) {
      return { error: 'Maloum account is missing auth credentials. Please reconnect.' };
    }
    if (!proxyUrl) {
      return {
        error:
          'Maloum proxy is required. Set MALOUM_PROXY_URL in backend .env or reconnect with a proxy.',
      };
    }
    return {
      meta,
      creator: {
        ...meta,
        accessToken,
        proxyUrl,
        timezone: 'UTC',
        session: {
          ...session,
          providerUserId: row.providerUserId || null,
          accessToken,
        },
      },
    };
  }

  const accessToken =
    decryptSecret(row.encryptedAccessToken) || session.token || null;
  let proxyUrl = decryptSecret(row.encryptedProxy) || null;
  if (!proxyUrl) {
    try {
      proxyUrl = fourBasedClient.resolveFourBasedProxyUrl(null);
    } catch {
      proxyUrl = null;
    }
  }
  const providerUserId = row.providerUserId || session.providerUserId || null;
  if (!accessToken || !providerUserId) {
    return { error: '4based account is missing auth credentials. Please reconnect.' };
  }
  if (!proxyUrl) {
    return {
      error:
        '4based proxy is required. Set FOURBASED_PROXY_URL in backend .env or reconnect with a proxy.',
    };
  }

  return {
    meta,
    creator: {
      ...meta,
      providerUserId,
      accessToken,
      proxyUrl,
      session: {
        ...session,
        providerUserId,
        token: accessToken,
        cookies: session.cookies || {},
        resource: session.resource || null,
      },
    },
  };
}

async function resolveAmbiguousMatchesForEntry(entryId) {
  if (!entryId) return 0;
  const result = await pool.query(
    `UPDATE sale_reconciliation_events
     SET status = 'resolved',
         resolution = 'auto_matched',
         "resolvedAt" = NOW()
     WHERE "messagingEntryId" = $1
       AND "eventType" = 'ambiguous_match'
       AND status = 'needs_review'
     RETURNING id`,
    [entryId]
  );
  return result.rows.length;
}

async function insertReconciliationEvent({
  creatorId,
  platform,
  eventType,
  status = 'needs_review',
  messagingEntryId = null,
  maloumMessageId = null,
  payoutTxnId = null,
  fanId = null,
  fanUsername = null,
  chatId = null,
  amount = null,
  currency = null,
  unlockedAt = null,
  reason = null,
  detailJson = null,
  recoveredMessageText = null,
  recoveredMediaJson = null,
  resolution = null,
  resolvedBy = null,
  resolvedAt = null,
} = {}) {
  if (eventType === 'ambiguous_match' && messagingEntryId) {
    const existing = await pool.query(
      `SELECT id
       FROM sale_reconciliation_events
       WHERE "messagingEntryId" = $1
         AND "eventType" = 'ambiguous_match'
         AND status = 'needs_review'
       ORDER BY "createdAt" ASC
       LIMIT 1`,
      [messagingEntryId]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE sale_reconciliation_events
         SET "detailJson" = COALESCE($2::jsonb, "detailJson"),
             "fanId" = COALESCE($3, "fanId"),
             "fanUsername" = COALESCE($4, "fanUsername"),
             "chatId" = COALESCE($5, "chatId"),
             "unlockedAt" = COALESCE("unlockedAt", $6::timestamptz),
             amount = COALESCE(amount, $7),
             "payoutTxnId" = COALESCE("payoutTxnId", $8)
         WHERE id = $1`,
        [
          existing.rows[0].id,
          detailJson ? JSON.stringify(detailJson) : null,
          fanId || null,
          fanUsername || null,
          chatId || null,
          unlockedAt || null,
          amount != null ? Number(amount) : null,
          payoutTxnId || null,
        ]
      );
      await pool.query(
        `UPDATE sale_reconciliation_events
         SET status = 'resolved',
             resolution = 'duplicate',
             "resolvedAt" = NOW()
         WHERE "messagingEntryId" = $1
           AND "eventType" = 'ambiguous_match'
           AND status = 'needs_review'
           AND id <> $2`,
        [messagingEntryId, existing.rows[0].id]
      );
      return existing.rows[0].id;
    }
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO sale_reconciliation_events (
      id, "creatorId", platform, "eventType", status,
      "messagingEntryId", "maloumMessageId", "payoutTxnId",
      "fanId", "fanUsername", "chatId", amount, currency, "unlockedAt",
      reason, "detailJson", "recoveredMessageText", "recoveredMediaJson",
      resolution, "resolvedBy", "resolvedAt"
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,
      $9,$10,$11,$12,$13,$14,
      $15,$16,$17,$18,
      $19,$20,$21
    )`,
    [
      id,
      creatorId,
      platform,
      eventType,
      status,
      messagingEntryId,
      maloumMessageId,
      payoutTxnId,
      fanId,
      fanUsername,
      chatId,
      amount,
      currency,
      unlockedAt,
      reason,
      detailJson ? JSON.stringify(detailJson) : null,
      recoveredMessageText,
      recoveredMediaJson ? JSON.stringify(recoveredMediaJson) : null,
      resolution,
      resolvedBy,
      resolvedAt,
    ]
  );
  return id;
}

async function fetchMaloumPayouts(creator, { fromIso, toIso }) {
  const rows = [];
  let next;
  for (let page = 0; page < MALOUM_MAX_PAGES; page += 1) {
    const payload = await maloumClient.listTransactionHistory(creator, {
      limit: MALOUM_PAGE_LIMIT,
      next,
    });
    const data = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];
    for (const row of data) {
      const ts = toIsoOrNull(row.executedAt || row.createdAt);
      if (ts && fromIso && ts < fromIso) {
        // Newest-first: stop once we pass the window start
        return rows;
      }
      if (ts && toIso && ts > toIso) continue;
      rows.push(row);
    }
    next = payload?.next || null;
    if (!next || data.length < MALOUM_PAGE_LIMIT) break;
  }
  return rows;
}

async function fetchFourBasedPayouts(creator, { fromIso, toIso }) {
  const rows = [];
  for (let page = 0; page < FOURBASED_MAX_PAGES; page += 1) {
    const offset = page * FOURBASED_PAGE_LIMIT;
    const pageRows = await fourBasedClient.listProcessStats(creator, {
      offset,
      limit: FOURBASED_PAGE_LIMIT,
      bookingdateFrom: fromIso,
      bookingdateTo: toIso,
    });
    const list = Array.isArray(pageRows) ? pageRows : [];
    rows.push(...list);
    if (list.length < FOURBASED_PAGE_LIMIT) break;
  }
  return rows;
}

function normalizeMaloumSales(rows) {
  return rows
    .filter(
      (r) =>
        String(r?.status || '').toUpperCase() === 'APPROVED' &&
        String(r?.category || '').toUpperCase() === 'CHAT_PRODUCT' &&
        r?.message
    )
    .map((r) => ({
      payoutTxnId: String(r._id || r.id),
      messageId: String(r.message),
      chatId: r.chat ? String(r.chat) : null,
      fanId: r.from?._id ? String(r.from._id) : null,
      fanUsername:
        typeof r.from?.username === 'string' ? r.from.username : null,
      amount: parseAmount(r.price?.net ?? r.price?.payoutAmount),
      currency: r.price?.currency || 'EUR',
      unlockedAt: toIsoOrNull(r.executedAt || r.createdAt),
      raw: r,
    }));
}

function normalizeFourBasedSales(rows) {
  return rows
    .filter((r) => {
      const type = String(r?.buyer_process_type || '');
      return type === 'file_stack';
    })
    .map((r) => {
      const fileStackId =
        r?.file_stack?._id || r?.buyer_process_foreignkey
          ? String(r.file_stack?._id || r.buyer_process_foreignkey)
          : null;
      const vaultFileStackId = r?.file_stack?.vault_file_stack_id
        ? String(r.file_stack.vault_file_stack_id)
        : null;
      const collectionId = firstFourBasedCollectionId(r?.file_stack);
      return {
        payoutTxnId: String(r._id || r.id),
        fileStackId,
        vaultFileStackId,
        collectionId,
        fanId: r.buyer_id || r.buyer?._id ? String(r.buyer_id || r.buyer._id) : null,
        fanUsername:
          typeof r.buyer?.name === 'string' ? r.buyer.name : null,
        // DomX 4based ledger stores USD = coins / 121 (same as activities).
        amount: (() => {
          const coins = Number(
            r.buyer_process_amount ?? r.file_stack?.price ?? r.amount
          );
          if (!Number.isFinite(coins) || coins === 0) return null;
          return Math.abs(coins) / 121;
        })(),
        currency: 'USD',
        unlockedAt: toIsoOrNull(r.created_at || r.createdAt),
        raw: r,
      };
    })
    .filter((r) => r.fileStackId || r.vaultFileStackId);
}

function firstFourBasedCollectionId(fileStack) {
  if (!fileStack || typeof fileStack !== 'object') return null;
  if (fileStack.collection_id) return String(fileStack.collection_id);
  if (fileStack.collectionId) return String(fileStack.collectionId);
  const ids = fileStack.collection_ids || fileStack.collectionIds;
  if (Array.isArray(ids) && ids[0]) return String(ids[0]);
  return null;
}

function fourBasedSaleMediaIds(sale) {
  const ids = [];
  const push = (value) => {
    if (value == null) return;
    const id = String(value).trim();
    if (id && !ids.includes(id)) ids.push(id);
  };
  if (Array.isArray(sale?.fileStackIds)) {
    for (const id of sale.fileStackIds) push(id);
  }
  if (Array.isArray(sale?.vaultFileStackIds)) {
    for (const id of sale.vaultFileStackIds) push(id);
  }
  if (Array.isArray(sale?.collectionIds)) {
    for (const id of sale.collectionIds) push(id);
  }
  push(sale?.fileStackId);
  push(sale?.vaultFileStackId);
  push(sale?.collectionId);
  return ids;
}

function entryHasMediaIds(mediaJson) {
  if (!mediaJson || !Array.isArray(mediaJson)) return false;
  for (const item of mediaJson) {
    if (!item || typeof item !== 'object') continue;
    for (const key of [
      'mediaId',
      'vaultFileStackId',
      'vault_file_stack_id',
      'fileStackId',
      'file_stack_id',
      'collectionId',
      'collection_id',
      'id',
      '_id',
    ]) {
      if (item[key] != null && String(item[key]).trim()) return true;
    }
  }
  return false;
}

function buildFourBasedPayoutGroup(members) {
  const list = Array.isArray(members) ? members.filter(Boolean) : [];
  const sortedByAmount = list.slice().sort((a, b) => {
    const aa = a.amount != null ? Number(a.amount) : 0;
    const ba = b.amount != null ? Number(b.amount) : 0;
    return ba - aa;
  });
  const primary = sortedByAmount[0] || {};
  const payoutTxnIds = [];
  const fileStackIds = [];
  const vaultFileStackIds = [];
  const collectionIds = [];
  const pushUnique = (target, value) => {
    if (value == null) return;
    const id = String(value);
    if (id && !target.includes(id)) target.push(id);
  };
  for (const member of list) {
    pushUnique(payoutTxnIds, member.payoutTxnId);
    pushUnique(fileStackIds, member.fileStackId);
    pushUnique(vaultFileStackIds, member.vaultFileStackId);
    pushUnique(collectionIds, member.collectionId);
  }
  const unlockedAts = list
    .map((member) => member.unlockedAt)
    .filter(Boolean)
    .sort();
  return {
    groupId: payoutTxnIds.slice().sort().join(','),
    payoutTxnId: primary.payoutTxnId || payoutTxnIds[0] || null,
    payoutTxnIds,
    fileStackId: fileStackIds[0] || null,
    vaultFileStackId: vaultFileStackIds[0] || null,
    collectionId: collectionIds[0] || null,
    fileStackIds,
    vaultFileStackIds,
    collectionIds,
    fanId: primary.fanId || null,
    fanUsername: primary.fanUsername || null,
    amount: primary.amount != null ? Number(primary.amount) : null,
    currency: 'USD',
    unlockedAt: unlockedAts[0] || primary.unlockedAt || null,
    members: list,
  };
}

/**
 * Collapse multi-file / collection child payouts into one sale group.
 * Singles with no shared collection/vault stay as one-item groups.
 */
function groupFourBasedPayouts(sales) {
  const list = Array.isArray(sales) ? sales.slice() : [];
  list.sort((a, b) => {
    const am = a.unlockedAt ? Date.parse(a.unlockedAt) : 0;
    const bm = b.unlockedAt ? Date.parse(b.unlockedAt) : 0;
    return am - bm;
  });

  const used = new Set();
  const groups = [];

  for (let i = 0; i < list.length; i += 1) {
    if (used.has(i)) continue;
    const seed = list[i];
    const members = [seed];
    used.add(i);
    const groupKey = seed.collectionId || seed.vaultFileStackId || null;
    const seedMs = seed.unlockedAt ? Date.parse(seed.unlockedAt) : NaN;

    if (seed.fanId && groupKey) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (used.has(j)) continue;
        const other = list[j];
        if (String(other.fanId || '') !== String(seed.fanId)) continue;
        const otherKey = other.collectionId || other.vaultFileStackId || null;
        if (!otherKey || otherKey !== groupKey) continue;
        const otherMs = other.unlockedAt ? Date.parse(other.unlockedAt) : NaN;
        if (Number.isFinite(seedMs) && Number.isFinite(otherMs)) {
          if (otherMs - seedMs > FOURBASED_GROUP_WINDOW_MS) break;
          if (Math.abs(otherMs - seedMs) > FOURBASED_GROUP_WINDOW_MS) continue;
        } else if (Number.isFinite(seedMs) || Number.isFinite(otherMs)) {
          continue;
        }
        members.push(other);
        used.add(j);
      }
    }

    groups.push(buildFourBasedPayoutGroup(members));
  }

  return groups;
}

function scoreFourBasedMatch(entry, group) {
  const entryFan = entry?.fanId ? String(entry.fanId) : null;
  const saleFan = group?.fanId ? String(group.fanId) : null;
  if (!entryFan || !saleFan || entryFan !== saleFan) return null;

  const sentMs = entry.sentAt ? new Date(entry.sentAt).getTime() : NaN;
  const soldMs = group.unlockedAt ? Date.parse(group.unlockedAt) : NaN;
  if (Number.isFinite(sentMs) && Number.isFinite(soldMs) && sentMs > soldMs) {
    return null;
  }
  const delta =
    Number.isFinite(sentMs) && Number.isFinite(soldMs)
      ? Math.abs(soldMs - sentMs)
      : Infinity;

  const mediaIds = fourBasedSaleMediaIds(group);
  if (mediaJsonHasId(entry.mediaJson, mediaIds)) {
    return { score: 0, delta, kind: 'media' };
  }
  if (entryHasMediaIds(entry.mediaJson)) {
    return null;
  }

  const entryPrice =
    entry.priceNet != null ? Math.abs(Number(entry.priceNet)) : NaN;
  const saleAmount =
    group.amount != null ? Math.abs(Number(group.amount)) : NaN;
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(saleAmount) ||
    Math.abs(entryPrice - saleAmount) > FOURBASED_PRICE_EPSILON
  ) {
    return null;
  }
  return { score: 1, delta, kind: 'price' };
}

function assignFourBasedMatches(entries, groups) {
  const pairs = [];
  for (const entry of entries) {
    for (const group of groups) {
      const scored = scoreFourBasedMatch(entry, group);
      if (scored) pairs.push({ entry, group, ...scored });
    }
  }
  pairs.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.delta !== b.delta) return a.delta - b.delta;
    return String(a.entry.id).localeCompare(String(b.entry.id));
  });

  const usedEntries = new Set();
  const usedGroups = new Set();
  const assignments = [];

  for (const pair of pairs) {
    const entryId = String(pair.entry.id);
    const groupId = pair.group.groupId;
    if (usedEntries.has(entryId) || usedGroups.has(groupId)) continue;
    const tied = pairs.some((other) => (
      other !== pair
      && String(other.entry.id) === entryId
      && other.score === pair.score
      && !usedGroups.has(other.group.groupId)
    ));
    if (tied) continue;
    usedEntries.add(entryId);
    usedGroups.add(groupId);
    assignments.push(pair);
  }

  const ambiguous = [];
  for (const entry of entries) {
    const entryId = String(entry.id);
    if (usedEntries.has(entryId)) continue;
    const leftover = pairs.filter(
      (pair) =>
        String(pair.entry.id) === entryId && !usedGroups.has(pair.group.groupId)
    );
    if (leftover.length === 0) continue;
    const best = Math.min(...leftover.map((pair) => pair.score));
    const top = leftover.filter((pair) => pair.score === best);
    if (top.length === 1) {
      usedEntries.add(entryId);
      usedGroups.add(top[0].group.groupId);
      assignments.push(top[0]);
    } else if (top.length > 1) {
      ambiguous.push({
        entry,
        groups: top.map((pair) => pair.group),
      });
    }
  }

  return { assignments, ambiguous, usedGroups, usedEntries };
}

function mediaJsonHasId(mediaJson, ids) {
  if (!mediaJson || !Array.isArray(mediaJson) || !ids?.length) return false;
  const want = new Set(ids.filter(Boolean).map(String));
  for (const item of mediaJson) {
    if (!item || typeof item !== 'object') continue;
    for (const key of [
      'mediaId',
      'vaultFileStackId',
      'vault_file_stack_id',
      'fileStackId',
      'file_stack_id',
      'collectionId',
      'collection_id',
      'id',
      '_id',
    ]) {
      if (item[key] != null && want.has(String(item[key]))) return true;
    }
  }
  return false;
}

async function findFourBasedEntryForPayout(
  creatorId,
  sale,
  { allowPurchased = false, preferPurchased = false } = {}
) {
  if (!creatorId || !sale?.fanId) return null;

  const soldAtIso = sale.unlockedAt || new Date().toISOString();
  const result = await pool.query(
    `SELECT *
     FROM messaging_dashboard_entries
     WHERE "creatorId" = $1
       AND platform = '4based'
       AND "contentType" = 'chat_product'
       AND "fanId" = $2
       AND "maloumMessageId" LIKE '4based:%'
       AND "maloumMessageId" NOT LIKE '4based-sale:%'
       AND "maloumMessageId" NOT LIKE '4based-tip:%'
       AND "maloumMessageId" NOT LIKE '4based-payout:%'
     ORDER BY
       CASE WHEN purchased = ${preferPurchased ? 'true' : 'false'} THEN 0 ELSE 1 END,
       CASE WHEN "sentAt" <= $3::timestamptz THEN 0 ELSE 1 END,
       ABS(EXTRACT(EPOCH FROM ("sentAt" - $3::timestamptz))) ASC,
       "sentAt" DESC
     LIMIT 40`,
    [creatorId, sale.fanId, soldAtIso]
  );

  const ids = fourBasedSaleMediaIds(sale);
  if (ids.length > 0) {
    for (const row of result.rows) {
      if (mediaJsonHasId(row.mediaJson, ids)) return row;
    }
  }

  const amount =
    sale.amount != null && Number.isFinite(Number(sale.amount))
      ? Math.abs(Number(sale.amount))
      : null;
  if (amount == null) return null;

  const soldMs = Date.parse(soldAtIso);
  let best = null;
  let bestDelta = Infinity;
  for (const row of result.rows) {
    if (row.priceNet == null) continue;
    if (row.purchased && !allowPurchased) continue;
    const price = Math.abs(Number(row.priceNet));
    if (!Number.isFinite(price) || Math.abs(price - amount) > FOURBASED_PRICE_EPSILON) {
      continue;
    }
    const sentMs = row.sentAt ? new Date(row.sentAt).getTime() : NaN;
    if (Number.isFinite(sentMs) && Number.isFinite(soldMs) && sentMs > soldMs) {
      continue;
    }
    const delta =
      Number.isFinite(sentMs) && Number.isFinite(soldMs)
        ? Math.abs(sentMs - soldMs)
        : Infinity;
    const purchasedRank = preferPurchased
      ? row.purchased
        ? 0
        : 1
      : row.purchased
        ? 1
        : 0;
    const bestRank = best
      ? preferPurchased
        ? best.purchased
          ? 0
          : 1
        : best.purchased
          ? 1
          : 0
      : 0;
    if (
      !best ||
      purchasedRank < bestRank ||
      (purchasedRank === bestRank && delta < bestDelta)
    ) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}

async function markVerified(entryId, { payoutTxnId, unlockedAt, purchased = false }) {
  await pool.query(
    `UPDATE messaging_dashboard_entries
     SET "payoutVerified" = true,
         "payoutVerifiedAt" = NOW(),
         "payoutTxnId" = COALESCE($2, "payoutTxnId"),
         "unlockedAt" = COALESCE("unlockedAt", $3::timestamptz),
         purchased = CASE WHEN $4::boolean THEN true ELSE purchased END,
         "updatedAt" = NOW()
     WHERE id = $1`,
    [entryId, payoutTxnId || null, unlockedAt || null, purchased === true]
  );
  await resolveAmbiguousMatchesForEntry(entryId);
}

async function restoreClearedFalseUnlocks(creatorId) {
  if (!creatorId || !isValidUuid(creatorId)) return 0;
  const result = await pool.query(
    `UPDATE messaging_dashboard_entries e
     SET purchased = true,
         "unlockedAt" = COALESCE(e."unlockedAt", ev."unlockedAt", e."sentAt"),
         "priceNet" = COALESCE(e."priceNet", ev.amount),
         "updatedAt" = NOW()
     FROM sale_reconciliation_events ev
     WHERE ev."eventType" = 'false_unlock_cleared'
       AND ev."messagingEntryId" = e.id
       AND e.purchased = false
       AND e."creatorId" = $1
       AND NOT EXISTS (
         SELECT 1
         FROM message_unsends u
         WHERE u."creatorId" = e."creatorId"
           AND u.platform = e.platform
           AND (
             (
               e.platform = '4based'
               AND e."maloumMessageId" LIKE '4based:%'
               AND e."maloumMessageId" NOT LIKE '4based-sale:%'
               AND e."maloumMessageId" NOT LIKE '4based-tip:%'
               AND e."maloumMessageId" NOT LIKE '4based-payout:%'
               AND u."platformMessageId" = substring(
                 e."maloumMessageId" from length('4based:') + 1
               )
             )
             OR (
               e.platform = 'maloum'
               AND u."platformMessageId" = e."maloumMessageId"
             )
           )
       )
     RETURNING e.id`,
    [creatorId]
  );
  return result.rows.length;
}

async function mergeFourBasedStubs(creatorId) {
  if (!creatorId || !isValidUuid(creatorId)) return 0;

  const bulk = await pool.query(
    `WITH matched AS (
       SELECT DISTINCT ON (stub.id)
         stub.id AS stub_id,
         send.id AS send_id,
         stub."priceNet" AS stub_price,
         stub."unlockedAt" AS stub_unlocked,
         stub."sentAt" AS stub_sent,
         stub."payoutTxnId" AS stub_payout
       FROM messaging_dashboard_entries stub
       JOIN messaging_dashboard_entries send
         ON send."creatorId" = stub."creatorId"
        AND send.platform = '4based'
        AND send."contentType" = 'chat_product'
        AND send."fanId" IS NOT NULL
        AND send."fanId" = stub."fanId"
        AND send.purchased = true
        AND send."maloumMessageId" LIKE '4based:%'
        AND send."maloumMessageId" NOT LIKE '4based-sale:%'
        AND send."maloumMessageId" NOT LIKE '4based-tip:%'
        AND send."maloumMessageId" NOT LIKE '4based-payout:%'
        AND send."priceNet" IS NOT NULL
        AND stub."priceNet" IS NOT NULL
        AND ABS(send."priceNet"::float - stub."priceNet"::float) <= $2
        AND send."sentAt" <= COALESCE(stub."unlockedAt", stub."sentAt")
       WHERE stub."creatorId" = $1
         AND stub.platform = '4based'
         AND stub."contentType" = 'chat_product'
         AND (
           stub."maloumMessageId" LIKE '4based-sale:%'
           OR stub."maloumMessageId" LIKE '4based-payout:%'
           OR stub."attributionSource" IN ('orphan_sale', 'deleted_import')
         )
       ORDER BY
         stub.id,
         ABS(
           EXTRACT(
             EPOCH FROM (
               send."sentAt" - COALESCE(stub."unlockedAt", stub."sentAt")
             )
           )
         ) ASC
     ),
     updated AS (
       UPDATE messaging_dashboard_entries send
       SET purchased = true,
           "priceNet" = COALESCE(send."priceNet", m.stub_price),
           "unlockedAt" = COALESCE(send."unlockedAt", m.stub_unlocked, m.stub_sent),
           "payoutTxnId" = COALESCE(send."payoutTxnId", m.stub_payout),
           "payoutVerified" = CASE
             WHEN m.stub_payout IS NOT NULL THEN true
             ELSE send."payoutVerified"
           END,
           "payoutVerifiedAt" = CASE
             WHEN m.stub_payout IS NOT NULL THEN NOW()
             ELSE send."payoutVerifiedAt"
           END,
           "updatedAt" = NOW()
       FROM matched m
       WHERE send.id = m.send_id
       RETURNING send.id
     )
     SELECT m.stub_id
     FROM matched m
     WHERE (SELECT COUNT(*) FROM updated) >= 0`,
    [creatorId, FOURBASED_PRICE_EPSILON]
  );
  const stubIds = bulk.rows.map((row) => row.stub_id).filter(Boolean);
  if (stubIds.length > 0) {
    await pool.query(
      `DELETE FROM messaging_dashboard_entries WHERE id = ANY($1::uuid[])`,
      [stubIds]
    );
  }
  let merged = stubIds.length;

  for (let pass = 0; pass < 5; pass += 1) {
    const stubs = await pool.query(
      `SELECT *
       FROM messaging_dashboard_entries
       WHERE "creatorId" = $1
         AND platform = '4based'
         AND "contentType" = 'chat_product'
         AND (
           "maloumMessageId" LIKE '4based-sale:%'
           OR "maloumMessageId" LIKE '4based-payout:%'
           OR "attributionSource" IN ('orphan_sale', 'deleted_import')
         )
       ORDER BY "sentAt" DESC
       LIMIT 200`,
      [creatorId]
    );
    if (stubs.rows.length === 0) break;

    let passMerged = 0;
    for (const stub of stubs.rows) {
      const match = await findFourBasedEntryForPayout(
        creatorId,
        {
          fanId: stub.fanId,
          fileStackId: null,
          vaultFileStackId: null,
          collectionId: null,
          amount: stub.priceNet != null ? Number(stub.priceNet) : null,
          unlockedAt: stub.unlockedAt || stub.sentAt,
        },
        { allowPurchased: true, preferPurchased: true }
      );
      if (!match || String(match.id) === String(stub.id)) continue;

      await pool.query(
        `UPDATE messaging_dashboard_entries
         SET purchased = true,
             "priceNet" = COALESCE("priceNet", $2),
             "unlockedAt" = COALESCE("unlockedAt", $3::timestamptz),
             "payoutTxnId" = COALESCE("payoutTxnId", $4),
             "payoutVerified" = CASE
               WHEN $4::text IS NOT NULL THEN true
               ELSE "payoutVerified"
             END,
             "payoutVerifiedAt" = CASE
               WHEN $4::text IS NOT NULL THEN NOW()
               ELSE "payoutVerifiedAt"
             END,
             "updatedAt" = NOW()
         WHERE id = $1`,
        [
          match.id,
          stub.priceNet != null ? Number(stub.priceNet) : null,
          stub.unlockedAt || stub.sentAt || null,
          stub.payoutTxnId || null,
        ]
      );
      await pool.query(
        `DELETE FROM messaging_dashboard_entries WHERE id = $1`,
        [stub.id]
      );
      passMerged += 1;
    }
    merged += passMerged;
    if (passMerged === 0) break;
  }
  return merged;
}

async function reconcileMaloum(authedCreator, meta, { monthFrom, monthTo, fetchFrom }) {
  const summary = {
    verified: 0,
    cleared: 0,
    imported: 0,
    exceptions: 0,
    restored: 0,
    merged: 0,
  };

  const payoutRows = await fetchMaloumPayouts(authedCreator, {
    fromIso: fetchFrom,
    toIso: monthTo,
  });
  const sales = normalizeMaloumSales(payoutRows);
  const byMessage = new Map();
  for (const sale of sales) {
    if (!byMessage.has(sale.messageId)) byMessage.set(sale.messageId, []);
    byMessage.get(sale.messageId).push(sale);
  }

  const candidates = await pool.query(
    `SELECT *
     FROM messaging_dashboard_entries
     WHERE "creatorId" = $1
       AND platform = 'maloum'
       AND "contentType" = 'chat_product'
       AND purchased = true
       AND "payoutVerified" = false
       AND "sentAt" <= $2::timestamptz`,
    [meta.id, monthTo]
  );

  const matchedMessageIds = new Set();

  for (const entry of candidates.rows) {
    const matches = byMessage.get(String(entry.maloumMessageId)) || [];
    if (matches.length === 1) {
      await markVerified(entry.id, {
        payoutTxnId: matches[0].payoutTxnId,
        unlockedAt: matches[0].unlockedAt,
        purchased: true,
      });
      matchedMessageIds.add(String(entry.maloumMessageId));
      summary.verified += 1;
    } else if (matches.length > 1) {
      await insertReconciliationEvent({
        creatorId: meta.id,
        platform: 'maloum',
        eventType: 'ambiguous_match',
        status: 'needs_review',
        messagingEntryId: entry.id,
        maloumMessageId: entry.maloumMessageId,
        fanId: entry.fanId || null,
        fanUsername: entry.fanUsername || null,
        chatId: entry.chatId || null,
        amount: entry.priceNet != null ? Number(entry.priceNet) : null,
        currency: entry.currency,
        unlockedAt: entry.unlockedAt,
        reason: 'multiple_payout_rows_for_message',
        detailJson: { payoutTxnIds: matches.map((m) => m.payoutTxnId) },
      });
      summary.exceptions += 1;
    }
  }

  for (const sale of sales) {
    if (matchedMessageIds.has(sale.messageId)) continue;
    const inMonth =
      sale.unlockedAt &&
      sale.unlockedAt >= monthFrom &&
      sale.unlockedAt <= monthTo;
    if (!inMonth) continue;

    const existing = await pool.query(
      `SELECT id, purchased, "payoutVerified"
       FROM messaging_dashboard_entries
       WHERE "maloumMessageId" = $1`,
      [sale.messageId]
    );
    if (existing.rows.length > 0) {
      await markVerified(existing.rows[0].id, {
        payoutTxnId: sale.payoutTxnId,
        unlockedAt: sale.unlockedAt,
        purchased: true,
      });
      summary.verified += 1;
    }
  }

  return summary;
}

async function reconcileFourBased(authedCreator, meta, { monthFrom, monthTo, fetchFrom }) {
  const summary = {
    verified: 0,
    cleared: 0,
    imported: 0,
    exceptions: 0,
    restored: 0,
    merged: 0,
  };

  const payoutRows = await fetchFourBasedPayouts(authedCreator, {
    fromIso: fetchFrom,
    toIso: monthTo,
  });
  const sales = normalizeFourBasedSales(payoutRows);
  const groups = groupFourBasedPayouts(sales);

  const candidates = await pool.query(
    `SELECT *
     FROM messaging_dashboard_entries
     WHERE "creatorId" = $1
       AND platform = '4based'
       AND "contentType" = 'chat_product'
       AND purchased = true
       AND "payoutVerified" = false
       AND "sentAt" <= $2::timestamptz
       AND "maloumMessageId" NOT LIKE '4based-tip:%'`,
    [meta.id, monthTo]
  );

  const { assignments, ambiguous, usedGroups, usedEntries } =
    assignFourBasedMatches(candidates.rows, groups);

  /** @type {Set<string>} */
  const matchedPayoutIds = new Set();
  const markGroupUsed = (group) => {
    if (!group) return;
    usedGroups.add(group.groupId);
    for (const payoutTxnId of group.payoutTxnIds || []) {
      matchedPayoutIds.add(String(payoutTxnId));
    }
    if (group.payoutTxnId) matchedPayoutIds.add(String(group.payoutTxnId));
  };

  for (const pair of assignments) {
    await markVerified(pair.entry.id, {
      payoutTxnId: pair.group.payoutTxnId,
      unlockedAt: pair.group.unlockedAt || pair.entry.unlockedAt,
      purchased: true,
    });
    usedEntries.add(String(pair.entry.id));
    markGroupUsed(pair.group);
    summary.verified += 1;
  }

  for (const item of ambiguous) {
    const payoutTxnIds = item.groups.flatMap((group) => group.payoutTxnIds || []);
    await insertReconciliationEvent({
      creatorId: meta.id,
      platform: '4based',
      eventType: 'ambiguous_match',
      status: 'needs_review',
      messagingEntryId: item.entry.id,
      maloumMessageId: item.entry.maloumMessageId,
      fanId: item.entry.fanId || null,
      fanUsername: item.entry.fanUsername || null,
      chatId: item.entry.chatId || null,
      amount: item.entry.priceNet != null ? Number(item.entry.priceNet) : null,
      currency: item.entry.currency,
      unlockedAt: item.entry.unlockedAt || item.groups[0]?.unlockedAt || null,
      reason: 'multiple_payout_rows_for_media',
      detailJson: { payoutTxnIds },
    });
    summary.exceptions += 1;
  }

  for (const group of groups) {
    if (usedGroups.has(group.groupId)) continue;
    if ((group.payoutTxnIds || []).some((id) => matchedPayoutIds.has(String(id)))) {
      continue;
    }
    const inMonth =
      group.unlockedAt &&
      group.unlockedAt >= monthFrom &&
      group.unlockedAt <= monthTo;
    if (!inMonth) continue;

    const existingMatch = await findFourBasedEntryForPayout(meta.id, group);
    if (
      existingMatch
      && !usedEntries.has(String(existingMatch.id))
      && !existingMatch.payoutVerified
    ) {
      await markVerified(existingMatch.id, {
        payoutTxnId: group.payoutTxnId,
        unlockedAt: group.unlockedAt,
        purchased: true,
      });
      usedEntries.add(String(existingMatch.id));
      markGroupUsed(group);
      summary.verified += 1;
      continue;
    }

    const payoutKeys = (group.payoutTxnIds || [group.payoutTxnId]).filter(Boolean);
    if (payoutKeys.length === 0) continue;
    const existingPayout = await pool.query(
      `SELECT id FROM messaging_dashboard_entries
       WHERE "maloumMessageId" = ANY($1::text[])
          OR "payoutTxnId" = ANY($2::text[])
       LIMIT 1`,
      [
        payoutKeys.map((id) => `4based-payout:${id}`),
        payoutKeys.map(String),
      ]
    );
    if (existingPayout.rows.length > 0) {
      await markVerified(existingPayout.rows[0].id, {
        payoutTxnId: group.payoutTxnId,
        unlockedAt: group.unlockedAt,
        purchased: true,
      });
      usedEntries.add(String(existingPayout.rows[0].id));
      markGroupUsed(group);
    }
  }

  return summary;
}

/**
 * Reconcile DomX purchased PPVs against platform payout ledgers.
 * @param {string} creatorId
 * @param {{ yearMonth?: string, force?: boolean, monthOnly?: boolean }} [options]
 */
async function reconcileCreatorPayouts(creatorId, { yearMonth, force = false, monthOnly = false } = {}) {
  if (!creatorId || !isValidUuid(creatorId)) {
    return { skipped: true, reason: 'invalid_creator' };
  }

  const restored = await restoreClearedFalseUnlocks(creatorId);
  const merged = await mergeFourBasedStubs(creatorId);

  if (!force) {
    const last = lastReconcileAtByCreator.get(creatorId) || 0;
    if (Date.now() - last < RECONCILE_THROTTLE_MS) {
      return { skipped: true, reason: 'throttled', restored, merged };
    }
  }

  const loaded = await loadAuthedCreator(creatorId);
  if (loaded.error) {
    return { skipped: true, reason: loaded.error, restored, merged };
  }

  const { meta, creator: authedCreator } = loaded;
  const platform = meta.platform;
  const bounds = monthBounds(yearMonth);
  let fetchFrom = bounds.monthFrom;

  if (!monthOnly) {
    const capYm = monthsBefore(bounds.yearMonth, SWEEP_CAP_MONTHS);
    const capFrom = monthBounds(capYm).monthFrom;
    const earliest = await pool.query(
      `SELECT MIN(COALESCE("unlockedAt", "sentAt")) AS earliest
       FROM messaging_dashboard_entries
       WHERE "creatorId" = $1
         AND "contentType" = 'chat_product'
         AND purchased = true
         AND "payoutVerified" = false
         AND "sentAt" <= $2::timestamptz`,
      [creatorId, bounds.monthTo]
    );
    const earliestIso = earliest.rows[0]?.earliest
      ? new Date(earliest.rows[0].earliest).toISOString()
      : null;
    if (earliestIso && earliestIso < fetchFrom) {
      fetchFrom = earliestIso < capFrom ? capFrom : earliestIso;
    }
  }

  lastReconcileAtByCreator.set(creatorId, Date.now());

  let summary;
  try {
    if (platform === '4based') {
      summary = await reconcileFourBased(authedCreator, meta, {
        monthFrom: bounds.monthFrom,
        monthTo: bounds.monthTo,
        fetchFrom,
      });
    } else {
      summary = await reconcileMaloum(authedCreator, meta, {
        monthFrom: bounds.monthFrom,
        monthTo: bounds.monthTo,
        fetchFrom,
      });
    }
  } catch (err) {
    console.warn(
      `Payout reconcile failed for ${creatorId}:`,
      err.message || err
    );
    return {
      skipped: false,
      error: err.message || String(err),
      yearMonth: bounds.yearMonth,
      platform,
      restored,
      merged,
    };
  }

  let mergedAfter = merged;
  if (platform === '4based') {
    mergedAfter += await mergeFourBasedStubs(creatorId);
  }

  return {
    skipped: false,
    yearMonth: bounds.yearMonth,
    platform,
    fetchFrom,
    monthFrom: bounds.monthFrom,
    monthTo: bounds.monthTo,
    ...summary,
    restored,
    merged: mergedAfter,
  };
}

/** @type {object | null} */
let reconcileAllJob = null;

function snapshotReconcileAllJob() {
  if (!reconcileAllJob) return null;
  return {
    status: reconcileAllJob.status,
    yearMonth: reconcileAllJob.yearMonth,
    total: reconcileAllJob.total,
    done: reconcileAllJob.done,
    currentName: reconcileAllJob.currentName,
    startedAt: reconcileAllJob.startedAt,
    finishedAt: reconcileAllJob.finishedAt,
    etaSeconds: reconcileAllJob.etaSeconds,
    verified: reconcileAllJob.verified,
    exceptions: reconcileAllJob.exceptions,
    errors: Array.isArray(reconcileAllJob.errors)
      ? reconcileAllJob.errors.slice()
      : [],
  };
}

function getReconcileAllStatus() {
  return snapshotReconcileAllJob();
}

function updateReconcileAllEta(job, startedMs) {
  if (!job || job.total <= 0) {
    if (job) job.etaSeconds = 0;
    return;
  }
  if (job.done <= 0 || job.done >= job.total) {
    job.etaSeconds = job.done >= job.total ? 0 : null;
    return;
  }
  const elapsed = Date.now() - startedMs;
  job.etaSeconds = Math.max(
    0,
    Math.round((elapsed / job.done) * (job.total - job.done) / 1000)
  );
}

async function runReconcileAll(job) {
  const startedMs = Date.now();
  try {
    const result = await pool.query(
      `SELECT id, "displayName", username, platform
       FROM creators
       ORDER BY LOWER(COALESCE("displayName", username, '')) ASC, id ASC`
    );
    const creators = result.rows;
    job.total = creators.length;
    if (creators.length === 0) {
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.etaSeconds = 0;
      return;
    }

    for (const creator of creators) {
      const name = creator.displayName || creator.username || creator.id;
      job.currentName = name;
      try {
        const summary = await reconcileCreatorPayouts(creator.id, {
          yearMonth: job.yearMonth,
          force: true,
          monthOnly: true,
        });
        job.verified += Number(summary.verified) || 0;
        job.exceptions += Number(summary.exceptions) || 0;
        if (summary.error) {
          job.errors.push({
            creatorId: creator.id,
            name,
            message: summary.error,
          });
        } else if (summary.skipped && summary.reason) {
          job.errors.push({
            creatorId: creator.id,
            name,
            message: summary.reason,
          });
        }
      } catch (err) {
        job.errors.push({
          creatorId: creator.id,
          name,
          message: err.message || String(err),
        });
      }
      job.done += 1;
      updateReconcileAllEta(job, startedMs);
    }

    job.currentName = null;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.etaSeconds = 0;
  } catch (err) {
    job.status = 'error';
    job.currentName = null;
    job.finishedAt = new Date().toISOString();
    job.etaSeconds = 0;
    job.errors.push({
      creatorId: null,
      name: null,
      message: err.message || String(err),
    });
  }
}

function startReconcileAll({ yearMonth } = {}) {
  if (reconcileAllJob?.status === 'running') {
    return {
      started: false,
      reason: 'already_running',
      job: snapshotReconcileAllJob(),
    };
  }

  const job = {
    status: 'running',
    yearMonth: parseYearMonth(yearMonth),
    total: 0,
    done: 0,
    currentName: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    etaSeconds: null,
    verified: 0,
    exceptions: 0,
    errors: [],
  };
  reconcileAllJob = job;
  setImmediate(() => {
    runReconcileAll(job).catch((err) => {
      job.status = 'error';
      job.finishedAt = new Date().toISOString();
      job.etaSeconds = 0;
      job.errors.push({
        creatorId: null,
        name: null,
        message: err.message || String(err),
      });
    });
  });
  return { started: true, job: snapshotReconcileAllJob() };
}

/**
 * Fire-and-forget throttled reconcile for badge/notification polls.
 */
function scheduleThrottledReconcile(creatorId) {
  if (!creatorId || !isValidUuid(creatorId)) return;
  setImmediate(() => {
    reconcileCreatorPayouts(creatorId).catch((err) => {
      console.warn(
        'Throttled payout reconcile failed:',
        err.message || err
      );
    });
  });
}

/**
 * Live payout-page total for Creator Analytics.
 * Maloum: available-for-payout balance. 4based: current-month provision sum.
 */
async function fetchReflectedTotalSales(creatorId) {
  const empty = { amounts: [], error: null };
  if (!creatorId || !isValidUuid(creatorId)) return empty;

  const loaded = await loadAuthedCreator(creatorId);
  if (loaded.error) {
    return { amounts: [], error: loaded.error };
  }

  const { meta, creator } = loaded;
  try {
    if (meta.platform === '4based') {
      const bounds = monthBounds();
      const raw = await fourBasedClient.getProcessSumNetto(creator, {
        bookingdateFrom: bounds.monthFrom,
        bookingdateTo: bounds.monthTo,
      });
      const amount =
        typeof raw === 'number'
          ? raw
          : Number(raw?.netto ?? raw?.amount ?? raw);
      if (!Number.isFinite(amount)) {
        return { amounts: [], error: '4based provision sum was empty' };
      }
      return {
        amounts: [{ currency: 'USD', amount: Math.round(Math.abs(amount) * 100) / 100 }],
        error: null,
      };
    }

    const payload = await maloumClient.getUserBalance(creator);
    const balance = payload?.balance && typeof payload.balance === 'object'
      ? payload.balance
      : payload;
    const amount = Number(
      balance?.payoutAmount ?? balance?.net ?? payload?.payoutAmount ?? payload?.net
    );
    const currency =
      typeof balance?.currency === 'string' && balance.currency.trim()
        ? balance.currency.trim().toUpperCase()
        : 'EUR';
    if (!Number.isFinite(amount)) {
      return { amounts: [], error: 'Maloum payout balance was empty' };
    }
    return {
      amounts: [{ currency, amount: Math.round(Math.abs(amount) * 100) / 100 }],
      error: null,
    };
  } catch (err) {
    return {
      amounts: [],
      error: err?.message || 'Failed to load reflected total sales',
    };
  }
}

module.exports = {
  reconcileCreatorPayouts,
  scheduleThrottledReconcile,
  startReconcileAll,
  getReconcileAllStatus,
  fetchReflectedTotalSales,
  loadAuthedCreator,
  parseYearMonth,
  monthBounds,
  monthStartDateString,
  RECONCILE_THROTTLE_MS,
};
