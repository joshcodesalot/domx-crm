const LEVELS = { error: 0, info: 1, debug: 2 };
const REDACTED = '[redacted]';
const SENSITIVE_KEY = /authorization|cookie|password|token|secret|proxy|body|message/i;
const { opsProcess } = require('./opsEvents');

function configuredLevel() {
  const raw = String(process.env.LOG_LEVEL || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, raw) ? LEVELS[raw] : LEVELS.info;
}

function redact(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    return value.map((item) => redact(item, seen));
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(val, seen);
  }
  return out;
}

function write(level, msg, extra) {
  if (LEVELS[level] > configuredLevel()) return;
  const record = {
    time: new Date().toISOString(),
    level,
    process: opsProcess(),
    msg: String(msg),
  };
  if (extra && typeof extra === 'object') {
    Object.assign(record, redact(extra));
  }
  try {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        time: record.time,
        level,
        process: record.process,
        msg: record.msg,
      })}\n`
    );
  }
}

function error(msg, extra) {
  write('error', msg, extra);
}

function info(msg, extra) {
  write('info', msg, extra);
}

function debug(msg, extra) {
  write('debug', msg, extra);
}

module.exports = { redact, error, info, debug };
