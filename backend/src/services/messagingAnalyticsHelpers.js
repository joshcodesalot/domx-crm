const { BUSINESS_TZ } = require('./businessTimezone');

function ratePercent(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  return Math.round((n / d) * 10000) / 100;
}

function normalizeCurrency(value) {
  return String(value || 'EUR').toUpperCase() === 'USD' ? 'USD' : 'EUR';
}

function mergeCurrencyAmounts(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const currency = item.currency === 'USD' ? 'USD' : 'EUR';
      map.set(currency, (map.get(currency) || 0) + (Number(item.amount) || 0));
    }
  }
  return Array.from(map.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function currencyAmountRowsToList(rows) {
  return (rows || [])
    .map((row) => ({
      currency: normalizeCurrency(row.currency),
      amount: Number(row.amount) || 0,
    }))
    .filter((row) => row.amount > 0);
}

function sumCurrencyAmounts(amounts) {
  return (amounts || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

function salesPerMessage(amounts, messagesSent) {
  const messages = Number(messagesSent) || 0;
  if (messages <= 0) return [];
  return (amounts || [])
    .map((item) => ({
      currency: item.currency === 'USD' ? 'USD' : 'EUR',
      amount: Math.round(((Number(item.amount) || 0) / messages) * 100) / 100,
    }))
    .filter((item) => item.amount > 0);
}

function revenuePerFan(amounts, fansWhoUnlocked) {
  const fans = Number(fansWhoUnlocked) || 0;
  if (fans <= 0) return [];
  return (amounts || [])
    .map((item) => ({
      currency: item.currency === 'USD' ? 'USD' : 'EUR',
      amount: Math.round(((Number(item.amount) || 0) / fans) * 100) / 100,
    }))
    .filter((item) => item.amount > 0);
}

function idlePercent(activeSeconds, idleSeconds) {
  const active = Number(activeSeconds) || 0;
  const idle = Number(idleSeconds) || 0;
  const total = active + idle;
  if (total <= 0) return 0;
  return Math.round((idle / total) * 10000) / 100;
}

function priceBandFromAmount(amount) {
  const n = Math.abs(Number(amount) || 0);
  if (n < 10) return 'under_10';
  if (n < 30) return '10_to_30';
  return '30_plus';
}

function emptyPriceBands() {
  return [
    { band: 'under_10', label: 'Under 10', sent: 0, unlocked: 0, unlockRate: 0 },
    { band: '10_to_30', label: '10–30', sent: 0, unlocked: 0, unlockRate: 0 },
    { band: '30_plus', label: '30+', sent: 0, unlocked: 0, unlockRate: 0 },
  ];
}

function buildPriceBandsFromRows(rows) {
  const bands = emptyPriceBands();
  const byBand = new Map(bands.map((b) => [b.band, b]));
  for (const row of rows || []) {
    const band = byBand.get(row.band) || byBand.get(priceBandFromAmount(row.amount));
    if (!band) continue;
    band.sent += Number(row.sent) || 0;
    band.unlocked += Number(row.unlocked) || 0;
  }
  for (const band of bands) {
    band.unlockRate = ratePercent(band.unlocked, band.sent);
  }
  return bands;
}

function emptyHourOfDay() {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    messagesSent: 0,
    salesCount: 0,
    salesAmount: 0,
  }));
}

function buildHourOfDayFromRows(rows) {
  const hours = emptyHourOfDay();
  for (const row of rows || []) {
    const hour = Math.min(23, Math.max(0, Number(row.hour) || 0));
    hours[hour].messagesSent += Number(row.messagesSent) || 0;
    hours[hour].salesCount += Number(row.salesCount) || 0;
    hours[hour].salesAmount += Number(row.salesAmount) || 0;
  }
  return hours;
}

/** Shared SELECT fragments for extended message/PPV stats. */
const EXTENDED_MESSAGE_STATS_SELECT = `
  COUNT(*) FILTER (
    WHERE m."contentType" IN ('text', 'media', 'chat_product')
  )::int AS "messagesSent",
  COUNT(*) FILTER (WHERE m."contentType" = 'chat_product')::int AS "ppvsSent",
  COUNT(*) FILTER (
    WHERE m."contentType" = 'chat_product' AND m.purchased = true
  )::int AS "ppvsUnlocked",
  COUNT(*) FILTER (
    WHERE m."contentType" = 'chat_product' AND m.purchased = false
  )::int AS "pendingPpvs",
  COUNT(*) FILTER (WHERE m."contentType" = 'media')::int AS "freeMediaSent",
  COUNT(*) FILTER (
    WHERE m."contentType" = 'chat_product'
      AND COALESCE(m."pictureCount", 0) > 0
      AND COALESCE(m."videoCount", 0) = 0
  )::int AS "photoPpvs",
  COUNT(*) FILTER (
    WHERE m."contentType" = 'chat_product'
      AND COALESCE(m."videoCount", 0) > 0
  )::int AS "videoPpvs",
  COUNT(DISTINCT m."fanId") FILTER (
    WHERE m."fanId" IS NOT NULL
      AND m."contentType" IN ('text', 'media', 'chat_product')
  )::int AS "uniqueFansMessaged",
  COUNT(DISTINCT m."fanId") FILTER (
    WHERE m."fanId" IS NOT NULL
      AND m."contentType" = 'chat_product'
      AND m.purchased = true
  )::int AS "fansWhoUnlocked",
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY m."responseTimeSeconds"
  ) FILTER (WHERE m."responseTimeSeconds" IS NOT NULL)::float AS "p50ResponseSeconds",
  PERCENTILE_CONT(0.9) WITHIN GROUP (
    ORDER BY m."responseTimeSeconds"
  ) FILTER (WHERE m."responseTimeSeconds" IS NOT NULL)::float AS "p90ResponseSeconds",
  AVG(ABS(m."priceNet")) FILTER (
    WHERE m."contentType" = 'chat_product' AND m."priceNet" IS NOT NULL
  )::float AS "avgPpvPrice",
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY ABS(m."priceNet")
  ) FILTER (
    WHERE m."contentType" = 'chat_product' AND m."priceNet" IS NOT NULL
  )::float AS "medianPpvPrice"
`;

