import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import {
  getCreators,
  getSaleReconciliation,
  getStaff,
  reconcileCreatorPayouts,
  resolveSaleReconciliation,
  type Creator,
  type SaleReconciliationEvent,
  type User,
} from '@/lib/api';
import { formatMoney, formatSentTime } from '@/lib/messagingDashboardFormat';

type TabId = 'needs_review' | 'cleared' | 'deleted_imports';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const selectClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

function currentYearMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function formatUnlocked(unlockedAt: string | null | undefined): string {
  if (!unlockedAt) return '--';
  const formatted = formatSentTime(unlockedAt);
  return `${formatted.date} ${formatted.time}`;
}

export default function FalseSalesReview() {
  const [tab, setTab] = useState<TabId>('needs_review');
  const [yearMonth, setYearMonth] = useState(currentYearMonth);
  const [creatorId, setCreatorId] = useState('');
  const [platform, setPlatform] = useState<'' | 'maloum' | '4based'>('');
  const [creators, setCreators] = useState<Creator[]>([]);
  const [staff, setStaff] = useState<User[]>([]);
  const [events, setEvents] = useState<SaleReconciliationEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reassignChatterId, setReassignChatterId] = useState('');

  const loadLists = useCallback(async () => {
    try {
      const [creatorsRes, staffRes] = await Promise.all([
        getCreators(),
        getStaff().catch(() => ({ staff: [] as User[] })),
      ]);
      setCreators(creatorsRes.creators || []);
      setStaff(staffRes.staff || []);
    } catch {
      /* ignore list errors */
    }
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getSaleReconciliation({
        yearMonth,
        creatorId: creatorId || undefined,
        platform: platform || undefined,
        tab,
        page: 1,
        limit: 100,
      });
      setEvents(result.data || []);
      setTotal(result.pagination?.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events');
      setEvents([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [yearMonth, creatorId, platform, tab]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const tabLabels = useMemo(
    () =>
      [
        { id: 'needs_review' as const, label: 'Needs review' },
        { id: 'cleared' as const, label: 'Cleared false sales' },
        { id: 'deleted_imports' as const, label: 'Deleted imports' },
      ] as const,
    []
  );

  async function handleReconcile() {
    if (!creatorId) {
      setError('Select a creator to reconcile');
      return;
    }
    setReconciling(true);
    setError(null);
    try {
      await reconcileCreatorPayouts(creatorId, yearMonth);
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reconcile failed');
    } finally {
      setReconciling(false);
    }
  }

  async function handleResolve(
    eventId: string,
    action: 'confirm_false' | 'restore_sale' | 'dismiss' | 'reassign'
  ) {
    setError(null);
    try {
      await resolveSaleReconciliation(eventId, {
        action,
        chatterId: action === 'reassign' ? reassignChatterId || undefined : undefined,
      });
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed');
    }
  }

  return (
    <AppLayout title="False Sales Review" activePage="falseSales">
      <div className="space-y-6">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">Month</label>
            <input
              type="month"
              className={inputClassName}
              value={yearMonth}
              onChange={(e) => setYearMonth(e.target.value)}
            />
          </div>
          <div className="w-56">
            <label className="block text-xs text-gray-500 mb-1">Creator</label>
            <select
              className={selectClassName}
              value={creatorId}
              onChange={(e) => setCreatorId(e.target.value)}
            >
              <option value="">All creators</option>
              {creators.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName || c.username || c.id}
                </option>
              ))}
            </select>
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 mb-1">Platform</label>
            <select
              className={selectClassName}
              value={platform}
              onChange={(e) =>
                setPlatform(e.target.value as '' | 'maloum' | '4based')
              }
            >
              <option value="">All</option>
              <option value="maloum">Maloum</option>
              <option value="4based">4based</option>
            </select>
          </div>
          <button
            type="button"
            onClick={() => void loadEvents()}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            disabled={!creatorId || reconciling}
            onClick={() => void handleReconcile()}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-gray-900 text-white dark:bg-white dark:text-gray-900 disabled:opacity-50"
          >
            {reconciling ? 'Reconciling…' : 'Reconcile now'}
          </button>
        </div>

        <div className="flex gap-2 border-b border-gray-200 dark:border-white/10">
          {tabLabels.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px ${
                tab === item.id
                  ? 'border-gray-900 dark:border-white text-gray-900 dark:text-white'
                  : 'border-transparent text-gray-500'
              }`}
            >
              {item.label}
            </button>
          ))}
          <div className="ml-auto text-xs text-gray-500 self-center">{total} events</div>
        </div>

        {error ? (
          <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
        ) : null}

        {tab === 'needs_review' ? (
          <div className="w-56">
            <label className="block text-xs text-gray-500 mb-1">
              Reassign chatter (for Deleted imports)
            </label>
            <select
              className={selectClassName}
              value={reassignChatterId}
              onChange={(e) => setReassignChatterId(e.target.value)}
            >
              <option value="">Select staff</option>
              {staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="overflow-x-auto border border-gray-200 dark:border-white/10 rounded-xl">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 dark:bg-white/[0.03] text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Creator</th>
                <th className="px-4 py-3 font-medium">Platform</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Fan</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Unlocked</th>
                <th className="px-4 py-3 font-medium">Reason / chat</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    {loading ? 'Loading…' : 'No events for this filter'}
                  </td>
                </tr>
              ) : (
                events.map((event) => (
                  <tr
                    key={event.id}
                    className="border-t border-gray-100 dark:border-white/5"
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatUnlocked(event.createdAt)}
                    </td>
                    <td className="px-4 py-3">{event.creatorName || '--'}</td>
                    <td className="px-4 py-3">{event.platform}</td>
                    <td className="px-4 py-3">{event.eventType}</td>
                    <td className="px-4 py-3">
                      {event.fanUsername || event.fanId || '--'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatMoney(event.amount, event.currency || 'EUR')}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatUnlocked(event.unlockedAt)}
                    </td>
                    <td className="px-4 py-3 max-w-[260px]">
                      <div className="line-clamp-2" title={event.reason || undefined}>
                        {event.reason || '--'}
                      </div>
                      {event.recoveredMessageText ? (
                        <div
                          className="text-xs text-gray-500 mt-1 line-clamp-2"
                          title={event.recoveredMessageText}
                        >
                          {event.recoveredMessageText}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {event.status}
                      {event.resolution ? (
                        <div className="text-xs text-gray-500">{event.resolution}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {event.status === 'needs_review' ? (
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            className="text-xs text-left text-gray-700 dark:text-gray-200 hover:underline"
                            onClick={() =>
                              void handleResolve(event.id, 'confirm_false')
                            }
                          >
                            Confirm false
                          </button>
                          <button
                            type="button"
                            className="text-xs text-left text-gray-700 dark:text-gray-200 hover:underline"
                            onClick={() =>
                              void handleResolve(event.id, 'restore_sale')
                            }
                          >
                            Restore sale
                          </button>
                          <button
                            type="button"
                            className="text-xs text-left text-gray-700 dark:text-gray-200 hover:underline"
                            onClick={() => void handleResolve(event.id, 'dismiss')}
                          >
                            Dismiss
                          </button>
                          <button
                            type="button"
                            disabled={!reassignChatterId}
                            className="text-xs text-left text-gray-700 dark:text-gray-200 hover:underline disabled:opacity-40"
                            onClick={() =>
                              void handleResolve(event.id, 'reassign')
                            }
                          >
                            Reassign
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">--</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
