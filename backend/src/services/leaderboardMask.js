/**
 * Server-side masking for leaderboard values.
 * Never expose raw peer totals to analytics.self clients.
 */

function formatMoneyPlain(amount, currency) {
  const code = String(currency || 'EUR').toUpperCase() === 'USD' ? 'USD' : 'EUR';
  const symbol = code === 'USD' ? '$' : '€';
  const n = Math.max(0, Number(amount) || 0);
  return `${symbol}${n.toFixed(2)}`;
}

function maskMoneyString(formatted) {
  // e.g. $400.05 → $4**.**  |  €1251.24 → €1***.**
  const match = String(formatted).match(/^([^\d-]*)(-?)(\d+)(\.)(\d+)(.*)$/);
  if (!match) return '***';
  const [, prefix, sign, intPart, dot, fracPart, suffix] = match;
  const maskedInt =
    intPart[0] + '*'.repeat(Math.max(0, intPart.length - 1));
  const maskedFrac = '*'.repeat(fracPart.length);
  return `${prefix}${sign}${maskedInt}${dot}${maskedFrac}${suffix}`;
}

function maskMoney(amount, currency) {
  return maskMoneyString(formatMoneyPlain(amount, currency));
}

function maskMoneyAmounts(amounts) {
  if (!amounts || amounts.length === 0) {
    return maskMoney(0, 'EUR');
  }
  return amounts
    .map((item) => maskMoney(item.amount, item.currency))
    .join(' · ');
}

function formatResponseDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) {
    return '--';
  }
  const totalSeconds = Math.max(0, Math.floor(Number(seconds)));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`;
}

function maskDigitsKeepFirst(digitStr) {
  const s = String(digitStr);
  if (s.length === 0) return s;
  return s[0] + '*'.repeat(Math.max(0, s.length - 1));
}

function maskDurationString(formatted) {
  // 42m 24s → 4*m **s  |  1h 05m → 1*h **m  |  42s → 4*s
  const text = String(formatted);
  if (text === '--') return '--';

  const hourMatch = text.match(/^(\d+)h\s+(\d+)m$/);
  if (hourMatch) {
    return `${maskDigitsKeepFirst(hourMatch[1])}h ${'*'.repeat(hourMatch[2].length)}m`;
  }

  const minMatch = text.match(/^(\d+)m\s+(\d+)s$/);
  if (minMatch) {
    return `${maskDigitsKeepFirst(minMatch[1])}m ${'*'.repeat(minMatch[2].length)}s`;
  }

  const secMatch = text.match(/^(\d+)s$/);
  if (secMatch) {
    return `${maskDigitsKeepFirst(secMatch[1])}s`;
  }

  return text.replace(/\d/g, '*');
}

function maskDuration(seconds) {
  return maskDurationString(formatResponseDuration(seconds));
}

function maskPercent(value) {
  const n = Math.max(0, Number(value) || 0);
  const fixed = n.toFixed(2); // e.g. 15.50
  const [intPart, fracPart = '00'] = fixed.split('.');
  const maskedInt = maskDigitsKeepFirst(intPart);
  return `${maskedInt}.${'*'.repeat(fracPart.length)}%`;
}

function maskCount(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  const s = String(n);
  return maskDigitsKeepFirst(s);
}

module.exports = {
  formatMoneyPlain,
  maskMoney,
  maskMoneyAmounts,
  formatResponseDuration,
  maskDuration,
  maskPercent,
  maskCount,
};
