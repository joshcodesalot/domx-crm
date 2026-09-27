function hostBase() {
  const base = process.env.BROWSER_HOST_URL;
  return base ? base.replace(/\/$/, '') : '';
}

function hostSecret() {
  return process.env.BROWSER_HOST_SECRET || '';
}

function publicViewBase() {
  const base = process.env.BROWSER_HOST_PUBLIC_URL || process.env.BROWSER_HOST_URL || '';
  return base.replace(/\/$/, '');
}

function hostError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function hostRequest(pathname, options = {}) {
  const base = hostBase();
  if (!base) {
    return null;
  }
  const secret = hostSecret();
  if (!secret) {
    throw hostError('BROWSER_HOST_SECRET is not set.', 503, 'BROWSER_HOST_UNAVAILABLE');
  }
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      'X-Domx-Host-Secret': secret,
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(60000),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function stopRemoteSession(creatorId, options = {}) {
  if (!hostBase()) return { ok: true, skipped: true };
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000;
  const result = await hostRequest(`/sessions/${encodeURIComponent(creatorId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!result) return { ok: true, skipped: true };
  if (result.response.status === 404) return { ok: true, missing: true };
  if (!result.response.ok) {
    throw hostError(
      result.data.error || 'Browser host failed to close Clearcote',
      502,
      result.data.code || 'BROWSER_HOST_FAILED'
    );
  }
  return result.data;
}

async function startRemoteSession(payload) {
  if (!hostBase()) {
    throw hostError(
      'This Mac opens Clearcote on the Debian browser host. Set BROWSER_HOST_URL on the API.',
      503,
      'BROWSER_HOST_UNAVAILABLE'
    );
  }
  const result = await hostRequest('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000),
  });
  if (!result.response.ok) {
    throw hostError(
      result.data.error || 'Browser host failed to start Clearcote',
      result.response.status === 503 ? 503 : 502,
      result.data.code || 'BROWSER_HOST_FAILED'
    );
  }
  const viewBase = publicViewBase();
  if (!viewBase || !result.data.viewPath) {
    throw hostError(
      'Browser host did not return a view URL. Set BROWSER_HOST_PUBLIC_URL.',
      503,
      'BROWSER_HOST_UNAVAILABLE'
    );
  }
  return {
    viewUrl: `${viewBase}${result.data.viewPath}`,
  };
}

module.exports = {
  hostBase,
  publicViewBase,
  stopRemoteSession,
  startRemoteSession,
};
