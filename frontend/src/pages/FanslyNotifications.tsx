import { WorkspaceDrawer, WorkspaceDrawerButton } from '@/components/WorkspaceDrawer';
import AppShell from '@/components/AppShell';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Loader2 } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';
import fanslyIcon from '@/assets/fansly.svg';
import {
  ackFanslyNotifications,
  listFanslyNotifications,
  type FanslyAccount,
  type FanslyMessage,
  type FanslyNotification,
  type FanslyNotificationFilter,
  type FanslyTip,
} from '@/lib/api';

const PAGE_SIZE = 50;

const FALLBACK_FILTERS: FanslyNotificationFilter[] = [
  { id: 'all', label: 'All', types: '' },
  { id: 'tips', label: 'Tips', types: '7001' },
  { id: 'purchases', label: 'Media Purchases', types: '2007,2008' },
];

function formatTime(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '';
  const numeric = Number(value);
  const ms = numeric < 1e12 ? numeric * 1000 : numeric;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function money(amount: number): string {
  return `$${(amount / 1000).toFixed(2)}`;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[] | undefined): T[] {
  const next = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming || []) next.set(row.id, row);
  return [...next.values()];
}

function accountName(accounts: FanslyAccount[], id: string | null | undefined): string | null {
  if (!id) return null;
  const account = accounts.find((row) => row.id === id);
  if (!account) return null;
  return account.displayName || account.username || null;
}

function describeNotification(
  note: FanslyNotification,
  accounts: FanslyAccount[],
  messages: FanslyMessage[],
  tips: FanslyTip[],
  filters: FanslyNotificationFilter[]
): { title: string; detail: string } {
  const typeLabel =
    filters.find((filter) => filter.types.split(',').includes(String(note.type)))?.label ||
    `Type ${note.type}`;
  const tip = tips.find((row) => row.id === note.correlationId);
  if (tip) {
    const name = accountName(accounts, tip.senderId) || 'A fan';
    return {
      title: `${name} tipped ${money(tip.amount)}`,
      detail: tip.message || typeLabel,
    };
  }
  const message = messages.find((row) => row.id === note.correlationId);
  const name =
    accountName(accounts, note.correlationGroupId) ||
    accountName(accounts, message?.senderId) ||
    'A fan';
  let detail = message?.content || typeLabel;
  if (note.metadata) {
    try {
      const meta = JSON.parse(note.metadata) as { accountMediaPrice?: number };
      if (typeof meta.accountMediaPrice === 'number') {
        detail = `${typeLabel} · ${money(meta.accountMediaPrice)}`;
      }
    } catch {
      // metadata is optional free text
    }
  }
  return { title: `${name} · ${typeLabel}`, detail };
}

