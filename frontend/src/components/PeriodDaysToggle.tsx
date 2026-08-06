export const CHART_PERIOD_OPTIONS = [1, 3, 5, 7] as const;
export type ChartPeriodDays = (typeof CHART_PERIOD_OPTIONS)[number];

const manilaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function periodDaysLabel(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/** Today as YYYY-MM-DD in Asia/Manila. */
export function manilaCalendarDateString(date = new Date()): string {
  return manilaDateFormatter.format(date);
}

/** Last N inclusive Manila calendar days ending today, oldest first. */
export function buildManilaDateRange(days: number): string[] {
  const count = Math.max(0, Math.floor(Number(days) || 0));
  const today = manilaCalendarDateString();
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

export function rangeFromPresetDays(days: ChartPeriodDays): {
  startDate: string;
  endDate: string;
} {
  const dates = buildManilaDateRange(days);
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
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5'
            }`}
          >
            {periodDaysLabel(days)}
          </button>
        );
      })}
    </div>
  );
}
