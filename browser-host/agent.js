const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const {
  buildClearcoteArgs,
  findClearcoteExecutable,
  MISSING_CLEARCOTE_MESSAGE,
} = require('./clearcote/launchArgs');
const { packProfile, unpackProfile } = require('./clearcote/profileArchive');

const sessions = new Map();
let nextDisplay = 100;

function commandExists(name) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    return fs.existsSync(path.join(dir, name));
  });
}

function novncRoot() {
  const candidates = [process.env.NOVNC_WEB, '/usr/share/novnc', '/usr/share/novnc/www'].filter(
    Boolean
  );
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'vnc.html'))) || null;
}

function dataRoot() {
  const preferred = process.env.BROWSER_HOST_DATA || '/var/lib/domx-browser';
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'domx-browser');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function authorized(req) {
  const expected = process.env.BROWSER_HOST_SECRET || '';
  const got = req.headers['x-domx-host-secret'];
  if (!expected || typeof got !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function allocDisplay() {
  const used = new Set([...sessions.values()].map((session) => session.display));
  let display = nextDisplay;
  while (used.has(display)) display += 1;
  nextDisplay = display + 1;
  if (nextDisplay > 200) nextDisplay = 100;
  return display;
}

function spawnGroup(command, args, env) {
  return spawn(command, args, {
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function capture(child) {
  let text = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      text = `${text}${chunk.toString()}`.slice(-4000);
    });
  }
  return () => text.trim();
}

function killProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // The process is already gone.
    }
  }
}

