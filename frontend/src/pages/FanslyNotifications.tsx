import { WorkspaceDrawer, WorkspaceDrawerButton } from '@/components/WorkspaceDrawer';
import AppShell from '@/components/AppShell';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import fanslyIcon from '@/assets/fansly.svg';
import {
  listFanslyNotifications,
  type FanslyAccount,
  type FanslyMessage,
  type FanslyNotification,
  type FanslyNotificationFilter,
  type FanslyTip,
} from '@/lib/api';

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
  return `$${(amount / 100).toFixed(2)}`;
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
  const { creators, creatorsLoading } = useCreatorLive({ platform: 'fansly' });
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FanslyNotificationFilter[]>(FALLBACK_FILTERS);
  const [activeTypes, setActiveTypes] = useState('');
  const [notes, setNotes] = useState<FanslyNotification[]>([]);
  const [accounts, setAccounts] = useState<FanslyAccount[]>([]);
  const [messages, setMessages] = useState<FanslyMessage[]>([]);
  const [tips, setTips] = useState<FanslyTip[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedCreatorId((prev) => {
      if (prev && creators.some((creator) => creator.id === prev)) return prev;
      return creators[0]?.id || null;
    });
  }, [creators]);

  const load = useCallback(
    async (before?: string) => {
      if (!selectedCreatorId) return;
      setError(null);
      const result = await listFanslyNotifications(selectedCreatorId, {
        type: activeTypes,
        before,
      });
      if (result.filters?.length) setFilters(result.filters);
      const nextNotes = result.notifications || [];
      setNotes((prev) => (before ? [...prev, ...nextNotes] : nextNotes));
      setAccounts((prev) => (before ? mergeById(prev, result.accounts) : result.accounts || []));
      setMessages((prev) => (before ? mergeById(prev, result.messages) : result.messages || []));
      setTips((prev) => (before ? mergeById(prev, result.tips) : result.tips || []));
      return nextNotes;
    },
    [activeTypes, selectedCreatorId]
  );

  useEffect(() => {
    if (!selectedCreatorId) return;
    let cancelled = false;
    setLoading(true);
    load()
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
            {creators.map((creator) => (
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
                <span className="truncate text-sm font-medium">{creator.displayName}</span>
              </button>
            ))}
          </div>
        </WorkspaceDrawer>

        <section className="flex-1 min-w-0 flex flex-col">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-white/10 flex gap-2 overflow-x-auto">
            {filters.map((filter) => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setActiveTypes(filter.types)}
                className={`shrink-0 text-xs px-2.5 py-1 rounded-full ${
                  activeTypes === filter.types
                    ? 'bg-sky-500 text-white'
                    : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300'
                }`}
              >
                {filter.label}
              </button>
            ))}
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
            {rows.map((row) => (
              <article
                key={row.note.id}
                className="px-4 py-3 border-b border-gray-100 dark:border-white/5"
              >
                <p className="text-sm font-medium">{row.title}</p>
                <p className="text-sm text-gray-600 dark:text-gray-300 mt-0.5 whitespace-pre-wrap">
                  {row.detail}
                </p>
                <p className="text-[11px] text-gray-400 mt-1">{formatTime(row.note.createdAt)}</p>
              </article>
            ))}
            {oldestId && notes.length >= 20 && (
              <div className="p-4">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    load(oldestId)
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
