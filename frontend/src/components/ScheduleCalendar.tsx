import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  berlinDateString,
  berlinTimeString,
} from '@/lib/berlinTime';
import type { ScheduledContentJob } from '@/lib/api';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mondayIndex(year: number, month: number) {
  const dow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return (dow + 6) % 7;
}

function countForDate(
  jobs: ScheduledContentJob[],
  date: string,
  timeZone: string
): number {
  return jobs.filter((job) => berlinDateString(new Date(job.runAt), timeZone) === date)
    .length;
}

export default function ScheduleCalendar({
  year,
  month,
  selectedDate,
  jobs,
  timeZone,
  onMonthChange,
  onSelectDate,
}: {
  year: number;
  month: number;
  selectedDate: string;
  jobs: ScheduledContentJob[];
  timeZone: string;
  onMonthChange: (year: number, month: number) => void;
  onSelectDate: (date: string) => void;
}) {
  const today = berlinDateString(new Date(), timeZone);
  const leading = mondayIndex(year, month);
  const totalDays = daysInMonth(year, month);
  const cells = useMemo(() => {
    const list: Array<{ date: string | null; day: number | null }> = [];
    for (let i = 0; i < leading; i += 1) list.push({ date: null, day: null });
    for (let day = 1; day <= totalDays; day += 1) {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      list.push({ date: `${year}-${mm}-${dd}`, day });
    }
    return list;
  }, [leading, totalDays, year, month]);

  const dayJobs = jobs
    .filter((job) => berlinDateString(new Date(job.runAt), timeZone) === selectedDate)
    .slice()
    .sort(
      (a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime()
    );

  const title = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            if (month === 1) onMonthChange(year - 1, 12);
            else onMonthChange(year, month - 1);
          }}
          className="p-1 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <p className="text-sm font-semibold text-gray-900 dark:text-white">
          {title}
        </p>
        <button
          type="button"
          onClick={() => {
            if (month === 12) onMonthChange(year + 1, 1);
            else onMonthChange(year, month + 1);
          }}
          className="p-1 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800"
          aria-label="Next month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="text-[10px] font-bold uppercase tracking-wider text-gray-400 py-1"
          >
            {d}
          </div>
        ))}
        {cells.map((cell, index) => {
          if (!cell.date) {
            return <div key={`e-${index}`} />;
          }
          const count = countForDate(jobs, cell.date, timeZone);
          const selected = cell.date === selectedDate;
          const isToday = cell.date === today;
          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => onSelectDate(cell.date as string)}
              className={`relative h-9 rounded-lg text-xs font-medium ${
                selected
                  ? 'bg-domx-600 text-white'
                  : isToday
                    ? 'bg-domx-600/15 text-domx-600 dark:text-domx-400'
                    : 'text-gray-700 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800'
              }`}
            >
              {cell.day}
              {count > 0 && (
                <span
                  className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 rounded-full ${
                    selected ? 'bg-white' : 'bg-domx-500'
                  } ${count > 1 ? 'px-1 min-w-[12px] h-3 text-[8px] leading-3 text-white' : 'w-1.5 h-1.5'}`}
                >
                  {count > 1 ? count : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="space-y-1.5 max-h-40 overflow-y-auto">
        {dayJobs.length === 0 ? (
          <p className="text-[11px] text-gray-500 dark:text-zinc-500">
            Nothing scheduled this day ({timeZone}).
          </p>
        ) : (
          dayJobs.map((job) => (
            <div
              key={job.id}
              className="flex items-start justify-between gap-2 text-[11px] rounded-lg px-2 py-1.5 bg-gray-50 dark:bg-zinc-800/60"
            >
              <div className="min-w-0">
                <p className="font-semibold text-gray-800 dark:text-zinc-200 truncate">
                  {berlinTimeString(new Date(job.runAt), timeZone)} ·{' '}
                  {job.kind === 'feed_post' ? 'Feed' : 'Mass'} · {job.platform}
                </p>
                <p className="text-gray-500 truncate">
                  {job.creatorName || 'Creator'}
                  {job.bodyText ? ` — ${job.bodyText}` : ''}
                </p>
              </div>
              <span
                className={`shrink-0 ${
                  job.status === 'pending'
                    ? 'text-amber-500'
                    : job.status === 'sent'
                      ? 'text-emerald-500'
                      : job.status === 'failed'
                        ? 'text-red-500'
                        : 'text-gray-400'
                }`}
              >
                {job.status}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
