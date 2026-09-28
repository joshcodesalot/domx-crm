/**
 * Per-staff weekly work schedules.
 * Idle on-shift checks use Philippine Time (PHT, Asia/Manila, no DST).
 * Overnight: endTime <= startTime (e.g. 23:00 → 08:00).
 * Shift-start attribution: events in [D+start, end) count toward calendar date D.
 */

const pool = require('../db/pool');
const {
  BUSINESS_TZ,
  normalizeTimeZone,
  buildDateRangeBetween,
  calendarDateString,
  zonedWallTimeToUtc,
} = require('./businessTimezone');

/** Staff work-schedule wall clock (PHT). */
const SCHEDULE_TZ = 'Asia/Manila';

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
 * HH:MM:SS → seconds since midnight.
 * @param {string} time
 */
function timeToSeconds(time) {
  const normalized = normalizeTime(time);
  if (!normalized) return 0;
  const [hh, mm, ss] = normalized.split(':').map(Number);
  return hh * 3600 + mm * 60 + (ss || 0);
}

/**
 * Wall-clock date/time/DOW for an instant in a timezone.
 * @param {Date} date
 * @param {string} [timeZone]
 * @returns {{ dateStr: string, time: string, dow: number }}
 */
function wallClockInTimeZone(date, timeZone = SCHEDULE_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  return {
    dateStr,
    time: `${map.hour}:${map.minute}:${map.second}`,
    dow: dayOfWeekForDate(dateStr),
  };
}

/**
 * True when `date` falls inside the weekly schedule (Europe/Berlin).
 * No schedule rows → all day (same as messaging analytics).
 * Overnight spill from the previous weekday still counts.
 * @param {Date} date
 * @param {Map<number, ScheduleDay>|undefined} week
 */
function isDateWithinWeekSchedule(date, week) {
  if (!week || week.size === 0) return true;

  const wall = wallClockInTimeZone(date, BUSINESS_TZ);
  const localTime = wall.time;
  const today = week.get(wall.dow);
  if (today) {
    const start = normalizeTime(today.startTime);
    const end = normalizeTime(today.endTime);
    if (start && end) {
      if (!isOvernight(start, end)) {
        if (localTime >= start && localTime < end) return true;
      } else if (localTime >= start) {
        return true;
      }
    }
  }

  const prev = week.get((wall.dow + 6) % 7);
  if (prev && isOvernight(prev.startTime, prev.endTime)) {
    const end = normalizeTime(prev.endTime);
    if (end && localTime < end) return true;
  }

  return false;
}

/**
 * Scheduled seconds that fall on a PHT calendar date, including
 * previous-day overnight spill into this morning.
 * No schedule → full day (86400).
 * @param {string} dateStr YYYY-MM-DD
 * @param {Map<number, ScheduleDay>|undefined} week
 */
function scheduledSecondsOnCalendarDay(dateStr, week) {
  if (!week || week.size === 0) return 24 * 3600;

  let seconds = 0;
  const dow = dayOfWeekForDate(dateStr);
  const today = week.get(dow);
  if (today) {
    const start = timeToSeconds(today.startTime);
    const end = timeToSeconds(today.endTime);
    if (end > start) {
      seconds += end - start;
    } else {
      seconds += 86400 - start;
    }
  }

  const prev = week.get((dow + 6) % 7);
  if (prev && isOvernight(prev.startTime, prev.endTime)) {
    seconds += timeToSeconds(prev.endTime);
  }
  return seconds;
}

/**
 * JS day-of-week for a YYYY-MM-DD (0=Sun … 6=Sat).
 * Uses UTC noon so the calendar date is stable (PH has no DST).
 * @param {string} dateStr
 */
function dayOfWeekForDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

/**
 * Shift a YYYY-MM-DD by whole calendar days.
 * @param {string} dateStr
 * @param {number} deltaDays
 */
