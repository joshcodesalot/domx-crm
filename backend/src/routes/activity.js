const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/authorize');

const router = express.Router();

const ONLINE_MS = 2 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const HEARTBEAT_FRESH_MS = 2 * 60 * 1000;
const MAX_ACTIVE_INTERVAL_SECONDS = 60;

function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function parseInputAt(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
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
    const now = new Date();
    const today = utcDateString(now);

    const existing = await pool.query(
      `SELECT "lastInputAt", "lastHeartbeatAt", "activeSecondsToday", "activeSecondsDate"
       FROM user_activity_presence
       WHERE "userId" = $1`,
      [userId]
    );

    const prev = existing.rows[0] || null;
    let activeSecondsToday = 0;
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

      const effectiveInputAt = clientInputAt || (prev.lastInputAt ? new Date(prev.lastInputAt) : null);
      const hadRecentInput =
        effectiveInputAt != null &&
        now.getTime() - effectiveInputAt.getTime() <= MAX_ACTIVE_INTERVAL_SECONDS * 1000;

      if (hadRecentInput && intervalSeconds > 0) {
        activeSecondsToday += intervalSeconds;
      }
    } else if (clientInputAt) {
      const ageSeconds = Math.floor((now.getTime() - clientInputAt.getTime()) / 1000);
      if (ageSeconds >= 0 && ageSeconds <= MAX_ACTIVE_INTERVAL_SECONDS) {
        activeSecondsToday = Math.min(MAX_ACTIVE_INTERVAL_SECONDS, ageSeconds || 1);
      }
    }

    const lastInputAt =
      clientInputAt ||
      (prev?.lastInputAt ? new Date(prev.lastInputAt) : null);

    const result = await pool.query(
      `INSERT INTO user_activity_presence (
         "userId", "lastInputAt", "lastHeartbeatAt",
         "activeSecondsToday", "activeSecondsDate", "updatedAt"
       ) VALUES ($1, $2, $3, $4, $5::date, $3)
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
         "activeSecondsDate" = EXCLUDED."activeSecondsDate",
         "updatedAt" = EXCLUDED."updatedAt"
       RETURNING "userId", "lastInputAt", "lastHeartbeatAt",
                 "activeSecondsToday", "activeSecondsDate"`,
      [
        userId,
        lastInputAt ? lastInputAt.toISOString() : null,
        now.toISOString(),
        activeSecondsToday,
        activeSecondsDate,
      ]
    );

    const row = result.rows[0];
    const seconds = Number(row.activeSecondsToday) || 0;

    await pool.query(
      `INSERT INTO user_activity_daily ("userId", day, "activeSeconds", "updatedAt")
       VALUES ($1, $2::date, $3, $4)
       ON CONFLICT ("userId", day) DO UPDATE SET
         "activeSeconds" = EXCLUDED."activeSeconds",
         "updatedAt" = EXCLUDED."updatedAt"`,
      [userId, activeSecondsDate, seconds, now.toISOString()]
    );

    res.json({
      ok: true,
      status: derivePresenceStatus(row, now.getTime()),
      lastInputAt: row.lastInputAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      activeSecondsToday: seconds,
    });
  } catch (err) {
    console.error('activity heartbeat failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function buildUtcDateRange(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

router.get(
  '/history',
  authenticate,
  requirePermission('analytics.view'),
  async (req, res) => {
    try {
      const parsedDays = Math.min(
        Math.max(Number.parseInt(String(req.query.days || '14'), 10) || 14, 1),
        90
      );
      const dateRange = buildUtcDateRange(parsedDays);
      const startDate = dateRange[0];
      const endDate = dateRange[dateRange.length - 1];

      const [chattersResult, dailyResult] = await Promise.all([
        pool.query(
          `SELECT u.id AS "userId", u.name AS "userName"
           FROM users u
           WHERE u.role = 'chatter' AND u.status = 'active'
           ORDER BY u.name ASC`
        ),
        pool.query(
          `SELECT d."userId",
                  d.day::text AS date,
                  COALESCE(d."activeSeconds", 0)::int AS "activeSeconds"
           FROM user_activity_daily d
           JOIN users u ON u.id = d."userId"
           WHERE u.role = 'chatter'
             AND d.day >= $1::date
             AND d.day <= $2::date`,
          [startDate, endDate]
        ),
      ]);

      const secondsByUserDay = new Map();
      for (const row of dailyResult.rows) {
        const date = String(row.date).slice(0, 10);
        secondsByUserDay.set(`${row.userId}:${date}`, Number(row.activeSeconds) || 0);
      }

      const teamTotals = new Map(dateRange.map((date) => [date, 0]));
      const chatters = chattersResult.rows.map((chatter) => {
        const days = dateRange.map((date) => {
          const activeSeconds =
            secondsByUserDay.get(`${chatter.userId}:${date}`) || 0;
          teamTotals.set(date, (teamTotals.get(date) || 0) + activeSeconds);
          return { date, activeSeconds };
        });
        return {
          userId: chatter.userId,
          userName: chatter.userName,
          days,
          activeSecondsPeriod: days.reduce((sum, d) => sum + d.activeSeconds, 0),
        };
      });

      res.json({
        days: parsedDays,
        startDate,
        endDate,
        teamByDay: dateRange.map((date) => ({
          date,
          activeSeconds: teamTotals.get(date) || 0,
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
  requirePermission('analytics.view'),
  async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT u.id AS "userId",
                u.name AS "userName",
                u.role,
                p."lastInputAt",
                p."lastHeartbeatAt",
                CASE
                  WHEN p."activeSecondsDate" = (NOW() AT TIME ZONE 'UTC')::date
                  THEN COALESCE(p."activeSecondsToday", 0)
                  ELSE 0
                END AS "activeSecondsToday"
         FROM users u
         LEFT JOIN user_activity_presence p ON p."userId" = u.id
         WHERE u.role = 'chatter' AND u.status = 'active'
         ORDER BY u.name ASC`
      );

      const now = Date.now();
      const chatters = result.rows.map((row) => ({
        userId: row.userId,
        userName: row.userName,
        status: derivePresenceStatus(row, now),
        lastInputAt: row.lastInputAt,
        lastHeartbeatAt: row.lastHeartbeatAt,
        activeSecondsToday: Number(row.activeSecondsToday) || 0,
      }));

      res.json({
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
