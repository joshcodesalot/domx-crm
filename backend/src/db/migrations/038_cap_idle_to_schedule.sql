-- One-time: cap historical idle to leftover PHT shift time.
-- migrate.js re-runs every .sql file, so a sentinel prevents recapping
-- after later schedule edits.

CREATE TABLE IF NOT EXISTS schema_data_patches (
  id TEXT PRIMARY KEY,
  "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  schedule_tz TEXT := 'Asia/Manila';
  business_tz TEXT := 'Europe/Berlin';
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_data_patches WHERE id = '038_cap_idle_to_schedule'
  ) THEN
    RETURN;
  END IF;

  WITH scheduled_users AS (
    SELECT DISTINCT "userId" FROM user_work_schedules
  ),
  candidate_days AS (
    SELECT d."userId", d.day
    FROM user_activity_daily d
    JOIN scheduled_users s ON s."userId" = d."userId"
    UNION
    SELECT p."userId", p."activeSecondsDate"
    FROM user_activity_presence p
    JOIN scheduled_users s ON s."userId" = p."userId"
    WHERE p."activeSecondsDate" IS NOT NULL
  ),
  bounds AS (
    SELECT
      c."userId",
      c.day,
      (c.day::timestamp AT TIME ZONE business_tz) AS day_start,
      ((c.day + 1)::timestamp AT TIME ZONE business_tz) AS day_end
    FROM candidate_days c
  ),
  manila_span AS (
    SELECT
      b.*,
      ((b.day_start AT TIME ZONE schedule_tz)::date - 1) AS manila_from,
      (b.day_end AT TIME ZONE schedule_tz)::date AS manila_to
    FROM bounds b
  ),
  manila_dates AS (
    SELECT
      s.*,
      gs::date AS manila_date
    FROM manila_span s
    CROSS JOIN LATERAL generate_series(s.manila_from, s.manila_to, INTERVAL '1 day') gs
  ),
  windows AS (
    SELECT
      md."userId",
      md.day,
      md.day_start,
      md.day_end,
      (md.manila_date::timestamp + uws."startTime") AT TIME ZONE schedule_tz AS window_start,
      CASE
        WHEN uws."startTime" < uws."endTime" THEN
          (md.manila_date::timestamp + uws."endTime") AT TIME ZONE schedule_tz
        ELSE
          ((md.manila_date + 1)::timestamp + uws."endTime") AT TIME ZONE schedule_tz
      END AS window_end
    FROM manila_dates md
    JOIN user_work_schedules uws
      ON uws."userId" = md."userId"
     AND uws."dayOfWeek" = EXTRACT(DOW FROM md.manila_date)::int
  ),
  overlap AS (
    SELECT
      b."userId",
      b.day,
      COALESCE(SUM(
        GREATEST(
          0::numeric,
          EXTRACT(EPOCH FROM (
            LEAST(w.window_end, b.day_end) - GREATEST(w.window_start, b.day_start)
          ))
        )
      ), 0)::int AS scheduled_seconds
    FROM bounds b
    LEFT JOIN windows w
      ON w."userId" = b."userId"
     AND w.day = b.day
    GROUP BY b."userId", b.day
  )
  UPDATE user_activity_daily d
  SET
    "idleSeconds" = LEAST(
      d."idleSeconds",
      GREATEST(0, o.scheduled_seconds - COALESCE(d."activeSeconds", 0))
    ),
    "updatedAt" = NOW()
  FROM overlap o
  WHERE d."userId" = o."userId"
    AND d.day = o.day;

  WITH scheduled_users AS (
    SELECT DISTINCT "userId" FROM user_work_schedules
  ),
  candidate_days AS (
    SELECT p."userId", p."activeSecondsDate" AS day
    FROM user_activity_presence p
    JOIN scheduled_users s ON s."userId" = p."userId"
    WHERE p."activeSecondsDate" IS NOT NULL
  ),
  bounds AS (
    SELECT
      c."userId",
      c.day,
      (c.day::timestamp AT TIME ZONE business_tz) AS day_start,
      ((c.day + 1)::timestamp AT TIME ZONE business_tz) AS day_end
    FROM candidate_days c
  ),
  manila_span AS (
    SELECT
      b.*,
      ((b.day_start AT TIME ZONE schedule_tz)::date - 1) AS manila_from,
      (b.day_end AT TIME ZONE schedule_tz)::date AS manila_to
    FROM bounds b
  ),
  manila_dates AS (
    SELECT
      s.*,
      gs::date AS manila_date
    FROM manila_span s
    CROSS JOIN LATERAL generate_series(s.manila_from, s.manila_to, INTERVAL '1 day') gs
  ),
  windows AS (
    SELECT
      md."userId",
      md.day,
      md.day_start,
      md.day_end,
      (md.manila_date::timestamp + uws."startTime") AT TIME ZONE schedule_tz AS window_start,
      CASE
        WHEN uws."startTime" < uws."endTime" THEN
          (md.manila_date::timestamp + uws."endTime") AT TIME ZONE schedule_tz
        ELSE
          ((md.manila_date + 1)::timestamp + uws."endTime") AT TIME ZONE schedule_tz
      END AS window_end
    FROM manila_dates md
    JOIN user_work_schedules uws
      ON uws."userId" = md."userId"
     AND uws."dayOfWeek" = EXTRACT(DOW FROM md.manila_date)::int
  ),
  overlap AS (
    SELECT
      b."userId",
      b.day,
      COALESCE(SUM(
        GREATEST(
          0::numeric,
          EXTRACT(EPOCH FROM (
            LEAST(w.window_end, b.day_end) - GREATEST(w.window_start, b.day_start)
          ))
        )
      ), 0)::int AS scheduled_seconds
    FROM bounds b
    LEFT JOIN windows w
      ON w."userId" = b."userId"
     AND w.day = b.day
    GROUP BY b."userId", b.day
  )
  UPDATE user_activity_presence p
  SET
    "idleSecondsToday" = LEAST(
      p."idleSecondsToday",
      GREATEST(0, o.scheduled_seconds - COALESCE(p."activeSecondsToday", 0))
    ),
    "updatedAt" = NOW()
  FROM overlap o
  WHERE p."userId" = o."userId"
    AND p."activeSecondsDate" = o.day;

  INSERT INTO schema_data_patches (id) VALUES ('038_cap_idle_to_schedule');
END $$;
