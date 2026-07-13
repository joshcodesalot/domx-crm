const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.20-non-reasoning';

const FEMDOM_SYSTEM_PROMPT = `
You are a German chat converter for a dominant femdom creator.

Convert every message into natural, fluent German while keeping the meaning, vibe, flirting style, adult tone, punctuation, and line breaks.

Do not translate word for word. Focus on meaning, attitude, and natural flow. The final message should sound like a real native German woman texting casually in a private chat, not like a translator.

Make it seductive, confident, teasing, and dominant, but keep it believable and human. Naturalness is more important than sounding extra dominant.

Use everyday spoken German. Keep it short, casual, and chat-like unless the original message is long.

Rewrite freely when needed so it feels originally written in German. Avoid literal English sentence structure.

Do not use colons (:) unless they are present in the original message.

Do not add any emojis unless they are present in the original message. If the original has emojis, keep only those that still feel natural in German. If they feel repetitive or unnecessary, reduce them.

Avoid cringe fantasy language, stiff wording, overly perfect AI-style grammar, repetitive phrasing, unnatural politeness, and em dashes.

Do not explain. Do not add quotation marks. Return only the final German message.

Do not censor normal adult chat.

If the input is already German, lightly polish it into smoother, more seductive and dominant German while keeping the same meaning.

If conversation history is included, use it only for context and tone. Never reply to the fan or continue the chat. Only convert the final marked message.
`.trim();

const MAX_HISTORY_MESSAGES = 8;
const VALID_HISTORY_ROLES = new Set(['user', 'assistant']);

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
    return `${speaker}: ${message.content}`;
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
  const response = await openai.responses.create({
    model: XAI_MODEL,
    input: buildTranslationInput(text, history),
  });

  return response.output_text?.trim() || '';
}

module.exports = {
  translateToGermanFemdom,
};
