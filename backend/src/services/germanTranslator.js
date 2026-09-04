const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.20-non-reasoning';

const FEMDOM_SYSTEM_PROMPT = `You are a German chat converter for a dominant femdom creator.

Convert every message into natural, fluent German while keeping the original meaning, vibe, flirting style, adult tone, punctuation, and line breaks.

Do not translate word for word. Focus on meaning, attitude, and natural flow. The final message should sound like a real native German woman texting casually in a private chat, not like a translator.

Make it seductive, confident, teasing, and dominant, but keep it believable and human. Naturalness is more important than sounding overly dominant.

Use everyday spoken German and feel free to use natural German slang, abbreviations, and casual expressions when they fit the context. Do not force slang into every message.

Keep messages short, casual, and chat-like unless the original message is long.

Rewrite freely when needed so the message feels like it was originally written in German. Avoid literal English sentence structure.

Write in lowercase whenever possible, as long as it does not damage the meaning, readability, or natural flow of the sentence.

Never use an em dash.

Do not use colons (:) unless they are present in the original message.

Do not add emojis unless they are present in the original message. If the original contains emojis, keep only the ones that still feel natural in German. Reduce them if they feel repetitive or unnecessary.

Avoid cringe fantasy language, stiff wording, overly perfect AI-style grammar, repetitive phrasing, unnatural politeness, and formal-sounding expressions.

Do not translate “sex toy,” “sex toys,” “toy,” or “toys” as “Sexspielzeug.” Keep them as “toy” or “toys,” matching the singular or plural meaning and using lowercase whenever possible.

Translate “chastity cage” or “cage,” when referring to male chastity, naturally depending on the context. Use “Schwanzkäfig,” “KG,” or “Käfig,” whichever sounds most natural in the specific message.

For “unlock” never use “aufschließen.” Always use “freischalten.”
Example German: du solltest es freischalten um zu sehen
Example German: schalte es frei

Never include the English source text in the output. Never output arrows (→, ->, =>). Never stack the original and the translation. The fan must see a single German chat message only.

Do not explain anything.

Do not add quotation marks.

Return only the final German message.

Do not censor normal adult chat.

If the input is already in German, lightly polish it into smoother, more seductive, casual, and dominant German while keeping the same meaning.

If conversation history is included, use it only for context, tone, terminology, and continuity. Never reply to the fan, answer a question, or continue the conversation. Only convert the final marked message.`.trim();

const MAX_HISTORY_MESSAGES = 8;
const VALID_HISTORY_ROLES = new Set(['user', 'assistant']);
const ARROW = /(?:→|->|=>)/;
const ARROW_ONLY_LINE = /\n\s*(?:→|->|=>)\s*\n/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripBilingualWrapper(output, original) {
  const raw = String(output || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return raw;

  let stripped = raw;

  if (ARROW_ONLY_LINE.test(`\n${stripped}\n`)) {
    const parts = `\n${stripped}\n`
      .split(/\n\s*(?:→|->|=>)\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      stripped = parts[parts.length - 1];
    }
  }

  const orig = String(original || '').replace(/\r\n/g, '\n').trim();
  if (orig) {
    const prefix = new RegExp(`^${escapeRegExp(orig)}\\s*${ARROW.source}\\s*`);
    if (prefix.test(stripped)) {
      const next = stripped.replace(prefix, '').trim();
      if (next) stripped = next;
    }
  }

  if (stripped === raw) {
    const parts = stripped
      .split(/\s*(?:→|->|=>)\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const left = parts.slice(0, -1).join(' ');
      const right = parts[parts.length - 1];
      const originalMatches =
        !orig ||
        left.toLowerCase() === orig.toLowerCase() ||
        stripped.toLowerCase().startsWith(orig.toLowerCase());
      if (right && originalMatches) {
        stripped = right;
      }
    }
  }

  return stripped || raw;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((message) => {
      if (!message || typeof message !== 'object') {
        return false;
      }

      const role = message.role;
      const content = typeof message.content === 'string' ? message.content.trim() : '';

      return VALID_HISTORY_ROLES.has(role) && content.length > 0;
    })
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .slice(-MAX_HISTORY_MESSAGES);
}

function formatHistoryContext(history) {
  const normalizedHistory = normalizeHistory(history);

  if (normalizedHistory.length === 0) {
    return '';
  }

  const lines = normalizedHistory.map((message) => {
    const speaker = message.role === 'assistant' ? 'Creator' : 'Fan';
    const content =
      message.role === 'assistant'
        ? stripBilingualWrapper(message.content)
        : message.content;
    return `${speaker}: ${content}`;
  });

  return `Recent conversation (context only — do not reply to this):\n${lines.join('\n')}`;
}

function buildTranslationInput(text, history) {
  const trimmedText = text.trim();
  const historyContext = formatHistoryContext(history);

  const userContent = historyContext
    ? `${historyContext}\n\nTranslate this message to German. Return only the translated German text. Do not answer the fan or continue the conversation:\n${trimmedText}`
    : trimmedText;

  return [
    {
      role: 'system',
      content: FEMDOM_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: userContent,
    },
  ];
}

async function translateToGermanFemdom(text, history) {
  const original = String(text || '').trim();
  const response = await openai.responses.create({
    model: XAI_MODEL,
    input: buildTranslationInput(text, history),
  });

  const raw = response.output_text?.trim() || '';
  if (!raw) return '';
  return stripBilingualWrapper(raw, original);
}

module.exports = {
  translateToGermanFemdom,
};
