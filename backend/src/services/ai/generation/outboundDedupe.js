const RELATED_HINTS = [
  'selfie',
  'selca',
  'foto',
  'photo',
  'pic',
  'bild',
  'nackt',
  'nude',
  'ppv',
  'matcha',
  'video',
  'clip',
  'schick',
  'send',
];

const PET_NAME_PHRASES = [
  'braver junge',
  'good boy',
  'baby',
  'babe',
  'süsser',
  'süßer',
];

const DISTINCTIVE_CLOSERS = ['hoodie', 'sanft lenke', 'sanft lenken'];

const SIMILARITY_THRESHOLD = 0.72;
const RELATED_THRESHOLD = 0.45;
const SESSION_WINDOW_MS = 30 * 60 * 1000;
const SESSION_OUTBOUND_LIMIT = 2;

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeOutboundText(text) {
  return asText(text)
    .toLowerCase()
    .replace(/[\u2013\u2014\u2015]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text) {
  return new Set(normalizeOutboundText(text).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / new Set([...left, ...right]).size;
}

function relatedHintHits(text) {
  const normalized = normalizeOutboundText(text);
  if (!normalized) return new Set();
  const hits = new Set();
  for (const hint of RELATED_HINTS) {
    if (normalized.includes(hint)) hits.add(hint);
  }
  return hits;
}

function isRelatedPitch(a, b) {
  if (jaccard(a, b) >= RELATED_THRESHOLD) return true;
  const left = relatedHintHits(a);
  const right = relatedHintHits(b);
  for (const hint of left) {
    if (right.has(hint)) return true;
  }
  return false;
}

function hasPhrase(haystack, phrase) {
  return ` ${haystack} `.includes(` ${phrase} `);
}

function openerSpan(text) {
  const normalized = normalizeOutboundText(text);
  if (!normalized) return '';
  const clause = normalized.split(/[,.]/)[0] || '';
  return clause.split(' ').filter(Boolean).slice(0, 5).join(' ');
}

function petNameOpenerHits(text) {
  const opener = openerSpan(text);
  const hits = new Set();
  if (!opener) return hits;
  for (const phrase of PET_NAME_PHRASES) {
    if (hasPhrase(opener, phrase)) hits.add(phrase);
  }
  return hits;
}

function sharedPetNameOpener(a, b) {
  const left = petNameOpenerHits(a);
  const right = petNameOpenerHits(b);
  for (const name of left) {
    if (right.has(name)) return true;
  }
  return false;
}

function distinctiveCloserHits(text) {
  const normalized = normalizeOutboundText(text);
  const hits = new Set();
  if (!normalized) return hits;
  for (const phrase of DISTINCTIVE_CLOSERS) {
    if (normalized.includes(phrase)) hits.add(phrase === 'sanft lenken' ? 'sanft lenke' : phrase);
  }
  return hits;
}

function sharedDistinctiveCloser(a, b) {
  const left = distinctiveCloserHits(a);
  const right = distinctiveCloserHits(b);
  for (const phrase of left) {
    if (right.has(phrase)) return true;
  }
  return false;
}

function trailingEmoji(text) {
  const trimmed = asText(text).trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)\s*$/u);
  return match ? match[1] : null;
}

function sameTrailingEmoji(a, b) {
  const left = trailingEmoji(a);
  const right = trailingEmoji(b);
  return Boolean(left && right && left === right);
}

function newestSentAtMs(messages) {
  let newest = null;
  const list = Array.isArray(messages) ? messages : [];
  for (const msg of list) {
    const t = Date.parse(msg?.sentAt);
    if (!Number.isFinite(t)) continue;
    if (newest == null || t > newest) newest = t;
  }
  return newest;
}

function trailingCreatorOutbounds(messages, { limit = SESSION_OUTBOUND_LIMIT } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const newest = newestSentAtMs(list);
  const recent = [];
  for (let i = list.length - 1; i >= 0 && recent.length < limit; i -= 1) {
    const msg = list[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.direction !== 'outbound' || msg.senderRole === 'system') continue;
    const t = Date.parse(msg.sentAt);
    if (Number.isFinite(t) && newest != null && newest - t > SESSION_WINDOW_MS) {
      continue;
    }
    recent.push(msg);
  }
  return recent.reverse();
}

function isDuplicatePair(draftText, previousText) {
  const previous = asText(previousText).trim();
  if (!previous) return false;
  if (jaccard(draftText, previous) >= SIMILARITY_THRESHOLD) return true;
  if (isRelatedPitch(draftText, previous)) return true;
  if (sharedPetNameOpener(draftText, previous)) return true;
  if (sharedDistinctiveCloser(draftText, previous)) return true;
  if (
    sameTrailingEmoji(draftText, previous) &&
    (sharedPetNameOpener(draftText, previous) ||
      sharedDistinctiveCloser(draftText, previous) ||
      jaccard(draftText, previous) >= RELATED_THRESHOLD)
  ) {
    return true;
  }
  return false;
}

function evaluateOutboundDedupe({ messages, draft, lastUnsentText } = {}) {
  const draftText = asText(draft).trim();
  if (!draftText) return { ok: true, flags: [] };

  if (isDuplicatePair(draftText, lastUnsentText)) {
    return { ok: false, flags: ['duplicate_outbound'] };
  }

  const recent = trailingCreatorOutbounds(messages);
  for (const msg of recent.slice(-2)) {
    if (isDuplicatePair(draftText, msg.text)) {
      return { ok: false, flags: ['duplicate_outbound'] };
    }
  }

  if (recent.length >= 2) {
    const previous = recent[recent.length - 2];
    const last = recent[recent.length - 1];
    if (
      isRelatedPitch(previous.text, last.text) &&
      isRelatedPitch(draftText, last.text)
    ) {
      return { ok: false, flags: ['duplicate_outbound'] };
    }
  }

  return { ok: true, flags: [] };
}

module.exports = {
  RELATED_HINTS,
  SIMILARITY_THRESHOLD,
  SESSION_WINDOW_MS,
  normalizeOutboundText,
  jaccard,
  trailingCreatorOutbounds,
  evaluateOutboundDedupe,
};
