const xai = require('./xaiClient');
const { stripModelTokens } = require('./germanTranslator');

const BUMP_HISTORY_LIMIT = 40;
const BUMP_RECENT_MS = 2 * 60 * 60 * 1000;
const BUMP_STALE_MS = 2 * 24 * 60 * 60 * 1000;
const BUMP_MAX_CHARS = 500;

const BERLIN_TIME_ZONE = 'Europe/Berlin';

const NOT_MESSAGEABLE_RE =
  /USER_PRIVACY_RESTRICTED|USER_IS_BLOCKED|YOU_BLOCKED_USER|INPUT_USER_DEACTIVATED|USER_DEACTIVATED|CHAT_WRITE_FORBIDDEN|PEER_ID_INVALID|USER_BOT|CHAT_ADMIN_REQUIRED|USER_BANNED|does not allow messages|no longer available|cannot be added/i;

const SESSION_DEAD_RE =
  /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|session expired/i;

const LABEL_PREFIX =
  /^(?:German|Deutsch|Translation|Übersetzung|Final German|Bump|Message)\s*:\s*/i;

const GERMAN_SAMPLES = [
  'was machst du gerade?',
  "na, was gibt's neues?",
  "wie läuft's bei dir?",
  'was treibst du so?',
  'alles gut bei dir?',
  'und, was steht bei dir so an?',
  'woran denkst du gerade?',
  'wie war dein tag bisher?',
  'bist du gerade beschäftigt?',
  'erzähl mal, was geht bei dir so?',
  'Hey, ich bin gerade bisschen gelangweilt haha',
  'ich brauch gerade etwas Unterhaltung, bist du da?',
  'irgendwie ist heute ein komischer tag',
  'mir ist gerade nach bisschen quatschen, meld dich falls du ungestört bist',
  'ich hab gerade so meine 5 minuten',
  'Hey, ich wollte mich einfach mal melden',
  'irgendwie musste ich gerade an dich denken',
];

const GERMAN_WORD_RE =
  /^(?:ich|bin|gerade|du|dir|dich|und|nicht|das|ist|wie|was|mal|schon|eine|der|die|den)$/u;
const ENGLISH_WORD_RE = /^(?:the|you|what|your|are|doing)$/u;