const SERIES_CURRENCY_EXPR =
  `UPPER(COALESCE(NULLIF(TRIM(m.currency), ''), 'EUR'))`;

const SERIES_MESSAGE_SELECT = `
  COUNT(*) FILTER (
    WHERE m."contentType" IN ('text', 'media', 'chat_product')
  )::int AS "messagesSent",
  COUNT(*) FILTER (WHERE m."contentType" = 'chat_product')::int AS "ppvsSent",
  COUNT(*) FILTER (
    WHERE m."contentType" = 'chat_product' AND m.purchased = true
  )::int AS "ppvsUnlocked",
  COUNT(*) FILTER (
    WHERE m."contentType" = 'chat_product' AND m.purchased = false
  )::int AS "pendingPpvs",
  COUNT(*) FILTER (WHERE m."contentType" = 'media')::int AS "freeMediaSent",
  COUNT(DISTINCT m."fanId") FILTER (
    WHERE m."fanId" IS NOT NULL
      AND m."contentType" IN ('text', 'media', 'chat_product')
  )::int AS "uniqueFansMessaged",
  ${SERIES_CURRENCY_EXPR} AS currency,
  COALESCE(SUM(ABS(m."priceNet")) FILTER (
    WHERE m.purchased = true AND m."priceNet" IS NOT NULL
  ), 0)::float AS revenue,
  COALESCE(SUM(ABS(m."priceNet")) FILTER (
    WHERE m."contentType" = 'tip' AND m."priceNet" IS NOT NULL
  ), 0)::float AS "tipRevenue",
  COALESCE(SUM(ABS(m."priceNet")) FILTER (
    WHERE m."contentType" = 'chat_product' AND m.purchased = true AND m."priceNet" IS NOT NULL
  ), 0)::float AS "ppvRevenue"
`;

function parseExtendedMessageStats(row = {}) {
  const messagesSent = Number(row.messagesSent) || 0;
  const ppvsSent = Number(row.ppvsSent) || 0;
  const ppvsUnlocked = Number(row.ppvsUnlocked) || 0;
  return {
    messagesSent,
    ppvsSent,
    ppvsUnlocked,
    pendingPpvs: Number(row.pendingPpvs) || 0,
    freeMediaSent: Number(row.freeMediaSent) || 0,
    photoPpvs: Number(row.photoPpvs) || 0,
    videoPpvs: Number(row.videoPpvs) || 0,
    uniqueFansMessaged: Number(row.uniqueFansMessaged) || 0,
    fansWhoUnlocked: Number(row.fansWhoUnlocked) || 0,
    p50ResponseSeconds:
      row.p50ResponseSeconds != null && !Number.isNaN(Number(row.p50ResponseSeconds))
        ? Number(row.p50ResponseSeconds)
        : null,
    p90ResponseSeconds:
      row.p90ResponseSeconds != null && !Number.isNaN(Number(row.p90ResponseSeconds))
        ? Number(row.p90ResponseSeconds)
        : null,
    avgPpvPrice:
      row.avgPpvPrice != null && !Number.isNaN(Number(row.avgPpvPrice))
        ? Math.round(Number(row.avgPpvPrice) * 100) / 100
        : null,
    medianPpvPrice:
      row.medianPpvPrice != null && !Number.isNaN(Number(row.medianPpvPrice))
        ? Math.round(Number(row.medianPpvPrice) * 100) / 100
        : null,
    goldenRatio: ratePercent(ppvsSent, messagesSent),
    ppvConversionRate: ratePercent(ppvsUnlocked, ppvsSent),
  };
}

function periodDateClause(alias, startParam, endParam) {
  const col = alias ? `${alias}."sentAt"` : '"sentAt"';
  return `(${col} AT TIME ZONE '${BUSINESS_TZ}')::date >= $${startParam}::date
             AND (${col} AT TIME ZONE '${BUSINESS_TZ}')::date <= $${endParam}::date`;
}

module.exports = {
  BUSINESS_TZ,
  ratePercent,
  normalizeCurrency,
  mergeCurrencyAmounts,
  currencyAmountRowsToList,
  sumCurrencyAmounts,
  salesPerMessage,
  revenuePerFan,
  idlePercent,
  priceBandFromAmount,
  emptyPriceBands,
  buildPriceBandsFromRows,
  emptyHourOfDay,
  buildHourOfDayFromRows,
  EXTENDED_MESSAGE_STATS_SELECT,
  SERIES_MESSAGE_SELECT,
  SERIES_CURRENCY_EXPR,
  parseExtendedMessageStats,
  periodDateClause,
};
