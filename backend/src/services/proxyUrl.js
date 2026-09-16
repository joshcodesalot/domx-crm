class InvalidProxyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidProxyError';
    this.status = 400;
  }
}

function parseHostPort(hostPort) {
  if (!hostPort || typeof hostPort !== 'string') {
    return null;
  }
  let rest = hostPort.trim();
  if (!rest) {
    return null;
  }
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    rest = rest.slice(at + 1);
  }
  rest = rest.split('/')[0].split('?')[0].trim();
  if (!rest) {
    return null;
  }

  if (rest.startsWith('[')) {
    const match = rest.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (!match) {
      return null;
    }
    const port = Number(match[2]);
    if (port < 1 || port > 65535) {
      return null;
    }
    return { host: match[1], port: String(port) };
  }

  const lastColon = rest.lastIndexOf(':');
  if (lastColon <= 0) {
    return null;
  }
  const host = rest.slice(0, lastColon).trim();
  const portText = rest.slice(lastColon + 1).trim();
  if (!host || !/^\d{1,5}$/.test(portText)) {
    return null;
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) {
    return null;
  }
  return { host, port: String(port) };
}

function formatHostPort(host, port) {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
}

function buildProxyUrl(hostPort, username, password) {
  const parsed = parseHostPort(hostPort);
  if (!parsed) {
    return null;
  }
  const user = typeof username === 'string' ? username : '';
  const pass = typeof password === 'string' ? password : '';
  let auth = '';
  if (user || pass) {
    auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
  }
  return `http://${auth}${formatHostPort(parsed.host, parsed.port)}`;
}

function parseProxyParts(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
    return null;
  }
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`
    );
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return {
      hostPort: formatHostPort(parsed.hostname, port),
      username: parsed.username ? decodeURIComponent(parsed.username) : '',
      password: parsed.password ? decodeURIComponent(parsed.password) : '',
    };
  } catch {
    return null;
  }
}

/**
 * Read an explicit custom proxy from a request body.
 * Accepts either `proxyUrl` or `{ proxyHost, proxyUsername, proxyPassword }`.
 * Empty fields mean "not provided" (use stored / env fallback).
 */
function customProxyFromBody(body) {
  const proxyHost =
    typeof body?.proxyHost === 'string' ? body.proxyHost.trim() : '';
  const proxyUsername =
    typeof body?.proxyUsername === 'string' ? body.proxyUsername : '';
  const proxyPassword =
    typeof body?.proxyPassword === 'string' ? body.proxyPassword : '';
  const proxyUrl = typeof body?.proxyUrl === 'string' ? body.proxyUrl.trim() : '';

  if (proxyHost) {
    const built = buildProxyUrl(proxyHost, proxyUsername, proxyPassword);
    if (!built) {
      throw new InvalidProxyError(
        'Proxy address is invalid. Use host:port (for example 1.2.3.4:8080).'
      );
    }
    return { provided: true, proxyUrl: built };
  }

  if (proxyUrl) {
    return { provided: true, proxyUrl };
  }

  return { provided: false, proxyUrl: null };
}

module.exports = {
  InvalidProxyError,
  parseHostPort,
  buildProxyUrl,
  parseProxyParts,
  customProxyFromBody,
};
