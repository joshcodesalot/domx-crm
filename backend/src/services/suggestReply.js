const OpenAI = require('openai');
const { translateToGermanFemdom } = require('./germanTranslator');

const openai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.20-non-reasoning';

const MAX_MESSAGES = 12;
const VALID_ROLES = new Set(['user', 'assistant']);

const SUGGEST_SYSTEM_PROMPT = `You draft reply suggestions for a dominant femdom creator who messages fans.
Return exactly two English reply drafts as JSON only (no markdown, no explanation):
{"rapport":"...","upsell":"..."}
Rules:

Write as the creator (assistant), short casual chat texts a real woman would send.
Stay seductive, confident, teasing, and dominant, but believable and human.
Never use an em dash.
Do not use colons (:) unless needed for a natural chat message.
Do not invent specific PPV prices, unlock amounts, media filenames, or claim media was already sent.
Before suggesting or saying anything like "unlock now", first check the conversation context whether a PPV was already sent. Only push unlock if one is present.
Do not censor normal adult chat.
Use fan notes for kinks, limits, VIP status, and personal details when present. Respect limits.
Never invent or use the fan's platform username or real name. Only address them with a provided nickname or an occasional pet name as instructed in the user message.
Drafts must be in English for the chatter to review (German is added separately).
Continuity: reply to the latest fan message using recent conversation context.

rapport (tame):

Build rapport: warmth, curiosity, connection, light teasing.
No hard sell, no PPV push, no aggressive sexting.

upsell (aggressive):

Flirty/sexual escalation and/or a soft upsell toward paid content.
Still natural chat — not a sales script. No fake prices.
Only reference unlocking if a PPV is confirmed present in the context.

After the English drafts are ready, convert every message into natural, fluent German while keeping the original meaning, vibe, flirting style, adult tone, punctuation, and line breaks.
Do not translate word for word. Focus on meaning, attitude, and natural flow. The final message should sound like a real native German woman texting casually in a private chat, not like a translator.
Make it seductive, confident, teasing, and dominant, but keep it believable and human. Naturalness is more important than sounding overly dominant.
Use everyday spoken German. Add natural German chat slang, abbreviations, and casual expressions only when they fit the moment and tone (e.g. geil, krass, digga, ey, haha, lol, omg, bisschen, voll, richtig, einfach, schon, noch, mal, etc.). Never force slang into every message. Prefer clean, confident texting over heavy slang. Keep the dominant vibe through attitude and word choice, not through exaggerated or try-hard expressions.
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
Examples:

“you should unlock to see..” → “du solltest es freischalten um zu sehen”
“unlock it” → “schalte es frei”

Do not explain anything.
Do not add quotation marks.
Return only the final German message.
Do not censor normal adult chat.`.trim();

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message) => {
      if (!message || typeof message !== 'object') return false;
      const role = message.role;
      const content =
        typeof message.content === 'string' ? message.content.trim() : '';
      return VALID_ROLES.has(role) && content.length > 0;
    })
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .slice(-MAX_MESSAGES);
}

function formatConversation(messages) {
  return messages
    .map((message) => {
      const speaker = message.role === 'assistant' ? 'Creator' : 'Fan';
      return `${speaker}: ${message.content}`;
    })
    .join('\n');
}

function buildSuggestInput({ messages, fanNotes, fanNickname }) {
  const normalized = normalizeMessages(messages);
  const parts = [];
  const nickname =
    typeof fanNickname === 'string' ? fanNickname.trim() : '';

  if (nickname) {
    parts.push(
      `Fan nickname: ${nickname}\nAddressing: use this nickname naturally when it fits (not every sentence). Do not use any other name for the fan.`
    );
  } else {
    parts.push(
      'Fan nickname: (none)\nAddressing: do not use any platform username or real name. Occasionally address the fan with a pet name like "slave" or "my little one" when it feels natural — skip often so drafts stay varied. Do not force a pet name into both rapport and upsell.'
    );
  }

  const notes = typeof fanNotes === 'string' ? fanNotes.trim() : '';
  if (notes) {
    parts.push(`Fan notes:\n${notes}`);
  }

  if (normalized.length > 0) {
    parts.push(`Recent conversation:\n${formatConversation(normalized)}`);
  } else {
    parts.push('Recent conversation: (none yet — draft a short opener as the creator)');
  }

  parts.push(
    'Draft the two English replies now. Return only the JSON object.'
  );

  return [
    { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function draftEnglishSuggestions({ messages, fanNotes, fanNickname }) {
  const response = await openai.responses.create({
    model: XAI_MODEL,
    input: buildSuggestInput({ messages, fanNotes, fanNickname }),
  });

  const parsed = extractJsonObject(response.output_text);
  const rapport =
    typeof parsed?.rapport === 'string' ? parsed.rapport.trim() : '';
  const upsell =
    typeof parsed?.upsell === 'string' ? parsed.upsell.trim() : '';

  if (!rapport || !upsell) {
    throw new Error('Suggest reply returned incomplete drafts');
  }

  return { rapport, upsell };
}

async function suggestReply({ messages, fanNotes, fanNickname }) {
  const normalized = normalizeMessages(messages);
  const { rapport, upsell } = await draftEnglishSuggestions({
    messages: normalized,
    fanNotes,
    fanNickname,
  });

  const history = normalized.slice(-8);

  const [rapportDe, upsellDe] = await Promise.all([
    translateToGermanFemdom(rapport, history),
    translateToGermanFemdom(upsell, history),
  ]);

  if (!rapportDe?.trim() || !upsellDe?.trim()) {
    throw new Error('Suggest reply translation returned empty text');
  }

  return {
    suggestions: [
      {
        id: 'rapport',
        label: 'Rapport',
        english: rapport,
        german: rapportDe.trim(),
      },
      {
        id: 'upsell',
        label: 'Upsell',
        english: upsell,
        german: upsellDe.trim(),
      },
    ],
  };
}

module.exports = {
  suggestReply,
  normalizeMessages,
};
