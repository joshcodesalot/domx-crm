import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { useAuth } from '@/context/AuthContext';
import {
  getActivityHistory,
  getActivityPresence,
  getOverviewAnalytics,
  type ActivityHistoryDay,
  type ActivityHistoryResponse,
  type CurrencyAmount,
  type OverviewAnalyticsResponse,
  type OverviewChatterStats,
  type PresenceChatter,
  type PresenceStatus,
} from '@/lib/api';
import { formatMoney, formatResponseTime } from '@/lib/messagingDashboardFormat';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 18) return 'Good Afternoon';
  return 'Good Evening';
}

function formatCurrencyAmounts(amounts: CurrencyAmount[] | undefined): string {
  if (!amounts || amounts.length === 0) {
    return formatMoney(0, 'EUR');
  }
  return amounts.map((item) => formatMoney(item.amount, item.currency)).join(' · ');
}

function dayTotal(amounts: CurrencyAmount[]): number {
  return amounts.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

function formatActiveDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m`;
}

function statusBadgeClass(status: PresenceStatus): string {
  switch (status) {
    case 'online':
      return 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400';
    case 'idle':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400';
  }
}

function statusLabel(status: PresenceStatus): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'idle':
      return 'Idle';
    default:
      return 'Away';
  }
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-5 border border-gray-200 dark:border-white/5 rounded-lg bg-gray-50/50 dark:bg-transparent">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</p>
      <p className="text-xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}

function DailySalesBars({
  days,
}: {
  days: OverviewAnalyticsResponse['dailySalesByDay'];
}) {
  const max = Math.max(1, ...days.map((day) => dayTotal(day.amounts)));

  return (
    <div className="h-64 border border-gray-200 dark:border-white/10 rounded-lg p-4 flex items-end gap-1.5">
      {days.map((day) => {
        const total = dayTotal(day.amounts);
        const heightPct = Math.max(total > 0 ? 6 : 2, Math.round((total / max) * 100));
        const label = new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
        return (
          <div
            key={day.date}
            className="flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1"
            title={`${label}: ${formatCurrencyAmounts(day.amounts)}`}
          >
            <div
              className="w-full max-w-[28px] rounded-t bg-gray-900 dark:bg-white/80 transition-all"
              style={{ height: `${heightPct}%` }}
            />
            <span className="text-[10px] text-gray-400 truncate w-full text-center">
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ActiveTimeBars({ days }: { days: ActivityHistoryDay[] }) {
  const max = Math.max(1, ...days.map((day) => day.activeSeconds));

  return (
    <div className="h-64 border border-gray-200 dark:border-white/10 rounded-lg p-4 flex items-end gap-1.5">
      {days.map((day) => {
        const total = day.activeSeconds;
        const heightPct = Math.max(total > 0 ? 6 : 2, Math.round((total / max) * 100));
        const label = new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
        return (
          <div
            key={day.date}
            className="flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1"
            title={`${label}: ${formatActiveDuration(total)}`}
          >
            <div
              className="w-full max-w-[28px] rounded-t bg-gray-700 dark:bg-white/50 transition-all"
              style={{ height: `${heightPct}%` }}
            />
            <span className="text-[10px] text-gray-400 truncate w-full text-center">
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ChatterRow = OverviewChatterStats & {
  status: PresenceStatus;
  activeSecondsToday: number;
  activeSecondsPeriod: number;
};

export default function Dashboard() {
  const { user, hasPermission } = useAuth();
  const canViewAnalytics = hasPermission('analytics.view');

  const [overview, setOverview] = useState<OverviewAnalyticsResponse | null>(null);
  const [history, setHistory] = useState<ActivityHistoryResponse | null>(null);
  const [presenceById, setPresenceById] = useState<Record<string, PresenceChatter>>({});
  const [onlineCount, setOnlineCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!canViewAnalytics) return;

      if (!options.silent) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setError(null);

      try {
        const [overviewResult, presenceResult, historyResult] = await Promise.all([
          getOverviewAnalytics(),
          getActivityPresence(),
          getActivityHistory(14),
        ]);

        setOverview(overviewResult);
        setHistory(historyResult);

        const map: Record<string, PresenceChatter> = {};
        for (const chatter of presenceResult.chatters) {
          map[chatter.userId] = chatter;
        }
        setPresenceById(map);
        setOnlineCount(presenceResult.onlineCount);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load overview');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [canViewAnalytics]
  );

  useEffect(() => {
    if (!canViewAnalytics) {
      setLoading(false);
      return;
    }
    void loadData();
  }, [canViewAnalytics, loadData]);

  useEffect(() => {
    if (!canViewAnalytics) return;
    const interval = window.setInterval(() => {
      void loadData({ silent: true });
    }, 20_000);
    return () => window.clearInterval(interval);
  }, [canViewAnalytics, loadData]);

  const periodByUserId = useMemo(() => {
    const map: Record<string, number> = {};
    for (const chatter of history?.chatters || []) {
      map[chatter.userId] = chatter.activeSecondsPeriod;
    }
    return map;
  }, [history]);

  const chatterRows: ChatterRow[] = useMemo(() => {
    const fromOverview = overview?.chatters || [];
    const overviewIds = new Set(fromOverview.map((c) => c.chatterId));

    const rows: ChatterRow[] = fromOverview.map((chatter) => {
      const presence = presenceById[chatter.chatterId];
      return {
        ...chatter,
        status: presence?.status || 'away',
        activeSecondsToday: presence?.activeSecondsToday || 0,
        activeSecondsPeriod: periodByUserId[chatter.chatterId] || 0,
      };
    });

    for (const presence of Object.values(presenceById)) {
      if (overviewIds.has(presence.userId)) continue;
      rows.push({
        chatterId: presence.userId,
        chatterName: presence.userName,
        avgResponseTimeSeconds: null,
        dailySales: [],
        totalSales: [],
        status: presence.status,
        activeSecondsToday: presence.activeSecondsToday,
        activeSecondsPeriod: periodByUserId[presence.userId] || 0,
      });
    }

    return rows.sort((a, b) => {
      const rank = { online: 0, idle: 1, away: 2 } as const;
      const statusDiff = rank[a.status] - rank[b.status];
      if (statusDiff !== 0) return statusDiff;
      return a.chatterName.localeCompare(b.chatterName);
    });
  }, [overview, presenceById, periodByUserId]);

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <AppLayout title="Overview" activePage="dashboard">
      <div className="max-w-5xl mx-auto">
        <div className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold mb-1">{getGreeting()}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {canViewAnalytics
                ? 'Team performance and chatter activity'
                : `Welcome back, ${user.name}`}
            </p>
          </div>

          {canViewAnalytics ? (
            <button
              type="button"
              onClick={() => void loadData({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-2 self-start rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          ) : null}
        </div>

        {!canViewAnalytics ? (
          <div className="border border-gray-200 dark:border-white/10 rounded-lg p-12 flex items-center justify-center">
            <p className="text-sm text-gray-400 dark:text-gray-500">
              Your dashboard is ready. Content will appear here.
            </p>
          </div>
        ) : loading ? (
          <div className="border border-gray-200 dark:border-white/10 rounded-lg p-12 flex items-center justify-center">
            <p className="text-sm text-gray-400 dark:text-gray-500">Loading overview...</p>
          </div>
        ) : error ? (
          <div className="border border-red-200 dark:border-red-500/30 rounded-lg p-6 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : (
          <div className="space-y-12">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                label="Daily Sales"
                value={formatCurrencyAmounts(overview?.dailySales)}
              />
              <MetricCard
                label="Total Sales"
                value={formatCurrencyAmounts(overview?.totalSales)}
              />
              <MetricCard
                label="Avg Response Time"
                value={formatResponseTime(overview?.avgResponseTimeSeconds)}
              />
              <MetricCard label="Online Chatters" value={String(onlineCount)} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2">
                <h3 className="text-sm font-medium mb-4">Daily Sales (14 days)</h3>
                {overview?.dailySalesByDay?.length ? (
                  <DailySalesBars days={overview.dailySalesByDay} />
                ) : (
                  <div className="h-64 border border-gray-200 dark:border-white/10 rounded-lg flex items-center justify-center text-sm text-gray-400">
                    No data available
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-sm font-medium mb-4">Top Earners (today)</h3>
                <div className="space-y-3">
                  {chatterRows
                    .filter((row) => dayTotal(row.dailySales) > 0)
                    .sort((a, b) => dayTotal(b.dailySales) - dayTotal(a.dailySales))
                    .slice(0, 5)
                    .map((row) => (
                      <div
                        key={row.chatterId}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="truncate font-medium">{row.chatterName}</span>
                        <span className="shrink-0 text-gray-500 dark:text-gray-400">
                          {formatCurrencyAmounts(row.dailySales)}
                        </span>
                      </div>
                    ))}
                  {chatterRows.every((row) => dayTotal(row.dailySales) === 0) ? (
                    <div className="text-sm text-gray-400 text-center py-8">
                      No data to display
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-4">Active Time (14 days)</h3>
              <p className="text-xs text-gray-400 mb-3">
                Team total from click and keydown activity (UTC days)
              </p>
              {history?.teamByDay?.length ? (
                <ActiveTimeBars days={history.teamByDay} />
              ) : (
                <div className="h-64 border border-gray-200 dark:border-white/10 rounded-lg flex items-center justify-center text-sm text-gray-400">
                  No activity data yet
                </div>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium mb-4">Chatter Performance</h3>
              <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-white/[0.02] text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="px-4 py-3 font-medium">Chatter</th>
                        <th className="px-4 py-3 font-medium">Avg Response</th>
                        <th className="px-4 py-3 font-medium">Daily Sales</th>
                        <th className="px-4 py-3 font-medium">Total Sales</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Active Today</th>
                        <th className="px-4 py-3 font-medium">Active (14d)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chatterRows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={7}
                            className="px-4 py-10 text-center text-gray-400"
                          >
                            No chatters to display
                          </td>
                        </tr>
                      ) : (
                        chatterRows.map((row) => (
                          <tr
                            key={row.chatterId}
                            className="border-t border-gray-100 dark:border-white/5"
                          >
                            <td className="px-4 py-3 font-medium whitespace-nowrap">
                              {row.chatterName}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {formatResponseTime(row.avgResponseTimeSeconds)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {formatCurrencyAmounts(row.dailySales)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              {formatCurrencyAmounts(row.totalSales)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <span
                                className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(row.status)}`}
                              >
                                {statusLabel(row.status)}
                              </span>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-gray-500 dark:text-gray-400">
                              {formatActiveDuration(row.activeSecondsToday)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-gray-500 dark:text-gray-400">
                              {formatActiveDuration(row.activeSecondsPeriod)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              {overview?.lastUpdated ? (
                <p className="mt-3 text-xs text-gray-400">
                  Last updated: {new Date(overview.lastUpdated).toLocaleString()}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
