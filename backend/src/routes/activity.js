const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');
const {
  getAnalyticsScope,
  TRACKED_STAFF_ROLES,
} = require('../services/analyticsScope');
const {
  BUSINESS_TZ,
  calendarDateString,
  resolveAnalyticsPeriod,
} = require('../services/businessTimezone');
const { getUserTimeZone } = require('../services/rbac');

const router = express.Router();

const ONLINE_MS = 2 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const HEARTBEAT_FRESH_MS = 2 * 60 * 1000;
const MAX_ACTIVE_INTERVAL_SECONDS = 60;
const MAX_KEYSTROKE_DELTA = 5000;

function parseInputAt(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseKeystrokeDelta(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_KEYSTROKE_DELTA, Math.floor(n));
}

function derivePresenceStatus(row, now = Date.now()) {
  const lastHeartbeatAt = row?.lastHeartbeatAt
    ? new Date(row.lastHeartbeatAt).getTime()
    : null;
  const lastInputAt = row?.lastInputAt ? new Date(row.lastInputAt).getTime() : null;

  if (lastHeartbeatAt == null || now - lastHeartbeatAt > HEARTBEAT_FRESH_MS) {
    return 'away';
  }

  if (lastInputAt != null && now - lastInputAt <= ONLINE_MS) {
    return 'online';
  }

  if (
    lastInputAt != null &&
    now - lastInputAt > ONLINE_MS &&
    now - lastInputAt <= IDLE_MS
  ) {
    return 'idle';
  }

  return 'away';
}

