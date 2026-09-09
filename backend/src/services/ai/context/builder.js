const { defaultCreatorAiProfile } = require('../profile');
const { OUTPUT_ACTIONS, isAiMode, MODES } = require('../contracts');
const { normalizeFacts } = require('../memory');
const { normalizeConversationState } = require('../stateMachine');
const { normalizeMediaCandidates } = require('../mediaCandidates');
const { normalizeRules } = require('../brain/rules');
const { normalizeSopsForContext } = require('../brain/sopImport');
const { resolveGivenName, sanitizeFanUsername } = require('../names');
const {
  BUSINESS_TZ,
  calendarDateString,
  calendarTimeString,
} = require('../../businessTimezone');

const CONTEXT_SCHEMA_VERSION = 1;
const CONTEXT_MESSAGE_LIMIT = 20;
const LIVE_SESSION_HOURS = 6;

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
]);

function isSecretKey(key) {
  return SECRET_KEYS.has(String(key || '').toLowerCase());
}

function stripSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecrets(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const next = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    next[key] = stripSecrets(nested);
  }
  return next;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function messageTimeMs(msg) {
  if (!msg?.sentAt) return 0;
  const ms = new Date(msg.sentAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function parseTimeMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function formatRelativeAge(sentAt, now) {
  const thenMs = parseTimeMs(sentAt);
  if (thenMs == null) return null;
  const nowMs = parseTimeMs(now) || Date.now();
  const diffMs = Math.max(0, nowMs - thenMs);
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function inboundIsLiveSession(gapHours) {
  return gapHours != null && Number(gapHours) < LIVE_SESSION_HOURS;
}

function nowBerlin(now) {
  const date = now ? new Date(now) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    timezone: BUSINESS_TZ,
    date: calendarDateString(safe, BUSINESS_TZ),
    time: calendarTimeString(safe, BUSINESS_TZ),
    iso: safe.toISOString(),
  };
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = asText(raw.text);
  const platformMessageId = String(raw.platformMessageId || '').trim();
  if (!platformMessageId && !text.trim()) return null;

  const direction = raw.direction === 'outbound' ? 'outbound' : 'inbound';
  const senderRole =
    raw.senderRole === 'creator' || raw.senderRole === 'system'
      ? raw.senderRole
      : 'fan';

  let priceNet = null;
  if (raw.priceNet != null && raw.priceNet !== '') {
    const n = Number(raw.priceNet);
    if (Number.isFinite(n)) priceNet = n;
  }

  let sentAt = null;
  if (raw.sentAt) {
    const parsed = new Date(raw.sentAt);
    if (!Number.isNaN(parsed.getTime())) sentAt = parsed.toISOString();
  }

  return {
    platformMessageId: platformMessageId || null,
    direction,
    senderRole,
    text,
    hasMedia: Boolean(raw.hasMedia),
    isPpv: Boolean(raw.isPpv),
    priceNet,
    sentAt,
  };
}

function withRelativeAge(messages, now) {
  return messages.map((msg) => ({
    ...msg,
    relativeAge: formatRelativeAge(msg.sentAt, now),
  }));
}

function pickMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map(normalizeMessage)
    .filter(Boolean)
    .sort((a, b) => messageTimeMs(a) - messageTimeMs(b))
    .slice(-CONTEXT_MESSAGE_LIMIT);
}

function lastInboundAnchor(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.direction === 'inbound' && msg.platformMessageId) {
      return msg.platformMessageId;
    }
  }
  return null;
}

function lastInboundSentAt(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].direction === 'inbound' && messages[i].sentAt) {
      return messages[i].sentAt;
    }
  }
  return null;
}

function sessionGapHours(conversation, messages, now) {
  const inboundAt =
    parseTimeMs(conversation?.lastInboundAt) ||
    parseTimeMs(lastInboundSentAt(messages));
  if (inboundAt == null) return null;
  const nowMs = parseTimeMs(now) || Date.now();
  return Math.round(Math.max(0, (nowMs - inboundAt) / 36e5) * 10) / 10;
}

