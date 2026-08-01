import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign,
  Bell,
  Gift,
  Heart,
  Loader2,
  Lock,
  MessageCircle,
  Play,
  RefreshCw,
  UserPlus,
  X,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import fourBasedIcon from '@/assets/4based_icon.ico';
import { useStaffSync } from '@/context/StaffSyncContext';
import { formatRelativeTime } from '@/components/fourbased/FourBasedChatPanels';
import {
  fourBasedPublicPreviewUrl,
  getCreators,
  getFourBasedActivities,
  getFourBasedBadges,
  resetFourBasedActivities,
  type Creator,
  type FourBasedActivity,
} from '@/lib/api';

const BADGE_POLL_MS = 15_000;
const PAGE_LIMIT = 20;

const FILTER_OPTIONS: { key: string; label: string }[] = [
  { key: 'comment', label: 'Comments' },
  { key: 'like', label: 'Likes' },
  { key: 'follow', label: 'Followers' },
  { key: 'content', label: 'Content' },
  { key: 'sale', label: 'Sales' },
  { key: 'subscription', label: 'Subscriptions' },
  { key: 'tip', label: 'Tips' },
  { key: 'chat_unlock', label: 'Chat unlocks' },
  { key: 'mention', label: 'Mentions' },
];

function fanName(a: FourBasedActivity): string {
  return (
    (typeof a.user?.name === 'string' && a.user.name.trim()) ||
    'Fan'
  );
}

function activityTitle(a: FourBasedActivity): string {
  const name = fanName(a);
  switch (a.type) {
    case 'like':
      return `${name} liked your post`;
    case 'follow':
      return `${name} started following you`;
    case 'comment':
      return `${name} commented`;
    case 'tip':
      return `${name} sent a tip`;
    case 'sale':
      return `${name} unlocked content`;
    case 'chat_unlock':
      return `${name} unlocked your chat`;
    case 'subscription':
      return `${name} subscribed`;
    case 'content':
      return `${name} posted new content`;
    case 'mention':
      return `${name} mentioned you`;
    default:
      return a.type
        ? `${name} — ${String(a.type).replace(/_/g, ' ')}`
        : `${name} — notification`;
  }
}

function ActivityIcon({ type }: { type?: string }) {
  if (type === 'like') return <Heart className="w-4 h-4 text-rose-500" />;
  if (type === 'follow') return <UserPlus className="w-4 h-4 text-emerald-500" />;
  if (type === 'comment') return <MessageCircle className="w-4 h-4 text-sky-500" />;
  if (type === 'tip') return <Gift className="w-4 h-4 text-amber-500" />;
  if (type === 'sale' || type === 'chat_unlock') {
    return <Lock className="w-4 h-4 text-4based-500" />;
  }
  if (type === 'mention') return <AtSign className="w-4 h-4 text-violet-500" />;
  return <Bell className="w-4 h-4 text-gray-500 dark:text-zinc-400" />;
}

function isVideoStack(a: FourBasedActivity): boolean {
  const fs = a.file_stack;
  if (!fs) return false;
  const kind = String(fs.fileStackType || fs.type || '').toLowerCase();
  return kind.includes('video');
}

function activityAmountDollars(a: FourBasedActivity): number | null {
  // Sale activities often have process: null; price is on file_stack.price (coins).
  const coins = Number(
    a.process?.amount ?? a.process?.value ?? a.file_stack?.price
  );
  if (!Number.isFinite(coins) || coins === 0) return null;
  return Math.abs(coins) / 121;
}