function waitExit(child, ms) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process is already gone.
        }
      }
      resolve();
    }, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForDisplay(display) {
  const socket = `/tmp/.X11-unix/X${display}`;
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (fs.existsSync(socket)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Virtual display :${display} did not start`);
}

async function assertStaysUp(child, label, stderr) {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (child.exitCode !== null) {
    const detail = stderr();
    throw new Error(`${label} exited (${child.exitCode})${detail ? `: ${detail}` : ''}`);
  }
}

async function startDisplay(display, vncPort) {
  const env = { ...process.env, DISPLAY: `:${display}` };
  if (commandExists('Xvfb') && commandExists('x0vncserver')) {
    const xvfb = spawnGroup(
      'Xvfb',
      [`:${display}`, '-screen', '0', '1366x768x24', '-ac', '-nolisten', 'tcp'],
      env
    );
    const xvfbErr = capture(xvfb);
    try {
      await waitForDisplay(display);
      await assertStaysUp(xvfb, 'Xvfb', xvfbErr);
      const vnc = spawnGroup(
        'x0vncserver',
        [
          '-display',
          `:${display}`,
          '-rfbport',
          String(vncPort),
          '-localhost',
          'yes',
          '-SecurityTypes',
          'None',
        ],
        env
      );
      const vncErr = capture(vnc);
      try {
        await assertStaysUp(vnc, 'TigerVNC', vncErr);
      } catch (err) {
        killProcess(vnc);
        throw err;
      }
      return { xvfb, vnc };
    } catch (err) {
      killProcess(xvfb);
      throw err;
    }
  }

  const vncBin = commandExists('Xtigervnc') ? 'Xtigervnc' : commandExists('Xvnc') ? 'Xvnc' : null;
  if (!vncBin) {
    throw Object.assign(
      new Error(
        'Install a virtual display and TigerVNC: sudo apt install xvfb tigervnc-scraping-server tigervnc-standalone-server novnc'
      ),
      { status: 503, code: 'BROWSER_HOST_UNAVAILABLE' }
    );
  }
  const vnc = spawnGroup(
    vncBin,
    [
      `:${display}`,
      '-geometry',
      '1366x768',
      '-depth',
      '24',
      '-rfbport',
      String(vncPort),
      '-localhost',
      'yes',
      '-SecurityTypes',
      'None',
      '-ac',
    ],
    env
  );
  const vncErr = capture(vnc);
  try {
    await waitForDisplay(display);
    await assertStaysUp(vnc, 'TigerVNC', vncErr);
  } catch (err) {
    killProcess(vnc);
    throw err;
  }
  return { xvfb: null, vnc };
}

function hostHeaders(session) {
  return {
    'X-Domx-Host-Secret': process.env.BROWSER_HOST_SECRET,
    'X-Domx-View-Token': session.viewToken,
    'X-Domx-Profile-Generation': String(session.generation),
  };
}

async function downloadArchive(session) {
  if (!session.hasArchive || !session.archiveUrl) return;
  const response = await fetch(session.archiveUrl, {
    headers: hostHeaders(session),
    signal: AbortSignal.timeout(120000),
  });
  if (response.status === 204) return;
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not download the browser profile');
  }
  unpackProfile(Buffer.from(await response.arrayBuffer()), session.userDataDir);
}

async function uploadArchive(session) {
  if (!session.archiveUrl) {
    throw new Error('Profile archive URL is missing');
  }
  const zip = packProfile(session.userDataDir);
  const response = await fetch(session.archiveUrl, {
    method: 'PUT',
    headers: {
      ...hostHeaders(session),
      'Content-Type': 'application/octet-stream',
    },
    body: zip,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not save the browser profile');
  }
}

async function stopSession(creatorId, { upload }) {
  const session = sessions.get(creatorId);
  if (!session) {
    throw Object.assign(new Error('Browser session is not running'), { status: 404 });
  }
  if (session.stopPromise) return session.stopPromise;
  session.stopPromise = (async () => {
    if (session.watchdog) clearInterval(session.watchdog);
    session.watchdog = null;
    try {
      killProcess(session.chrome);
      await waitExit(session.chrome, 5000);
      if (upload && !session.skipUpload) {
        await uploadArchive(session);
      }
      killProcess(session.vnc);
      killProcess(session.xvfb);
      await waitExit(session.vnc, 2000);
      await waitExit(session.xvfb, 2000);
      fs.rmSync(session.userDataDir, { recursive: true, force: true });
      sessions.delete(creatorId);
      return { ok: true };
    } catch (err) {
      session.stopPromise = null;
      throw err;
    }
  })();
  return session.stopPromise;
}

function startWatchdog(session) {
  let failures = 0;
  const sessionUrl = String(session.archiveUrl || '').replace(/\/archive$/, '/session');
  session.watchdog = setInterval(() => {
    if (!sessionUrl) return;
    fetch(sessionUrl, { headers: hostHeaders(session) })
      .then(async (response) => {
        if (!response.ok) throw new Error('session check failed');
        failures = 0;
        const body = await response.json();
        if (!body.matches) {
          session.skipUpload = true;
          await stopSession(session.creatorId, { upload: false });
          return;
        }
        if (!body.active) {
          await stopSession(session.creatorId, { upload: true });
        }
      })
      .catch(() => {
        failures += 1;
        if (failures >= 3) {
          stopSession(session.creatorId, { upload: true }).catch((err) => {
            console.error('Clearcote save after lost API:', err.message);
          });
        }
      });
  }, 20000);
}

async function startSession(body) {
  const creatorId = typeof body?.creatorId === 'string' ? body.creatorId : '';
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      creatorId
    ) ||
    !body.viewToken ||
    !body.encryptionKey ||
    !body.fingerprintSeed
  ) {
    throw Object.assign(new Error('Browser session is missing fields'), { status: 400 });
  }
  const existing = sessions.get(creatorId);
  if (existing && existing.viewToken === body.viewToken && !existing.stopPromise) {
    return { viewPath: existing.viewPath };
  }
  if (existing) {
    existing.skipUpload = true;
    await stopSession(creatorId, { upload: false });
  }
  if (!novncRoot()) {
    throw Object.assign(new Error('noVNC is not installed. On Debian: sudo apt install novnc'), {
      status: 503,
      code: 'NOVNC_MISSING',
    });
  }
  const executable = findClearcoteExecutable();
  if (!executable) {
    throw Object.assign(new Error(MISSING_CLEARCOTE_MESSAGE), {
      status: 503,
      code: 'CLEARCOTE_MISSING',
    });
  }

  const display = allocDisplay();
  const vncPort = 5900 + (display - 100);
  const userDataDir = path.join(dataRoot(), creatorId);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const session = {
    creatorId,
    viewToken: body.viewToken,
    generation: body.generation,
    archiveUrl: body.archiveUrl,
    hasArchive: Boolean(body.hasArchive),
    userDataDir,
    display,
    vncPort,
    viewPath: `/vnc.html?autoconnect=1&reconnect=1&resize=scale&path=${encodeURIComponent(
      `websockify?token=${body.viewToken}`
    )}`,
  };

  try {
    await downloadArchive(session);
    const displayProcs = await startDisplay(display, vncPort);
    session.xvfb = displayProcs.xvfb;
    session.vnc = displayProcs.vnc;
    const chrome = spawnGroup(
      executable,
      buildClearcoteArgs({
        userDataDir,
        fingerprintSeed: body.fingerprintSeed,
        fingerprintPlatform: body.fingerprintPlatform,
        encryptionKey: body.encryptionKey,
        proxyUrl: body.proxyUrl,
        timezone: body.timezone,
        acceptLanguage: body.acceptLanguage,
        virtualDisplay: true,
      }),
      { ...process.env, DISPLAY: `:${display}` }
    );
    session.chrome = chrome;
    sessions.set(creatorId, session);
    await assertStaysUp(chrome, 'Clearcote', capture(chrome));
    startWatchdog(session);
    return { viewPath: session.viewPath };
  } catch (err) {
    if (!sessions.has(creatorId)) {
      sessions.set(creatorId, session);
    }
    session.skipUpload = true;
    await stopSession(creatorId, { upload: false }).catch(() => {});
    throw err;
  }
}

function contentType(file) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function serveNovnc(req, res) {
  const root = novncRoot();
  if (!root) {
    send(res, 503, { error: 'noVNC is not installed. On Debian: sudo apt install novnc' });
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/vnc.html';
  const file = path.resolve(root, `.${rel}`);
  const rootResolved = path.resolve(root);
  if (file !== rootResolved && !file.startsWith(`${rootResolved}${path.sep}`)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType(file) });
  fs.createReadStream(file).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, {
      ok: true,
      novnc: Boolean(novncRoot()),
      clearcote: Boolean(findClearcoteExecutable()),
    });
    return;
  }

  if (url.pathname === '/sessions' || url.pathname.startsWith('/sessions/')) {
    if (!authorized(req)) {
      send(res, 401, { error: 'Authentication required' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions') {
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      const started = await startSession(body);
      send(res, 200, started);
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/sessions/')) {
      const creatorId = decodeURIComponent(url.pathname.slice('/sessions/'.length));
      const stopped = await stopSession(creatorId, { upload: true });
      send(res, 200, stopped);
      return;
    }
    send(res, 404, { error: 'Not found' });
    return;
  }

  if (req.method === 'GET') {
    serveNovnc(req, res);
    return;
  }
  send(res, 404, { error: 'Not found' });
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/websockify') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    const session = [...sessions.values()].find((item) => item.viewToken === token && item.vncPort);
    if (!session) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = net.connect(session.vncPort, '127.0.0.1');
      let closed = false;
      const closeBoth = () => {
        if (closed) return;
        closed = true;
        try {
          ws.close();
        } catch {
          // The socket is already closed.
        }
        tcp.destroy();
      };
      ws.on('message', (data) => {
        if (!tcp.destroyed) tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
      });
      tcp.on('data', (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
      });
      ws.on('close', closeBoth);
      ws.on('error', closeBoth);
      tcp.on('error', closeBoth);
      tcp.on('close', closeBoth);
    });
  });
}

async function shutdown() {
  const ids = [...sessions.keys()];
  for (const creatorId of ids) {
    try {
      await stopSession(creatorId, { upload: true });
    } catch (err) {
      console.error(err.message);
    }
  }
  process.exit(0);
}

function main() {
  if (!process.env.BROWSER_HOST_SECRET) {
    console.error('BROWSER_HOST_SECRET is required');
    process.exit(1);
  }
  const port = Number(process.env.BROWSER_HOST_PORT || 6090);
  const host = process.env.BROWSER_HOST_BIND || '127.0.0.1';
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (res.headersSent) return;
      send(res, err.status || 500, { error: err.message || 'Browser host failed', code: err.code });
    });
  });
  attachWebSocket(server);
  server.listen(port, host, () => {
    console.log(`DomX browser host listening on http://${host}:${port}`);
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  novncRoot,
  authorized,
};
