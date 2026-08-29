import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Gift,
  HandCoins,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { useAuth } from '@/context/AuthContext';
import { useConfirm } from '@/context/ConfirmDialogContext';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useStaffSync } from '@/context/StaffSyncContext';
import { usePollEnabled } from '@/hooks/useDocumentVisible';
import { formatRelativeTime } from '@/components/maloum/MaloumChatPanels';
import {
  claimThroneNotification,
  getThroneNotifications,
  markThroneNotificationsReadAll,
  type ThroneNotification,
} from '@/lib/api';
import telegramIcon from '@/assets/telegram_icon.svg';

function notificationTitle(n: ThroneNotification): string {
  const gifter = n.gifterUsername?.trim() || 'Someone';
  const item = n.itemName?.trim() || 'a gift';
  switch (n.eventType) {
    case 'contribution_purchased':
      return `${gifter} contributed to ${item}`;
    case 'gift_crowdfunded':
      return `${item} was fully funded`;
    default:
      return `${gifter} bought ${item}`;
  }
}

function formatAmount(amount: number | null, currency: string | null): string | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  const code = (currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

export default function TelegramNotifications() {
  const { user } = useAuth();
  const canSeeWebhook = user?.role === 'owner' || user?.role === 'manager';
  const pollEnabled = usePollEnabled(true);
  const confirm = useConfirm();
  const { onSyncEvent } = useStaffSync();
  const { throneUnread, refreshThroneUnread } = useCreatorLive({
    platform: 'telegram',
    wantBadges: true,
    pollEnabled,
  });

  const [notifications, setNotifications] = useState<ThroneNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadNotifications = useCallback(
    async (opts?: { append?: boolean; before?: string | null }) => {
      const append = Boolean(opts?.append);
      if (!append) setLoading(true);
      setError(null);
      try {
        const result = await getThroneNotifications({
          limit: 30,
          before: opts?.before || undefined,
        });
        const list = result.notifications || [];
        setNotifications((prev) => (append ? [...prev, ...list] : list));
        setNextCursor(result.next || null);
        if (result.webhookUrl) setWebhookUrl(result.webhookUrl);

        if (!append) {
          try {
            await markThroneNotificationsReadAll();
            void refreshThroneUnread();
            setNotifications((prev) =>
              prev.map((n) => (n.isRead ? n : { ...n, isRead: true }))
            );
          } catch {
            void refreshThroneUnread();
          }
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to load notifications'
        );
      } finally {
        setLoading(false);
      }
    },
    [refreshThroneUnread]
  );

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  useEffect(() => {
    return onSyncEvent((event) => {
      if (event.type !== 'telegram:throne') return;
      const incoming = event.notification as ThroneNotification | undefined;
      if (event.event === 'claimed' && incoming?.id) {
        setNotifications((prev) =>
          prev.map((n) => (n.id === incoming.id ? { ...n, ...incoming } : n))
        );
        return;
      }
      void loadNotifications();
    });
  }, [onSyncEvent, loadNotifications]);

  async function handleCopyWebhook() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy webhook URL');
    }
  }

  async function handleTakeSales(n: ThroneNotification) {
    const amountLabel = formatAmount(n.amount, n.currency) || 'this';
    const ok = await confirm({
      title: 'Take this sale?',
      message: `Award ${amountLabel} to yourself on the sales dashboard?`,
      confirmLabel: 'Take sales',
    });
    if (!ok) return;
    setClaimingId(n.id);
    setError(null);
    try {
      const result = await claimThroneNotification(n.id);
      setNotifications((prev) =>
        prev.map((item) => (item.id === n.id ? result.notification : item))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to take sale');
      void loadNotifications();
    } finally {
      setClaimingId(null);
    }
  }

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="chatter" />

      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className="h-16 px-4 md:px-6 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3 shrink-0 bg-white/80 dark:bg-zinc-950/80">
          <div className="flex items-center gap-3 min-w-0">
            <img src={telegramIcon} alt="" className="w-8 h-8 rounded-full" />
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                Telegram — Notifications
              </h1>
              <p className="text-xs text-gray-500 dark:text-zinc-500">
                Throne gifts, contributions, and crowdfunded items
                {throneUnread > 0 ? ` · ${throneUnread} unread` : ''}
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

        {canSeeWebhook && webhookUrl ? (
          <div className="px-4 md:px-6 py-3 border-b border-gray-200 dark:border-zinc-800/60 bg-gray-50/80 dark:bg-zinc-900/40">
            <p className="text-xs text-gray-500 dark:text-zinc-500 mb-1.5">
              Paste this subscriber URL in Throne → Integrations → Webhook.{' '}
              <a
                href="https://help.throne.com/en/articles/15935990-how-do-i-set-up-webhook-integration"
                target="_blank"
                rel="noreferrer"
                className="text-domx-600 dark:text-domx-400 hover:underline"
              >
                Setup guide
              </a>
            </p>
            <div className="flex items-center gap-2 min-w-0">
              <code className="flex-1 min-w-0 truncate text-[11px] px-2 py-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 text-gray-700 dark:text-zinc-300">
                {webhookUrl}
              </code>
              <button
                type="button"
                onClick={() => void handleCopyWebhook()}
                className="inline-flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
          {loading && notifications.length === 0 && (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          {!loading && !error && notifications.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-zinc-500 text-center py-12">
              No Throne notifications yet.
            </p>
          )}
          {notifications.map((n) => {
            const when = formatRelativeTime(n.createdAt);
            const amount = formatAmount(n.amount, n.currency);
            const unread = n.isRead === false;
            const claimed = Boolean(n.claimedByUserId);
            return (
              <article
                key={n.id}
                className={`rounded-2xl border p-4 flex items-start gap-3 ${
                  unread
                    ? 'border-domx-500/30 bg-domx-600/5'
                    : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40'
                }`}
              >
                {n.itemThumbnailUrl ? (
                  <img
                    src={n.itemThumbnailUrl}
                    alt=""
                    className="w-12 h-12 rounded-xl object-cover shrink-0 bg-gray-100 dark:bg-zinc-800"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center shrink-0">
                    <Gift className="w-5 h-5 text-amber-500" />
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
                      {notificationTitle(n)}
                    </p>
                    {when && (
                      <span className="text-[11px] text-gray-500 dark:text-zinc-500 shrink-0">
                        {when}
                      </span>
                    )}
                  </div>
                  {n.message ? (
                    <p className="mt-1 text-xs text-gray-600 dark:text-zinc-400 line-clamp-2">
                      {n.message}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-zinc-500">
                    {amount != null && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold">
                        {amount}
                      </span>
                    )}
                    {n.throneCreatorUsername && (
                      <span className="truncate">@{n.throneCreatorUsername}</span>
                    )}
                    {n.gifterUsername && (
                      <span className="truncate">from {n.gifterUsername}</span>
                    )}
                    {unread && (
                      <span className="text-domx-600 dark:text-domx-400 font-medium">
                        Unread
                      </span>
                    )}
                  </div>
                </div>
                <div className="shrink-0">
                  {claimed ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 px-2 py-1.5">
                      Taken by {n.claimedByUserName || 'staff'}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleTakeSales(n)}
                      disabled={claimingId === n.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-domx-600 text-white hover:bg-domx-500 disabled:opacity-50"
                    >
                      {claimingId === n.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <HandCoins className="w-3.5 h-3.5" />
                      )}
                      Take sales
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {nextCursor && (
            <button
              type="button"
              onClick={() =>
                void loadNotifications({ append: true, before: nextCursor })
              }
              disabled={loading}
              className="w-full py-2 text-sm text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