export default function FourBasedNotifications() {
  const { onSyncEvent } = useStaffSync();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [creatorsLoading, setCreatorsLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [unreadByCreatorId, setUnreadByCreatorId] = useState<Record<string, number>>(
    {}
  );

  const [activities, setActivities] = useState<FourBasedActivity[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const resetDoneForCreatorRef = useRef<string | null>(null);

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );

  const typesParam = useMemo(
    () => (selectedTypes.length > 0 ? selectedTypes.join(',') : undefined),
    [selectedTypes]
  );

  const loadCreators = useCallback(async () => {
    setCreatorsLoading(true);
    try {
      const { creators: list } = await getCreators();
      const fourBased = list.filter((c) => c.platform === '4based');
      setCreators(fourBased);
      setSelectedCreatorId((prev) => prev || fourBased[0]?.id || null);
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
        const result = await getFourBasedBadges(id);
        updates[id] = Number(result.notifications) || 0;
      } catch {
        // best-effort
      }
    }
    if (Object.keys(updates).length > 0) {
      setUnreadByCreatorId((prev) => ({ ...prev, ...updates }));
    }
  }, []);

  const loadActivities = useCallback(
    async (opts?: { append?: boolean; offset?: number; resetUnread?: boolean }) => {
      if (!selectedCreatorId) return;
      const append = Boolean(opts?.append);
      const nextOffset = opts?.offset ?? 0;
      if (!append) setLoading(true);
      setError(null);
      try {
        const result = await getFourBasedActivities(selectedCreatorId, {
          limit: PAGE_LIMIT,
          offset: nextOffset,
          types: typesParam,
        });
        const page = result.activities || [];
        setActivities((prev) => (append ? [...prev, ...page] : page));
        setOffset(nextOffset + page.length);
        setHasMore(page.length >= PAGE_LIMIT);

        if (
          opts?.resetUnread &&
          !append &&
          resetDoneForCreatorRef.current !== selectedCreatorId
        ) {
          try {
            await resetFourBasedActivities(selectedCreatorId);
            resetDoneForCreatorRef.current = selectedCreatorId;
          } catch {
            // best-effort
          }
        }

        void refreshBadges([selectedCreatorId]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load notifications');
      } finally {
        setLoading(false);
      }
    },
    [selectedCreatorId, typesParam, refreshBadges]
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
    resetDoneForCreatorRef.current = null;
    setActivities([]);
    setOffset(0);
    setHasMore(false);
    if (selectedCreatorId) {
      void loadActivities({ resetUnread: true });
    }
    // Reset unread only on creator switch (not filter changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCreatorId]);

  useEffect(() => {
    if (!selectedCreatorId) return;
    setActivities([]);
    setOffset(0);
    setHasMore(false);
    void loadActivities({ resetUnread: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typesParam]);

  function toggleType(key: string) {
    setSelectedTypes((prev) =>
      prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]
    );
  }

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <aside className="w-64 border-r border-gray-200 dark:border-zinc-800/60 flex flex-col shrink-0 bg-white/50 dark:bg-zinc-950/50">
        <div className="h-16 px-4 border-b border-gray-200 dark:border-zinc-800/60 flex items-center gap-2">
          <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded" />
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
              No 4based creators yet. Connect one from Manage Creators.
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
                  initialsClassName="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0 bg-gradient-to-br from-emerald-400 to-teal-600"
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
                    <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-medium text-4based-500">
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
                <div className="w-9 h-9 rounded-xl bg-emerald-600/20 flex items-center justify-center border border-emerald-500/30">
                  <Bell className="w-4 h-4 text-emerald-500" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {selectedCreator?.displayName || 'Creator'} — Notifications
                  </h1>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    Tips, sales, likes, and other 4based activity
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadActivities({ resetUnread: false })}
                className="p-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
                title="Refresh"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="px-4 md:px-6 py-3 border-b border-gray-200 dark:border-zinc-800/60 flex flex-wrap gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setSelectedTypes([])}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  selectedTypes.length === 0
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300 hover:bg-gray-200 dark:hover:bg-zinc-700'
                }`}
              >
                All
              </button>
              {FILTER_OPTIONS.map((opt) => {
                const active = selectedTypes.includes(opt.key);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => toggleType(opt.key)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      active
                        ? 'bg-emerald-600 text-white'
                        : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300 hover:bg-gray-200 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
              {loading && activities.length === 0 && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              )}
              {error && <p className="text-sm text-red-400">{error}</p>}
              {!loading && !error && activities.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-12">
                  No notifications yet.
                </p>
              )}
              {activities.map((a) => {
                const when = formatRelativeTime(a.created_at);
                const amount = activityAmountDollars(a);
                const unread = a.status === 'unread';
                const thumb = fourBasedPublicPreviewUrl(a.file_stack, [
                  '100x100',
                  '200x200',
                  '80x80',
                  '50x50',
                ]);
                const fullPreview = fourBasedPublicPreviewUrl(a.file_stack, [
                  '500x500',
                  '200x200',
                  '100x100',
                ]);
                const avatar = fourBasedPublicPreviewUrl(a.user?.avatar, [
                  '80x80',
                  '50x50',
                  '100x100',
                ]);
                const video = isVideoStack(a);

                return (
                  <article
                    key={a._id}
                    className={`rounded-2xl border p-4 flex items-start gap-3 ${
                      unread
                        ? 'border-emerald-500/30 bg-emerald-600/5'
                        : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40'
                    }`}
                  >
                    {avatar ? (
                      <img
                        src={avatar}
                        alt=""
                        className="w-9 h-9 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center shrink-0">
                        <ActivityIcon type={a.type} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p
                          className={`text-sm ${
                            unread
                              ? 'font-semibold text-gray-900 dark:text-white'
                              : 'font-medium text-gray-800 dark:text-zinc-200'
                          }`}
                        >
                          {activityTitle(a)}
                        </p>
                        {when && (
                          <span className="text-[11px] text-gray-500 dark:text-zinc-500 shrink-0">
                            {when}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-500">
                        <span className="inline-flex items-center gap-1">
                          <ActivityIcon type={a.type} />
                          {a.type || 'activity'}
                        </span>
                        {amount != null && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold">
                            ${amount.toFixed(2)}
                          </span>
                        )}
                        {a.user?.name && (
                          <span className="truncate">@{String(a.user.name)}</span>
                        )}
                        {unread && (
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                            Unread
                          </span>
                        )}
                      </div>
                    </div>
                    {thumb && (
                      <button
                        type="button"
                        onClick={() => setPreviewUrl(fullPreview || thumb)}
                        className="relative w-14 h-14 rounded-lg overflow-hidden shrink-0 border border-gray-200 dark:border-zinc-700 bg-gray-100 dark:bg-zinc-800"
                        title="Preview"
                      >
                        <img
                          src={thumb}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                        {video && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                            <Play className="w-4 h-4 text-white fill-white" />
                          </span>
                        )}
                      </button>
                    )}
                  </article>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  onClick={() =>
                    void loadActivities({
                      append: true,
                      offset,
                      resetUnread: false,
                    })
                  }
                  disabled={loading}
                  className="w-full py-2 text-sm text-emerald-600 dark:text-emerald-400 hover:underline disabled:opacity-40"
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </>
        )}
      </main>

      {previewUrl && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}
          role="presentation"
        >
          <button
            type="button"
            onClick={() => setPreviewUrl(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={previewUrl}
            alt=""
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
