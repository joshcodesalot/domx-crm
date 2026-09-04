import { useEffect, useState } from 'react';
import { DEFAULT_TIMEZONE } from '@/lib/berlinTime';

const TITLE = 'Germany · Europe/Berlin';

const berlinTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DEFAULT_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function nowBerlinTime(): string {
  return berlinTimeFormatter.format(new Date());
}

export default function GermanTimeClock({ compact = false }: { compact?: boolean }) {
  const [time, setTime] = useState(nowBerlinTime);

  useEffect(() => {
    const id = window.setInterval(() => setTime(nowBerlinTime()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (compact) {
    return (
      <div
        title={TITLE}
        className="flex flex-col items-center leading-none select-none"
        aria-label={TITLE}
      >
        <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300 tabular-nums">
          {time}
        </span>
        <span className="text-[9px] font-semibold tracking-wide text-gray-400 dark:text-gray-500 mt-0.5">
          DE
        </span>
      </div>
    );
  }

  return (
    <span
      title={TITLE}
      className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 px-2.5 py-1 bg-gray-100 dark:bg-white/5 rounded-full tabular-nums select-none shrink-0"
      aria-label={TITLE}
    >
      <span className="font-medium text-gray-700 dark:text-gray-200">{time}</span>
      <span className="text-[10px] font-semibold tracking-wide text-gray-400 dark:text-gray-500">
        DE
      </span>
    </span>
  );
}
