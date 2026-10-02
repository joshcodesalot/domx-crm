const { randomUUID } = require('crypto');
const pool = require('../db/pool');

const DEVICE_ID_MAX = 80;
const LABEL_MAX = 120;
const AGENT_MAX = 500;

function clip(value, max) {
  const text = value == null ? '' : String(value);
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function normalizeDeviceId(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > DEVICE_ID_MAX) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return '';
  return raw;
}

function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  if (!ua.trim()) return 'Unknown device';

  let os = 'Unknown OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let client = 'Browser';
  if (/Electron/i.test(ua)) client = 'Electron';
  else if (/Edg\//i.test(ua)) client = 'Edge';
  else if (/Chrome\//i.test(ua)) client = 'Chrome';
  else if (/Firefox\//i.test(ua)) client = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) client = 'Safari';

  return clip(`${client} on ${os}`, LABEL_MAX);
}

async function recordLoginEvent({ user, ipAddress, deviceId, userAgent }) {
  if (!user?.id) return;
  try {
    const currentDeviceId = normalizeDeviceId(deviceId);
    const currentIp = ipAddress ? clip(String(ipAddress).trim(), 45) : null;
    const agent = clip(userAgent || '', AGENT_MAX);
    const label = deviceLabel(agent);

    const previous = await pool.query(
      `SELECT "ipAddress", "deviceId", "deviceLabel"
       FROM login_events
       WHERE "userId" = $1
       ORDER BY "createdAt" DESC
       LIMIT 1`,
      [user.id]
    );
    const prior = previous.rows[0] || null;
    const previousIp = prior?.ipAddress ? String(prior.ipAddress) : null;
    const previousDeviceId = prior?.deviceId ? String(prior.deviceId) : null;
    const previousDeviceLabel = prior?.deviceLabel ? String(prior.deviceLabel) : '';

    const ipChanged = Boolean(prior && previousIp !== currentIp);
    const deviceChanged = Boolean(
      prior && (previousDeviceId || '') !== (currentDeviceId || '')
    );

    await pool.query(
      `INSERT INTO login_events (
         id, "userId", "userName", "userEmail",
         "ipAddress", "previousIp", "ipChanged",
         "deviceId", "previousDeviceId", "deviceChanged",
         "userAgent", "deviceLabel", "previousDeviceLabel"
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, $10,
         $11, $12, $13
       )`,
      [
        randomUUID(),
        user.id,
        clip(user.name || 'Staff', 255),
        clip(user.email || '', 255),
        currentIp,
        prior ? previousIp : null,
        ipChanged,
        currentDeviceId || null,
        prior ? previousDeviceId : null,
        deviceChanged,
        agent,
        label,
        prior ? clip(previousDeviceLabel, LABEL_MAX) : '',
      ]
    );
  } catch (err) {
    console.error('login activity log failed:', err);
  }
}

module.exports = {
  normalizeDeviceId,
  deviceLabel,
  recordLoginEvent,
};
