const { randomUUID } = require('crypto');
const pool = require('../db/pool');
const maloumClient = require('./maloumClient');
const fourBasedClient = require('./fourBasedClient');
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

async function loadCreator(creatorId) {
  const result = await pool.query(
    `SELECT *
     FROM creators
     WHERE id = $1`,
    [creatorId]
  );
  return result.rows[0] || null;
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
      return {
        payoutTxnId: String(r._id || r.id),
        fileStackId,
        vaultFileStackId,
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
      'id',
      '_id',
    ]) {
      if (item[key] != null && want.has(String(item[key]))) return true;
    }
  }
  return false;
}

async function findFourBasedEntryForPayout(creatorId, sale) {
  if (!creatorId || !sale?.fanId) return null;
  if (!sale.fileStackId && !sale.vaultFileStackId) return null;

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
     ORDER BY "sentAt" DESC
     LIMIT 40`,
    [creatorId, sale.fanId]
  );

  const ids = [sale.fileStackId, sale.vaultFileStackId];
  for (const row of result.rows) {
    if (mediaJsonHasId(row.mediaJson, ids)) return row;
  }
  return null;
}

async function recoverMaloumMessage(creator, chatId, messageId) {
  if (!chatId || !messageId) return { text: null, mediaJson: null };
  try {
    let next;
    for (let page = 0; page < 8; page += 1) {
      const payload = await maloumClient.getMessages(creator, chatId, {
        limit: 30,
        next,
      });
      const list = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];
      const found = list.find(
        (m) => String(m?._id || m?.id || '') === String(messageId)
      );
      if (found) {
        const text =
          typeof found.content?.text === 'string'
            ? found.content.text
            : typeof found.text === 'string'
              ? found.text
              : null;
        const assets = Array.isArray(found.content?.assets)
          ? found.content.assets
          : [];
        const mediaJson = assets.map((a) => ({
          mediaId: a?.mediaId || a?._id || a?.id || undefined,
          type: a?.type || undefined,
        }));
        return { text, mediaJson: mediaJson.length ? mediaJson : null };
      }
      next = payload?.next || null;
      if (!next || list.length === 0) break;
    }
  } catch (err) {
    console.warn('Maloum chat recovery failed:', err.message || err);
  }
  return { text: null, mediaJson: null };
}

async function recoverFourBasedMessage(creator, fanId, sale) {
  if (!fanId) return { text: null, mediaJson: null, chatId: null };
  try {
    const chat = await fourBasedClient.getChatByUser(creator, fanId);
    const chatId = chat?._id || chat?.id ? String(chat._id || chat.id) : null;
    if (!chatId) return { text: null, mediaJson: null, chatId: null };

    for (let offset = 0; offset < 100; offset += 20) {
      const payload = await fourBasedClient.getMessages(creator, chatId, {
        limit: 20,
        offset,
      });
      const list = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
      const found = list.find((m) => {
        const fs = m?.file_stack || m?.fileStack;
        if (!fs) return false;
        const ids = [
          fs._id,
          fs.id,
          fs.vault_file_stack_id,
          fs.vaultFileStackId,
        ]
          .filter(Boolean)
          .map(String);
        return (
          (sale.fileStackId && ids.includes(String(sale.fileStackId))) ||
          (sale.vaultFileStackId &&
            ids.includes(String(sale.vaultFileStackId)))
        );
      });
      if (found) {
        const text =
          typeof found.message === 'string'
            ? found.message
            : typeof found.text === 'string'
              ? found.text
              : null;
        const fs = found.file_stack || found.fileStack;
        const mediaJson = fs
          ? [
              {
                mediaId: String(
                  fs.vault_file_stack_id || fs._id || fs.id || ''
                ),
                fileStackId: fs._id || fs.id ? String(fs._id || fs.id) : undefined,
                vaultFileStackId: fs.vault_file_stack_id
                  ? String(fs.vault_file_stack_id)
                  : undefined,
                type: fs.fileStackType || fs.type || undefined,
              },
            ]
          : null;
        return { text, mediaJson, chatId };
      }
      if (list.length < 20) break;
    }
    return { text: null, mediaJson: null, chatId };
  } catch (err) {
    console.warn('4based chat recovery failed:', err.message || err);
  }
  return { text: null, mediaJson: null, chatId: null };
}

async function markVerified(entryId, { payoutTxnId, unlockedAt }) {
  await pool.query(
    `UPDATE messaging_dashboard_entries
     SET "payoutVerified" = true,
         "payoutVerifiedAt" = NOW(),
         "payoutTxnId" = COALESCE($2, "payoutTxnId"),
         "unlockedAt" = COALESCE("unlockedAt", $3::timestamptz),
         "updatedAt" = NOW()
     WHERE id = $1`,
    [entryId, payoutTxnId || null, unlockedAt || null]
  );
}

async function clearFalseUnlock(entry, { reason, payoutDetail }) {
  await pool.query(
    `UPDATE messaging_dashboard_entries
     SET purchased = false,
         "unlockedAt" = NULL,
         "payoutVerified" = false,
         "payoutVerifiedAt" = NULL,
         "payoutTxnId" = NULL,
         "updatedAt" = NOW()
     WHERE id = $1`,
    [entry.id]
  );

  await insertReconciliationEvent({
    creatorId: entry.creatorId,
    platform: entry.platform === '4based' ? '4based' : 'maloum',
    eventType: 'false_unlock_cleared',
    status: 'resolved',
    messagingEntryId: entry.id,
    maloumMessageId: entry.maloumMessageId,
    fanId: entry.fanId,
    fanUsername: entry.fanUsername,
    chatId: entry.chatId,
    amount: entry.priceNet != null ? Number(entry.priceNet) : null,
    currency: entry.currency,
    unlockedAt: entry.unlockedAt || null,
    reason,
    detailJson: payoutDetail || null,
    resolution: 'auto_cleared',
    resolvedAt: new Date().toISOString(),
  });
}

async function importDeletedSale({
  creator,
  creatorRow,
  platform,
  sale,
  recovered,
}) {
  const maloumMessageId =
    platform === 'maloum'
      ? String(sale.messageId)
      : `4based-payout:${sale.payoutTxnId}`;

  const existing = await pool.query(
    `SELECT id FROM messaging_dashboard_entries WHERE "maloumMessageId" = $1`,
    [maloumMessageId]
  );
  if (existing.rows.length > 0) {
    await markVerified(existing.rows[0].id, {
      payoutTxnId: sale.payoutTxnId,
      unlockedAt: sale.unlockedAt,
    });
    return { imported: false, entryId: existing.rows[0].id };
  }

  const unlockedAt = sale.unlockedAt || new Date().toISOString();
  const chatId =
    recovered.chatId ||
    sale.chatId ||
    (sale.fanId
      ? platform === '4based'
        ? `4based-payout:${sale.fanId}`
        : String(sale.chatId || sale.fanId)
      : `deleted:${sale.payoutTxnId}`);

  const mediaJson = recovered.mediaJson || null;
  const pictureCount = Array.isArray(mediaJson)
    ? mediaJson.filter((m) => !String(m?.type || '').includes('video')).length
    : 0;
  const videoCount = Array.isArray(mediaJson)
    ? mediaJson.filter((m) => String(m?.type || '').includes('video')).length
    : 0;

  const entryId = randomUUID();
  const insert = await pool.query(
    `INSERT INTO messaging_dashboard_entries (
      id, "creatorId", "creatorName", "creatorUsername", "creatorAvatarUrl",
      platform, "chatterId", "chatterName", "chatterEmail",
      "chatId", "fanId", "fanUsername", "maloumMessageId", "optimisticMessageId",
      "contentType", "englishMessage", "germanTranslatedMessage", "actualSentText",
      "priceNet", currency, purchased, "unlockedAt",
      "payoutVerified", "payoutVerifiedAt", "payoutTxnId", "attributionSource",
      "mediaCount", "pictureCount", "videoCount", "mediaJson",
      "previousFanMessageAt", "responseTimeSeconds", "sentAt"
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6,NULL,'Deleted',NULL,
      $7,$8,$9,$10,NULL,
      'chat_product',$11,NULL,$11,
      $12,$13,true,$14,
      true,NOW(),$15,'deleted_import',
      $16,$17,$18,$19::jsonb,
      NULL,NULL,$14
    )
    ON CONFLICT ("maloumMessageId") DO NOTHING
    RETURNING id`,
    [
      entryId,
      creatorRow.id,
      creatorRow.displayName || 'Deleted',
      creatorRow.username || null,
      creatorRow.avatarUrl || null,
      platform,
      chatId,
      sale.fanId || null,
      sale.fanUsername || null,
      maloumMessageId,
      recovered.text || null,
      sale.amount,
      sale.currency || (platform === '4based' ? 'USD' : 'EUR'),
      unlockedAt,
      sale.payoutTxnId,
      mediaJson ? mediaJson.length : 0,
      pictureCount,
      videoCount,
      mediaJson ? JSON.stringify(mediaJson) : null,
    ]
  );

  const messagingEntryId = insert.rows[0]?.id || null;
  const needsReview = !recovered.text;
  await insertReconciliationEvent({
    creatorId: creatorRow.id,
    platform,
    eventType: 'payout_orphan_imported',
    status: needsReview ? 'needs_review' : 'resolved',
    messagingEntryId,
    maloumMessageId,
    payoutTxnId: sale.payoutTxnId,
    fanId: sale.fanId,
    fanUsername: sale.fanUsername,
    chatId,
    amount: sale.amount,
    currency: sale.currency,
    unlockedAt,
    reason: needsReview
      ? 'imported_under_deleted_chat_recovery_incomplete'
      : 'imported_under_deleted',
    detailJson: { payoutTxnId: sale.payoutTxnId },
    recoveredMessageText: recovered.text || null,
    recoveredMediaJson: recovered.mediaJson || null,
    resolution: needsReview ? null : 'auto_imported',
    resolvedAt: needsReview ? null : new Date().toISOString(),
  });

  return { imported: Boolean(messagingEntryId), entryId: messagingEntryId };
}

async function reconcileMaloum(creatorRow, { monthFrom, monthTo, fetchFrom }) {
  const summary = {
    verified: 0,
    cleared: 0,
    imported: 0,
    exceptions: 0,
  };

  const payoutRows = await fetchMaloumPayouts(creatorRow, {
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
    [creatorRow.id, monthTo]
  );

  const matchedMessageIds = new Set();

  for (const entry of candidates.rows) {
    const matches = byMessage.get(String(entry.maloumMessageId)) || [];
    if (matches.length === 1) {
      await markVerified(entry.id, {
        payoutTxnId: matches[0].payoutTxnId,
        unlockedAt: matches[0].unlockedAt,
      });
      matchedMessageIds.add(String(entry.maloumMessageId));
      summary.verified += 1;
    } else if (matches.length > 1) {
      await insertReconciliationEvent({
        creatorId: creatorRow.id,
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
    } else {
      await clearFalseUnlock(entry, {
        reason: 'no_payout_match_for_purchased_row',
      });
      summary.cleared += 1;
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
      const row = existing.rows[0];
      if (row.purchased) {
        await markVerified(row.id, {
          payoutTxnId: sale.payoutTxnId,
          unlockedAt: sale.unlockedAt,
        });
        summary.verified += 1;
      }
      continue;
    }

    const recovered = await recoverMaloumMessage(
      creatorRow,
      sale.chatId,
      sale.messageId
    );
    const result = await importDeletedSale({
      creator: creatorRow,
      creatorRow,
      platform: 'maloum',
      sale,
      recovered,
    });
    if (result.imported) summary.imported += 1;
    if (!recovered.text) summary.exceptions += 1;
  }

  return summary;
}

async function reconcileFourBased(creatorRow, { monthFrom, monthTo, fetchFrom }) {
  const summary = {
    verified: 0,
    cleared: 0,
    imported: 0,
    exceptions: 0,
  };

  const payoutRows = await fetchFourBasedPayouts(creatorRow, {
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
    [creatorRow.id, monthTo]
  );

  /** @type {Set<string>} */
  const matchedEntryIds = new Set();
  /** @type {Set<string>} */
  const matchedPayoutIds = new Set();

  for (const entry of candidates.rows) {
    const matches = sales.filter((sale) => {
      if (sale.fanId && entry.fanId && String(sale.fanId) !== String(entry.fanId)) {
        return false;
      }
      return mediaJsonHasId(entry.mediaJson, [
        sale.fileStackId,
        sale.vaultFileStackId,
      ]);
    });

    if (matches.length === 1) {
      await markVerified(entry.id, {
        payoutTxnId: matches[0].payoutTxnId,
        unlockedAt: matches[0].unlockedAt,
      });
      matchedEntryIds.add(String(entry.id));
      matchedPayoutIds.add(matches[0].payoutTxnId);
      summary.verified += 1;
    } else if (matches.length > 1) {
      await insertReconciliationEvent({
        creatorId: creatorRow.id,
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
    } else if (
      String(entry.maloumMessageId || '').startsWith('4based-payout:')
    ) {
      // Already a payout import stub without media match — leave for month import path
      matchedEntryIds.add(String(entry.id));
    } else {
      await clearFalseUnlock(entry, {
        reason: 'no_payout_match_for_purchased_row',
      });
      summary.cleared += 1;
    }
  }

  for (const sale of sales) {
    if (matchedPayoutIds.has(sale.payoutTxnId)) continue;
    const inMonth =
      sale.unlockedAt &&
      sale.unlockedAt >= monthFrom &&
      sale.unlockedAt <= monthTo;
    if (!inMonth) continue;

    const existingMatch = await findFourBasedEntryForPayout(creatorRow.id, sale);
    if (existingMatch) {
      await markVerified(existingMatch.id, {
        payoutTxnId: sale.payoutTxnId,
        unlockedAt: sale.unlockedAt,
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
      });
      continue;
    }

    const recovered = await recoverFourBasedMessage(creatorRow, sale.fanId, sale);
    const result = await importDeletedSale({
      creator: creatorRow,
      creatorRow,
      platform: '4based',
      sale,
      recovered,
    });
    if (result.imported) summary.imported += 1;
    if (!recovered.text) summary.exceptions += 1;
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

  if (!force) {
    const last = lastReconcileAtByCreator.get(creatorId) || 0;
    if (Date.now() - last < RECONCILE_THROTTLE_MS) {
      return { skipped: true, reason: 'throttled' };
    }
  }

  const creatorRow = await loadCreator(creatorId);
  if (!creatorRow) {
    return { skipped: true, reason: 'creator_not_found' };
  }

  const platform = creatorRow.platform === '4based' ? '4based' : 'maloum';
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
      summary = await reconcileFourBased(creatorRow, {
        monthFrom: bounds.monthFrom,
        monthTo: bounds.monthTo,
        fetchFrom,
      });
    } else {
      summary = await reconcileMaloum(creatorRow, {
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
    };
  }

  return {
    skipped: false,
    yearMonth: bounds.yearMonth,
    platform,
    fetchFrom,
    monthFrom: bounds.monthFrom,
    monthTo: bounds.monthTo,
    ...summary,
  };
}

/**
 * Fire-and-forget throttled reconcile for badge/notification polls.
 */
function scheduleThrottledReconcile(creatorId) {
  if (!creatorId || !isValidUuid(creatorId)) return;
  const last = lastReconcileAtByCreator.get(creatorId) || 0;
  if (Date.now() - last < RECONCILE_THROTTLE_MS) return;
  setImmediate(() => {
    reconcileCreatorPayouts(creatorId).catch((err) => {
      console.warn(
        'Throttled payout reconcile failed:',
        err.message || err
      );
    });
  });
}

module.exports = {
  reconcileCreatorPayouts,
  scheduleThrottledReconcile,
  parseYearMonth,
  monthBounds,
  monthStartDateString,
  RECONCILE_THROTTLE_MS,
};
