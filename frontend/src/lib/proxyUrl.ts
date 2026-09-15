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

export function parseLooseProxyLine(
  line: string
): { hostPort: string; username: string; password: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  if (trimmed.includes('@') || /^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
      );
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const hostPort = formatHostPort(parsed.hostname, port);
      if (!parseHostPort(hostPort)) {
        return null;
      }
      return {
        hostPort,
        username: parsed.username ? decodeURIComponent(parsed.username) : '',
        password: parsed.password ? decodeURIComponent(parsed.password) : '',
      };
    } catch {
      return null;
    }
  }

  const firstColon = trimmed.indexOf(':');
  if (firstColon <= 0) {
    return null;
  }
  const host = trimmed.slice(0, firstColon).trim();
  const afterHost = trimmed.slice(firstColon + 1);
  const secondColon = afterHost.indexOf(':');
  if (secondColon === -1) {
    if (!parseHostPort(trimmed)) {
      return null;
    }
    return { hostPort: trimmed, username: '', password: '' };
  }

  const port = afterHost.slice(0, secondColon).trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return null;
  }
  const userAndPass = afterHost.slice(secondColon + 1);
  const userColon = userAndPass.indexOf(':');
  const username =
    userColon === -1 ? userAndPass : userAndPass.slice(0, userColon);
  const password = userColon === -1 ? '' : userAndPass.slice(userColon + 1);
  const hostPort = formatHostPort(host, port);
  if (!parseHostPort(hostPort)) {
    return null;
  }
  return { hostPort, username, password };
}
