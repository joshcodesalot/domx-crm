/**
 * Per-staff weekly work schedules in Asia/Manila.
 * Overnight: endTime <= startTime (e.g. 23:00 → 08:00).
 * Shift-start attribution: events in [D+start, end) count toward calendar date D.
 */

const pool = require('../db/pool');
const {
  BUSINESS_TZ,
  buildDateRangeBetween,
  calendarDateString,
} = require('./businessTimezone');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * @param {unknown} value
 * @returns {string|null} HH:MM:SS
 */
function normalizeTime(value) {
  if (value == null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const hh = String(value.getUTCHours()).padStart(2, '0');
    const mm = String(value.getUTCMinutes()).padStart(2, '0');
    const ss = String(value.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  const raw = String(value).trim();
  const match = TIME_RE.exec(raw);
  if (!match) return null;
  const hh = match[1];
  const mm = match[2];
  const ss = match[3] || '00';
  return `${hh}:${mm}:${ss}`;
}

/**
 * Format HH:MM:SS → HH:MM for labels.
 * @param {string} time
 */
function formatTimeShort(time) {
  const normalized = normalizeTime(time);
  if (!normalized) return '';
  return normalized.slice(0, 5);
}

/**
 * @param {string} startTime
 * @param {string} endTime
 */
function isOvernight(startTime, endTime) {
  const start = normalizeTime(startTime);
  const end = normalizeTime(endTime);
  if (!start || !end) return false;
  return end <= start;
}

/**
 * JS day-of-week for a YYYY-MM-DD in Asia/Manila (0=Sun … 6=Sat).
 * Uses UTC noon so the calendar date is stable (PH has no DST).
 * @param {string} dateStr
 */
function dayOfWeekForDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

/**
 * Next calendar day YYYY-MM-DD.
 * @param {string} dateStr
 */
function nextCalendarDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Build a timestamptz literal expression for SQL using Asia/Manila wall clock.
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:MM:SS
 */
function manilaTimestampSql(dateStr, timeStr) {
  const t = normalizeTime(timeStr) || '00:00:00';
  return `(TIMESTAMP '${dateStr} ${t}' AT TIME ZONE '${BUSINESS_TZ}')`;
}

/**
 * @typedef {{ dayOfWeek: number, startTime: string, endTime: string }} ScheduleDay
 * @typedef {Map<string, Map<number, ScheduleDay>>} ScheduleMap
 */

/**
 * Load schedules for user IDs.
 * @param {string[]} userIds
 * @returns {Promise<ScheduleMap>}
 */
async function loadSchedulesByUserId(userIds) {
  /** @type {ScheduleMap} */
  const byUser = new Map();
  if (!userIds || userIds.length === 0) return byUser;

  const result = await pool.query(
    `SELECT "userId", "dayOfWeek",
            to_char("startTime", 'HH24:MI:SS') AS "startTime",
            to_char("endTime", 'HH24:MI:SS') AS "endTime"
     FROM user_work_schedules
     WHERE "userId" = ANY($1::uuid[])
     ORDER BY "userId", "dayOfWeek"`,
    [userIds]
  );

  for (const row of result.rows) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, new Map());
    byUser.get(row.userId).set(Number(row.dayOfWeek), {
      dayOfWeek: Number(row.dayOfWeek),
      startTime: row.startTime,
      endTime: row.endTime,
    });
  }
  return byUser;
}

/**
 * @param {Map<number, ScheduleDay>|undefined} week
 * @returns {{ scheduleApplied: boolean, shiftLabel: string|null }}
 */
function scheduleMetaForWeek(week) {
  if (!week || week.size === 0) {
    return { scheduleApplied: false, shiftLabel: null };
  }
  const days = [...week.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  const labels = new Set(
    days.map((d) => `${formatTimeShort(d.startTime)}–${formatTimeShort(d.endTime)}`)
  );
  if (labels.size === 1) {
    return { scheduleApplied: true, shiftLabel: [...labels][0] };
  }
  return { scheduleApplied: true, shiftLabel: 'Custom week' };
}

/**
 * Expand shift windows for users over inclusive date range.
 * Users with no schedule get full calendar days.
 * @param {string[]} userIds
 * @param {string} startDate
 * @param {string} endDate
 * @param {ScheduleMap} [schedules]
 * @returns {Promise<Array<{ userId: string, windowStartSql: string, windowEndSql: string }>>}
 */
async function expandShiftWindows(userIds, startDate, endDate, schedules) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return [];

  const byUser = schedules || (await loadSchedulesByUserId(ids));
  const dates = buildDateRangeBetween(startDate, endDate);
  /** @type {Array<{ userId: string, windowStartSql: string, windowEndSql: string }>} */
  const windows = [];

  for (const userId of ids) {
    const week = byUser.get(userId);
    for (const dateStr of dates) {
      if (!week || week.size === 0) {
        windows.push({
          userId,
          windowStartSql: manilaTimestampSql(dateStr, '00:00:00'),
          windowEndSql: manilaTimestampSql(nextCalendarDate(dateStr), '00:00:00'),
        });
        continue;
      }
      const dow = dayOfWeekForDate(dateStr);
      const day = week.get(dow);
      if (!day) {
        // Day off — no window
        continue;
      }
      const start = normalizeTime(day.startTime) || '00:00:00';
      const end = normalizeTime(day.endTime) || '00:00:00';
      if (isOvernight(start, end)) {
        windows.push({
          userId,
          windowStartSql: manilaTimestampSql(dateStr, start),
          windowEndSql: manilaTimestampSql(nextCalendarDate(dateStr), end),
        });
      } else {
        windows.push({
          userId,
          windowStartSql: manilaTimestampSql(dateStr, start),
          windowEndSql: manilaTimestampSql(dateStr, end),
        });
      }
    }
  }

  return windows;
}

