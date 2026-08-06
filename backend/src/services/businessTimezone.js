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

module.exports = {
  BUSINESS_TZ,
  calendarDateString,
  monthStartDateString,
  buildDateRange,
};
