import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import CreatorAvatar from '@/components/CreatorAvatar';
import PeriodDaysToggle, {
  DEFAULT_TIMEZONE,
  formatPeriodRangeLabel,
  rangeFromPresetDays,
  type ChartPeriodDays,
} from '@/components/PeriodDaysToggle';
import { useAuth } from '@/context/AuthContext';
import {
  getCreatorOverview,
  getCreatorSeries,
  getCreators,
  type Creator,
  type CreatorOverviewResponse,
  type CreatorSeriesDay,
  type CurrencyAmount,
} from '@/lib/api';
import { formatMoney, formatResponseTime } from '@/lib/messagingDashboardFormat';
import fourBasedIcon from '@/assets/4based_icon.ico';
import maloumIcon from '@/assets/maloum_icon.png';

function PlatformIcon({
  platform,
  className = 'w-3.5 h-3.5',
}: {
  platform?: 'maloum' | '4based' | null;
  className?: string;
}) {
  if (platform === '4based') {
    return <img src={fourBasedIcon} alt="" className={className} />;
  }
  if (platform === 'maloum') {
    return (
      <img
        src={maloumIcon}
        alt=""
        className={`${className} rounded-sm object-cover`}
      />
    );
  }
  return null;
}

function formatCurrencyAmounts(amounts: CurrencyAmount[] | undefined): string {
  if (!amounts || amounts.length === 0) return formatMoney(0, 'EUR');
  return amounts.map((item) => formatMoney(item.amount, item.currency)).join(' · ');
}

