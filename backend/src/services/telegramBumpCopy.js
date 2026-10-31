const { createResponse } = require('./openRouterClient');
const { stripModelTokens } = require('./germanTranslator');

const BUMP_HISTORY_LIMIT = 40;
const BUMP_RECENT_MS = 2 * 60 * 60 * 1000;
const BUMP_MAX_CHARS = 500;

const BERLIN_TIME_ZONE = 'Europe/Berlin';

const NOT_MESSAGEABLE_RE =
  /USER_PRIVACY_RESTRICTED|USER_IS_BLOCKED|YOU_BLOCKED_USER|INPUT_USER_DEACTIVATED|USER_DEACTIVATED|CHAT_WRITE_FORBIDDEN|PEER_ID_INVALID|USER_BOT|CHAT_ADMIN_REQUIRED|USER_BANNED|does not allow messages|no longer available|cannot be added/i;

const SESSION_DEAD_RE =
  /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|session expired/i;

const LABEL_PREFIX =
  /^(?:German|Deutsch|Translation|Übersetzung|Final German|Bump|Message)\s*:\s*/i;

const BUMP_SYSTEM_PROMPT = `
You write one private Telegram message for a dominant adult creator texting one fan in German.

You receive that fan's notes, the recent chat with Europe/Berlin timestamps, and the current time in Germany.

Write one or two short sentences, the way a real woman texts. Make it personal to these notes and this chat. React to how long it has been since the last message and to the time of day.

Match the dominance already in the creator's recent messages. Do not become more dominant, softer, or switch character. A casual thread stays casual. A dominant thread stays at that same level.

Do not invent facts, plans, purchases, media, or feelings that are not in the notes or the chat. Do not mention notes, timestamps, bumps, lists, or automation. Do not add emojis unless the creator's recent messages already use them. No greeting templates, no labels, no quotation marks.

Output only the German message.
`.trim();

function berlinParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BERLIN_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  const day = pick('day');
  const month = pick('month');
  const year = pick('year');
  const hour = pick('hour');
  const minute = pick('minute');
  if (!day || !month || !year || !hour || !minute) return null;
  return { day, month, year, hour, minute };
}

function berlinStamp(value) {
  const parts = berlinParts(value);
  if (!parts) return '';
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

function messageTimeMs(message) {
  if (!message || message.date == null || message.date === '') return null;
  if (message.date instanceof Date) {
    const ms = message.date.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof message.date === 'number' && Number.isFinite(message.date)) {
    return message.date > 1e12 ? message.date : message.date * 1000;
  }
  const ms = Date.parse(String(message.date));
  return Number.isFinite(ms) ? ms : null;
}

function latestMessageMs(messages) {
  let latest = null;
  for (const message of messages || []) {
    const ms = messageTimeMs(message);
    if (ms == null) continue;
    if (latest == null || ms > latest) latest = ms;
  }
  return latest;
}

function isRecentChat(messages, nowMs, windowMs = BUMP_RECENT_MS) {
  const latest = latestMessageMs(messages);
  if (latest == null) return false;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return false;
  return now - latest < windowMs;
}

function bumpSkipReason({
  kind,
  service = false,
  messageable = true,
  messages,
  nowMs,
  windowMs = BUMP_RECENT_MS,
} = {}) {
  if (kind === 'group') return 'Group chat';
  if (service) return 'Service chat';
  if (messageable === false) return 'Not messageable';
  if (isRecentChat(messages, nowMs, windowMs)) return 'Recent conversation';
  return null;
}

function bumpErrorAction(err) {
  const raw = String(err?.text || err?.message || err || '')
    .replace(/^Error:\s*/i, '')
    .trim();
  const reason = raw.slice(0, 240) || 'Failed';
  if (SESSION_DEAD_RE.test(raw) || /OPENROUTER_API_KEY is not set/i.test(raw)) {
    return { action: 'stop', reason };
  }
  if (NOT_MESSAGEABLE_RE.test(raw)) {
    return { action: 'skip', reason: 'Not messageable' };
  }
  return { action: 'skip', reason };
}

function usefulNotes(notes) {
  const lines = String(notes || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const splitAt = line.indexOf(':');
      if (splitAt === -1) return true;
      return line.slice(splitAt + 1).trim().length > 0;
    });
  return lines.join('\n');
}

function messageBody(message) {
  const text = String(message?.text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text;
  const placeholder = String(message?.placeholder || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (placeholder) return `(${placeholder.toLowerCase()})`;
  const kind = String(message?.kind || '').trim();
  if (kind && kind !== 'text' && kind !== 'empty') return `(${kind})`;
  return '';
}

function transcriptLines(messages) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-BUMP_HISTORY_LIMIT)
    .map((message) => {
      const body = messageBody(message);
      if (!body) return '';
      const stamp = berlinStamp(messageTimeMs(message) ?? message?.date);
      const who = message?.isOutgoing ? 'creator' : 'fan';
      return `[${stamp || 'unknown time'}] ${who}: ${body}`;
    })
    .filter(Boolean);
}

function buildBumpInput({ notes, messages, now = new Date() } = {}) {
  const noteText = usefulNotes(notes);
  const lines = transcriptLines(messages);
  const nowStamp = berlinStamp(now) || 'unknown';
  return [
    { role: 'system', content: BUMP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Current time in Germany: ${nowStamp}`,
        '',
        'Notes:',
        noteText || '(none)',
        '',
        'Chat, oldest first:',
        lines.length ? lines.join('\n') : '(no messages)',
        '',
        'Write the German message.',
      ].join('\n'),
    },
  ];
}

function cleanBumpText(output) {
  let result = stripModelTokens(output).replace(/\r\n/g, '\n').trim();
  if (!result) return '';
  result = result
    .replace(/^```(?:text|german|deutsch)?\s*\n([\s\S]*?)\n```$/i, '$1')
    .trim();
  result = result.replace(LABEL_PREFIX, '').trim();
  if (
    result.length >= 2 &&
    ((result.startsWith('"') && result.endsWith('"')) ||
      (result.startsWith('„') && result.endsWith('“')) ||
      (result.startsWith('“') && result.endsWith('”')) ||
      (result.startsWith("'") && result.endsWith("'")))
  ) {
    result = result.slice(1, -1).trim();
  }
  result = result.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (result.length <= BUMP_MAX_CHARS) return result;
  const clipped = result.slice(0, BUMP_MAX_CHARS);
  const sentence = clipped.match(/^[\s\S]*[.!?](?=\s|$)/);
  return (sentence ? sentence[0] : clipped).trim();
}

async function generateBump({ notes, messages, now } = {}) {
  const response = await createResponse({
    input: buildBumpInput({ notes, messages, now }),
  });
  const raw = response?.outputText;
  if (typeof raw !== 'string') return '';
  return cleanBumpText(raw);
}

module.exports = {
  BUMP_HISTORY_LIMIT,
  BUMP_RECENT_MS,
  BUMP_SYSTEM_PROMPT,
  berlinStamp,
  isRecentChat,
  bumpSkipReason,
  bumpErrorAction,
  usefulNotes,
  buildBumpInput,
  cleanBumpText,
  generateBump,
};
