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

const SIMILARITY_THRESHOLD = 0.72;
const RELATED_THRESHOLD = 0.45;

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

function trailingCreatorOutbounds(messages) {
  const recent = [];
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.direction === 'inbound') break;
    if (msg.direction === 'outbound' && msg.senderRole !== 'system') {
      recent.push(msg);
    }
  }
  return recent.reverse();
}

function evaluateOutboundDedupe({ messages, draft, lastUnsentText } = {}) {
  const draftText = asText(draft).trim();
  if (!draftText) return { ok: true, flags: [] };

  if (lastUnsentText && jaccard(draftText, lastUnsentText) >= SIMILARITY_THRESHOLD) {
    return { ok: false, flags: ['duplicate_outbound'] };
  }
  if (lastUnsentText && isRelatedPitch(draftText, lastUnsentText)) {
    return { ok: false, flags: ['duplicate_outbound'] };
  }

  const recent = trailingCreatorOutbounds(messages);
  for (const msg of recent.slice(-2)) {
    if (jaccard(draftText, msg.text) >= SIMILARITY_THRESHOLD) {
      return { ok: false, flags: ['duplicate_outbound'] };
    }
    if (isRelatedPitch(draftText, msg.text)) {
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
  normalizeOutboundText,
  jaccard,
  trailingCreatorOutbounds,
  evaluateOutboundDedupe,
};
