export const HISTORY_AUTO_TRANSLATE_LIMIT = 20;

/**
 * Newest-first eligible messages. Already-translated rows inside the
 * window still occupy a slot, so older history is not pulled in to fill it.
 */
export function selectAutoHistoryTranslations(
  itemsNewestFirst,
  alreadyTranslated,
  limit = HISTORY_AUTO_TRANSLATE_LIMIT
) {
  const cap = Number(limit);
  const source = Array.isArray(itemsNewestFirst) ? itemsNewestFirst : [];
  const window = Number.isFinite(cap) && cap > 0 ? source.slice(0, cap) : [];
  if (typeof alreadyTranslated !== 'function') return window.slice();
  return window.filter((item) => Boolean(item?.key) && !alreadyTranslated(item.key));
}
