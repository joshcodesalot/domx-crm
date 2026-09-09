const HEX_ID_RE = /^[a-f0-9]{24}$/i;
const LONG_NUMERIC_RE = /^\d{8,}$/;

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function looksLikeOpaqueId(value) {
  const text = asText(value).trim();
  if (!text) return true;
  if (HEX_ID_RE.test(text)) return true;
  if (LONG_NUMERIC_RE.test(text)) return true;
  return false;
}

function sanitizeFanUsername(value) {
  let text = asText(value).trim();
  if (!text) return null;
  if (text.startsWith('@')) text = text.slice(1).trim();
  if (!text || looksLikeOpaqueId(text)) return null;
  return text;
}

function nameFromNotes(notes) {
  const text = asText(notes);
  if (!text.trim()) return null;
  const match = text.match(
    /(?:^|\n)\s*(?:name|given\s*name|vorname)\s*[:\-]\s*([^\n,;/]+)/i
  );
  if (!match) return null;
  const candidate = match[1].trim();
  if (!candidate || looksLikeOpaqueId(candidate)) return null;
  return candidate;
}

function nameFromMemories(memories) {
  for (const fact of Array.isArray(memories) ? memories : []) {
    if (!fact || fact.kind !== 'name') continue;
    const text = asText(fact.text).trim();
    if (text && !looksLikeOpaqueId(text)) return text;
  }
  return null;
}

function resolveGivenName({
  statedName,
  nickname,
  notes,
  memories,
  username,
} = {}) {
  const usernameNorm = sanitizeFanUsername(username);
  const candidates = [
    asText(statedName).trim() || null,
    asText(nickname).trim() || null,
    nameFromMemories(memories),
    nameFromNotes(notes),
  ];
  for (const candidate of candidates) {
    if (!candidate || looksLikeOpaqueId(candidate)) continue;
    if (usernameNorm && candidate.toLowerCase() === usernameNorm.toLowerCase()) {
      continue;
    }
    return candidate;
  }
  return null;
}

function displayFanLabel({
  nickname,
  fanLabel,
  fanUsername,
  platformFanId,
} = {}) {
  const candidates = [nickname, fanLabel, fanUsername];
  for (const candidate of candidates) {
    const text = asText(candidate).trim();
    if (text && !looksLikeOpaqueId(text)) return text;
  }
  void platformFanId;
  return 'Fan';
}

module.exports = {
  looksLikeOpaqueId,
  sanitizeFanUsername,
  nameFromNotes,
  nameFromMemories,
  resolveGivenName,
  displayFanLabel,
};
