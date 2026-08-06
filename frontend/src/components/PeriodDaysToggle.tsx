export const CHART_PERIOD_OPTIONS = [1, 3, 5, 7] as const;
export type ChartPeriodDays = (typeof CHART_PERIOD_OPTIONS)[number];

export function periodDaysLabel(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

export default function PeriodDaysToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: ChartPeriodDays;
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