const BUMP_SYSTEM_PROMPT = `
You write one private Telegram message for the model. She is always a femdom woman. The fan is the submissive. This does not change from chat to chat.

Lines labeled "model (you already sent this)" are messages she already sent. Lines labeled "fan (he sent this)" are his. You speak only as the model. Do not answer in the fan's voice, and do not copy a title he uses for her.

A model line is a message she already sent. Never answer a model line, and never treat it as something the fan said. If the last line is hers and the thread is still fresh, continue as her. Do not reply to her own question.

When the user message says the thread is stale, send one new short opener in the chat's language. Do not mention or continue the old topic.

Never call the fan Herrin, Mistress, Goddess, Domina, or any dominant title. Never ask him for tasks, and never offer to obey. Do not invent a nickname. Never call the fan by his Telegram username or @handle, including one copied from the notes, his display name, or his messages. A handle is not a name. Use a name or pet name only when a model line in this chat already uses it. If none of her lines name him, do not call him anything.

You receive that fan's notes, the last 40 messages, and the current time in Germany. Every timestamp is already German time (Europe/Berlin). The named part of day is context only, so the message does not contradict the hour.

Write the next line in this chat, not the opening of a new session. One or two short sentences, the way she texts. Follow up on the latest written line, or continue whatever is still open in that history. A pet name from the notes is not enough.

No greeting of any kind: Guten Morgen, Guten Tag, Guten Abend, Guten Nacht, Moin, Morgen, Hallo, Hi, Hey, Hello, Na, Servus, good morning, good afternoon, good evening, good night, or the fan's name used as a hello. Do not mention sleep, "es ist schon eine Weile her", or "heute Abend". Do not announce the hour or the gap.

If the fan sent the last message, answer that message. A short gap is a normal reply. A long gap still answers him, without saying how long it has been.

If the model sent the last message, do not repeat her last line and do not greet. Nudge the same thread, or pick up one concrete thing still open in the history.

One short line. A question is allowed when it fits, and so is a statement. Do not paste an example unchanged, and do not send the same line to every fan. Follow the last message in the chat. Write in the language of the recent chat. German examples do not switch the language.

Write in the language of the recent chat, especially the latest text from the model and the fan. If the thread mixes languages, follow the latest messages. If the history has no written text, write German.

Write like a real person continuing this private conversation, not like an AI assistant. Natural continuation comes before trying to get a reply.

Use the latest messages, anything still unanswered, and the notes. Respond to the meaning and tone, not just keywords. Do not ask something the chat or the notes already answered. Do not ask a question in every message. A short statement, reaction, or playful comment is enough.

Do not repeat a phrase, sentence shape, or pattern, including the same idea in different words. Do not open a new topic while this one can continue. If he shares something personal, acknowledge it before moving on.

Match her vocabulary, punctuation, and how dominant her recent messages already are. Do not become more dominant, softer, or switch character. A casual thread stays casual. A dominant thread stays at that same level. Do not force flirting, domination, or selling onto it.

Do not invent memories, personal experiences, promises, products, prices, availability, plans, media, or feelings that are not in the notes or the chat. Do not mention notes, timestamps, bumps, lists, or automation. Do not add emojis unless her recent messages already use them. Do not add slang or typos on purpose. No greeting templates, no labels, no quotation marks.

Before the final line, silently check that it fits this chat, does not repeat a recent line, keeps her personality, and sounds like a text. Do not print that check.

Output only the message. Do not name the language.
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

function berlinDayPart(value) {
  const parts = berlinParts(value);
  if (!parts) return '';
  const hour = Number(parts.hour);
  if (!Number.isFinite(hour)) return '';
  if (hour >= 22 || hour <= 4) return 'night';
  if (hour < 11) return 'morning';
  if (hour <= 16) return 'day';
  return 'evening';
}

function germanTimeLabel(value) {
  const stamp = berlinStamp(value);
  return stamp ? `${stamp}, German time` : '';
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

function isDeletedMessage(message) {
  return Boolean(message?.deleted);
}

function latestMessageMs(messages) {
  let latest = null;
  for (const message of messages || []) {
    if (isDeletedMessage(message)) continue;
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
  if (SESSION_DEAD_RE.test(raw) || /(?:OPENROUTER|XAI)_API_KEY is not set/i.test(raw)) {
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

function transcriptSpeaker(message, options) {
  const kind = options?.kind;
  if (kind === 'group') {
    const name = String(message?.senderName || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name) return name;
  }
  const selfId = options?.selfId != null ? String(options.selfId) : '';
  const senderId = message?.senderId != null ? String(message.senderId) : '';
  if (message?.isOutgoing || (selfId && senderId === selfId)) return 'model';
  return 'fan';
}

function transcriptLabel(who) {
  if (who === 'model') return 'model (you already sent this)';
  if (who === 'fan') return 'fan (he sent this)';
  return who;
}

function transcriptLines(messages, options) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-BUMP_HISTORY_LIMIT)
    .map((message) => {
      if (isDeletedMessage(message)) return '';
      const body = messageBody(message);
      if (!body) return '';
      const stamp = germanTimeLabel(messageTimeMs(message) ?? message?.date);
      const who = transcriptLabel(transcriptSpeaker(message, options));
      return `[${stamp || 'unknown time'}] ${who}: ${body}`;
    })
    .filter(Boolean);
}

function pluralAgo(count, unit) {
  const n = Math.max(1, count);
  return n === 1 ? `1 ${unit} ago` : `${n} ${unit}s ago`;
}

function elapsedAgo(deltaMs) {
  const delta = Math.max(0, Number(deltaMs) || 0);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < hour) return pluralAgo(Math.round(delta / minute), 'minute');
  if (delta < 2 * day) return pluralAgo(Math.round(delta / hour), 'hour');
  return pluralAgo(Math.round(delta / day), 'day');
}

function newestWrittenMessage(messages, options) {
  let latest = null;
  let latestMs = null;
  const history = Array.isArray(messages) ? messages.slice(-BUMP_HISTORY_LIMIT) : [];
  for (const message of history) {
    if (isDeletedMessage(message) || !messageBody(message)) continue;
    const ms = messageTimeMs(message);
    if (latest == null || (ms != null && (latestMs == null || ms >= latestMs))) {
      latest = message;
      latestMs = ms;
    }
  }
  return { message: latest, ms: latestMs };
}

function lastMessageLine(messages, now, options) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const { message: latest, ms: latestMs } = newestWrittenMessage(messages, options);
  if (!latest) return 'Last message: there is no last message.';
  const who = transcriptSpeaker(latest, options);
  if (latestMs == null || !Number.isFinite(nowMs)) {
    return `Last message: ${who} at unknown time.`;
  }
  const stamp = berlinStamp(latestMs) || 'unknown time';
  return `Last message: ${who} at ${stamp} German time, ${elapsedAgo(nowMs - latestMs)}.`;
}

function writtenBodies(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => !isDeletedMessage(message) && messageBody(message))
    .slice(-8)
    .map((message) => messageBody(message));
}

function chatLanguage(messages) {
  const bodies = writtenBodies(messages);
  if (!bodies.length) return 'german';
  const words = bodies.join(' ').toLowerCase().match(/\p{L}+/gu) || [];
  let german = 0;
  let english = 0;
  for (const word of words) {
    if (GERMAN_WORD_RE.test(word)) german += 1;
    if (ENGLISH_WORD_RE.test(word)) english += 1;
  }
  if (german > english) return 'german';
  if (english > german) return 'english';
  return 'other';
}

function germanSampleBlock() {
  return [
    'The recent chat is German. Write in German.',
    'German examples of length and tone. Do not paste an example unchanged.',
    ...GERMAN_SAMPLES.map((line) => `- ${line}`),
  ];
}

function threadIsStale(messages, now) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const { ms } = newestWrittenMessage(messages);
  if (ms == null || !Number.isFinite(nowMs)) return false;
  return nowMs - ms > BUMP_STALE_MS;
}

function buildBumpInput({ notes, messages, now = new Date(), selfId = null } = {}) {
  const options = { selfId };
  const noteText = usefulNotes(notes);
  const lines = transcriptLines(messages, options);
  const nowStamp = berlinStamp(now) || 'unknown';
  const dayPart = berlinDayPart(now);
  const stale = threadIsStale(messages, now);
  const language = chatLanguage(messages);
  const languageLine =
    language === 'german'
      ? null
      : language === 'english'
        ? 'The recent chat is English. Write one short line in English only.'
        : 'Write one short line in the language of the recent chat only.';
  return [
    { role: 'system', content: BUMP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Current time in Germany: ${nowStamp}${dayPart ? ` (${dayPart})` : ''}`,
        lastMessageLine(messages, now, options),
        ...(stale
          ? [
              'This thread is stale. Send a new opener and do not continue the old topic.',
            ]
          : []),
        ...(language === 'german' ? germanSampleBlock() : languageLine ? [languageLine] : []),
        '',
        'Notes:',
        noteText || '(none)',
        '',
        'Chat, oldest first:',
        lines.length ? lines.join('\n') : '(no messages)',
        '',
        stale
          ? 'Write a new opener in the chat language. Do not continue the old topic.'
          : 'Write the message in the chat language.',
      ].join('\n'),
    },
  ];
}

