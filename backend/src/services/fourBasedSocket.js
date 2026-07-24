const { io } = require('socket.io-client');
const { HttpsProxyAgent } = require('https-proxy-agent');
const pool = require('../db/pool');
const { decryptJson, decryptSecret } = require('./crypto');
const { emitToUsers } = require('./userEventBus');
const { normalizeProxyUrl } = require('./fourBasedClient');

const SOCKET_URL = 'https://socket.4based.com';
const connections = new Map();

async function getUserIdsWithCreatorAccess(creatorId) {
  const [assigned, managers] = await Promise.all([
    pool.query(
      `SELECT "userId" FROM creator_staff_assignments WHERE "creatorId" = $1`,
      [creatorId]
    ),
    pool.query(
      `SELECT id FROM users WHERE status = 'active' AND role <> 'chatter'`
    ),
  ]);

  return [
    ...new Set([
      ...assigned.rows.map((row) => row.userId),
      ...managers.rows.map((row) => row.id),
    ]),
  ];
}

function loadCreatorAuth(row) {
  let session = {};
  try {
    if (row.encryptedSession) {
      session = decryptJson(row.encryptedSession) || {};
    }
  } catch (err) {
    console.warn('[4based-socket] Failed to decrypt session', row.id, err.message);
  }

  const token =
    decryptSecret(row.encryptedAccessToken) || session.token || null;
  const proxyUrl = decryptSecret(row.encryptedProxy) || null;
  const providerUserId = row.providerUserId || session.providerUserId || null;

  return { token, proxyUrl, providerUserId, session };
}

function disconnectCreator(creatorId) {
  const existing = connections.get(creatorId);
  if (!existing) {
    return;
  }
  try {
    existing.socket.removeAllListeners();
    existing.socket.disconnect();
  } catch {
    // ignore
  }
  connections.delete(creatorId);
}

function connectCreator(row) {
  const creatorId = row.id;
  const { token, proxyUrl, providerUserId } = loadCreatorAuth(row);

  if (!token || !providerUserId) {
    console.warn(
      `[4based-socket] Skipping creator ${creatorId}: missing token or providerUserId`
    );
    return null;
  }

  disconnectCreator(creatorId);

  const options = {
    transports: ['websocket'],
    path: '/socket.io/',
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
    timeout: 20000,
    auth: {
      'x-auth-token': token,
    },
    extraHeaders: {
      Origin: 'https://4based.com',
    },
  };

  const normalizedProxy = normalizeProxyUrl(proxyUrl);
  if (normalizedProxy) {
    options.agent = new HttpsProxyAgent(normalizedProxy);
  }

  const socket = io(SOCKET_URL, options);

  socket.on('connect', () => {
    console.log(`[4based-socket] Connected creator ${creatorId}`);
    socket.emit('subscribe', providerUserId);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[4based-socket] Disconnected creator ${creatorId}: ${reason}`);
  });

  socket.on('connect_error', (err) => {
    console.warn(
      `[4based-socket] Connect error creator ${creatorId}:`,
      err?.message || err
    );
  });

  const relay = async (eventName, payload) => {
    try {
      const userIds = await getUserIdsWithCreatorAccess(creatorId);
      emitToUsers(userIds, {
        type: '4based:event',
        event: eventName,
        creatorId,
        providerUserId,
        payload,
      });
    } catch (err) {
      console.warn('[4based-socket] Relay failed', err.message);
    }
  };

  // Catch-all for message-like events from 4based
  socket.onAny((eventName, ...args) => {
    if (eventName === 'connect' || eventName === 'disconnect') {
      return;
    }
    const payload = args.length <= 1 ? args[0] : args;
    void relay(eventName, payload);
  });

  connections.set(creatorId, { socket, providerUserId });
  return socket;
}

async function connectCreatorById(creatorId) {
  const result = await pool.query(
    `SELECT id, platform, "providerUserId", "encryptedSession",
            "encryptedAccessToken", "encryptedProxy", "connectionStatus"
     FROM creators
     WHERE id = $1 AND platform = '4based'`,
    [creatorId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return connectCreator(result.rows[0]);
}

async function startFourBasedSocketManager() {
  try {
    const result = await pool.query(
      `SELECT id, platform, "providerUserId", "encryptedSession",
              "encryptedAccessToken", "encryptedProxy", "connectionStatus"
       FROM creators
       WHERE platform = '4based'
         AND "connectionStatus" = 'connected'
         AND "encryptedAccessToken" IS NOT NULL`
    );

    for (const row of result.rows) {
      try {
        connectCreator(row);
      } catch (err) {
        console.warn(
          `[4based-socket] Failed to connect creator ${row.id}:`,
          err.message
        );
      }
    }

    console.log(
      `[4based-socket] Started with ${result.rows.length} creator connection(s)`
    );
  } catch (err) {
    console.error('[4based-socket] Failed to start:', err.message);
  }
}

function stopFourBasedSocketManager() {
  for (const creatorId of [...connections.keys()]) {
    disconnectCreator(creatorId);
  }
}

module.exports = {
  startFourBasedSocketManager,
  stopFourBasedSocketManager,
  connectCreatorById,
  disconnectCreator,
  connectCreator,
};
