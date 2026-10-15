const pool = require('../db/pool');

const MESSAGE_MAX = 500;
const STACK_MAX = 2000;
const SLOW_REQUEST_MS = 2000;
const HEARTBEAT_MS = 60_000;
const RETENTION_MS = 60 * 60 * 1000;
const SENSITIVE_ENV_KEY = /authorization|cookie|password|token|secret|proxy|key/i;
const PROXY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/]+:[^\s/@]+@[^\s]+/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]{8,}/i;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

const heartbeats = new Set();
let retentionTimer = null;

function shouldRecordRequest(status, durationMs) {
  const code = Number(status);
  const duration = Number(durationMs);
  return code >= 500 || duration >= SLOW_REQUEST_MS;
}

function requestKind(status) {
  return Number(status) >= 500 ? 'error' : 'slow_request';
}

function sensitiveEnvValues() {
  const values = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_KEY.test(key)) continue;
    if (typeof value !== 'string' || value.length < 8) continue;
    values.push(value);
  }
  return values;
}

function containsSensitive(text) {
  if (!text) return false;
  const value = String(text);
  if (PROXY_URL.test(value) || BEARER.test(value) || JWT.test(value)) return true;
  return sensitiveEnvValues().some((secret) => value.includes(secret));
}

function redactSecrets(text) {
  let out = String(text || '');
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/]+:[^\s/@]+@[^\s]+/gi, '[redacted]');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [redacted]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  for (const secret of sensitiveEnvValues()) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function sanitizeMessage(message) {
  const redacted = redactSecrets(message || '');
  if (redacted.length <= MESSAGE_MAX) return redacted;
  return redacted.slice(0, MESSAGE_MAX);
}

function errorDetails(err) {
  const name = err && typeof err === 'object' && err.name ? String(err.name) : 'Error';
  const stack = err && typeof err === 'object' && err.stack ? String(err.stack) : '';
  if (!stack) return { name };
  if (containsSensitive(stack)) return { name, stackOmitted: true };
  return {
    name,
    stack: stack.length > STACK_MAX ? stack.slice(0, STACK_MAX) : stack,
  };
}

function routeSource(req) {
  const routePath = req?.route?.path;
  if (typeof routePath === 'string' && routePath) {
    return `${req.baseUrl || ''}${routePath}`;
  }
  return req?.path || 'unknown';
}

function safeDetails(details) {
  if (!details || typeof details !== 'object') return null;
  const out = {};
  if (details.name) out.name = String(details.name).slice(0, 200);
  if (typeof details.stack === 'string' && details.stack && !containsSensitive(details.stack)) {
    out.stack = details.stack.length > STACK_MAX ? details.stack.slice(0, STACK_MAX) : details.stack;
  } else if (details.stackOmitted || typeof details.stack === 'string') {
    out.stackOmitted = true;
  }
  return out;
}

function opsProcess() {
  const role = String(process.env.PROCESS_ROLE || '').trim().toLowerCase();
  return role === 'worker' ? 'worker' : 'api';
}

function clampInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(Math.round(number), 2147483647));
}

async function record(row) {
  const message = row.message == null ? null : sanitizeMessage(row.message);
  const details = safeDetails(row.details);
  try {
    await pool.query(
      `INSERT INTO ops_events
         (kind, process, source, method, path, status, "durationMs", message, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.kind,
        row.process || opsProcess(),
        row.source || '',
        row.method || null,
        row.path || null,
        row.status == null ? null : clampInt(row.status),
        row.durationMs == null ? null : clampInt(row.durationMs),
        message,
        details == null ? null : JSON.stringify(details),
      ]
    );
  } catch (err) {
    try {
      console.error('[ops] failed to record event:', err.message || err);
    } catch {
      // Ops logging must not affect the request or the worker.
    }
  }
}

function recordRequest(fields) {
  if (!shouldRecordRequest(fields.status, fields.durationMs)) return;
  void record({
    kind: requestKind(fields.status),
    process: opsProcess(),
    source: fields.source || fields.path || '',
    method: fields.method,
    path: fields.path,
    status: fields.status,
    durationMs: fields.durationMs,
    message: null,
    details: null,
  });
}

function recordHandlerError(err, req) {
  void record({
    kind: 'error',
    process: opsProcess(),
    source: routeSource(req),
    method: req?.method || null,
    path: req?.path || null,
    status: 500,
    message: err?.message || 'Internal server error',
    details: errorDetails(err),
  });
}

function noteTickFailure(source, err) {
  const message = err && typeof err === 'object' && err.message
    ? err.message
    : String(err || 'tick failed');
  void record({
    kind: 'error',
    process: opsProcess(),
    source,
    message,
    details: errorDetails(err),
  });
}

function startHeartbeat(source) {
  if (heartbeats.has(source)) return;
  heartbeats.add(source);
  const beat = () => {
    void record({
      kind: 'heartbeat',
      process: opsProcess(),
      source,
      message: null,
      details: null,
    });
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function startOpsRetention() {
  if (retentionTimer) return;
  const run = () => {
    void pool.query(`DELETE FROM ops_events WHERE "time" < NOW() - INTERVAL '14 days'`).catch((err) => {
      console.error('[ops] retention failed:', err.message || err);
    });
  };
  run();
  retentionTimer = setInterval(run, RETENTION_MS);
  if (typeof retentionTimer.unref === 'function') retentionTimer.unref();
}

module.exports = {
  MESSAGE_MAX,
  STACK_MAX,
  SLOW_REQUEST_MS,
  shouldRecordRequest,
  requestKind,
  sanitizeMessage,
  errorDetails,
  routeSource,
  recordRequest,
  recordHandlerError,
  noteTickFailure,
  startHeartbeat,
  startOpsRetention,
  opsProcess,
};
