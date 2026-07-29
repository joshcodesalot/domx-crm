import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Gift, Loader2, Lock, RefreshCw } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import maloumIcon from '@/assets/maloum_icon.png';
import { useStaffSync } from '@/context/StaffSyncContext';
import { formatRelativeTime } from '@/components/maloum/MaloumChatPanels';
import {
  getCreators,
  getMaloumBadges,
  getMaloumNotifications,
  type Creator,
  type MaloumNotification,
} from '@/lib/api';

const BADGE_POLL_MS = 15_000;

function fanDisplayName(n: MaloumNotification): string {
  return (
    (typeof n.fanNickname === 'string' && n.fanNickname.trim()) ||
    (typeof n.fanUsername === 'string' && n.fanUsername.trim()) ||
    'Fan'
  );
}

function notificationTitle(n: MaloumNotification): string {
  const fan = fanDisplayName(n);
  switch (n.type) {
    case 'CHAT_PRODUCT_SOLD':
      return `${fan} unlocked a PPV`;
    case 'FAN_TIPPED':
      return `${fan} sent a tip`;
    default:
      return n.type
        ? `${fan} — ${String(n.type).replace(/_/g, ' ').toLowerCase()}`
        : `${fan} — notification`;
  }
}

function NotificationIcon({ type }: { type?: string }) {
  if (type === 'CHAT_PRODUCT_SOLD') {
    return <Lock className="w-4 h-4 text-domx-500" />;
  }
  if (type === 'FAN_TIPPED') {
    return <Gift className="w-4 h-4 text-amber-500" />;
  }
  return <Bell className="w-4 h-4 text-gray-500 dark:text-zinc-400" />;
}

export default function MaloumNotifications() {
  const { onSyncEvent } = useStaffSync();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [unreadByCreatorId, setUnreadByCreatorId] = useState<Record<string, number>>(
    {}
  );

  const [notifications, setNotifications] = useState<MaloumNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const maloum = list.filter((c) => c.platform === 'maloum');
      setCreators(maloum);
      setSelectedCreatorId((prev) => prev || maloum[0]?.id || null);
    } catch {
      setCreators([]);
    } finally {
      setCreatorsLoading(false);
    }
  }, []);

  const refreshBadges = useCallback(async (creatorIds: string[]) => {
    if (creatorIds.length === 0) return;
    const updates: Record<string, number> = {};
    for (const id of creatorIds) {
      try {
        const result = await getMaloumBadges(id);
        updates[id] = Number(result.notifications) || 0;
      } catch {
        // best-effort
      }
    }
    if (Object.keys(updates).length > 0) {
      setUnreadByCreatorId((prev) => ({ ...prev, ...updates }));
    }
  }, []);

  const loadNotifications = useCallback(
    async (opts?: { append?: boolean; next?: string | null }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      if (!append) setLoading(true);
      setError(null);
      try {
        const result = await getMaloumNotifications(selectedCreatorId, {
          limit: 30,
          next: opts?.next || undefined,
        });
        setNotifications((prev) =>
          append
            ? [...prev, ...(result.notifications || [])]
            : result.notifications || []
        );
        setNextCursor(result.next || null);
        void refreshBadges([selectedCreatorId]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load notifications');
      } finally {
        setLoading(false);
      }
    },
    [selectedCreatorId, refreshBadges]
  );

  useEffect(() => {
    void loadCreators();
  }, [loadCreators]);

  useEffect(() => {
    return onSyncEvent(() => {
      void loadCreators();
    });
  }, [onSyncEvent, loadCreators]);

  useEffect(() => {
    const ids = creators.map((c) => c.id);
    void refreshBadges(ids);
    const timer = window.setInterval(() => {
      void refreshBadges(ids);
    }, BADGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [creators, refreshBadges]);

  useEffect(() => {
    setNotifications([]);
    setNextCursor(null);
    if (selectedCreatorId) {
      void loadNotifications();
    }
  }, [selectedCreatorId, loadNotifications]);

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={maloumIcon} alt="" className="w-5 h-5 rounded" />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            Notifications
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {creatorsLoading && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">Loading creators…</p>
          )}
          {!creatorsLoading && creators.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-zinc-500 p-3">
              No Maloum creators yet. Connect one from Manage Creators.
            </p>
          )}
          {creators.map((creator) => {
            const active = selectedCreatorId === creator.id;
            const unread = unreadByCreatorId[creator.id] || 0;
            return (
              <button
                key={creator.id}
                type="button"
                onClick={() => setSelectedCreatorId(creator.id)}
                className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all group ${
                  active
                    ? 'bg-gray-100 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50'
                    : 'hover:bg-gray-100 dark:hover:bg-zinc-800/30 border border-transparent'
                }`}
              >
                <CreatorAvatar
                  avatarUrl={creator.avatarUrl}
                  displayName={creator.displayName}
                  className="w-10 h-10 rounded-full object-cover shrink-0"
                  initialsClassName="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 bg-gradient-to-br from-orange-400 to-rose-500"
                />
                <div className="min-w-0 flex-1">
                  <span
                    className={`text-sm truncate block ${
                      active
                        ? 'font-semibold text-gray-900 dark:text-white'
                        : 'font-medium text-gray-700 dark:text-zinc-300'
                    }`}
                  >
                    {creator.displayName}
                  </span>
                  {unread > 0 && (
                    <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-medium text-maloum-500">
                      <Bell className="w-3 h-3" />
                      {unread > 99 ? '99+' : unread} unread
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {!selectedCreatorId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
            Select a creator
          </div>
        ) : (
          <>
            <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 bg-white/80 dark:bg-zinc-950/80">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-domx-600/20 flex items-center justify-center border border-domx-500/30">
                  <Bell className="w-4 h-4 text-domx-400" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {selectedCreator?.displayName || 'Creator'} — Notifications
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    Tips, PPV unlocks, and other Maloum alerts
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadNotifications()}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
                title="Refresh"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
              {loading && notifications.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
              {error && <p className="text-sm text-red-400">{error}</p>}
              {!loading && !error && notifications.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-12">
                  No notifications yet.
                </p>
              )}
              {notifications.map((n) => {
                const when = formatRelativeTime(n.createdAt);
                const amount =
                  typeof n.net === 'number' && Number.isFinite(n.net) ? n.net : null;
                const unread = n.isRead === false;
                return (
                  <article
                    key={n._id}
                    className={`rounded-2xl border p-4 flex items-start gap-3 ${
                      unread
                        ? 'border-domx-500/30 bg-domx-600/5'
                        : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40'
                    }`}
                  >
                    <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center shrink-0">
                      <NotificationIcon type={n.type} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p
                          className={`text-sm ${
                            unread
                              ? 'font-semibold text-gray-900 dark:text-white'
                              : 'font-medium text-gray-800 dark:text-zinc-200'
                          }`}
                        >
                          {notificationTitle(n)}
                        </p>
                        {when && (
                          <span className="text-[11px] text-gray-500 dark:text-zinc-500 shrink-0">
                            {when}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-500">
                        {amount != null && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold">
                            €{amount}
                          </span>
                        )}
                        {n.fanUsername && (
                          <span className="truncate">@{String(n.fanUsername)}</span>
                        )}
                        {unread && (
                          <span className="text-domx-600 dark:text-domx-400 font-medium">
                            Unread
                          </span>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
              {nextCursor && (
                <button
                  type="button"
                  onClick={() =>
                    void loadNotifications({ append: true, next: nextCursor })
                  }
                  disabled={loading}
                  className="w-full py-2 text-sm text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
