import type { MaloumChatListItem } from '@/lib/api';

/** Maloum managed lists arrive as opaque codes like __0h7fd89v__; show native labels. */
export const MANAGED_LIST_LABELS_BY_NAME: Record<string, string> = {
  __0h7fd89v__: 'All free followers and subscribers',
  __9a5ju9d3__: 'All free followers',
  __x0y89z7l__: 'All subscribers',
};

export const MANAGED_LIST_LABELS_BY_ORDER = [
  'All free followers and subscribers',
  'All free followers',
  'All subscribers',
] as const;

export const ALL_FREE_FOLLOWERS_AND_SUBSCRIBERS =
  'All free followers and subscribers';

export function isManagedListCode(name: string): boolean {
  return /^__[\w]+__$/.test(name);
}

export function isManagedChatList(list: MaloumChatListItem): boolean {
  const name = (list.name || '').trim();
  return Boolean(list.isManaged) || isManagedListCode(name);
}

/** Rank among managed lists in API order (0, 1, 2…) — works across creators whose codes differ. */
export function buildManagedListRanks(
  lists: MaloumChatListItem[]
): Map<string, number> {
  const ranks = new Map<string, number>();
  let index = 0;
  for (const list of lists) {
    if (!isManagedChatList(list)) continue;
    ranks.set(list._id, index);
    index += 1;
  }
  return ranks;
}

export function friendlyListName(
  list: MaloumChatListItem,
  managedRanks?: Map<string, number>
): string {
  const raw = (list.name || '').trim();
  if (raw && MANAGED_LIST_LABELS_BY_NAME[raw]) {
    return MANAGED_LIST_LABELS_BY_NAME[raw];
  }
  if (isManagedChatList(list)) {
    const rank = managedRanks?.get(list._id);
    if (rank != null && rank >= 0 && rank < MANAGED_LIST_LABELS_BY_ORDER.length) {
      return MANAGED_LIST_LABELS_BY_ORDER[rank];
    }
  }
  if (isManagedListCode(raw)) {
    return MANAGED_LIST_LABELS_BY_NAME[raw] || 'Managed list';
  }
  const fallback = raw || 'Untitled list';
  return isManagedListCode(fallback) ? 'Managed list' : fallback;
}

export function listLabel(
  list: MaloumChatListItem,
  managedRanks?: Map<string, number>
): string {
  const name = friendlyListName(list, managedRanks);
  const count =
    typeof list.totalMemberCount === 'number' ? ` (${list.totalMemberCount})` : '';
  return `${name}${count}`;
}

export function findDefaultIncludeList(
  lists: MaloumChatListItem[],
  managedRanks?: Map<string, number>
): MaloumChatListItem | null {
  const ranks = managedRanks ?? buildManagedListRanks(lists);
  for (const list of lists) {
    if (friendlyListName(list, ranks) === ALL_FREE_FOLLOWERS_AND_SUBSCRIBERS) {
      return list;
    }
  }
  for (const list of lists) {
    if (ranks.get(list._id) === 0) return list;
  }
  return null;
}

export function friendlyCategoryName(name: string): string {
  const raw = (name || '').trim();
  if (!raw || raw === '__default__') return raw || 'Category';
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}
