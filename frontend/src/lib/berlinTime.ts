import { useAuth } from '@/context/AuthContext';
import { DEFAULT_TIMEZONE } from '@/components/PeriodDaysToggle';

export { DEFAULT_TIMEZONE };

export function useStaffTimeZone(): string {
  const { user } = useAuth();
  return user?.timezone || DEFAULT_TIMEZONE;
}

function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMs = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second)
    );
    return asUtc - instant;
  };
  let instant = utcGuess - offsetMs(utcGuess);
  instant = utcGuess - offsetMs(instant);
  return new Date(instant);
}

function formatParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

export function berlinNowParts(timeZone: string = DEFAULT_TIMEZONE) {
  return formatParts(new Date(), timeZone);
}

export function berlinDateString(
  date: Date,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  return formatParts(date, timeZone).date;
}

export function berlinTimeString(
  date: Date,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  return formatParts(date, timeZone).time;
}

export function berlinDateTimeLabel(
  iso: string,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = formatParts(date, timeZone);
  return `${parts.date} ${parts.time}`;
}

export function berlinWallToIso(
  date: string,
  time: string,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return zonedWallTimeToUtc(y, m, d, hh || 0, mm || 0, timeZone).toISOString();
}

export function berlinMonthUtcRange(
  year: number,
  month: number,
  timeZone: string = DEFAULT_TIMEZONE
): {
  from: string;
  to: string;
} {
  const start = zonedWallTimeToUtc(year, month, 1, 0, 0, timeZone);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = new Date(
    zonedWallTimeToUtc(nextYear, nextMonth, 1, 0, 0, timeZone).getTime() - 1
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

export { DEFAULT_TIMEZONE as BERLIN_TZ };
