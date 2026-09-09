const xaiClient = require('../providers/xaiClient');
const { extractJsonObject } = require('../providers/jsonExtract');
const { extractUsage, estimateCostUsd } = require('../usage');
const { OUTPUT_ACTIONS } = require('../contracts');
const { withTimeout, GENERATE_TIMEOUT_MS } = require('../generation/generateReply');

const CRITIC_LOW_CONFIDENCE = 0.7;

const CRITIC_PROMPT = `You review one already-bound AI draft for a creator chatting with a fan.
Return JSON only (no markdown, no explanation) with this exact shape:
{
  "ok": true,
  "flags": [],
  "reason": null
}
Rules:
- Do not invent mediaId or price.
- Do not rewrite the reply.
- Set ok to false if the draft is unsafe, off-persona, or a bad PPV.`.trim();

function asConfidence(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function shouldCritic(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return false;
  }
  if (output.action === OUTPUT_ACTIONS.SEND_PPV) return true;
  const flags = Array.isArray(output.flags) ? output.flags : [];
  if (flags.length > 0) return true;
  return asConfidence(output.confidence) < CRITIC_LOW_CONFIDENCE;
}

function normalizeCriticResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  if (typeof parsed.ok !== 'boolean') return null;
  if (!Array.isArray(parsed.flags)) return null;

  const flags = [];
  for (const flag of parsed.flags) {
    if (typeof flag !== 'string') return null;
    const trimmed = flag.trim();
    if (trimmed) flags.push(trimmed);
  }

  let reason = null;
  if (parsed.reason != null && parsed.reason !== '') {
    if (typeof parsed.reason !== 'string') return null;
    reason = parsed.reason;
  }

  return { ok: parsed.ok, flags, reason };
}

function mergeCriticFlags(existing, extra) {
  const out = [];
  const seen = new Set();
  for (const flag of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(extra) ? extra : [])]) {
    const text = typeof flag === 'string' ? flag.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function buildCriticInput(context, output) {
  return [
    { role: 'system', content: CRITIC_PROMPT },
    { role: 'user', content: JSON.stringify({ context: context || {}, output: output || {} }) },
  ];
}

async function callCriticProvider(impl, input) {
  if (typeof impl.validateReply === 'function') {
    return impl.validateReply({ input });
  }
  return impl.createResponse({ input });
}

async function criticReply({ context, output, provider, timeoutMs } = {}) {
  const impl = provider || xaiClient;
  const ms = timeoutMs == null ? GENERATE_TIMEOUT_MS : timeoutMs;

  let response;
  try {
    response = await withTimeout(
      callCriticProvider(impl, buildCriticInput(context, output)),
      ms,
      'critic_timeout'
    );
  } catch (err) {
    if (err?.code === 'timeout' || err?.message === 'critic_timeout') {
      const timeoutErr = new Error('critic_timeout');
      timeoutErr.code = 'timeout';
      throw timeoutErr;
    }
    const failed = new Error(err?.message || 'critic_failed');
    failed.code = 'critic_failed';
    throw failed;
  }

  const usageRaw = extractUsage(response);
  const usage = usageRaw
    ? {
        ...usageRaw,
        costUsd: estimateCostUsd(usageRaw),
      }
    : null;

  const parsed = extractJsonObject(response?.outputText);
  const result = normalizeCriticResult(parsed);
  if (!result) {
    const invalid = new Error('critic_invalid');
    invalid.code = 'critic_invalid';
    invalid.usage = usage;
    throw invalid;
  }
  return { ...result, usage };
}

module.exports = {
  CRITIC_LOW_CONFIDENCE,
  CRITIC_PROMPT,
  shouldCritic,
  normalizeCriticResult,
  mergeCriticFlags,
  buildCriticInput,
  criticReply,
};
