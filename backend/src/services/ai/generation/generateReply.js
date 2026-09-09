const xaiClient = require('../providers/xaiClient');
const { extractJsonObject } = require('../providers/jsonExtract');
const { extractUsage, normalizeUsage, estimateCostUsd } = require('../usage');
const {
  OUTPUT_SCHEMA_VERSION,
  OUTPUT_ACTIONS,
  OUTPUT_INTENTS,
  ROUTES,
  isConversationState,
} = require('../contracts');

const GENERATE_TIMEOUT_MS = 20000;
const INTENT_VALUES = new Set(Object.values(OUTPUT_INTENTS));

const SYSTEM_PROMPT = `You draft one reply for a creator chatting with a fan.
Return JSON only (no markdown, no explanation) with this exact shape:
{
  "schemaVersion": 1,
  "reply": "text the creator would send",
  "replyEnglish": "English draft of the same reply",
  "intent": "rapport|upsell|question|close|other",
  "recommendedState": null,
  "action": "TEXT_REPLY or SEND_PPV",
  "mediaId": null,
  "price": null,
  "confidence": 0.0,
  "requiresHumanReview": true,
  "suggestedRoute": "HUMAN_REVIEW",
  "flags": []
}
Rules:
- action may be TEXT_REPLY or SEND_PPV.
- SEND_PPV only with a mediaId from mediaCandidates. Do not invent mediaId or price.
- Follow the profile, sops, and constraints in the user context.
- Keep the German reply to 1-2 sentences, about 240 characters, unless the latest inbound asked several questions.
- Ask at most one question. Do not stack topics (no selfie AND how you lie AND what made you sad).
- Never use an em dash.
- Never address the fan by username, handle, or id. Never "hey {username}".
- Default is no pet name. Use fan.givenName only if confirmed. Do not make boy the fallback address.
- boy / babe / braver Junge / süßer at most rarely; never if the last creator outbound already used one.
- Never copy the previous outbound opener, closer, or trailing emoji.
- If the fan repeats the same beat, advance (one new ask or soft sell). Do not reprint the hoodie line.
- Each message has sentAt and relativeAge. nowBerlin is Europe/Berlin.
- Use heute / gerade / today / right now only if inboundIsLiveSession is true (latest inbound is this session, last few hours). Older emotion is history.
- If sessionGapHours is large, re-engage. Do not resume a days-old beat.
- suggestedRoute is a hint only.`.trim();

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function withTimeout(promise, ms, code = 'generate_timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(code);
      err.code = 'timeout';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeGeneratedOutput(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const intent = INTENT_VALUES.has(parsed.intent)
    ? parsed.intent
    : OUTPUT_INTENTS.OTHER;

  let suggestedRoute = ROUTES.HUMAN_REVIEW;
  if (parsed.suggestedRoute === ROUTES.AUTO_SEND) {
    suggestedRoute = ROUTES.AUTO_SEND;
  } else if (parsed.suggestedRoute === ROUTES.HUMAN_REVIEW) {
    suggestedRoute = ROUTES.HUMAN_REVIEW;
  }

  let price = null;
  if (parsed.price != null && parsed.price !== '') {
    const n = Number(parsed.price);
    if (Number.isFinite(n)) price = n;
  }

  let confidence = 0;
  if (parsed.confidence != null && parsed.confidence !== '') {
    const n = Number(parsed.confidence);
    if (Number.isFinite(n)) confidence = n;
  }

  return {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    reply: asText(parsed.reply),
    replyEnglish: asText(parsed.replyEnglish),
    intent,
    recommendedState: isConversationState(parsed.recommendedState)
      ? parsed.recommendedState
      : null,
    action:
      parsed.action === OUTPUT_ACTIONS.SEND_PPV
        ? OUTPUT_ACTIONS.SEND_PPV
        : OUTPUT_ACTIONS.TEXT_REPLY,
    mediaId: parsed.mediaId ?? null,
    price,
    confidence,
    requiresHumanReview: true,
    suggestedRoute,
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
  };
}

function buildGenerateInput(context) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(context || {}) },
  ];
}

async function generateReply({ context, provider, timeoutMs } = {}) {
  const impl = provider || xaiClient;
  const ms = timeoutMs == null ? GENERATE_TIMEOUT_MS : timeoutMs;

  let response;
  try {
    response = await withTimeout(
      impl.createResponse({ input: buildGenerateInput(context) }),
      ms
    );
  } catch (err) {
    if (err?.code === 'timeout' || err?.message === 'generate_timeout') {
      const timeoutErr = new Error('generate_timeout');
      timeoutErr.code = 'timeout';
      throw timeoutErr;
    }
    const failed = new Error(err?.message || 'generate_failed');
    failed.code = 'provider_error';
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
  const output = normalizeGeneratedOutput(parsed);
  if (!output) {
    const invalid = new Error('invalid_json');
    invalid.code = 'invalid_json';
    invalid.usage = usage;
    throw invalid;
  }
  return { output, usage };
}

function unwrapGenerated(result) {
  if (!result || typeof result !== 'object') {
    return { output: result, usage: null };
  }
  if (result.output && typeof result.output === 'object' && result.reply == null) {
    return {
      output: result.output,
      usage: normalizeUsage(result.usage) || result.usage || null,
    };
  }
  const { usage, ...rest } = result;
  return {
    output: rest.reply != null ? rest : result,
    usage: normalizeUsage(usage) || usage || null,
  };
}

module.exports = {
  GENERATE_TIMEOUT_MS,
  SYSTEM_PROMPT,
  withTimeout,
  normalizeGeneratedOutput,
  buildGenerateInput,
  generateReply,
  unwrapGenerated,
};
