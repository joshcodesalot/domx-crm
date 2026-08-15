import { useCallback, useEffect, useMemo, useState } from 'react';
import { Calendar, Clock } from 'lucide-react';
import ScheduleCalendar from '@/components/ScheduleCalendar';
import { listScheduledContent, type ScheduledContentJob } from '@/lib/api';
import { berlinMonthUtcRange, berlinNowParts, useStaffTimeZone } from '@/lib/berlinTime';

export type ScheduleJobPlatformFilter = 'all' | 'maloum' | '4based';
export type ScheduleJobKindFilter = 'all' | 'feed_post' | 'mass_message';

export default function ScheduleDateTimePicker({
  date,
  time,
  onDateChange,
  onTimeChange,
  platformFilter = 'all',
  kindFilter = 'all',
}: {
  date: string;
  time: string;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
  platformFilter?: ScheduleJobPlatformFilter;
  kindFilter?: ScheduleJobKindFilter;
}) {
  const timeZone = useStaffTimeZone();
  const now = berlinNowParts(timeZone);
  const [year, setYear] = useState(() => Number(date.slice(0, 4)) || now.year);
  const [month, setMonth] = useState(
    () => Number(date.slice(5, 7)) || now.month
  );
  const [jobs, setJobs] = useState<ScheduledContentJob[]>([]);

  const loadMonth = useCallback(async (y: number, m: number) => {
    const range = berlinMonthUtcRange(y, m, timeZone);
    try {
      const result = await listScheduledContent(range);
      setJobs(result.jobs || []);
    } catch {
      setJobs([]);
    }
  }, [timeZone]);

  useEffect(() => {
    void loadMonth(year, month);
  }, [year, month, loadMonth]);

  const filteredJobs = useMemo(
    () =>
      jobs.filter((job) => {
        if (platformFilter !== 'all' && job.platform !== platformFilter) return false;
        if (kindFilter !== 'all' && job.kind !== kindFilter) return false;
        return true;
      }),
    [jobs, platformFilter, kindFilter]
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row gap-4">
        <label className="flex-1">
          <span className="block text-xs font-semibold text-gray-500 tracking-wider mb-2">
            DATE ({timeZone})
          </span>
          <div className="relative">
            <input
              type="date"
              value={date}
              onChange={(e) => {
                const next = e.target.value;
                onDateChange(next);
                if (next) {
                  setYear(Number(next.slice(0, 4)));
                  setMonth(Number(next.slice(5, 7)));
                }
              }}
              className="w-full rounded-md border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2.5 pr-10 text-sm text-gray-900 dark:text-zinc-200 focus:outline-none focus:border-domx-500"
            />
            <Calendar className="pointer-events-none absolute right-3 top-2.5 w-4 h-4 text-gray-500" />
          </div>
        </label>
        <label className="flex-1">
          <span className="block text-xs font-semibold text-gray-500 tracking-wider mb-2">
            TIME ({timeZone})
          </span>
          <div className="relative">
            <input
              type="time"
              value={time}
              onChange={(e) => onTimeChange(e.target.value)}
              className="w-full rounded-md border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2.5 pr-10 text-sm text-gray-900 dark:text-zinc-200 focus:outline-none focus:border-domx-500"
            />
            <Clock className="pointer-events-none absolute right-3 top-2.5 w-4 h-4 text-gray-500" />
          </div>
        </label>
      </div>
      <ScheduleCalendar
        year={year}
        month={month}
        selectedDate={date}
        jobs={filteredJobs}
        timeZone={timeZone}
        onMonthChange={(y, m) => {
          setYear(y);
          setMonth(m);
        }}
        onSelectDate={onDateChange}
      />
    </div>
  );
}
