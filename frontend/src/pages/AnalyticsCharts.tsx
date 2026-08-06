import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { Info, RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import PeriodDaysToggle, {
  formatPeriodRangeLabel,
  rangeFromPresetDays,
  type ChartPeriodDays,
} from '@/components/PeriodDaysToggle';
import { useAuth } from '@/context/AuthContext';
import {
  getAnalyticsSeries,
  type AnalyticsSeriesDay,
  type AnalyticsSeriesResponse,
  type AnalyticsSeriesStaff,
  type CurrencyAmount,
} from '@/lib/api';
import { formatMoney } from '@/lib/messagingDashboardFormat';

const STAFF_COLORS = [
  { stroke: 'stroke-orange-500', fill: 'fill-orange-500', hex: '#f97316' },
  { stroke: 'stroke-sky-500', fill: 'fill-sky-500', hex: '#0ea5e9' },
  { stroke: 'stroke-emerald-500', fill: 'fill-emerald-500', hex: '#10b981' },
  { stroke: 'stroke-violet-500', fill: 'fill-violet-500', hex: '#8b5cf6' },
  { stroke: 'stroke-rose-500', fill: 'fill-rose-500', hex: '#f43f5e' },
  { stroke: 'stroke-amber-500', fill: 'fill-amber-500', hex: '#f59e0b' },
  { stroke: 'stroke-teal-500', fill: 'fill-teal-500', hex: '#14b8a6' },
  { stroke: 'stroke-indigo-500', fill: 'fill-indigo-500', hex: '#6366f1' },
];

function formatCurrencyAmounts(amounts: CurrencyAmount[] | undefined): string {
  if (!amounts || amounts.length === 0) {
    return formatMoney(0, 'EUR');
  }
  return amounts.map((item) => formatMoney(item.amount, item.currency)).join(' · ');
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function ChartCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h3>
        {hint ? (
          <span title={hint} className="text-gray-400">
            <Info className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function LineChart({
  days,
  getValue,
  formatTooltip,
  colorClass = 'stroke-orange-500',
  fillClass = 'fill-orange-500',
  yMax,
  yTickFormat,
}: {
  days: AnalyticsSeriesDay[];
  getValue: (day: AnalyticsSeriesDay) => number;
  formatTooltip: (day: AnalyticsSeriesDay, value: number) => string;
  colorClass?: string;
  fillClass?: string;
  yMax?: number;
  yTickFormat?: (v: number) => string;
}) {
  const values = days.map((d) => getValue(d));
  const dataMax = Math.max(0, ...values);
  const max = yMax != null ? Math.max(yMax, dataMax || 1) : Math.max(1, dataMax);
  const width = 320;
  const height = 160;
  const padX = 8;
  const padY = 12;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const points = days.map((day, i) => {
    const x =
      days.length === 1
        ? padX + innerW / 2
        : padX + (i / (days.length - 1)) * innerW;
    const v = getValue(day);
    const y = padY + innerH - (v / max) * innerH;
    return { x, y, day, v };
  });

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(max * t));

  return (
    <div className="relative">
      <div className="flex gap-3">
        <div className="flex flex-col justify-between text-[10px] text-gray-400 py-1 w-10 text-right shrink-0">
          {[...ticks].reverse().map((t) => (
            <span key={t}>{yTickFormat ? yTickFormat(t) : t}</span>
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-40 overflow-visible"
            role="img"
          >
            {ticks.map((t) => {
              const y = padY + innerH - (t / max) * innerH;
              return (
                <line
                  key={t}
                  x1={padX}
                  x2={width - padX}
                  y1={y}
                  y2={y}
                  className="stroke-gray-200 dark:stroke-white/10"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
              );
            })}
            {points.length > 1 ? (
              <path
                d={pathD}
                fill="none"
                className={colorClass}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null}
            {points.map((p) => (
              <circle
                key={p.day.date}
                cx={p.x}
                cy={p.y}
                r={3.5}
                className={`${fillClass} ${colorClass}`}
              >
                <title>{formatTooltip(p.day, p.v)}</title>
              </circle>
            ))}
          </svg>
          <div className="flex justify-between mt-1 px-1">
            {days.map((day) => (
              <span
                key={day.date}
                className="text-[10px] text-gray-400 truncate flex-1 text-center"
              >
                {dayLabel(day.date)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MultiLineChart({
  staffSeries,
  getValue,
  formatValue,
  yMax,
  yTickFormat,
}: {
  staffSeries: AnalyticsSeriesStaff[];
  getValue: (day: AnalyticsSeriesDay) => number;
  formatValue: (day: AnalyticsSeriesDay, value: number, name: string) => string;
  yMax?: number;
  yTickFormat?: (v: number) => string;
}) {
  const dates =
    staffSeries[0]?.series.map((d) => d.date) ||
    ([] as string[]);
  const allValues = staffSeries.flatMap((s) => s.series.map((d) => getValue(d)));
  const dataMax = Math.max(0, ...allValues);
  const max = yMax != null ? Math.max(yMax, dataMax || 1) : Math.max(1, dataMax);
  const width = 320;
  const height = 160;
  const padX = 8;
  const padY = 12;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(max * t));

  return (
    <div className="relative">
      <div className="flex gap-3">
        <div className="flex flex-col justify-between text-[10px] text-gray-400 py-1 w-10 text-right shrink-0">
          {[...ticks].reverse().map((t) => (
            <span key={t}>{yTickFormat ? yTickFormat(t) : t}</span>
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-40 overflow-visible"
            role="img"
          >
            {ticks.map((t) => {
              const y = padY + innerH - (t / max) * innerH;
              return (
                <line
                  key={t}
                  x1={padX}
                  x2={width - padX}
                  y1={y}
                  y2={y}
                  className="stroke-gray-200 dark:stroke-white/10"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
              );
            })}
            {staffSeries.map((staff, staffIndex) => {
              const color = STAFF_COLORS[staffIndex % STAFF_COLORS.length];
              const points = staff.series.map((day, i) => {
                const x =
                  staff.series.length === 1
                    ? padX + innerW / 2
                    : padX + (i / (staff.series.length - 1)) * innerW;
                const v = getValue(day);
                const y = padY + innerH - (v / max) * innerH;
                return { x, y, day, v };
              });
              const pathD = points
                .map(
                  (p, i) =>
                    `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`
                )
                .join(' ');
              return (
                <g key={staff.chatterId}>
                  {points.length > 1 ? (
                    <path
                      d={pathD}
                      fill="none"
                      stroke={color.hex}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ) : null}
                  {points.map((p) => (
                    <circle
                      key={`${staff.chatterId}-${p.day.date}`}
                      cx={p.x}
                      cy={p.y}
                      r={3}
                      fill={color.hex}
                    >
                      <title>
                        {formatValue(p.day, p.v, staff.chatterName)}
                      </title>
                    </circle>
                  ))}
                </g>
              );
            })}
          </svg>
          <div className="flex justify-between mt-1 px-1">
            {dates.map((date) => (
              <span
                key={date}
                className="text-[10px] text-gray-400 truncate flex-1 text-center"
              >
                {dayLabel(date)}
              </span>
            ))}
          </div>
          {staffSeries.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">
              {staffSeries.map((staff, i) => {
                const color = STAFF_COLORS[i % STAFF_COLORS.length];
                return (
                  <span
                    key={staff.chatterId}
                    className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"
                  >
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: color.hex }}
                    />
                    <span className="truncate max-w-[120px]">{staff.chatterName}</span>
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActivityStackedBars({ days }: { days: AnalyticsSeriesDay[] }) {
  const max = Math.max(
    1,
    ...days.map((d) => (d.activeSeconds || 0) + (d.idleSeconds || 0))
  );

  return (
    <div className="h-44 flex items-end gap-1.5">
      {days.map((day) => {
        const active = day.activeSeconds || 0;
        const idle = day.idleSeconds || 0;
        const total = active + idle;
        const heightPct = Math.max(total > 0 ? 8 : 2, Math.round((total / max) * 100));
        const activeShare = total > 0 ? (active / total) * 100 : 0;
        return (
          <div
            key={day.date}
            className="flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1"
            title={`${dayLabel(day.date)}: Active ${formatDuration(active)} · Idle ${formatDuration(idle)}`}
          >
            <div
              className="w-full max-w-[36px] rounded-t overflow-hidden flex flex-col justify-end"
              style={{ height: `${heightPct}%` }}
            >
              <div
                className="w-full bg-amber-400/80 dark:bg-amber-400/60"
                style={{ height: `${100 - activeShare}%` }}
              />
              <div
                className="w-full bg-teal-500 dark:bg-teal-400"
                style={{ height: `${activeShare}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 truncate w-full text-center">
              {dayLabel(day.date)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MetricLineChart({
  compareMode,
  series,
  staffSeries,
  getValue,
  formatSingle,
  formatCompare,
  colorClass,
  fillClass,
  yMax,
  yTickFormat,
}: {
  compareMode: boolean;
  series: AnalyticsSeriesDay[];
  staffSeries: AnalyticsSeriesStaff[];
  getValue: (day: AnalyticsSeriesDay) => number;
  formatSingle: (day: AnalyticsSeriesDay, value: number) => string;
  formatCompare: (day: AnalyticsSeriesDay, value: number, name: string) => string;
  colorClass?: string;
  fillClass?: string;
  yMax?: number;
  yTickFormat?: (v: number) => string;
}) {
  if (compareMode && staffSeries.length > 0) {
    return (
      <MultiLineChart
        staffSeries={staffSeries}
        getValue={getValue}
        formatValue={formatCompare}
        yMax={yMax}
        yTickFormat={yTickFormat}
      />
    );
  }
  return (
    <LineChart
      days={series}
      getValue={getValue}
      formatTooltip={formatSingle}
      colorClass={colorClass}
      fillClass={fillClass}
      yMax={yMax}
      yTickFormat={yTickFormat}
    />
  );
}

export default function AnalyticsCharts() {
  const { user, hasPermission } = useAuth();
  const isTeamScope = user?.role === 'owner' || user?.role === 'manager';
  const canViewMessaging = hasPermission('analytics.view');

  const [data, setData] = useState<AnalyticsSeriesResponse | null>(null);
  const defaultRange = useMemo(() => rangeFromPresetDays(7), []);
  const [presetDays, setPresetDays] = useState<ChartPeriodDays | null>(7);
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const [staffFilter, setStaffFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const periodLabel = useMemo(
    () => formatPeriodRangeLabel(startDate, endDate),
    [startDate, endDate]
  );

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!isTeamScope) return;
      if (!options.silent) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const result = await getAnalyticsSeries(
          presetDays != null
            ? { days: presetDays }
            : { startDate, endDate }
        );
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load charts');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [isTeamScope, presetDays, startDate, endDate]
  );

  useEffect(() => {
    void load();
  }, [load]);

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

  const byStaff = data?.byStaff || [];

  useEffect(() => {
    if (staffFilter === 'all') return;
    if (!byStaff.some((s) => s.chatterId === staffFilter)) {
      setStaffFilter('all');
    }
  }, [byStaff, staffFilter]);

  const compareMode = isTeamScope && staffFilter === 'all' && byStaff.length > 0;

  const series = useMemo(() => {
    if (!isTeamScope || staffFilter === 'all') {
      return data?.series || [];
    }
    const match = byStaff.find((s) => s.chatterId === staffFilter);
    return match?.series || [];
  }, [data?.series, byStaff, isTeamScope, staffFilter]);

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!isTeamScope) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <AppLayout title="Analytics Charts" activePage="charts">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold mb-1">Team Charts</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {periodLabel} (Asia/Manila)
              {canViewMessaging ? (
                <>
                  {' · '}
                  <Link
                    to="/dashboard/messaging"
                    className="text-gray-700 dark:text-gray-300 underline-offset-2 hover:underline"
                  >
                    Messaging log
                  </Link>
                </>
              ) : null}
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
            {isTeamScope ? (
              <select
                value={staffFilter}
                onChange={(e) => setStaffFilter(e.target.value)}
                disabled={loading || refreshing}
                className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-2 text-sm text-gray-700 dark:text-gray-200 disabled:opacity-50"
              >
                <option value="all">All (compare)</option>
                {byStaff.map((staff) => (
                  <option key={staff.chatterId} value={staff.chatterId}>
                    {staff.chatterName}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              onClick={() => void load({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-2 self-start rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="border border-gray-200 dark:border-white/10 rounded-lg p-12 flex items-center justify-center">
            <p className="text-sm text-gray-400">Loading charts...</p>
          </div>
        ) : error ? (
          <div className="border border-red-200 dark:border-red-500/30 rounded-lg p-6 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ChartCard
              title="Day activity time"
              hint="Active vs idle seconds from heartbeat activity"
            >
              <ActivityStackedBars days={series} />
              <div className="mt-3 flex gap-4 text-[11px] text-gray-400">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-teal-500" /> Active
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-amber-400" /> Idle
                </span>
              </div>
              {compareMode ? (
                <p className="mt-2 text-[11px] text-gray-400">
                  Activity bars show team totals. Switch to a staff member to view
                  their activity.
                </p>
              ) : null}
            </ChartCard>

            <ChartCard
              title="Golden ratio"
              hint="Percentage of direct messages that were PPVs. PPVs sent ÷ DMs sent × 100"
            >
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.goldenRatio}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Golden ratio: ${v.toFixed(2)}%`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Golden ratio: ${v.toFixed(2)}%`
                }
                yTickFormat={(v) => `${v}%`}
              />
            </ChartCard>

            <ChartCard
              title="PPV conversion rate"
              hint="Percentage of direct PPVs unlocked by fans, by send date. Unlocked ÷ sent × 100"
            >
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.ppvConversionRate}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Unlock rate: ${v.toFixed(2)}%`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Unlock rate: ${v.toFixed(2)}%`
                }
                yMax={100}
                yTickFormat={(v) => `${v}%`}
              />
            </ChartCard>

            <ChartCard
              title="Sent PPV"
              hint="Direct PPVs sent (contentType chat_product)"
            >
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.ppvsSent}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Sent PPV: ${Math.round(v)}`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Sent PPV: ${Math.round(v)}`
                }
                colorClass="stroke-rose-500"
                fillClass="fill-rose-500"
              />
            </ChartCard>

            <ChartCard title="Keystrokes" hint="Keydown count (content is never logged)">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.keystrokes}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Keystrokes: ${Math.round(v)}`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Keystrokes: ${Math.round(v)}`
                }
                colorClass="stroke-teal-500"
                fillClass="fill-teal-500"
              />
            </ChartCard>

            <ChartCard title="Messages sent">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.messagesSent}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Messages: ${Math.round(v)}`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Messages: ${Math.round(v)}`
                }
                colorClass="stroke-sky-500"
                fillClass="fill-sky-500"
              />
            </ChartCard>

            <ChartCard title="Revenue">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) =>
                  d.revenue.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
                }
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | ${formatCurrencyAmounts(d.revenue)} (${v.toFixed(2)})`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | ${formatCurrencyAmounts(d.revenue)} (${v.toFixed(2)})`
                }
                colorClass="stroke-emerald-500"
                fillClass="fill-emerald-500"
              />
            </ChartCard>

            <ChartCard title="Tip revenue" hint="Revenue from tip entries">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) =>
                  (d.tipRevenue || []).reduce(
                    (sum, r) => sum + (Number(r.amount) || 0),
                    0
                  )
                }
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Tips: ${formatCurrencyAmounts(d.tipRevenue)} (${v.toFixed(2)})`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Tips: ${v.toFixed(2)}`
                }
                colorClass="stroke-amber-500"
                fillClass="fill-amber-500"
              />
            </ChartCard>

            <ChartCard title="Unique fans messaged">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.uniqueFansMessaged || 0}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Unique fans: ${Math.round(v)}`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Unique fans: ${Math.round(v)}`
                }
                colorClass="stroke-indigo-500"
                fillClass="fill-indigo-500"
              />
            </ChartCard>

            <ChartCard title="Pending PPVs" hint="Sent PPVs not yet unlocked">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.pendingPpvs || 0}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Pending: ${Math.round(v)}`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Pending: ${Math.round(v)}`
                }
                colorClass="stroke-rose-400"
                fillClass="fill-rose-400"
              />
            </ChartCard>

            <ChartCard title="Sales per message">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.salesPerMessageValue || 0}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | ${v.toFixed(2)} per message`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | ${v.toFixed(2)} / msg`
                }
                colorClass="stroke-lime-500"
                fillClass="fill-lime-500"
              />
            </ChartCard>

            <ChartCard title="Idle %" hint="Idle ÷ (active + idle)">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.idlePercent || 0}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Idle: ${v.toFixed(1)}%`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Idle: ${v.toFixed(1)}%`
                }
                yMax={100}
                yTickFormat={(v) => `${v}%`}
                colorClass="stroke-amber-400"
                fillClass="fill-amber-400"
              />
            </ChartCard>

            <ChartCard title="Free media sent">
              <MetricLineChart
                compareMode={compareMode}
                series={series}
                staffSeries={byStaff}
                getValue={(d) => d.freeMediaSent || 0}
                formatSingle={(d, v) =>
                  `${dayLabel(d.date)} | Free media: ${Math.round(v)}`
                }
                formatCompare={(d, v, name) =>
                  `${name} · ${dayLabel(d.date)} | Free media: ${Math.round(v)}`
                }
                colorClass="stroke-cyan-500"
                fillClass="fill-cyan-500"
              />
            </ChartCard>
          </div>
        )}

        {data?.lastUpdated ? (
          <p className="mt-6 text-xs text-gray-400">
            Last updated: {new Date(data.lastUpdated).toLocaleString()}
          </p>
        ) : null}
      </div>
    </AppLayout>
  );
}