function dayTotal(amounts: CurrencyAmount[]): number {
  return amounts.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

function formatCount(value: number | undefined): string {
  return String(Math.max(0, Math.floor(Number(value) || 0)));
}

function formatPercent(value: number | undefined): string {
  return `${(Number(value) || 0).toFixed(2)}%`;
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
  days: { date: string; amounts: CurrencyAmount[] }[];
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

function SeriesLine({
  days,
  getValue,
  label,
}: {
  days: CreatorSeriesDay[];
  getValue: (day: CreatorSeriesDay) => number;
  label: string;
}) {
  const values = days.map(getValue);
  const max = Math.max(1, ...values);
  const width = 320;
  const height = 140;
  const padX = 8;
  const padY = 10;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const points = days.map((day, i) => {
    const x =
      days.length === 1 ? padX + innerW / 2 : padX + (i / (days.length - 1)) * innerW;
    const y = padY + innerH - (getValue(day) / max) * innerH;
    return { x, y, day, v: getValue(day) };
  });
  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg p-4">
      <h4 className="text-sm font-medium mb-3">{label}</h4>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-36 overflow-visible">
        {points.length > 1 ? (
          <path
            d={pathD}
            fill="none"
            className="stroke-orange-500"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {points.map((p) => (
          <circle key={p.day.date} cx={p.x} cy={p.y} r={3} className="fill-orange-500">
            <title>{`${p.day.date}: ${p.v}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function HourHeatmap({
  hours,
}: {
  hours: { hour: number; messagesSent: number; salesAmount: number }[];
}) {
  const max = Math.max(1, ...hours.map((h) => h.messagesSent));
  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg p-4">
      <h4 className="text-sm font-medium mb-3">Hour of day (messages)</h4>
      <div className="grid grid-cols-12 gap-1">
        {hours.map((h) => {
          const intensity = h.messagesSent / max;
          return (
            <div
              key={h.hour}
              className="aspect-square rounded-sm flex items-center justify-center text-[9px] text-gray-600 dark:text-gray-300"
              style={{
                backgroundColor: `rgba(249, 115, 22, ${0.08 + intensity * 0.85})`,
              }}
              title={`${h.hour}:00 — ${h.messagesSent} msgs · sales ${h.salesAmount.toFixed(2)}`}
            >
              {h.hour}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CreatorAnalytics() {
  const { user } = useAuth();
  const canView = user?.role === 'owner' || user?.role === 'manager';
  const [searchParams, setSearchParams] = useSearchParams();
  const creatorFromUrl = searchParams.get('creatorId') || '';

  const [creators, setCreators] = useState<Creator[]>([]);
  const [overview, setOverview] = useState<CreatorOverviewResponse | null>(null);
  const [series, setSeries] = useState<CreatorSeriesDay[]>([]);
  const viewerTimeZone = user?.timezone || DEFAULT_TIMEZONE;
  const defaultRange = useMemo(
    () => rangeFromPresetDays(7, viewerTimeZone),
    [viewerTimeZone]
  );
  const [presetDays, setPresetDays] = useState<ChartPeriodDays | null>(7);
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [creatorId, setCreatorId] = useState(creatorFromUrl);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const periodLabel = useMemo(
    () => formatPeriodRangeLabel(startDate, endDate),
    [startDate, endDate]
  );

  useEffect(() => {
    setCreatorId(creatorFromUrl);
  }, [creatorFromUrl]);

  useEffect(() => {
    void getCreators()
      .then((result) => setCreators(result.creators || []))
      .catch(() => setCreators([]));
  }, []);

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!canView) return;
      if (!options.silent) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const rangeFilters =
          presetDays != null
            ? { days: presetDays, startDate, endDate }
            : { startDate, endDate };
        const filters = {
          ...rangeFilters,
          creatorId: creatorId || undefined,
        };
        const [overviewResult, seriesResult] = await Promise.all([
          getCreatorOverview(filters),
          getCreatorSeries(
            presetDays != null
              ? { days: presetDays, creatorId: creatorId || undefined }
              : { startDate, endDate, creatorId: creatorId || undefined }
          ),
        ]);
        setOverview(overviewResult);
        setSeries(seriesResult.series || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load creator analytics');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [canView, presetDays, startDate, endDate, creatorId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (presetDays == null) return;
    const range = rangeFromPresetDays(presetDays, viewerTimeZone);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  }, [viewerTimeZone, presetDays]);

  const handlePresetChange = (days: ChartPeriodDays) => {
    const range = rangeFromPresetDays(days, viewerTimeZone);
    setPresetDays(days);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  };

  const selectedCreator = creators.find((c) => c.id === creatorId) || null;
  const selectedPlatform =
    overview?.selected?.platform || selectedCreator?.platform || null;

  const handleCreatorChange = (value: string) => {
    setCreatorId(value);
    const next = new URLSearchParams(searchParams);
    if (value) next.set('creatorId', value);
    else next.delete('creatorId');
    setSearchParams(next, { replace: true });
  };

  if (!user) return <Navigate to="/login" replace />;
  if (!canView) return <Navigate to="/dashboard" replace />;

  const summary = overview?.summary;

  return (
    <AppLayout title="Creator Analytics" activePage="creatorAnalytics">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold mb-1">Creator Analytics</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {periodLabel} ({overview?.timeZone || viewerTimeZone})
              {' · '}
              <Link
                to="/dashboard"
                className="text-gray-700 dark:text-gray-300 underline-offset-2 hover:underline"
              >
                Overview
              </Link>
            </p>
          </div>
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
                  onChange={(e) => {
                    setPresetDays(null);
                    setStartDate(e.target.value);
                  }}
                  disabled={loading || refreshing}
                  className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                To
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => {
                    setPresetDays(null);
                    setEndDate(e.target.value);
                  }}
                  disabled={loading || refreshing}
                  className="rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <PlatformIcon platform={selectedPlatform} className="w-4 h-4" />
              <select
                value={creatorId}
                onChange={(e) => handleCreatorChange(e.target.value)}
                disabled={loading || refreshing}
                className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-2 text-sm disabled:opacity-50"
              >
                <option value="">All creators</option>
                {creators.map((creator) => (
                  <option key={creator.id} value={creator.id}>
                    {creator.platform === '4based' ? '4based · ' : 'Maloum · '}
                    {creator.displayName}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => void load({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-2 self-start rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-2 text-sm disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="border border-gray-200 dark:border-white/10 rounded-lg p-12 text-center text-sm text-gray-400">
            Loading creator analytics...
          </div>
        ) : error ? (
          <div className="border border-red-200 dark:border-red-500/30 rounded-lg p-6 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : (
          <div className="space-y-10">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                label="PPVs Sent"
                value={formatCount(summary?.ppvsSent)}
              />
              <MetricCard
                label="Unique Fans"
                value={formatCount(summary?.uniqueFansMessaged)}
              />
              <MetricCard
                label="Total Sales"
                value={formatCurrencyAmounts(summary?.totalSales)}
              />
              <MetricCard
                label="Messages Sent"
                value={formatCount(summary?.messagesSent)}
              />
              <MetricCard
                label="Tip Sales"
                value={formatCurrencyAmounts(summary?.tipSales)}
              />
              <MetricCard
                label="PPV Sales"
                value={formatCurrencyAmounts(summary?.ppvSales)}
              />
              <MetricCard
                label="Pending PPVs"
                value={formatCount(summary?.pendingPpvs)}
              />
              <MetricCard
                label="Avg PPV Price"
                value={
                  summary?.avgPpvPrice != null
                    ? summary.avgPpvPrice.toFixed(2)
                    : '--'
                }
              />
              <MetricCard
                label="Revenue / Fan"
                value={formatCurrencyAmounts(summary?.revenuePerFan)}
              />
              <MetricCard
                label="PPV Conversion"
                value={formatPercent(summary?.ppvConversionRate)}
              />
              <MetricCard
                label="Photo / Video PPVs"
                value={`${formatCount(summary?.photoPpvs)} / ${formatCount(summary?.videoPpvs)}`}
              />
              <MetricCard
                label="Free vs Paid"
                value={`${formatCount(summary?.freeMediaSent)} / ${formatCount(summary?.ppvsSent)}`}
              />
              <MetricCard
                label="p50 / p90 Response"
                value={`${formatResponseTime(summary?.p50ResponseSeconds ?? null)} / ${formatResponseTime(summary?.p90ResponseSeconds ?? null)}`}
              />
              <MetricCard
                label="Fans Who Unlocked"
                value={formatCount(summary?.fansWhoUnlocked)}
              />
              <MetricCard
                label="Sales / Message"
                value={formatCurrencyAmounts(summary?.salesPerMessage)}
              />
              <MetricCard
                label="Median PPV Price"
                value={
                  summary?.medianPpvPrice != null
                    ? summary.medianPpvPrice.toFixed(2)
                    : '--'
                }
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm font-medium mb-3">Daily sales</h3>
                {summary?.dailySalesByDay?.length ? (
                  <DailySalesBars days={summary.dailySalesByDay} />
                ) : (
                  <div className="h-64 border border-gray-200 dark:border-white/10 rounded-lg flex items-center justify-center text-sm text-gray-400">
                    No sales data
                  </div>
                )}
              </div>
              <HourHeatmap hours={summary?.hourOfDay || []} />
              <SeriesLine
                days={series}
                label="Messages sent"
                getValue={(d) => d.messagesSent}
              />
              <SeriesLine
                days={series}
                label="PPVs sent"
                getValue={(d) => d.ppvsSent}
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-white/5 text-sm font-medium">
                  Sales by chatter
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {(summary?.salesByChatter || []).length === 0 ? (
                        <tr>
                          <td className="px-4 py-8 text-center text-gray-400">
                            No chatter sales
                          </td>
                        </tr>
                      ) : (
                        (summary?.salesByChatter || [])
                          .slice()
                          .sort((a, b) => dayTotal(b.amounts) - dayTotal(a.amounts))
                          .map((row) => (
                            <tr
                              key={row.chatterId}
                              className="border-t border-gray-100 dark:border-white/5"
                            >
                              <td className="px-4 py-3">{row.chatterName}</td>
                              <td className="px-4 py-3 text-right">
                                {formatCurrencyAmounts(row.amounts)}
                              </td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-white/5 text-sm font-medium">
                  Sales by platform
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {(summary?.salesByPlatform || []).length === 0 ? (
                        <tr>
                          <td className="px-4 py-8 text-center text-gray-400">
                            No platform sales
                          </td>
                        </tr>
                      ) : (
                        (summary?.salesByPlatform || []).map((row) => (
                          <tr
                            key={row.platform}
                            className="border-t border-gray-100 dark:border-white/5"
                          >
                            <td className="px-4 py-3 capitalize">{row.platform}</td>
                            <td className="px-4 py-3 text-right">
                              {formatCurrencyAmounts(row.amounts)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-white/5 text-sm font-medium">
                  Unlock rate by price band
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-gray-500">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium">Band</th>
                        <th className="px-4 py-2 text-left font-medium">Sent</th>
                        <th className="px-4 py-2 text-left font-medium">Unlocked</th>
                        <th className="px-4 py-2 text-left font-medium">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(summary?.unlockRateByPriceBand || []).map((band) => (
                        <tr
                          key={band.band}
                          className="border-t border-gray-100 dark:border-white/5"
                        >
                          <td className="px-4 py-3">{band.label}</td>
                          <td className="px-4 py-3">{band.sent}</td>
                          <td className="px-4 py-3">{band.unlocked}</td>
                          <td className="px-4 py-3">{formatPercent(band.unlockRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-white/5 text-sm font-medium">
                  Top fans by spend
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {(summary?.topFans || []).length === 0 ? (
                        <tr>
                          <td className="px-4 py-8 text-center text-gray-400">
                            No fan spend yet
                          </td>
                        </tr>
                      ) : (
                        (summary?.topFans || []).map((fan) => (
                          <tr
                            key={fan.fanId}
                            className="border-t border-gray-100 dark:border-white/5"
                          >
                            <td className="px-4 py-3">
                              {fan.fanUsername || fan.fanId}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {formatCurrencyAmounts(fan.amounts)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {!creatorId ? (
              <div>
                <h3 className="text-sm font-medium mb-3">Creator comparison</h3>
                <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-white/[0.02] text-left text-xs uppercase tracking-wide text-gray-500">
                        <tr>
                          <th className="px-4 py-3 font-medium">Creator</th>
                          <th className="px-4 py-3 font-medium">Sales</th>
                          <th className="px-4 py-3 font-medium">Tips</th>
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
                              colSpan={7}
                              className="px-4 py-10 text-center text-gray-400"
                            >
                              No creators in this period
                            </td>
                          </tr>
                        ) : (
                          (overview?.creators || [])
                            .slice()
                            .sort(
                              (a, b) =>
                                dayTotal(b.totalSales) - dayTotal(a.totalSales)
                            )
                            .map((creator) => (
                              <tr
                                key={creator.creatorId}
                                className="border-t border-gray-100 dark:border-white/5"
                              >
                                <td className="px-4 py-3">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleCreatorChange(creator.creatorId)
                                    }
                                    className="flex items-center gap-2 hover:underline"
                                  >
                                    <PlatformIcon
                                      platform={creator.platform}
                                      className="w-3.5 h-3.5 shrink-0"
                                    />
                                    <CreatorAvatar
                                      avatarUrl={creator.creatorAvatarUrl}
                                      displayName={creator.creatorName}
                                      className="w-7 h-7 rounded-full object-cover"
                                      initialsClassName="w-7 h-7 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-[10px]"
                                    />
                                    {creator.creatorName}
                                  </button>
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {formatCurrencyAmounts(creator.totalSales)}
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap">
                                  {formatCurrencyAmounts(creator.tipSales)}
                                </td>
                                <td className="px-4 py-3">
                                  {formatCount(creator.messagesSent)}
                                </td>
                                <td className="px-4 py-3">
                                  {formatCount(creator.ppvsSent)}
                                </td>
                                <td className="px-4 py-3">
                                  {formatCount(creator.uniqueFansMessaged)}
                                </td>
                                <td className="px-4 py-3">
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

            {overview?.lastUpdated ? (
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
