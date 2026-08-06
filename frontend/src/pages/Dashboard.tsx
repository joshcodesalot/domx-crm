import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import PeriodDaysToggle, {
  formatPeriodRangeLabel,
  rangeFromPresetDays,
  type ChartPeriodDays,
} from '@/components/PeriodDaysToggle';
import { useAuth } from '@/context/AuthContext';
import {
  getActivityHistory,
  getActivityPresence,
  getLeaderboard,
  getOverviewAnalytics,
  type ActivityHistoryDay,
  type ActivityHistoryResponse,
  type CurrencyAmount,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type LeaderboardViewerRank,
  type OverviewAnalyticsResponse,
  type OverviewChatterStats,
  type OverviewCreatorStats,
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

function formatPercent(value: number | undefined): string {
  const n = Number(value) || 0;
  return `${n.toFixed(2)}%`;
}

function formatCount(value: number | undefined): string {
  return String(Math.max(0, Math.floor(Number(value) || 0)));
}

function formatRate(value: number | undefined): string {
  const n = Number(value) || 0;
  return n.toFixed(1);
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

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="p-5 border border-gray-200 dark:border-white/5 rounded-lg bg-gray-50/50 dark:bg-transparent">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1" title={hint}>
        {label}
      </p>
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

function DayActivityBars({ days }: { days: ActivityHistoryDay[] }) {
  const max = Math.max(
    1,
    ...days.map((day) => (day.activeSeconds || 0) + (day.idleSeconds || 0))
  );

  return (
    <div className="h-64 border border-gray-200 dark:border-white/10 rounded-lg p-4 flex items-end gap-1.5">
      {days.map((day) => {
        const active = day.activeSeconds || 0;
        const idle = day.idleSeconds || 0;
        const total = active + idle;
        const heightPct = Math.max(total > 0 ? 6 : 2, Math.round((total / max) * 100));
        const activeShare = total > 0 ? (active / total) * 100 : 0;
        const label = new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
        return (
          <div
            key={day.date}
            className="flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1"
            title={`${label}: Active ${formatActiveDuration(active)} · Idle ${formatActiveDuration(idle)}`}
          >
            <div
              className="w-full max-w-[28px] rounded-t overflow-hidden flex flex-col justify-end transition-all"
              style={{ height: `${heightPct}%` }}
            >
              <div
                className="w-full bg-amber-400/80 dark:bg-amber-400/60"
                style={{ height: `${100 - activeShare}%` }}
              />
              <div
                className="w-full bg-gray-900 dark:bg-white/80"
                style={{ height: `${activeShare}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 truncate w-full text-center">
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function LeaderboardCard({
  title,
  hint,
  entries,
  viewerRank,
  viewerId,
}: {
  title: string;
  hint?: string;
  entries: LeaderboardEntry[];
  viewerRank: LeaderboardViewerRank | null | undefined;
  viewerId?: string;
}) {
  const viewerInTop = entries.some((e) => e.userId === viewerId);

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg p-4">
      <h4 className="text-sm font-medium mb-1" title={hint}>
        {title}
      </h4>
      <p className="text-[11px] text-gray-400 mb-3">Values are partially hidden</p>
      <div className="space-y-2">
        {entries.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No data yet</p>
        ) : (
          entries.map((entry) => {
            const isViewer = entry.userId === viewerId;
            return (
              <div
                key={`${title}-${entry.userId}`}
                className={`flex items-center justify-between gap-3 text-sm ${
                  isViewer ? 'font-medium text-gray-900 dark:text-gray-100' : ''
                }`}
              >
                <span className="truncate min-w-0">
                  <span className="text-gray-400 mr-2 tabular-nums">#{entry.rank}</span>
                  {entry.userName}
                  {isViewer ? (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">
                      you
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400 font-mono text-xs">
                  {entry.maskedValue}
                </span>
              </div>
            );
          })
        )}
      </div>
      {viewerRank && !viewerInTop ? (
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-white/5 flex items-center justify-between gap-3 text-sm">
          <span className="truncate min-w-0 text-gray-500">
            <span className="text-gray-400 mr-2 tabular-nums">#{viewerRank.rank}</span>
            You
          </span>
          <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400 font-mono text-xs">
            {viewerRank.maskedValue}
          </span>
        </div>
      ) : null}
    </div>
  );
}

type ChatterRow = OverviewChatterStats & {
  status: PresenceStatus;
  activeSecondsToday: number;
  idleSecondsToday: number;
  keystrokesToday: number;
  activeSecondsPeriod: number;
  idleSecondsPeriod: number;
  keystrokesPeriod: number;
};

export default function Dashboard() {
  const { user, hasPermission } = useAuth();
  const canViewTeamAnalytics = hasPermission('analytics.view');
  const canViewSelfAnalytics = hasPermission('analytics.self');
  const canViewAnalytics = canViewTeamAnalytics || canViewSelfAnalytics;
  const isTeamScope =
    user?.role === 'owner' || user?.role === 'manager';

  const [overview, setOverview] = useState<OverviewAnalyticsResponse | null>(null);
  const [history, setHistory] = useState<ActivityHistoryResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [presenceById, setPresenceById] = useState<Record<string, PresenceChatter>>({});
  const [onlineCount, setOnlineCount] = useState(0);
  const defaultRange = useMemo(() => rangeFromPresetDays(7), []);
  const [presetDays, setPresetDays] = useState<ChartPeriodDays | null>(7);
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const periodLabel = useMemo(
    () => formatPeriodRangeLabel(startDate, endDate),
    [startDate, endDate]
  );

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
        const rangeFilters =
          presetDays != null
            ? { days: presetDays, startDate, endDate }
            : { startDate, endDate };

        const [overviewResult, presenceResult, historyResult, leaderboardResult] =
          await Promise.all([
            getOverviewAnalytics(rangeFilters),
            getActivityPresence(),
            getActivityHistory(
              presetDays != null
                ? { days: presetDays }
                : { startDate, endDate }
            ),
            getLeaderboard(),
          ]);

        setOverview(overviewResult);
        setHistory(historyResult);
        setLeaderboard(leaderboardResult);

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
    [canViewAnalytics, presetDays, startDate, endDate]
  );

  const handlePresetChange = (days: ChartPeriodDays) => {
    const range = rangeFromPresetDays(days);
    setPresetDays(days);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  };

  const handleStartDateChange = (value: string) => {
    setPresetDays(null);
    setStartDate(value);
  };

  const handleEndDateChange = (value: string) => {
    setPresetDays(null);
    setEndDate(value);
  };

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
    const map: Record<
      string,
      { active: number; idle: number; keystrokes: number }
    > = {};
    for (const chatter of history?.chatters || []) {
      map[chatter.userId] = {
        active: chatter.activeSecondsPeriod,
        idle: chatter.idleSecondsPeriod || 0,
        keystrokes: chatter.keystrokesPeriod || 0,
      };
    }
    return map;
  }, [history]);

  const chatterRows: ChatterRow[] = useMemo(() => {
    const fromOverview = overview?.chatters || [];
    const overviewIds = new Set(fromOverview.map((c) => c.chatterId));

    const rows: ChatterRow[] = fromOverview.map((chatter) => {
      const presence = presenceById[chatter.chatterId];
      const period = periodByUserId[chatter.chatterId];
      return {
        ...chatter,
        status: presence?.status || 'away',
        activeSecondsToday: presence?.activeSecondsToday || 0,
        idleSecondsToday: presence?.idleSecondsToday || 0,
        keystrokesToday: presence?.keystrokesToday || 0,
        activeSecondsPeriod: period?.active || 0,
        idleSecondsPeriod: period?.idle || 0,
        keystrokesPeriod: period?.keystrokes || 0,
      };
    });

    for (const presence of Object.values(presenceById)) {
      if (overviewIds.has(presence.userId)) continue;
      const period = periodByUserId[presence.userId];
      rows.push({
        chatterId: presence.userId,
        chatterName: presence.userName,
        avgResponseTimeSeconds: null,
        dailySales: [],
        totalSales: [],
        monthlyRevenue: [],
        messagesSent: 0,
        ppvsSent: 0,
        ppvsUnlocked: 0,
        goldenRatio: 0,
        ppvConversionRate: 0,
        status: presence.status,
        activeSecondsToday: presence.activeSecondsToday,
        idleSecondsToday: presence.idleSecondsToday || 0,
        keystrokesToday: presence.keystrokesToday || 0,
        activeSecondsPeriod: period?.active || 0,
        idleSecondsPeriod: period?.idle || 0,
        keystrokesPeriod: period?.keystrokes || 0,
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

  const showTeamWidgets = isTeamScope;

  return (
    <AppLayout title="Overview" activePage="dashboard">
      <div className="max-w-5xl mx-auto">
        <div className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold mb-1">{getGreeting()}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {!canViewAnalytics
                ? `Welcome back, ${user.name}`
                : isTeamScope
                  ? 'Team performance and chatter activity'
                  : 'Your performance and activity'}
            </p>
          </div>

          {canViewAnalytics ? (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <PeriodDaysToggle
                value={presetDays}
                onChange={handlePresetChange}
                disabled={loading || refreshing}
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  From
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => handleStartDateChange(e.target.value)}
                    disabled={loading || refreshing}
                    className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-2 py-1.5 text-sm text-gray-700 dark:text-gray-200 disabled:opacity-50"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  To
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => handleEndDateChange(e.target.value)}
                    disabled={loading || refreshing}
                    className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-2 py-1.5 text-sm text-gray-700 dark:text-gray-200 disabled:opacity-50"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={() => void loadData({ silent: true })}
                disabled={refreshing}
                className="inline-flex items-center gap-2 self-start rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
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
                hint="Purchased revenue during each chatter’s scheduled shift today (Asia/Manila)"
              />
              <MetricCard
                label="Period Sales"
                value={formatCurrencyAmounts(
                  overview?.totalRevenue || overview?.totalSales
                )}
                hint={`Purchased revenue for ${periodLabel}`}
              />
              <MetricCard
                label="Monthly Revenue"
                value={formatCurrencyAmounts(overview?.monthlyRevenue)}
                hint="Purchased revenue this calendar month (Asia/Manila)"
              />
              <MetricCard
                label="Avg Response Time"
                value={formatResponseTime(overview?.avgResponseTimeSeconds)}
                hint={`Average response time for ${periodLabel} (scheduled hours)`}
              />
              <MetricCard
                label="Messages Sent"
                value={formatCount(overview?.totalMessagesSent)}
                hint={`Direct messages sent in ${periodLabel}`}
              />
              <MetricCard
                label="Sent PPV"
                value={formatCount(overview?.ppvsSent)}
                hint={`Direct PPVs sent in ${periodLabel}`}
              />
              <MetricCard
                label="PPV Conversion Rate"
                value={formatPercent(overview?.ppvConversionRate)}
                hint={`Unlocked ÷ sent for ${periodLabel}`}
              />
              <MetricCard
                label="Golden Ratio"
                value={formatPercent(overview?.goldenRatio)}
                hint={`PPVs sent ÷ DMs sent for ${periodLabel}`}
              />
              <MetricCard
                label="Keystrokes"
                value={formatCount(overview?.keystrokesTotal)}
                hint={`Keystrokes in ${periodLabel}`}
              />
              <MetricCard
                label="Revenue per Hour"
                value={formatCurrencyAmounts(overview?.revenuePerHour)}
                hint={`Period sales ÷ active hours for ${periodLabel}`}
              />
              <MetricCard
                label="Messages per Hour"
                value={formatRate(overview?.messagesPerHour)}
                hint={`Period messages ÷ active hours for ${periodLabel}`}
              />
              <MetricCard
                label="Tip Sales"
                value={formatCurrencyAmounts(overview?.tipSales)}
                hint={`Tip revenue for ${periodLabel}`}
              />
              <MetricCard
                label="PPV Sales"
                value={formatCurrencyAmounts(overview?.ppvSales)}
                hint={`Unlocked PPV revenue for ${periodLabel}`}
              />
              <MetricCard
                label="Unique Fans"
                value={formatCount(overview?.uniqueFansMessaged)}
                hint={`Distinct fans messaged in ${periodLabel}`}
              />
              <MetricCard
                label="Fans Who Unlocked"
                value={formatCount(overview?.fansWhoUnlocked)}
                hint={`Fans who unlocked a PPV in ${periodLabel}`}
              />
              <MetricCard
                label="Pending PPVs"
                value={formatCount(overview?.pendingPpvs)}
                hint={`Sent PPVs not yet unlocked in ${periodLabel}`}
              />
              <MetricCard
                label="Avg PPV Price"
                value={
                  overview?.avgPpvPrice != null
                    ? overview.avgPpvPrice.toFixed(2)
                    : '--'
                }
                hint={`Average listed PPV price for ${periodLabel}`}
              />
              <MetricCard
                label="Revenue per Fan"
                value={formatCurrencyAmounts(overview?.revenuePerFan)}
                hint={`PPV sales ÷ fans who unlocked for ${periodLabel}`}
              />
              <MetricCard
                label="Sales per Message"
                value={formatCurrencyAmounts(overview?.salesPerMessage)}
                hint={`Period sales ÷ messages for ${periodLabel}`}
              />
              <MetricCard
                label="p50 Response"
                value={formatResponseTime(overview?.p50ResponseSeconds ?? null)}
                hint={`Median response time for ${periodLabel} (scheduled hours)`}
              />
              <MetricCard
                label="p90 Response"
                value={formatResponseTime(overview?.p90ResponseSeconds ?? null)}
                hint={`90th percentile response time for ${periodLabel} (scheduled hours)`}
              />
              <MetricCard
                label="Idle %"
                value={formatPercent(overview?.idlePercent)}
                hint={`Idle ÷ (active + idle) for ${periodLabel}`}
              />
              <MetricCard
                label="Free Media"
                value={formatCount(overview?.freeMediaSent)}
                hint={`Free media sends in ${periodLabel}`}
              />
              <MetricCard
                label="Photo / Video PPVs"
                value={`${formatCount(overview?.photoPpvs)} / ${formatCount(overview?.videoPpvs)}`}
                hint={`Photo-only vs video PPVs sent in ${periodLabel}`}
              />
              {showTeamWidgets ? (
                <MetricCard label="Online Chatters" value={String(onlineCount)} />
              ) : null}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className={showTeamWidgets ? 'lg:col-span-2' : 'lg:col-span-3'}>
                <h3 className="text-sm font-medium mb-4">
                  Daily Sales ({periodLabel})
                </h3>
                {overview?.dailySalesByDay?.length ? (
                  <DailySalesBars days={overview.dailySalesByDay} />
                ) : (
                  <div className="h-64 border border-gray-200 dark:border-white/10 rounded-lg flex items-center justify-center text-sm text-gray-400">
                    No data available
                  </div>
                )}
              </div>

              {showTeamWidgets ? (
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
              ) : null}
            </div>

            {showTeamWidgets ? (
              <div>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium mb-1">Creators</h3>
                    <p className="text-xs text-gray-400">
                      Period performance by creator
                    </p>
                  </div>
                  <Link
                    to="/dashboard/creator-analytics"
                    className="text-xs text-gray-600 dark:text-gray-300 underline-offset-2 hover:underline"
                  >
                    Open creator analytics
                  </Link>
                </div>
                <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-white/[0.02] text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        <tr>
                          <th className="px-4 py-3 font-medium">Creator</th>
                          <th className="px-4 py-3 font-medium">Sales</th>
                          <th className="px-4 py-3 font-medium">Messages</th>
                          <th className="px-4 py-3 font-medium">PPVs</th>
                          <th className="px-4 py-3 font-medium">Fans</th>
                          <th className="px-4 py-3 font-medium">Conv.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(overview?.creators || []).length === 0 ? (
                          <tr>
                            <td
                              colSpan={6}
                              className="px-4 py-10 text-center text-gray-400"
                            >
                              No creator data for this period
                            </td>
                          </tr>
                        ) : (
                          (overview?.creators || [])
                            .slice()
                            .sort(
                              (a: OverviewCreatorStats, b: OverviewCreatorStats) =>
                                dayTotal(b.totalSales) - dayTotal(a.totalSales)
                            )
                            .slice(0, 10)
                            .map((creator) => (
                              <tr
                                key={creator.creatorId}
                                className="border-t border-gray-100 dark:border-white/5"
                              >
                                <td className="px-4 py-3 font-medium whitespace-nowrap">
                                  <Link
                                    to={`/dashboard/creator-analytics?creatorId=${creator.creatorId}`}
                                    className="hover:underline"
                                  >
                                    {creator.creatorName}
                                  </Link>
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {formatCurrencyAmounts(creator.totalSales)}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {formatCount(creator.messagesSent)}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {formatCount(creator.ppvsSent)}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {formatCount(creator.uniqueFansMessaged)}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {formatPercent(creator.ppvConversionRate)}
                                </td>
                              </tr>
                            ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : null}

            <div>
              <h3 className="text-sm font-medium mb-1">Leaderboard</h3>
              <p className="text-xs text-gray-400 mb-4">
                Team rankings with partially hidden totals. Rankings use each
                chatter&apos;s scheduled hours (PHT); no schedule means all day.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <LeaderboardCard
                  title="Top Response Time"
                  hint="Fastest average response this month (scheduled hours)"
                  entries={leaderboard?.topResponseTime || []}
                  viewerRank={leaderboard?.viewerRank?.responseTime}
                  viewerId={user.id}
                />
                <LeaderboardCard
                  title="Top Sales"
                  hint="Highest purchased revenue this month (scheduled hours)"
                  entries={leaderboard?.topSales || []}
                  viewerRank={leaderboard?.viewerRank?.sales}
                  viewerId={user.id}
                />
                <LeaderboardCard
                  title="Top PPVs Unlocked"
                  hint="Most unlocked direct PPVs this month (scheduled hours)"
                  entries={leaderboard?.topPpvsUnlocked || []}
                  viewerRank={leaderboard?.viewerRank?.ppvsUnlocked}
                  viewerId={user.id}
                />
                <LeaderboardCard
                  title="Top Golden Ratio"
                  hint="Highest PPVs sent ÷ DMs sent this month (scheduled hours)"
                  entries={leaderboard?.topGoldenRatio || []}
                  viewerRank={leaderboard?.viewerRank?.goldenRatio}
                  viewerId={user.id}
                />
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-4">
                Day Activity Time ({periodLabel})
              </h3>
              <p className="text-xs text-gray-400 mb-3">
                {isTeamScope ? 'Team' : 'Your'} active (dark) and idle (amber) time from
                click and keydown activity (Asia/Manila days)
              </p>
              {history?.teamByDay?.length ? (
                <DayActivityBars days={history.teamByDay} />
              ) : (
                <div className="h-64 border border-gray-200 dark:border-white/10 rounded-lg flex items-center justify-center text-sm text-gray-400">
                  No activity data yet
                </div>
              )}
            </div>

            {showTeamWidgets ? (
              <div>
                <h3 className="text-sm font-medium mb-1">Staff Performance</h3>
                <p className="text-xs text-gray-400 mb-4">
                  Daily sales count during each person&apos;s scheduled shift today;
                  messages count only during scheduled hours
                </p>
                <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-white/[0.02] text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        <tr>
                          <th className="px-4 py-3 font-medium">Staff</th>
                          <th className="px-4 py-3 font-medium">Avg Response</th>
                          <th className="px-4 py-3 font-medium">Daily Sales</th>
                          <th className="px-4 py-3 font-medium">Total Sales</th>
                          <th className="px-4 py-3 font-medium">Messages</th>
                          <th className="px-4 py-3 font-medium">Sent PPV</th>
                          <th className="px-4 py-3 font-medium">Rev/hr</th>
                          <th className="px-4 py-3 font-medium">Msg/hr</th>
                          <th className="px-4 py-3 font-medium">PPV Conv.</th>
                          <th className="px-4 py-3 font-medium">Golden</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                          <th className="px-4 py-3 font-medium">Active Today</th>
                          <th className="px-4 py-3 font-medium">Idle Today</th>
                          <th className="px-4 py-3 font-medium">Keys Today</th>
                          <th className="px-4 py-3 font-medium">
                            Active (
                            {presetDays != null
                              ? `${presetDays}d`
                              : history?.days
                                ? `${history.days}d`
                                : 'period'}
                            )
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {chatterRows.length === 0 ? (
                          <tr>
                            <td
                              colSpan={15}
                              className="px-4 py-10 text-center text-gray-400"
                            >
                              No staff to display
                            </td>
                          </tr>
                        ) : (
                          chatterRows.map((row) => (
                            <tr
                              key={row.chatterId}
                              className="border-t border-gray-100 dark:border-white/5"
                            >
                              <td className="px-4 py-3 font-medium whitespace-nowrap">
                                <div>{row.chatterName}</div>
                                <div className="text-xs font-normal text-gray-400">
                                  {row.scheduleApplied
                                    ? row.shiftLabel || 'Scheduled'
                                    : 'All day'}
                                </div>
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
                                {formatCount(row.messagesSent)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {formatCount(row.ppvsSent)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {formatCurrencyAmounts(row.revenuePerHour)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {formatRate(row.messagesPerHour)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {formatPercent(row.ppvConversionRate)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                {formatPercent(row.goldenRatio)}
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
                                {formatActiveDuration(row.idleSecondsToday)}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-gray-500 dark:text-gray-400">
                                {formatCount(row.keystrokesToday)}
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
            ) : overview?.lastUpdated ? (
              <p className="text-xs text-gray-400">
                Last updated: {new Date(overview.lastUpdated).toLocaleString()}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
