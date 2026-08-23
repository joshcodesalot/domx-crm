function refId(item) {
  if (item && typeof item === 'object') {
    return String(item.id || item._id || '').trim();
  }
  return String(item || '').trim();
}

function refName(item) {
  if (item && typeof item === 'object') {
    return String(item.name || '').trim();
  }
  return '';
}

function asNamedRefs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const id = refId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: refName(item) });
  }
  return out;
}

function asIdList(value) {
  return asNamedRefs(value).map((ref) => ref.id);
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function isManagedChatList(list) {
  const name = String(list?.name || '').trim();
  return Boolean(list?.isManaged) || /^__[\w]+__$/.test(name);
}

function liveItemId(item) {
  return String(item?._id || item?.id || '').trim();
}

function findDefaultIncludeList(lists) {
  const list = Array.isArray(lists) ? lists : [];
  const named = list.find(
    (item) => String(item?.name || '').trim() === '__0h7fd89v__'
  );
  if (liveItemId(named)) return named;
  return list.find((item) => isManagedChatList(item) && liveItemId(item)) || null;
}

function toLiveRef(item) {
  const id = liveItemId(item);
  if (!id) return null;
  return { id, name: String(item?.name || '').trim() };
}

function resolveNamedRefs(requested, liveItems, { fallbackDefault = false } = {}) {
  const byId = new Map();
  const byName = new Map();
  for (const item of Array.isArray(liveItems) ? liveItems : []) {
    const ref = toLiveRef(item);
    if (!ref) continue;
    byId.set(ref.id, ref);
    const key = normalizeName(ref.name);
    if (key && !byName.has(key)) byName.set(key, ref);
  }

  const out = [];
  const seen = new Set();
  for (const ref of asNamedRefs(requested)) {
    const live =
      byId.get(ref.id) ||
      (ref.name ? byName.get(normalizeName(ref.name)) : null);
    if (!live || seen.has(live.id)) continue;
    seen.add(live.id);
    out.push(live);
  }

  if (fallbackDefault && out.length === 0) {
    const fallback = toLiveRef(findDefaultIncludeList(liveItems));
    if (fallback) out.push(fallback);
  }
  return out;
}

function refsEqual(left, right) {
  const a = asNamedRefs(left);
  const b = asNamedRefs(right);
  if (a.length !== b.length) return false;
  return a.every((ref, index) => ref.id === b[index].id && ref.name === b[index].name);
}

function pickRequested(payloadValue, settingsValue) {
  const fromPayload = asNamedRefs(payloadValue);
  return fromPayload.length ? fromPayload : asNamedRefs(settingsValue);
}

module.exports = {
  asNamedRefs,
  asIdList,
  findDefaultIncludeList,
  isManagedChatList,
  resolveNamedRefs,
  refsEqual,
  pickRequested,
};