function normalizeBumpLine(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DROPPED_SAMPLE_LINES = ['so, da bin ich wieder'];
const GERMAN_SAMPLE_KEYS = new Set(
  [...GERMAN_SAMPLES, ...DROPPED_SAMPLE_LINES].map((line) => normalizeBumpLine(line))
);

function matchesGermanSample(text) {
  const key = normalizeBumpLine(text);
  return Boolean(key) && GERMAN_SAMPLE_KEYS.has(key);
}

const NAME_WORD = String.raw`(?:mein(?:e|em|en)?|my|lieber|liebe|liebling|baby|babe|\p{Lu}[\p{L}'’-]*)`;
const LEADING_GREETING_RE =
  /^(?:guten\s+(?:morgen|tag|abend|nacht)|good\s+(?:morning|afternoon|evening|night)|moin(?:\s+moin)?|hallo|hello|hiya|heya|hey|hi|na|servus|gr(?:ü|ue)(?:ß|ss)\s+dich|morgen)\b[.!,…:\s]*/iu;
const LEADING_VOCATIVE_RE = new RegExp(
  `^${NAME_WORD}(?:\\s+${NAME_WORD}){0,2}\\s*[,.!…]\\s*`,
  'u'
);
const ONLY_NAME_RE = new RegExp(`^${NAME_WORD}(?:\\s+${NAME_WORD}){0,2}$`, 'u');

function stripLeadingGreeting(text) {
  const match = String(text || '').match(LEADING_GREETING_RE);
  if (!match) return text;
  let rest = text.slice(match[0].length).trim();
  const vocative = rest.match(LEADING_VOCATIVE_RE);
  if (vocative) rest = rest.slice(vocative[0].length).trim();
  rest = rest.replace(/^[,.!\s]+/, '').trim();
  if (!rest || ONLY_NAME_RE.test(rest)) return '';
  return rest.replace(/^(\p{Ll})/u, (letter) => letter.toUpperCase());
}

function cleanBumpText(output, messages) {
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
  result = stripLeadingGreeting(result);
  if (!result) return '';
  if (matchesGermanSample(result)) return '';
  if (result.length <= BUMP_MAX_CHARS) return result;
  const clipped = result.slice(0, BUMP_MAX_CHARS);
  const sentence = clipped.match(/^[\s\S]*[.!?](?=\s|$)/);
  return (sentence ? sentence[0] : clipped).trim();
}

async function generateBump({ notes, messages, now, selfId } = {}) {
  const response = await xai.createResponse({
    input: buildBumpInput({ notes, messages, now, selfId }),
  });
  const raw = response?.outputText;
  if (typeof raw !== 'string') return '';
  return cleanBumpText(raw, messages);
}

module.exports = {
  BUMP_HISTORY_LIMIT,
  BUMP_RECENT_MS,
  BUMP_SYSTEM_PROMPT,
  berlinStamp,
  berlinDayPart,
  isRecentChat,
  bumpSkipReason,
  bumpErrorAction,
  usefulNotes,
  transcriptLines,
  buildBumpInput,
  cleanBumpText,
  generateBump,
  normalizeBumpLine,
};
