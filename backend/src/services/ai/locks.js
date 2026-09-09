function conversationLockKey({ creatorId, platform, platformChatId } = {}) {
  return {
    creatorId: String(creatorId || ''),
    platform: String(platform || ''),
    platformChatId: String(platformChatId || ''),
  };
}

async function lockConversation(client, key) {
  const { creatorId, platform, platformChatId } = conversationLockKey(key);
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2 || ':' || $3))`,
    [creatorId, platform, platformChatId]
  );
}

async function withConversationLock(db, key, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await lockConversation(client, key);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  conversationLockKey,
  lockConversation,
  withConversationLock,
};