/**
 * Build a SQL VALUES list and param array for shift windows.
 * Returns null if no windows (callers should treat as empty result).
 * @param {Array<{ userId: string, windowStartSql: string, windowEndSql: string }>} windows
 * @param {number} [startParamIndex=1]
 * @returns {{ sql: string, params: string[], nextParamIndex: number } | null}
 */
function buildWindowValuesClause(windows, startParamIndex = 1) {
  if (!windows || windows.length === 0) return null;
  const params = [];
  const parts = [];
  let i = startParamIndex;
  for (const w of windows) {
    params.push(w.userId);
    parts.push(`($${i}::uuid, ${w.windowStartSql}, ${w.windowEndSql})`);
    i += 1;
  }
  return {
    sql: parts.join(',\n'),
    params,
    nextParamIndex: i,
  };
}

/**
 * SQL predicate: entry sentAt falls inside a scheduled work hour for its chatter.
 * Users with no schedule rows always match (full day).
 *
 * @param {string} [entryAlias='m']
 * @param {string} [schedAlias='uws']
 */
function duringScheduledHoursPredicate(entryAlias = 'm', schedAlias = 'uws') {
  const localTime = `(${entryAlias}."sentAt" AT TIME ZONE '${BUSINESS_TZ}')::time`;
  return `(
    NOT EXISTS (
      SELECT 1 FROM user_work_schedules _uws_any
      WHERE _uws_any."userId" = ${entryAlias}."chatterId"
    )
    OR (
      ${schedAlias}."userId" IS NOT NULL
      AND (
        (
          ${schedAlias}."startTime" < ${schedAlias}."endTime"
          AND ${localTime} >= ${schedAlias}."startTime"
          AND ${localTime} < ${schedAlias}."endTime"
        )
        OR (
          ${schedAlias}."startTime" >= ${schedAlias}."endTime"
          AND (
            ${localTime} >= ${schedAlias}."startTime"
            OR ${localTime} < ${schedAlias}."endTime"
          )
        )
      )
    )
  )`;
}

/**
 * LEFT JOIN fragment for schedule on entry's Manila DOW.
 * @param {string} [entryAlias='m']
 * @param {string} [schedAlias='uws']
 */
function scheduleDowJoin(entryAlias = 'm', schedAlias = 'uws') {
  return `LEFT JOIN user_work_schedules ${schedAlias}
            ON ${schedAlias}."userId" = ${entryAlias}."chatterId"
           AND ${schedAlias}."dayOfWeek" = EXTRACT(
             DOW FROM (${entryAlias}."sentAt" AT TIME ZONE '${BUSINESS_TZ}')
           )::int`;
}

/**
 * Validate and normalize a week payload from the API.
 * @param {unknown} days
 * @returns {{ ok: true, days: ScheduleDay[] } | { ok: false, error: string }}
 */
function parseScheduleDaysPayload(days) {
  if (!Array.isArray(days)) {
    return { ok: false, error: 'days must be an array' };
  }
  if (days.length > 7) {
    return { ok: false, error: 'days cannot have more than 7 entries' };
  }

  /** @type {ScheduleDay[]} */
  const parsed = [];
  const seen = new Set();

  for (const item of days) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'Invalid day entry' };
    }
    const dayOfWeek = Number(/** @type {{ dayOfWeek?: unknown }} */ (item).dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      return { ok: false, error: 'dayOfWeek must be 0–6' };
    }
    if (seen.has(dayOfWeek)) {
      return { ok: false, error: 'Duplicate dayOfWeek' };
    }
    seen.add(dayOfWeek);

    const startTime = normalizeTime(/** @type {{ startTime?: unknown }} */ (item).startTime);
    const endTime = normalizeTime(/** @type {{ endTime?: unknown }} */ (item).endTime);
    if (!startTime || !endTime) {
      return { ok: false, error: 'startTime and endTime must be HH:MM or HH:MM:SS' };
    }
    if (startTime === endTime) {
      return { ok: false, error: 'startTime and endTime cannot be equal' };
    }

    parsed.push({ dayOfWeek, startTime, endTime });
  }

  return { ok: true, days: parsed };
}

/**
 * Today's shift windows for a set of users (shift-start = today).
 * @param {string[]} userIds
 * @param {ScheduleMap} [schedules]
 */
async function expandTodayWindows(userIds, schedules) {
  const today = calendarDateString();
  return expandShiftWindows(userIds, today, today, schedules);
}

module.exports = {
  BUSINESS_TZ,
  TIME_RE,
  normalizeTime,
  formatTimeShort,
  isOvernight,
  dayOfWeekForDate,
  nextCalendarDate,
  manilaTimestampSql,
  loadSchedulesByUserId,
  scheduleMetaForWeek,
  expandShiftWindows,
  expandTodayWindows,
  buildWindowValuesClause,
  duringScheduledHoursPredicate,
  scheduleDowJoin,
  parseScheduleDaysPayload,
};
