const pool = require('../../db/pool');

const DEFAULT_INPUT_USD_PER_MTTOK = 3;
const DEFAULT_OUTPUT_USD_PER_MTTOK = 15;

function asTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function extractUsage(providerResponse) {
  const raw = providerResponse?.usage;
  if (!raw || typeof raw !== 'object') return null;

  const promptTokens = asTokenCount(
    raw.input_tokens ?? raw.prompt_tokens ?? raw.promptTokens
  );
  const completionTokens = asTokenCount(
    raw.output_tokens ?? raw.completion_tokens ?? raw.completionTokens
  );
  return { promptTokens, completionTokens };
}

function estimateCostUsd({ promptTokens, completionTokens } = {}) {
  const inputRate = Number(process.env.XAI_INPUT_USD_PER_MTTOK);
  const outputRate = Number(process.env.XAI_OUTPUT_USD_PER_MTTOK);
  const inputUsd = Number.isFinite(inputRate) ? inputRate : DEFAULT_INPUT_USD_PER_MTTOK;
  const outputUsd = Number.isFinite(outputRate) ? outputRate : DEFAULT_OUTPUT_USD_PER_MTTOK;
  const prompt = asTokenCount(promptTokens);
  const completion = asTokenCount(completionTokens);
  const cost = (prompt * inputUsd + completion * outputUsd) / 1_000_000;
  return Number(cost.toFixed(8));
}

function sumUsage(left, right) {
  const a = normalizeUsage(left);
  const b = normalizeUsage(right);
  if (!a && !b) return null;
  return {
    promptTokens: (a?.promptTokens || 0) + (b?.promptTokens || 0),
    completionTokens: (a?.completionTokens || 0) + (b?.completionTokens || 0),
    costUsd: Number(((a?.costUsd || 0) + (b?.costUsd || 0)).toFixed(8)),
  };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = asTokenCount(usage.promptTokens);
  const completionTokens = asTokenCount(usage.completionTokens);
  if (promptTokens === 0 && completionTokens === 0 && usage.costUsd == null) {
    if (
      usage.promptTokens == null &&
      usage.completionTokens == null &&
      usage.input_tokens == null
    ) {
      return null;
    }
  }
  const costUsd =
    usage.costUsd != null && Number.isFinite(Number(usage.costUsd))
      ? Number(usage.costUsd)
      : estimateCostUsd({ promptTokens, completionTokens });
  return { promptTokens, completionTokens, costUsd };
}

async function upsertAiUsage(row = {}, client = pool) {
  if (!row.runId || !row.creatorId) return null;
  const usage = normalizeUsage(row) || {
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };
  const result = await client.query(
    `INSERT INTO ai_usage (
       "runId", "creatorId", platform, mode,
       "promptTokens", "completionTokens", "costUsd"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ("runId") DO UPDATE SET
       "creatorId" = EXCLUDED."creatorId",
       platform = EXCLUDED.platform,
       mode = EXCLUDED.mode,
       "promptTokens" = EXCLUDED."promptTokens",
       "completionTokens" = EXCLUDED."completionTokens",
       "costUsd" = EXCLUDED."costUsd"
     RETURNING *`,
    [
      row.runId,
      row.creatorId,
      row.platform || null,
      row.mode || null,
      usage.promptTokens,
      usage.completionTokens,
      usage.costUsd,
    ]
  );
  return result.rows[0] || null;
}

function asDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function summarizeUsage({ from, to, creatorId } = {}, client = pool) {
  const params = [];
  const where = [];
  if (from) {
    params.push(asDate(from) || from);
    where.push(`"createdAt" >= $${params.length}`);
  }
  if (to) {
    params.push(asDate(to) || to);
    where.push(`"createdAt" <= $${params.length}`);
  }
  if (creatorId) {
    params.push(creatorId);
    where.push(`"creatorId" = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totals = await client.query(
    `SELECT
       COUNT(*)::int AS runs,
       COALESCE(SUM("promptTokens"), 0)::int AS "promptTokens",
       COALESCE(SUM("completionTokens"), 0)::int AS "completionTokens",
       COALESCE(SUM("costUsd"), 0)::numeric AS "costUsd"
     FROM ai_usage
     ${clause}`,
    params
  );

  const creators = await client.query(
    `SELECT
       "creatorId",
       COUNT(*)::int AS runs,
       COALESCE(SUM("promptTokens"), 0)::int AS "promptTokens",
       COALESCE(SUM("completionTokens"), 0)::int AS "completionTokens",
       COALESCE(SUM("costUsd"), 0)::numeric AS "costUsd"
     FROM ai_usage
     ${clause}
     GROUP BY "creatorId"
     ORDER BY "costUsd" DESC, runs DESC`,
    params
  );

  const totalRow = totals.rows[0] || {};
  return {
    totals: {
      runs: Number(totalRow.runs) || 0,
      promptTokens: Number(totalRow.promptTokens) || 0,
      completionTokens: Number(totalRow.completionTokens) || 0,
      costUsd: Number(totalRow.costUsd) || 0,
    },
    creators: creators.rows.map((row) => ({
      creatorId: row.creatorId,
      runs: Number(row.runs) || 0,
      promptTokens: Number(row.promptTokens) || 0,
      completionTokens: Number(row.completionTokens) || 0,
      costUsd: Number(row.costUsd) || 0,
    })),
  };
}

module.exports = {
  DEFAULT_INPUT_USD_PER_MTTOK,
  DEFAULT_OUTPUT_USD_PER_MTTOK,
  extractUsage,
  estimateCostUsd,
  normalizeUsage,
  sumUsage,
  upsertAiUsage,
  summarizeUsage,
};
