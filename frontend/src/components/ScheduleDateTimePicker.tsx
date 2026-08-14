import { useCallback, useEffect, useState } from 'react';
import ScheduleCalendar from '@/components/ScheduleCalendar';
import { listScheduledContent, type ScheduledContentJob } from '@/lib/api';
import { berlinMonthUtcRange, berlinNowParts, useStaffTimeZone } from '@/lib/berlinTime';

export default function ScheduleDateTimePicker({
  date,
  time,
  onDateChange,
  onTimeChange,
}: {
  date: string;
  time: string;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
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

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
            Date ({timeZone})
          </span>
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
            className="w-full rounded-lg border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm text-gray-900 dark:text-white"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
            Time ({timeZone})
          </span>
          <input
            type="time"
            value={time}
            onChange={(e) => onTimeChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm text-gray-900 dark:text-white"
          />
        </label>
      </div>
      <ScheduleCalendar
        year={year}
        month={month}
        selectedDate={date}
        jobs={jobs}
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