function safeProfile(profile) {
  const defaults = defaultCreatorAiProfile();
  const source = profile && typeof profile === 'object' ? profile : {};
  return {
    persona: asText(source.persona ?? defaults.persona),
    tone: asText(source.tone ?? defaults.tone),
    languages: Array.isArray(source.languages) ? source.languages.map(asText) : [],
    biography: asText(source.biography ?? defaults.biography),
    preferredTerminology:
      source.preferredTerminology &&
      typeof source.preferredTerminology === 'object' &&
      !Array.isArray(source.preferredTerminology)
        ? source.preferredTerminology
        : {},
    prohibitedClaims: Array.isArray(source.prohibitedClaims)
      ? source.prohibitedClaims.map(asText).filter(Boolean)
      : [],
    salesStyle: asText(source.salesStyle ?? defaults.salesStyle),
    platformRules:
      source.platformRules &&
      typeof source.platformRules === 'object' &&
      !Array.isArray(source.platformRules)
        ? source.platformRules
        : {},
    instructions: asText(source.instructions ?? defaults.instructions),
    version: Number(source.version) || 0,
  };
}

function buildConstraints(profile, { inboundIsLive } = {}) {
  const constraints = [
    `${OUTPUT_ACTIONS.TEXT_REPLY} or ${OUTPUT_ACTIONS.SEND_PPV}`,
    `${OUTPUT_ACTIONS.SEND_PPV} only with a mediaId from mediaCandidates`,
    'do not invent price',
    'reply in 1-2 sentences, about 240 characters of German, unless the latest inbound asked several questions',
    'ask at most one question per reply',
    'never use an em dash',
    'do not stack topics (no selfie AND how you lie AND what made you sad)',
    'never address the fan by username, handle, or platform id. never hey {username}',
    'default is no pet name. givenName only if confirmed. do not make boy the fallback address',
    'boy / babe / braver Junge / süßer at most rarely; never if the last creator outbound already used one',
    'never copy the previous outbound opener, closer, or trailing emoji',
    'if the fan repeats the same beat, advance with one new ask or soft sell; do not reprint the hoodie line',
    inboundIsLive
      ? 'latest inbound is this session: heute/gerade/today/right now are allowed'
      : 'latest inbound is old history: do not use heute/gerade/today/right now; do not resume an old emotional beat. re-engage instead',
  ];
  for (const claim of profile.prohibitedClaims) {
    constraints.push(`do not claim: ${claim}`);
  }
  return constraints;
}

function buildAiContext({
  conversation,
  messages,
  profile,
  fanNotes,
  fanNickname,
  fanUsername,
  fanMemories,
  mediaCandidates,
  rules,
  sops,
  mode,
  lastSessionSummary,
  now,
} = {}) {
  const convo = conversation && typeof conversation === 'object' ? conversation : {};
  const safe = safeProfile(profile);
  const clock = now || new Date().toISOString();
  const capped = withRelativeAge(pickMessages(messages), clock);
  const gapHours = sessionGapHours(convo, capped, clock);
  const liveSession = inboundIsLiveSession(gapHours);
  const memories = normalizeFacts(fanMemories);
  const username =
    sanitizeFanUsername(fanUsername) ||
    sanitizeFanUsername(convo.fanUsername) ||
    null;
  const nickname = asText(fanNickname).trim() || null;
  const notes = asText(fanNotes).trim() || null;
  const givenName = resolveGivenName({
    nickname,
    notes,
    memories,
    username,
  });

  const dto = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    creatorId: convo.creatorId || null,
    platform: convo.platform || null,
    conversationId: convo.id || convo.conversationId || null,
    revision: Number(convo.revision) || 0,
    anchorInboundMessageId:
      lastInboundAnchor(capped) || convo.lastInboundPlatformMessageId || null,
    profileVersion: safe.version,
    mode: isAiMode(mode) ? mode : convo.mode || MODES.OFF,
    conversationState: normalizeConversationState(convo.state),
    messages: capped,
    fan: {
      username,
      givenName,
      nickname,
      notes,
      platformFanId: convo.platformFanId || null,
      memories,
    },
    sessionGapHours: gapHours,
    inboundIsLiveSession: liveSession,
    nowBerlin: nowBerlin(clock),
    lastSessionSummary:
      typeof lastSessionSummary === 'string' && lastSessionSummary.trim()
        ? lastSessionSummary.trim()
        : null,
    mediaCandidates: normalizeMediaCandidates(mediaCandidates),
    rules: normalizeRules(rules),
    sops: normalizeSopsForContext(sops),
    constraints: buildConstraints(safe, { inboundIsLive: liveSession }),
    profile: safe,
  };

  return stripSecrets(dto);
}

module.exports = {
  CONTEXT_SCHEMA_VERSION,
  CONTEXT_MESSAGE_LIMIT,
  LIVE_SESSION_HOURS,
  formatRelativeAge,
  inboundIsLiveSession,
  nowBerlin,
  buildConstraints,
  buildAiContext,
};
