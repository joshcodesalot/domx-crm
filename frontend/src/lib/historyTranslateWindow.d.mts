export const HISTORY_AUTO_TRANSLATE_LIMIT: number;

export function selectAutoHistoryTranslations<T extends { key: string }>(
  itemsNewestFirst: readonly T[],
  alreadyTranslated?: (key: string) => boolean,
  limit?: number
): T[];
