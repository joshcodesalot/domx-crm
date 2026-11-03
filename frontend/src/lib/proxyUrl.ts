function parseHostPort(hostPort: string): { host: string; port: string } | null {
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

function formatHostPort(host: string, port: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
}

export function buildProxyUrl(
  hostPort: string,
  username?: string,
  password?: string
): string | null {
  const parsed = parseHostPort(hostPort);
  if (!parsed) {
    return null;
  }
  const user = username ?? '';
  const pass = password ?? '';
  let auth = '';
  if (user || pass) {
    auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
  }
  return `http://${auth}${formatHostPort(parsed.host, parsed.port)}`;
}

export function isValidProxyHostPort(hostPort: string): boolean {
  return parseHostPort(hostPort) !== null;
}
