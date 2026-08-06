/**
 * DomX business calendar timezone (Philippine Time).
 * Use for today / this-month / last-N-days bucketing only.
 * Wire ISO timestamps and Maloum API timezones stay separate.
 */
const BUSINESS_TZ = 'Asia/Manila';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD in Asia/Manila
 */
function calendarDateString(date = new Date()) {
  return dateFormatter.format(date);
}

/**
 * First day of the business-timezone calendar month containing `date`.
 * @param {Date} [date]
 * @returns {string} YYYY-MM-01
 */
function monthStartDateString(date = new Date()) {
  return `${calendarDateString(date).slice(0, 7)}-01`;
}

/**
 * Last N inclusive calendar days ending today (business TZ), oldest first.
 * @param {number} days
 * @returns {string[]}
 */
function buildDateRange(days) {
  const count = Math.max(0, Math.floor(Number(days) || 0));
  const today = calendarDateString();
  const [year, month, day] = today.split('-').map(Number);
  const dates = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    // Use UTC noon with PHT Y-M-D components so day arithmetic is stable (PH has no DST).
    const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    d.setUTCDate(d.getUTCDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${dd}`);
  }
  return dates;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRESET_PERIOD_DAYS = new Set([1, 3, 5, 7]);

function isValidDateString(value) {
  return DATE_RE.test(String(value || ''));
}

/**
 * Inclusive YYYY-MM-DD list from start to end (calendar arithmetic, no TZ shift).
 * @param {string} startDate
 * @param {string} endDate
 * @returns {string[]}
 */
function buildDateRangeBetween(startDate, endDate) {
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
    return [];
  }
  let start = startDate;
  let end = endDate;
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const dates = [];
  const cursor = new Date(Date.UTC(sy, sm - 1, sd, 12, 0, 0));
  const last = new Date(Date.UTC(ey, em - 1, ed, 12, 0, 0));
  while (cursor.getTime() <= last.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cursor.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${dd}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Resolve analytics period from query-like inputs.
 * Prefer explicit start/end; else days; else default 7. Caps span at maxDays.
 * @param {{ startDate?: string, endDate?: string, days?: string|number }} input
 * @param {number} [maxDays=90]
 * @param {{ allowAnyDays?: boolean, defaultDays?: number }} [options]
 * @returns {{ startDate: string, endDate: string, dates: string[], days: number }}
 */
function resolveAnalyticsPeriod(input = {}, maxDays = 90, options = {}) {
  const cap = Math.max(1, Math.floor(Number(maxDays) || 90));
  const defaultDays = PRESET_PERIOD_DAYS.has(options.defaultDays)
    ? options.defaultDays
    : Number.isFinite(Number(options.defaultDays)) && Number(options.defaultDays) >= 1
      ? Math.min(Math.floor(Number(options.defaultDays)), cap)
      : 7;
  let start = null;
  let end = null;

  if (isValidDateString(input.startDate) && isValidDateString(input.endDate)) {
    start = String(input.startDate);
    end = String(input.endDate);
    if (start > end) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    let dates = buildDateRangeBetween(start, end);
    if (dates.length > cap) {
      dates = dates.slice(dates.length - cap);
      start = dates[0];
      end = dates[dates.length - 1];
    }
    return {
      startDate: start,
      endDate: end,
      dates,
      days: dates.length,
    };
  }

  const parsedDays = Number.parseInt(String(input.days ?? ''), 10);
  let count = defaultDays;
  if (Number.isFinite(parsedDays) && parsedDays >= 1) {
    if (options.allowAnyDays || PRESET_PERIOD_DAYS.has(parsedDays)) {
      count = Math.min(parsedDays, cap);
    }
  }
  const dates = buildDateRange(count);
  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    dates,
    days: dates.length,
  };
}

module.exports = {
  BUSINESS_TZ,
  calendarDateString,
  monthStartDateString,
  buildDateRange,
  buildDateRangeBetween,
  isValidDateString,
  resolveAnalyticsPeriod,
  PRESET_PERIOD_DAYS,
};
