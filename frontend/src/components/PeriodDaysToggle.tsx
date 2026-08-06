export const CHART_PERIOD_OPTIONS = [1, 3, 5, 7] as const;
export type ChartPeriodDays = (typeof CHART_PERIOD_OPTIONS)[number];

export const DEFAULT_TIMEZONE = 'Europe/Berlin';

function dateFormatterFor(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function periodDaysLabel(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/** Today as YYYY-MM-DD in the given IANA timezone. */
export function calendarDateString(
  date = new Date(),
  timeZone = DEFAULT_TIMEZONE
): string {
  try {
    return dateFormatterFor(timeZone).format(date);
  } catch {
    return dateFormatterFor(DEFAULT_TIMEZONE).format(date);
  }
}

/** @deprecated Use calendarDateString */
export function manilaCalendarDateString(date = new Date()): string {
  return calendarDateString(date, DEFAULT_TIMEZONE);
}

/** Last N inclusive calendar days ending today, oldest first. */
export function buildDateRange(
  days: number,
  timeZone = DEFAULT_TIMEZONE
): string[] {
  const count = Math.max(0, Math.floor(Number(days) || 0));
  const today = calendarDateString(new Date(), timeZone);
  const [year, month, day] = today.split('-').map(Number);
  const dates: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    d.setUTCDate(d.getUTCDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${dd}`);
  }
  return dates;
}

/** @deprecated Use buildDateRange */
export function buildManilaDateRange(days: number): string[] {
  return buildDateRange(days, DEFAULT_TIMEZONE);
}

export function rangeFromPresetDays(
  days: ChartPeriodDays,
  timeZone = DEFAULT_TIMEZONE
): {
  startDate: string;
  endDate: string;
} {
  const dates = buildDateRange(days, timeZone);
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
  };
}

export function formatPeriodRangeLabel(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  if (startDate === endDate) return fmt(start);
  return `${fmt(start)} – ${fmt(end)}`;
}

export default function PeriodDaysToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: ChartPeriodDays | null;
  onChange: (days: ChartPeriodDays) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] p-1">
      {CHART_PERIOD_OPTIONS.map((days) => {
        const active = value === days;
        return (
          <button
            key={days}
            type="button"
            disabled={disabled}
            onClick={() => onChange(days)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
              active
                ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10'
            }`}
          >
            {periodDaysLabel(days)}
          </button>
        );
      })}
    </div>
  );
}