export default function FanslyNotifications() {
  const pollEnabled = usePollEnabled(true);
  const { creators, creatorsLoading, badgesByCreatorId, refreshBadges } = useCreatorLive({
    platform: 'fansly',
    wantBadges: true,
    pollEnabled,
  });
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FanslyNotificationFilter[]>(FALLBACK_FILTERS);
  const [selectedFilterIds, setSelectedFilterIds] = useState<string[]>([]);
  const [notes, setNotes] = useState<FanslyNotification[]>([]);
  const [accounts, setAccounts] = useState<FanslyAccount[]>([]);
  const [messages, setMessages] = useState<FanslyMessage[]>([]);
  const [tips, setTips] = useState<FanslyTip[]>([]);
  const [lastPageCount, setLastPageCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const refreshBadgesRef = useRef(refreshBadges);
  refreshBadgesRef.current = refreshBadges;

  useEffect(() => {
    setSelectedCreatorId((prev) => {
      if (prev && creators.some((creator) => creator.id === prev)) return prev;
      return creators[0]?.id || null;
    });
  }, [creators]);

  const typeFilters = useMemo(
    () => filters.filter((filter) => filter.id !== 'all' && filter.types),
    [filters]
  );

  const activeTypes = useMemo(() => {
    const selected = new Set(selectedFilterIds);
    const seen = new Set<string>();
    const codes: string[] = [];
    for (const filter of typeFilters) {
      if (!selected.has(filter.id)) continue;
      for (const code of filter.types.split(',')) {
        if (!code || seen.has(code)) continue;
        seen.add(code);
        codes.push(code);
      }
    }
    return codes.join(',');
  }, [selectedFilterIds, typeFilters]);

  const activeTypesRef = useRef(activeTypes);
  const selectedCreatorIdRef = useRef(selectedCreatorId);
  activeTypesRef.current = activeTypes;
  selectedCreatorIdRef.current = selectedCreatorId;

  const load = useCallback(
    async (before?: string, opts?: { ack?: boolean; isCurrent?: () => boolean }) => {
      const creatorId = selectedCreatorIdRef.current;
      if (!creatorId) return [];
      const current = opts?.isCurrent || (() => true);
      setError(null);
      const result = await listFanslyNotifications(creatorId, {
        type: activeTypesRef.current,
        before,
      });
      if (!current()) return [];
      if (result.filters?.length) setFilters(result.filters);
      const nextNotes = result.notifications || [];
      setLastPageCount(nextNotes.length);
      setNotes((prev) => (before ? [...prev, ...nextNotes] : nextNotes));
      setAccounts((prev) => (before ? mergeById(prev, result.accounts) : result.accounts || []));
      setMessages((prev) => (before ? mergeById(prev, result.messages) : result.messages || []));
      setTips((prev) => (before ? mergeById(prev, result.tips) : result.tips || []));

      const shouldAck =
        Boolean(opts?.ack) &&
        !before &&
        nextNotes.some((note) => note.acknowledgedAt == null) &&
        Boolean(nextNotes[0]?.id);
      if (shouldAck && current()) {
        const unreadIds = new Set(
          nextNotes.filter((note) => note.acknowledgedAt == null).map((note) => note.id)
        );
        try {
          await ackFanslyNotifications(creatorId, { beforeAnd: nextNotes[0].id, type: '' });
          void refreshBadgesRef.current([creatorId]);
          if (!current() || selectedCreatorIdRef.current !== creatorId) return nextNotes;
          const readAt = Math.floor(Date.now() / 1000);
          setNotes((prev) =>
            prev.map((note) =>
              unreadIds.has(note.id) ? { ...note, acknowledgedAt: readAt } : note
            )
          );
        } catch {
          // Leave the rows unread. Opening this creator again retries the ack.
        }
      }
      return nextNotes;
    },
    []
  );

  useEffect(() => {
    if (!selectedCreatorId) return;
    const key = `${selectedCreatorId}:${activeTypesRef.current}`;
    loadedKeyRef.current = key;
    let cancelled = false;
    setLoading(true);
    setNotes([]);
    setAccounts([]);
    setMessages([]);
    setTips([]);
    setLastPageCount(0);
    load(undefined, { ack: true, isCurrent: () => !cancelled && loadedKeyRef.current === key })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load notifications');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, selectedCreatorId]);

  useEffect(() => {
    const creatorId = selectedCreatorIdRef.current;
    if (!creatorId) return;
    const key = `${creatorId}:${activeTypes}`;
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    let cancelled = false;
    setLoading(true);
    setNotes([]);
    setAccounts([]);
    setMessages([]);
    setTips([]);
    setLastPageCount(0);
    load(undefined, { ack: false, isCurrent: () => !cancelled && loadedKeyRef.current === key })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load notifications');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Creator changes reload from the effect above. This one only refetches when filters change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTypes, load]);

  const oldestId = notes.length > 0 ? notes[notes.length - 1].id : null;
  const rows = useMemo(
    () => notes.map((note) => ({ note, ...describeNotification(note, accounts, messages, tips, filters) })),
    [accounts, filters, messages, notes, tips]
  );

  return (
    <AppShell
      title="Fansly Notifications"
      activePage="chatter"
      bleed
      headerExtras={
        <WorkspaceDrawerButton id="fansly-notif-accounts" size="lg" label="Creators" className="lg:hidden" />
      }
    >
      <div className="flex h-full min-h-0">
        <WorkspaceDrawer
          id="fansly-notif-accounts"
          size="lg"
          className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50"
        >
          <div className="px-4 py-3 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
            <img src={fanslyIcon} alt="" className="w-5 h-5" />
            <span className="font-medium text-sm">Fansly</span>
          </div>
          <div data-drawer-list className="flex-1 overflow-y-auto">
            {creatorsLoading && <p className="px-4 py-3 text-sm text-gray-500">Loading creators…</p>}
            {!creatorsLoading && creators.length === 0 && (
              <p className="px-4 py-3 text-sm text-gray-500">
                No Fansly creators yet. Connect one from Manage Creators.
              </p>
            )}
            {creators.map((creator) => {
              const unread = badgesByCreatorId[creator.id]?.notifications || 0;
              return (
                <button
                  key={creator.id}
                  type="button"
                  onClick={() => setSelectedCreatorId(creator.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left ${
                    creator.id === selectedCreatorId
                      ? 'bg-brand-50 dark:bg-white/5'
                      : 'hover:bg-gray-50 dark:hover:bg-white/5'
                  }`}
                >
                  <CreatorAvatar avatarUrl={creator.avatarUrl} displayName={creator.displayName} />
                  <span className="min-w-0">
                    <span className="truncate text-sm font-medium block">{creator.displayName}</span>
                    {unread > 0 && (
                      <span className="inline-flex items-center gap-1 mt-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                        <Bell className="w-3 h-3" />
                        {unread > 99 ? '99+' : unread} unread
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </WorkspaceDrawer>

        <section className="flex-1 min-w-0 flex flex-col">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-white/10 flex gap-2 overflow-x-auto">
            <button
              type="button"
              onClick={() => setSelectedFilterIds([])}
              className={`shrink-0 text-xs px-2.5 py-1 rounded-full ${
                selectedFilterIds.length === 0
                  ? 'bg-sky-500 text-white'
                  : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300'
              }`}
            >
              All
            </button>
            {typeFilters.map((filter) => {
              const active = selectedFilterIds.includes(filter.id);
              return (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() =>
                    setSelectedFilterIds((prev) =>
                      prev.includes(filter.id)
                        ? prev.filter((id) => id !== filter.id)
                        : [...prev, filter.id]
                    )
                  }
                  className={`shrink-0 text-xs px-2.5 py-1 rounded-full ${
                    active
                      ? 'bg-sky-500 text-white'
                      : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300'
                  }`}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <p className="px-4 py-3 text-sm text-gray-500 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading notifications…
              </p>
            )}
            {error && <p className="px-4 py-3 text-sm text-red-500">{error}</p>}
            {!loading && !error && rows.length === 0 && (
              <p className="px-4 py-6 text-sm text-gray-500">No notifications.</p>
            )}
            {rows.map((row) => {
              const unread = row.note.acknowledgedAt == null;
              return (
                <article
                  key={row.note.id}
                  className={`px-4 py-3 border-b ${
                    unread
                      ? 'border-sky-500/20 bg-sky-500/5'
                      : 'border-gray-100 dark:border-white/5'
                  }`}
                >
                  <p
                    className={`text-sm ${
                      unread ? 'font-semibold text-gray-900 dark:text-white' : 'font-medium'
                    }`}
                  >
                    {row.title}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-300 mt-0.5 whitespace-pre-wrap">
                    {row.detail}
                  </p>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {formatTime(row.note.createdAt)}
                    {unread && (
                      <span className="ml-2 font-medium text-sky-600 dark:text-sky-400">Unread</span>
                    )}
                  </p>
                </article>
              );
            })}
            {oldestId && lastPageCount >= PAGE_SIZE && (
              <div className="p-4">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    const key = loadedKeyRef.current;
                    load(oldestId, {
                      ack: false,
                      isCurrent: () => loadedKeyRef.current === key,
                    })
                      .catch((err) =>
                        setError(err instanceof Error ? err.message : 'Failed to load more')
                      )
                      .finally(() => setLoadingMore(false));
                  }}
                  className="text-sm text-sky-600 disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load older'}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
