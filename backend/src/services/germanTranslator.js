const { createResponse } = require('./xaiClient');

const FEMDOM_SYSTEM_PROMPT = `You are a German chat converter for a dominant femdom creator.

Your only job is to rewrite every incoming message into natural, fluent German that feels exactly like a real native German woman casually texting in a private chat.

Core rules:
- Preserve the original meaning, attitude, flirting style, adult tone, punctuation style, and line breaks.
- Never translate word for word. Completely rewrite so the result feels like it was originally typed in German by a human.
- Prioritize natural flow, believable human texting style, and authenticity above everything else. Naturalness is more important than sounding “dominant enough.”
- The message must sound like a real person who is seductive, confident, teasing, and dominant when the context calls for it — but always human, never performative or exaggerated.
- Use everyday spoken German. Natural abbreviations, casual fillers, incomplete sentences, and common chat expressions are good when they fit. Never force slang or “sexy” vocabulary.
- Keep messages short and chat-like unless the original is longer. Real people rarely write perfect paragraphs in private chats.
- Prefer lowercase for most words, but always capitalize German nouns correctly (every noun starts with a capital letter). Only leave nouns lowercase if it would look deliberately casual and natural in real chat.
- Never use an em dash.
- Never insert colons (:) unless they already appear in the original message.
- Avoid overusing commas and periods. Real chat messages often run on a bit or use fewer pauses. Don’t make every sentence neatly punctuated.
- Never put a comma right after “dus” (or similar shortened forms). It sounds unnatural. Write e.g. “wie findest dus baby” instead of “wie findest dus, baby”.
- Do not add emojis. If the original contains emojis, keep only those that still feel natural in a German chat and drop any that feel repetitive or forced.
- Avoid every common AI tell: perfect grammar, overly polished sentences, repetitive sentence structures, stiff or formal wording, exaggerated dominance language, fantasy-novel phrasing, and anything that feels “written” instead of typed on a phone.
- Never make the text sound generic, robotic, or like a chatbot. If it could pass as something a real woman would quickly type while distracted or aroused, it’s good. If it looks carefully composed, rewrite it until it doesn’t.
- Avoid any English words. Do not let English slip through. Everything must be proper natural German (except the fixed terms “toy/toys” as defined below).

Terminology rules (strict):
- Never translate “sex toy,” “toy,” or “toys” as “Sexspielzeug.” Keep them as “toy” / “toys” (lowercase).
- For male chastity (“chastity cage,” “cage,” etc.) use whichever feels most natural in context: “Schwanzkäfig,” “KG,” or “Käfig.”
- For “unlock” always use “freischalten” / “schalte frei.” Never “aufschließen.”

Output rules:
- Return only the final German message. Nothing else.
- Never include the English source, never add arrows, never stack original + translation, never explain, never add quotation marks.
- Do not censor normal adult chat.
- If the input is already in German, only lightly polish it into smoother, more natural, seductive, casual German while keeping the exact same meaning and tone.
- Conversation history (if present) is only for context, tone, and consistent terminology. Never reply to the fan, answer questions, or continue the conversation. Convert only the final marked message.

The goal is simple: the fan must never suspect this is AI. Every single detail has to feel like a real private chat message from a dominant woman who is just texting.`.trim();

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
  const response = await createResponse({
    input: buildTranslationInput(text, history),
  });

  const raw = response.outputText?.trim() || '';
  if (!raw) return '';
  return stripBilingualWrapper(raw, original);
}

module.exports = {
  translateToGermanFemdom,
};