router.post('/heartbeat', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const clientInputAt = parseInputAt(req.body?.lastInputAt);
    const keystrokeDelta = parseKeystrokeDelta(req.body?.keystrokeDelta);
    const now = new Date();
    const today = calendarDateString(now);

    const existing = await pool.query(
      `SELECT "lastInputAt", "lastHeartbeatAt",
              "activeSecondsToday", "idleSecondsToday", "keystrokesToday",
              "activeSecondsDate"
       FROM user_activity_presence
       WHERE "userId" = $1`,
      [userId]
    );

    const prev = existing.rows[0] || null;
    let activeSecondsToday = 0;
    let idleSecondsToday = 0;
    let keystrokesToday = 0;
    let activeSecondsDate = today;

    if (prev) {
      const prevDate =
        prev.activeSecondsDate instanceof Date
          ? prev.activeSecondsDate.toISOString().slice(0, 10)
          : prev.activeSecondsDate
            ? String(prev.activeSecondsDate).slice(0, 10)
            : null;

      if (prevDate === today) {
        activeSecondsToday = Number(prev.activeSecondsToday) || 0;
        idleSecondsToday = Number(prev.idleSecondsToday) || 0;
        keystrokesToday = Number(prev.keystrokesToday) || 0;
      }

      const prevHeartbeat = prev.lastHeartbeatAt
        ? new Date(prev.lastHeartbeatAt).getTime()
        : null;
      const intervalSeconds =
        prevHeartbeat != null
          ? Math.min(
              MAX_ACTIVE_INTERVAL_SECONDS,
              Math.max(0, Math.floor((now.getTime() - prevHeartbeat) / 1000))
            )
          : 0;

      const effectiveInputAt =
        clientInputAt || (prev.lastInputAt ? new Date(prev.lastInputAt) : null);
      const hadRecentInput =
        effectiveInputAt != null &&
        now.getTime() - effectiveInputAt.getTime() <=
          MAX_ACTIVE_INTERVAL_SECONDS * 1000;

      if (intervalSeconds > 0) {
        if (hadRecentInput) {
          activeSecondsToday += intervalSeconds;
        } else {
          // Session present (fresh heartbeat chain) but no recent input → idle
          idleSecondsToday += intervalSeconds;
        }
      }
    } else if (clientInputAt) {
      const ageSeconds = Math.floor((now.getTime() - clientInputAt.getTime()) / 1000);
      if (ageSeconds >= 0 && ageSeconds <= MAX_ACTIVE_INTERVAL_SECONDS) {
        activeSecondsToday = Math.min(MAX_ACTIVE_INTERVAL_SECONDS, ageSeconds || 1);
      }
    }

    keystrokesToday += keystrokeDelta;

    const lastInputAt =
      clientInputAt ||
      (prev?.lastInputAt ? new Date(prev.lastInputAt) : null);

    const result = await pool.query(
      `INSERT INTO user_activity_presence (
         "userId", "lastInputAt", "lastHeartbeatAt",
         "activeSecondsToday", "idleSecondsToday", "keystrokesToday",
         "activeSecondsDate", "updatedAt"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::date, $3)
       ON CONFLICT ("userId") DO UPDATE SET
         "lastInputAt" = CASE
           WHEN EXCLUDED."lastInputAt" IS NOT NULL
             AND (
               user_activity_presence."lastInputAt" IS NULL
               OR EXCLUDED."lastInputAt" > user_activity_presence."lastInputAt"
             )
           THEN EXCLUDED."lastInputAt"
           ELSE user_activity_presence."lastInputAt"
         END,
         "lastHeartbeatAt" = EXCLUDED."lastHeartbeatAt",
         "activeSecondsToday" = EXCLUDED."activeSecondsToday",
         "idleSecondsToday" = EXCLUDED."idleSecondsToday",
         "keystrokesToday" = EXCLUDED."keystrokesToday",
         "activeSecondsDate" = EXCLUDED."activeSecondsDate",
         "updatedAt" = EXCLUDED."updatedAt"
       RETURNING "userId", "lastInputAt", "lastHeartbeatAt",
                 "activeSecondsToday", "idleSecondsToday", "keystrokesToday",
                 "activeSecondsDate"`,
      [
        userId,
        lastInputAt ? lastInputAt.toISOString() : null,
        now.toISOString(),
        activeSecondsToday,
        idleSecondsToday,
        keystrokesToday,
        activeSecondsDate,
      ]
    );

    const row = result.rows[0];
    const activeSeconds = Number(row.activeSecondsToday) || 0;
    const idleSeconds = Number(row.idleSecondsToday) || 0;
    const keystrokes = Number(row.keystrokesToday) || 0;

    await pool.query(
      `INSERT INTO user_activity_daily (
         "userId", day, "activeSeconds", "idleSeconds", keystrokes, "updatedAt"
       )
       VALUES ($1, $2::date, $3, $4, $5, $6)
       ON CONFLICT ("userId", day) DO UPDATE SET
         "activeSeconds" = EXCLUDED."activeSeconds",
         "idleSeconds" = EXCLUDED."idleSeconds",
         keystrokes = EXCLUDED.keystrokes,
         "updatedAt" = EXCLUDED."updatedAt"`,
      [userId, activeSecondsDate, activeSeconds, idleSeconds, keystrokes, now.toISOString()]
    );

    res.json({
      ok: true,
      status: derivePresenceStatus(row, now.getTime()),
      lastInputAt: row.lastInputAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      activeSecondsToday: activeSeconds,
      idleSecondsToday: idleSeconds,
      keystrokesToday: keystrokes,
    });
  } catch (err) {
    console.error('activity heartbeat failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/history',
  authenticate,
  requirePermission('analytics.view', 'analytics.self'),
  async (req, res) => {
    try {
      const tz = await getUserTimeZone(req.user.id);
      const scope = getAnalyticsScope(req.user);
      const period = resolveAnalyticsPeriod(
        {
          startDate: req.query.startDate,
          endDate: req.query.endDate,
          days: req.query.days,
        },
        90,
        { allowAnyDays: true, defaultDays: 14, timeZone: tz }
      );
      const dateRange = period.dates;
      const startDate = period.startDate;
      const endDate = period.endDate;
      const parsedDays = period.days;

      let staffQuery;
      let staffParams;
      let dailyQuery;
      let dailyParams;

      if (scope.mode === 'team') {
        staffQuery = `SELECT u.id AS "userId", u.name AS "userName"
                      FROM users u
                      WHERE u.role = ANY($1::text[]) AND u.status = 'active'
                      ORDER BY u.name ASC`;
        staffParams = [TRACKED_STAFF_ROLES];
        dailyQuery = `SELECT d."userId",
                             d.day::text AS date,
                             COALESCE(d."activeSeconds", 0)::int AS "activeSeconds",
                             COALESCE(d."idleSeconds", 0)::int AS "idleSeconds",
                             COALESCE(d.keystrokes, 0)::int AS keystrokes
                      FROM user_activity_daily d
                      JOIN users u ON u.id = d."userId"
                      WHERE u.role = ANY($1::text[])
                        AND d.day >= $2::date
                        AND d.day <= $3::date`;
        dailyParams = [TRACKED_STAFF_ROLES, startDate, endDate];
      } else {
        staffQuery = `SELECT u.id AS "userId", u.name AS "userName"
                      FROM users u
                      WHERE u.id = ANY($1::uuid[])
                      ORDER BY u.name ASC`;
        staffParams = [scope.userIds];
        dailyQuery = `SELECT d."userId",
                             d.day::text AS date,
                             COALESCE(d."activeSeconds", 0)::int AS "activeSeconds",
                             COALESCE(d."idleSeconds", 0)::int AS "idleSeconds",
                             COALESCE(d.keystrokes, 0)::int AS keystrokes
                      FROM user_activity_daily d
                      WHERE d."userId" = ANY($1::uuid[])
                        AND d.day >= $2::date
                        AND d.day <= $3::date`;
        dailyParams = [scope.userIds, startDate, endDate];
      }

      const [staffResult, dailyResult] = await Promise.all([
        pool.query(staffQuery, staffParams),
        pool.query(dailyQuery, dailyParams),
      ]);

      const metricsByUserDay = new Map();
      for (const row of dailyResult.rows) {
        const date = String(row.date).slice(0, 10);
        metricsByUserDay.set(`${row.userId}:${date}`, {
          activeSeconds: Number(row.activeSeconds) || 0,
          idleSeconds: Number(row.idleSeconds) || 0,
          keystrokes: Number(row.keystrokes) || 0,
        });
      }

      const teamTotals = new Map(
        dateRange.map((date) => [
          date,
          { activeSeconds: 0, idleSeconds: 0, keystrokes: 0 },
        ])
      );

      const chatters = staffResult.rows.map((staff) => {
        const days = dateRange.map((date) => {
          const metrics = metricsByUserDay.get(`${staff.userId}:${date}`) || {
            activeSeconds: 0,
            idleSeconds: 0,
            keystrokes: 0,
          };
          const totals = teamTotals.get(date);
          totals.activeSeconds += metrics.activeSeconds;
          totals.idleSeconds += metrics.idleSeconds;
          totals.keystrokes += metrics.keystrokes;
          return { date, ...metrics };
        });
        return {
          userId: staff.userId,
          userName: staff.userName,
          days,
          activeSecondsPeriod: days.reduce((sum, d) => sum + d.activeSeconds, 0),
          idleSecondsPeriod: days.reduce((sum, d) => sum + d.idleSeconds, 0),
          keystrokesPeriod: days.reduce((sum, d) => sum + d.keystrokes, 0),
        };
      });

      res.json({
        days: parsedDays,
        startDate,
        endDate,
        timeZone: tz,
        scope: scope.mode,
        teamByDay: dateRange.map((date) => ({
          date,
          ...teamTotals.get(date),
        })),
        chatters,
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error('activity history failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/presence',
  authenticate,
  requirePermission('analytics.view', 'analytics.self'),
  async (req, res) => {
    try {
      // Presence day keys are written in BUSINESS_TZ (Europe/Berlin).
      const tz = BUSINESS_TZ;
      const scope = getAnalyticsScope(req.user);

      let query;
      let params;
      if (scope.mode === 'team') {
        query = `SELECT u.id AS "userId",
                        u.name AS "userName",
                        u.role,
                        p."lastInputAt",
                        p."lastHeartbeatAt",
                        CASE
                          WHEN p."activeSecondsDate" = (NOW() AT TIME ZONE '${tz}')::date
                          THEN COALESCE(p."activeSecondsToday", 0)
                          ELSE 0
                        END AS "activeSecondsToday",
                        CASE
                          WHEN p."activeSecondsDate" = (NOW() AT TIME ZONE '${tz}')::date
                          THEN COALESCE(p."idleSecondsToday", 0)
                          ELSE 0
                        END AS "idleSecondsToday",
                        CASE
                          WHEN p."activeSecondsDate" = (NOW() AT TIME ZONE '${tz}')::date
                          THEN COALESCE(p."keystrokesToday", 0)
                          ELSE 0
                        END AS "keystrokesToday"
                 FROM users u
                 LEFT JOIN user_activity_presence p ON p."userId" = u.id
                 WHERE u.role = ANY($1::text[]) AND u.status = 'active'
                 ORDER BY u.name ASC`;
        params = [TRACKED_STAFF_ROLES];
      } else {
        query = `SELECT u.id AS "userId",
                        u.name AS "userName",
                        u.role,
                        p."lastInputAt",
                        p."lastHeartbeatAt",
                        CASE
                          WHEN p."activeSecondsDate" = (NOW() AT TIME ZONE '${tz}')::date
                          THEN COALESCE(p."activeSecondsToday", 0)
                          ELSE 0
                        END AS "activeSecondsToday",
                        CASE
                          WHEN p."activeSecondsDate" = (NOW() AT TIME ZONE '${tz}')::date
                          THEN COALESCE(p."idleSecondsToday", 0)
                          ELSE 0
                        END AS "idleSecondsToday",
                        CASE
                          WHEN p."activeSecondsDate" = (NOW() AT TIME ZONE '${tz}')::date
                          THEN COALESCE(p."keystrokesToday", 0)
                          ELSE 0
                        END AS "keystrokesToday"
                 FROM users u
                 LEFT JOIN user_activity_presence p ON p."userId" = u.id
                 WHERE u.id = ANY($1::uuid[])
                 ORDER BY u.name ASC`;
        params = [scope.userIds];
      }

      const result = await pool.query(query, params);

      const now = Date.now();
      const chatters = result.rows.map((row) => ({
        userId: row.userId,
        userName: row.userName,
        role: row.role,
        status: derivePresenceStatus(row, now),
        lastInputAt: row.lastInputAt,
        lastHeartbeatAt: row.lastHeartbeatAt,
        activeSecondsToday: Number(row.activeSecondsToday) || 0,
        idleSecondsToday: Number(row.idleSecondsToday) || 0,
        keystrokesToday: Number(row.keystrokesToday) || 0,
      }));

      res.json({
        scope: scope.mode,
        chatters,
        onlineCount: chatters.filter((c) => c.status === 'online').length,
        idleCount: chatters.filter((c) => c.status === 'idle').length,
        awayCount: chatters.filter((c) => c.status === 'away').length,
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error('activity presence failed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
