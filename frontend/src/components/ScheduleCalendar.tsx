import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import ScheduleJobThumb from '@/components/ScheduleJobThumb';
import {
  berlinDateString,
  berlinTimeString,
} from '@/lib/berlinTime';
import type { ScheduledContentJob } from '@/lib/api';

function jobStatusClass(status: ScheduledContentJob['status']): string {
  if (status === 'sent') return 'text-emerald-500';
  if (status === 'pending' || status === 'running') return 'text-amber-500';
  if (status === 'failed' || status === 'cancelled') return 'text-red-400';
  return 'text-gray-400';
}

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mondayIndex(year: number, month: number) {
  const dow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return (dow + 6) % 7;
}

function jobsByDateMap(
  jobs: ScheduledContentJob[],
  timeZone: string
): Map<string, ScheduledContentJob[]> {
  const map = new Map<string, ScheduledContentJob[]>();
  for (const job of jobs) {
    const date = berlinDateString(new Date(job.runAt), timeZone);
    const list = map.get(date);
    if (list) list.push(job);
    else map.set(date, [job]);
  }
  return map;
}

function scheduleDayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${monthName.toUpperCase()} ${day}`;
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

  const jobsByDate = useMemo(
    () => jobsByDateMap(jobs, timeZone),
    [jobs, timeZone]
  );
  const dayJobs = useMemo(() => {
    const list = jobsByDate.get(selectedDate) || [];
    return list
      .slice()
      .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime());
  }, [jobsByDate, selectedDate]);

  const title = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="rounded-lg border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-5 flex flex-col gap-4">
      <div className="flex justify-between items-center text-sm font-medium text-gray-800 dark:text-zinc-200">
        <button
          type="button"
          onClick={() => {
            if (month === 1) onMonthChange(year - 1, 12);
            else onMonthChange(year, month - 1);
          }}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span>{title}</span>
        <button
          type="button"
          onClick={() => {
            if (month === 12) onMonthChange(year + 1, 1);
            else onMonthChange(year, month + 1);
          }}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Next month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-gray-500">
        {WEEKDAYS.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-sm">
        {cells.map((cell, index) => {
          if (!cell.date) {
            return <div key={`e-${index}`} className="p-2" />;
          }
          const hasPosts = (jobsByDate.get(cell.date)?.length || 0) > 0;
          const selected = cell.date === selectedDate;
          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => onSelectDate(cell.date as string)}
              className={`p-2 rounded-md transition-all relative flex items-center justify-center font-medium ${
                selected
                  ? 'bg-domx-600 text-white shadow-md'
                  : 'text-gray-700 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800'
              }`}
            >
              {cell.day}
              {hasPosts && !selected && (
                <span className="absolute bottom-1 w-1 h-1 rounded-full bg-domx-400" />
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex flex-col gap-2 pt-4 border-t border-gray-200 dark:border-zinc-800/80">
        <div className="text-xs font-medium text-gray-500 mb-1">
          SCHEDULE FOR {scheduleDayLabel(selectedDate)}
        </div>
        {dayJobs.length === 0 ? (
          <div className="text-sm text-gray-500 italic py-3 text-center rounded-md border border-gray-200 dark:border-zinc-800/50 bg-gray-50 dark:bg-zinc-900/50">
            No posts scheduled for this date.
          </div>
        ) : (
          dayJobs.map((job) => (
            <div
              key={job.id}
              className="p-3 bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 rounded-md text-sm hover:border-gray-300 dark:hover:border-zinc-700 transition-colors flex gap-3"
            >
              <ScheduleJobThumb job={job} className="w-10 h-10 sm:w-12 sm:h-12 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center mb-1.5 gap-2">
                  <span className="font-semibold text-gray-800 dark:text-zinc-200 truncate">
                    {berlinTimeString(new Date(job.runAt), timeZone)}
                    <span className="text-gray-500 mx-1">•</span>
                    {job.kind === 'feed_post' ? 'Feed' : 'Mass'}
                    <span className="text-gray-500 mx-1">•</span>
                    {job.platform}
                  </span>
                  <span className={`shrink-0 text-xs ${jobStatusClass(job.status)}`}>
                    {job.status}
                  </span>
                </div>
                <div
                  className="text-gray-500 dark:text-zinc-400 text-xs truncate"
                  title={job.bodyText || undefined}
                >
                  {job.creatorName || 'Creator'}
                  {job.bodyText ? ` — ${job.bodyText}` : ''}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