function shiftCalendarDate(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Next calendar day YYYY-MM-DD.
 * @param {string} dateStr
 */
function nextCalendarDate(dateStr) {
  return shiftCalendarDate(dateStr, 1);
}

/**
 * Previous calendar day YYYY-MM-DD.
 * @param {string} dateStr
 */
function prevCalendarDate(dateStr) {
  return shiftCalendarDate(dateStr, -1);
}

/**
 * Build a timestamptz literal for a wall-clock instant.
 * Defaults to the website clock (Europe/Berlin). Pass Asia/Manila for the leaderboard.
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:MM:SS
 * @param {string} [timeZone]
 */
function manilaTimestampSql(dateStr, timeStr, timeZone = BUSINESS_TZ) {
  const t = normalizeTime(timeStr) || '00:00:00';
  const tz = normalizeTimeZone(timeZone);
  return `(TIMESTAMP '${dateStr} ${t}' AT TIME ZONE '${tz}')`;
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
 * Morning slice of an overnight shift that started the calendar day before `startDate`.
 * [startDate 00:00, startDate endTime). Omitted unless that previous day is overnight.
 * @param {Map<number, ScheduleDay>|undefined} week
 * @param {string} startDate
 * @param {string} timeZone
 * @returns {{ windowStartSql: string, windowEndSql: string } | null}
 */
function leadingOvernightSpill(week, startDate, timeZone) {
  if (!week || week.size === 0) return null;
  const prev = week.get(dayOfWeekForDate(prevCalendarDate(startDate)));
  if (!prev || !isOvernight(prev.startTime, prev.endTime)) return null;
  const end = normalizeTime(prev.endTime) || '00:00:00';
  return {
    windowStartSql: manilaTimestampSql(startDate, '00:00:00', timeZone),
    windowEndSql: manilaTimestampSql(startDate, end, timeZone),
  };
}

/**
 * Expand shift windows for users over inclusive date range.
 * Users with no schedule get full calendar days.
 * Default clock is Europe/Berlin. The leaderboard passes Asia/Manila and
 * includeLeadingOvernightSpill so 00:00–08:00 on the first day still counts.
 * @param {string[]} userIds
 * @param {string} startDate
 * @param {string} endDate
 * @param {ScheduleMap} [schedules]
 * @param {string} [timeZone]
 * @param {{ includeLeadingOvernightSpill?: boolean }} [options]
 * @returns {Promise<Array<{ userId: string, windowStartSql: string, windowEndSql: string }>>}
 */
async function expandShiftWindows(
  userIds,
  startDate,
  endDate,
  schedules,
  timeZone = BUSINESS_TZ,
  options = {}
) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return [];

  const tz = normalizeTimeZone(timeZone);
  const byUser = schedules || (await loadSchedulesByUserId(ids));
  const dates = buildDateRangeBetween(startDate, endDate);
  /** @type {Array<{ userId: string, windowStartSql: string, windowEndSql: string }>} */
  const windows = [];

  for (const userId of ids) {
    const week = byUser.get(userId);
    if (options.includeLeadingOvernightSpill) {
      const spill = leadingOvernightSpill(week, startDate, tz);
      if (spill) windows.push({ userId, ...spill });
    }
    for (const dateStr of dates) {
      if (!week || week.size === 0) {
        windows.push({
          userId,
          windowStartSql: manilaTimestampSql(dateStr, '00:00:00', tz),
          windowEndSql: manilaTimestampSql(nextCalendarDate(dateStr), '00:00:00', tz),
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
          windowStartSql: manilaTimestampSql(dateStr, start, tz),
          windowEndSql: manilaTimestampSql(nextCalendarDate(dateStr), end, tz),
        });
      } else {
        windows.push({
          userId,
          windowStartSql: manilaTimestampSql(dateStr, start, tz),
          windowEndSql: manilaTimestampSql(dateStr, end, tz),
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
 * SQL predicate: entry sentAt falls inside a scheduled Berlin work hour.
 * Users with no schedule rows always match (full day).
 * A morning after midnight also matches the previous weekday's overnight row.
 *
 * @param {string} [entryAlias='m']
 * @param {string} [schedAlias='uws']
 */
function duringScheduledHoursPredicate(entryAlias = 'm', schedAlias = 'uws') {
  const localTime = `(${entryAlias}."sentAt" AT TIME ZONE '${BUSINESS_TZ}')::time`;
  const berlinDow = `EXTRACT(DOW FROM (${entryAlias}."sentAt" AT TIME ZONE '${BUSINESS_TZ}'))::int`;
  const prevDow = `(${berlinDow} + 6) % 7`;
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
    OR EXISTS (
      SELECT 1 FROM user_work_schedules _uws_prev
      WHERE _uws_prev."userId" = ${entryAlias}."chatterId"
        AND _uws_prev."dayOfWeek" = ${prevDow}
        AND _uws_prev."startTime" >= _uws_prev."endTime"
        AND ${localTime} < _uws_prev."endTime"
    )
  )`;
}

/**
 * Shift label converted from Berlin wall-clock hours into `timeZone`.
 * A single weekly pattern uses the offset in effect at `at`. Mixed weeks stay "Custom week".
 * @param {Map<number, ScheduleDay>|undefined} week
 * @param {string} [timeZone]
 * @param {Date} [at]
 * @returns {{ scheduleApplied: boolean, shiftLabel: string|null }}
 */
function shiftLabelInTimeZone(week, timeZone = BUSINESS_TZ, at = new Date()) {
  const meta = scheduleMetaForWeek(week);
  if (!meta.scheduleApplied || !meta.shiftLabel || meta.shiftLabel === 'Custom week') {
    return meta;
  }
  const day = [...week.values()][0];
  const start = normalizeTime(day.startTime);
  const end = normalizeTime(day.endTime);
  if (!start || !end) return meta;

  const tz = normalizeTimeZone(timeZone);
  const berlinDate = wallClockInTimeZone(at, BUSINESS_TZ).dateStr;
  const [year, month, date] = berlinDate.split('-').map(Number);
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  const startInstant = zonedWallTimeToUtc(
    year,
    month,
    date,
    startHour,
    startMinute,
    BUSINESS_TZ
  );
  const endDate = isOvernight(start, end) ? nextCalendarDate(berlinDate) : berlinDate;
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
  const endInstant = zonedWallTimeToUtc(
    endYear,
    endMonth,
    endDay,
    endHour,
    endMinute,
    BUSINESS_TZ
  );
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return {
    scheduleApplied: true,
    shiftLabel: `${formatter.format(startInstant)}–${formatter.format(endInstant)}`,
  };
}

/**
 * LEFT JOIN fragment for schedule on the entry's Berlin day of week.
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
  SCHEDULE_TZ,
  TIME_RE,
  normalizeTime,
  formatTimeShort,
  isOvernight,
  timeToSeconds,
  wallClockInTimeZone,
  isDateWithinWeekSchedule,
  scheduledSecondsOnCalendarDay,
  dayOfWeekForDate,
  nextCalendarDate,
  manilaTimestampSql,
  loadSchedulesByUserId,
  scheduleMetaForWeek,
  shiftLabelInTimeZone,
  expandShiftWindows,
  expandTodayWindows,
  buildWindowValuesClause,
  duringScheduledHoursPredicate,
  scheduleDowJoin,
  parseScheduleDaysPayload,
};
