const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { requireOwnerOrManager } = require('../middleware/authorize');
const { getUserTimeZone } = require('../services/rbac');

const router = express.Router();

const CHANGE_FILTERS = new Set(['ip', 'device', 'either']);

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function shareUser(row) {
  return {
    userId: row.userId || null,
    userName: row.userName || '',
    userEmail: row.userEmail || '',
    lastSeenAt: row.lastSeenAt,
  };
}

function groupShares(rows, keyName) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.key || '');
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: '', users: [] };
      groups.set(key, group);
    }
    if (row.label && (!group.label || new Date(row.lastSeenAt) >= new Date(group.latest || 0))) {
      group.label = row.label;
    }
    if (!group.latest || new Date(row.lastSeenAt) > new Date(group.latest)) {
      group.latest = row.lastSeenAt;
    }
    group.users.push(shareUser(row));
  }

  return [...groups.values()]
    .filter((group) => group.users.length > 1)
    .map((group) => {
      const users = group.users.sort((a, b) => a.userName.localeCompare(b.userName));
      if (keyName === 'deviceId') {
        return { deviceId: group.key, deviceLabel: group.label || '', users };
      }
      return { ipAddress: group.key, users };
    })
    .sort((a, b) => b.users.length - a.users.length);
}

async function loadShares() {
  const [devices, ips] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (key, identity)
         "deviceId" AS key,
         COALESCE("userId"::text, lower("userEmail")) AS identity,
         "userId",
         "userName",
         "userEmail",
         "deviceLabel" AS label,
         "createdAt" AS "lastSeenAt"
       FROM login_events
       WHERE COALESCE("deviceId", '') <> ''
       ORDER BY key, identity, "createdAt" DESC`
    ),
    pool.query(
      `SELECT DISTINCT ON (key, identity)
         "ipAddress" AS key,
         COALESCE("userId"::text, lower("userEmail")) AS identity,
         "userId",
         "userName",
         "userEmail",
         '' AS label,
         "createdAt" AS "lastSeenAt"
       FROM login_events
       WHERE COALESCE("ipAddress", '') <> ''
       ORDER BY key, identity, "createdAt" DESC`
    ),
  ]);

  return {
    sharedDevices: groupShares(devices.rows, 'deviceId'),
    sharedIps: groupShares(ips.rows, 'ipAddress'),
  };
}

function toEvent(row) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    userId: row.userId,
    userName: row.userName,
    userEmail: row.userEmail,
    ipAddress: row.ipAddress || '',
    previousIp: row.previousIp || '',
    ipChanged: Boolean(row.ipChanged),
    deviceId: row.deviceId || '',
    previousDeviceId: row.previousDeviceId || '',
    deviceChanged: Boolean(row.deviceChanged),
    deviceLabel: row.deviceLabel || '',
    previousDeviceLabel: row.previousDeviceLabel || '',
  };
}

router.get(
  '/',
  authenticate,
  requireOwnerOrManager,
  async (req, res) => {
    try {
      const tz = await getUserTimeZone(req.user.id);
      const { startDate, endDate, userId, change, page = '1', limit = '20' } = req.query;

      const conditions = [];
      const values = [];
      let paramIndex = 1;

      if (startDate) {
        const dateValue = String(startDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
          return res.status(400).json({ error: 'Invalid startDate' });
        }
        conditions.push(
          `(e."createdAt" AT TIME ZONE '${tz}')::date >= $${paramIndex}::date`
        );
        values.push(dateValue);
        paramIndex += 1;
      }

      if (endDate) {
        const dateValue = String(endDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
          return res.status(400).json({ error: 'Invalid endDate' });
        }
        conditions.push(
          `(e."createdAt" AT TIME ZONE '${tz}')::date <= $${paramIndex}::date`
        );
        values.push(dateValue);
        paramIndex += 1;
      }

      if (userId) {
        if (!isValidUuid(userId)) {
          return res.status(400).json({ error: 'Invalid userId' });
        }
        conditions.push(`e."userId" = $${paramIndex}`);
        values.push(userId);
        paramIndex += 1;
      }

      const summaryConditions = [...conditions];
      const summaryValues = [...values];

      const changeValue = change != null ? String(change).trim() : '';
      if (changeValue) {
        if (!CHANGE_FILTERS.has(changeValue)) {
          return res.status(400).json({ error: 'Invalid change filter' });
        }
        if (changeValue === 'ip') {
          conditions.push('e."ipChanged" = TRUE');
        } else if (changeValue === 'device') {
          conditions.push('e."deviceChanged" = TRUE');
        } else {
          conditions.push('(e."ipChanged" = TRUE OR e."deviceChanged" = TRUE)');
        }
      }

      const parsedPage = Math.max(Number.parseInt(String(page), 10) || 1, 1);
      const parsedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 20, 1), 100);
      const offset = (parsedPage - 1) * parsedLimit;
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const summaryWhere =
        summaryConditions.length > 0 ? `WHERE ${summaryConditions.join(' AND ')}` : '';

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM login_events e
         ${whereClause}`,
        values
      );
      const total = countResult.rows[0]?.total || 0;

      const summaryResult = await pool.query(
        `SELECT
           COUNT(*)::int AS logins,
           COUNT(*) FILTER (WHERE e."ipChanged")::int AS "ipChanged",
           COUNT(*) FILTER (WHERE e."deviceChanged")::int AS "deviceChanged",
           COUNT(*) FILTER (WHERE e."ipChanged" OR e."deviceChanged")::int AS "eitherChanged"
         FROM login_events e
         ${summaryWhere}`,
        summaryValues
      );
      const summaryRow = summaryResult.rows[0] || {};

      const dataResult = await pool.query(
        `SELECT e.*
         FROM login_events e
         ${whereClause}
         ORDER BY e."createdAt" DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...values, parsedLimit, offset]
      );

      const from = total === 0 ? 0 : offset + 1;
      const to = total === 0 ? 0 : Math.min(offset + dataResult.rows.length, total);
      const shares = await loadShares();

      return res.json({
        data: dataResult.rows.map(toEvent),
        sharedDevices: shares.sharedDevices,
        sharedIps: shares.sharedIps,
        summary: {
          logins: summaryRow.logins || 0,
          ipChanged: summaryRow.ipChanged || 0,
          deviceChanged: summaryRow.deviceChanged || 0,
          eitherChanged: summaryRow.eitherChanged || 0,
        },
        pagination: {
          page: parsedPage,
          limit: parsedLimit,
          total,
          from,
          to,
        },
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error('login activity list failed:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
