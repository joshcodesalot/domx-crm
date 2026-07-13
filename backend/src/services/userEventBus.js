const subscribersByUserId = new Map();

function getSubscribers(userId) {
  if (!subscribersByUserId.has(userId)) {
    subscribersByUserId.set(userId, new Set());
  }
  return subscribersByUserId.get(userId);
}

function writeSse(res, event) {
  if (res.writableEnded || res.destroyed) {
    return false;
  }

  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function subscribe(userId, res) {
  const subscribers = getSubscribers(userId);
  subscribers.add(res);

  if (!res.writableEnded) {
    res.write(': connected\n\n');
  }
}

function unsubscribe(userId, res) {
  const subscribers = subscribersByUserId.get(userId);
  if (!subscribers) {
    return;
  }

  subscribers.delete(res);
  if (subscribers.size === 0) {
    subscribersByUserId.delete(userId);
  }
}

function emitToUser(userId, event) {
  const subscribers = subscribersByUserId.get(userId);
  if (!subscribers || subscribers.size === 0) {
    return;
  }

  for (const res of subscribers) {
    const ok = writeSse(res, event);
    if (!ok) {
      unsubscribe(userId, res);
    }
  }
}

function emitToUsers(userIds, event) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  for (const userId of uniqueIds) {
    emitToUser(userId, event);
  }
}

function sendPingToAll() {
  for (const [userId, subscribers] of subscribersByUserId.entries()) {
    for (const res of subscribers) {
      if (res.writableEnded || res.destroyed) {
        unsubscribe(userId, res);
        continue;
      }

      try {
        res.write(': ping\n\n');
      } catch {
        unsubscribe(userId, res);
      }
    }
  }
}

const pingInterval = setInterval(sendPingToAll, 30000);
if (typeof pingInterval.unref === 'function') {
  pingInterval.unref();
}

module.exports = {
  subscribe,
  unsubscribe,
  emitToUser,
  emitToUsers,
};
