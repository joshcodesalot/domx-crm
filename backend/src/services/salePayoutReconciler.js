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
      const collectionId = r?.file_stack?.collection_id
        ? String(r.file_stack.collection_id)
        : null;
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

  const ids = [sale.fileStackId, sale.vaultFileStackId, sale.collectionId].filter(
    Boolean
  );
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

  /** @type {Set<string>} */
  const matchedPayoutIds = new Set();

  for (const entry of candidates.rows) {
    const matches = sales.filter((sale) => {
      if (sale.fanId && entry.fanId && String(sale.fanId) !== String(entry.fanId)) {
        return false;
      }
      if (mediaJsonHasId(entry.mediaJson, [
        sale.fileStackId,
        sale.vaultFileStackId,
        sale.collectionId,
      ])) {
        return true;
      }
      const entryPrice =
        entry.priceNet != null ? Math.abs(Number(entry.priceNet)) : NaN;
      const saleAmount =
        sale.amount != null ? Math.abs(Number(sale.amount)) : NaN;
      if (
        !Number.isFinite(entryPrice) ||
        !Number.isFinite(saleAmount) ||
        Math.abs(entryPrice - saleAmount) > FOURBASED_PRICE_EPSILON
      ) {
        return false;
      }
      const sentMs = entry.sentAt ? new Date(entry.sentAt).getTime() : NaN;
      const soldMs = sale.unlockedAt ? Date.parse(sale.unlockedAt) : NaN;
      return !Number.isFinite(sentMs) || !Number.isFinite(soldMs) || sentMs <= soldMs;
    });

    if (matches.length === 1) {
      await markVerified(entry.id, {
        payoutTxnId: matches[0].payoutTxnId,
        unlockedAt: matches[0].unlockedAt,
        purchased: true,
      });
      matchedPayoutIds.add(matches[0].payoutTxnId);
      summary.verified += 1;
    } else if (matches.length > 1) {
      await insertReconciliationEvent({
        creatorId: meta.id,
        platform: '4based',
        eventType: 'ambiguous_match',
        status: 'needs_review',
        messagingEntryId: entry.id,
        maloumMessageId: entry.maloumMessageId,
        amount: entry.priceNet != null ? Number(entry.priceNet) : null,
        currency: entry.currency,
        unlockedAt: entry.unlockedAt,
        reason: 'multiple_payout_rows_for_media',
        detailJson: { payoutTxnIds: matches.map((m) => m.payoutTxnId) },
      });
      summary.exceptions += 1;
    }
  }

  for (const sale of sales) {
    if (matchedPayoutIds.has(sale.payoutTxnId)) continue;
    const inMonth =
      sale.unlockedAt &&
      sale.unlockedAt >= monthFrom &&
      sale.unlockedAt <= monthTo;
    if (!inMonth) continue;

    const existingMatch = await findFourBasedEntryForPayout(meta.id, sale);
    if (existingMatch) {
      await markVerified(existingMatch.id, {
        payoutTxnId: sale.payoutTxnId,
        unlockedAt: sale.unlockedAt,
        purchased: true,
      });
      summary.verified += 1;
      continue;
    }

    const existingPayout = await pool.query(
      `SELECT id FROM messaging_dashboard_entries
       WHERE "maloumMessageId" = $1 OR "payoutTxnId" = $2
       LIMIT 1`,
      [`4based-payout:${sale.payoutTxnId}`, sale.payoutTxnId]
    );
    if (existingPayout.rows.length > 0) {
      await markVerified(existingPayout.rows[0].id, {
        payoutTxnId: sale.payoutTxnId,
        unlockedAt: sale.unlockedAt,
        purchased: true,
      });
    }
  }

  return summary;
}

/**
 * Reconcile DomX purchased PPVs against platform payout ledgers.
 * @param {string} creatorId
 * @param {{ yearMonth?: string, force?: boolean }} [options]
 */
async function reconcileCreatorPayouts(creatorId, { yearMonth, force = false } = {}) {
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

  let fetchFrom = bounds.monthFrom;
  const earliestIso = earliest.rows[0]?.earliest
    ? new Date(earliest.rows[0].earliest).toISOString()
    : null;
  if (earliestIso && earliestIso < fetchFrom) {
    fetchFrom = earliestIso < capFrom ? capFrom : earliestIso;
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
  fetchReflectedTotalSales,
  loadAuthedCreator,
  parseYearMonth,
  monthBounds,
  monthStartDateString,
  RECONCILE_THROTTLE_MS,
};
