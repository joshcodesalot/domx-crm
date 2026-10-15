const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requireOwnerOrManager } = require('../middleware/authorize');

const router = express.Router();

const KINDS = new Set(['error', 'slow_request', 'heartbeat']);

router.get('/events', authenticate, requireOwnerOrManager, async (req, res, next) => {
  try {
    const parsed = Number.parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 100, 1), 200);
    const params = [];
    let where = '';
    if (typeof req.query.kind === 'string' && KINDS.has(req.query.kind)) {
      params.push(req.query.kind);
      where = 'WHERE kind = $1';
    }
    params.push(limit);
    const result = await pool.query(
      `SELECT id, "time", kind, process, source, method, path, status, "durationMs", message, details
       FROM ops_events
       ${where}
       ORDER BY "time" DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ events: result.rows });
  } catch (err) {
    next(err);
  }
});

router.get('/summary', authenticate, requireOwnerOrManager, async (req, res, next) => {
  try {
    const [counts, heartbeats] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE kind = 'error')::int AS "errorsLastHour",
           COUNT(*) FILTER (WHERE kind = 'slow_request')::int AS "slowRequestsLastHour"
         FROM ops_events
         WHERE "time" >= NOW() - INTERVAL '1 hour'`
      ),
      pool.query(
        `SELECT DISTINCT ON (source)
           source, "time", kind, message
         FROM ops_events
         WHERE kind = 'heartbeat'
         ORDER BY source, "time" DESC`
      ),
    ]);
    const row = counts.rows[0] || {};
    res.json({
      errorsLastHour: row.errorsLastHour || 0,
      slowRequestsLastHour: row.slowRequestsLastHour || 0,
      heartbeats: heartbeats.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
