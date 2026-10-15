const pool = require('../db/pool');
const {
  encryptJson,
  encryptSecret,
  hashToken,
  generateAccountToken,
} = require('../services/crypto');
const fanslyClient = require('../services/fanslyClient');

async function connectFanslyCreator(req, res, helpers) {
  const {
    readCustomProxy,
    cleanupExpiredPending,
    partitionIdFor,
    encryptCustomProxy,
    encryptOptionalLoginPassword,
    PENDING_TTL_MINUTES,
  } = helpers;
  const {
    accountId,
    platform,
    email,
    displayName,
    username,
    postLoginUrl,
    avatarUrl,
    password,
  } = req.body;

  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!password || typeof password !== 'string' || !password.length) {
    return res.status(400).json({ error: 'Password is required' });
  }

  const customProxy = readCustomProxy(req.body);
  if (!customProxy.ok) {
    return res.status(400).json({ error: customProxy.error });
  }

  let resolvedProxy;
  try {
    resolvedProxy = fanslyClient.resolveFanslyProxyUrl(customProxy.proxyUrl);
  } catch (err) {
    if (err instanceof fanslyClient.FanslyApiError) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    throw err;
  }

  try {
    await cleanupExpiredPending();

    const existingCreator = await pool.query(
      'SELECT id FROM creators WHERE "accountId" = $1',
      [accountId]
    );
    if (existingCreator.rows.length > 0) {
      return res.status(409).json({ error: 'Account ID is already in use' });
    }

    const existingPending = await pool.query(
      `SELECT "accountId" FROM creator_connect_pending
       WHERE "accountId" = $1 AND "createdBy" = $2 AND "expiresAt" > NOW()`,
      [accountId, req.user.id]
    );
    if (existingPending.rows.length > 0) {
      await pool.query(
        'DELETE FROM creator_connect_pending WHERE "accountId" = $1',
        [accountId]
      );
    }

    const twofaToken =
      typeof req.body?.twofaToken === 'string' ? req.body.twofaToken.trim() : '';
    const twofaCode =
      typeof req.body?.twofaCode === 'string' ? req.body.twofaCode.trim() : '';
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
    let loginResult;
    try {
      loginResult =
        twofaToken && twofaCode
          ? await fanslyClient.verifyTwofa({
              twofaToken,
              code: twofaCode,
              deviceId,
              proxyUrl: resolvedProxy,
            })
          : await fanslyClient.login({
              username: email.trim(),
              password,
              proxyUrl: resolvedProxy,
            });
    } catch (err) {
      if (err instanceof fanslyClient.TwoFactorRequiredError) {
        return res.json({
          status: 'twofa_required',
          twofaToken: err.twofaToken,
          deviceId: err.deviceId,
          ...(Number.isInteger(err.twofaType) ? { twofaType: err.twofaType } : {}),
          ...(typeof err.email === 'string' && err.email ? { email: err.email } : {}),
        });
      }
      if (err instanceof fanslyClient.WrongPasswordError || err.code === 'WRONG_PASSWORD') {
        return res.status(400).json({ error: 'Password not correct' });
      }
      if (err instanceof fanslyClient.FanslyApiError) {
        return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
          error: err.message || 'Fansly login failed',
        });
      }
      throw err;
    }

    const accountToken = generateAccountToken();
    const accountTokenHash = hashToken(accountToken);
    const partitionId = partitionIdFor(accountId);
    const loginEmail = email.trim();
    const sessionPayload = {
      cookies: loginResult.cookies,
      token: loginResult.token,
      sessionId: loginResult.sessionId,
      deviceId: loginResult.deviceId,
      providerUserId: loginResult.providerUserId,
      loginEmail,
      savedAt: new Date().toISOString(),
      platform: 'fansly',
    };
    const encryptedSession = encryptJson(sessionPayload);
    const encryptedAccessToken = encryptSecret(loginResult.token);
    const encryptedProxy = encryptCustomProxy(customProxy.provided, resolvedProxy);
    const encryptedLoginPassword = encryptOptionalLoginPassword(password);
    const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000);
    const resolvedDisplayName =
      (typeof displayName === 'string' && displayName.trim()) ||
      loginResult.displayName;
    const resolvedUsername =
      (typeof username === 'string' && username.trim()) ||
      loginResult.username ||
      null;
    const resolvedAvatar = avatarUrl || loginResult.avatarUrl || null;
    const resolvedPostLoginUrl =
      (typeof postLoginUrl === 'string' && postLoginUrl.trim()) ||
      loginResult.postLoginUrl;

    await pool.query(
      `INSERT INTO creator_connect_pending (
         "accountId", "accountTokenHash", "partitionId", platform,
         "displayName", username, "postLoginUrl", "avatarUrl", "encryptedSession",
         "loginEmail", "encryptedLoginPassword", "encryptedAccessToken",
         "encryptedRefreshToken", "accessTokenExpiresAt",
         "providerUserId", "encryptedProxy",
         "createdBy", "expiresAt"
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        accountId,
        accountTokenHash,
        partitionId,
        platform,
        resolvedDisplayName,
        resolvedUsername,
        resolvedPostLoginUrl,
        resolvedAvatar,
        encryptedSession,
        loginEmail,
        encryptedLoginPassword ?? null,
        encryptedAccessToken,
        null,
        null,
        loginResult.providerUserId,
        encryptedProxy,
        req.user.id,
        expiresAt,
      ]
    );

    return res.status(201).json({
      accountToken,
      accountId,
      partitionId,
      displayName: resolvedDisplayName,
      username: resolvedUsername,
      postLoginUrl: resolvedPostLoginUrl,
      avatarUrl: resolvedAvatar,
      providerUserId: loginResult.providerUserId,
      cookies: [],
      origins: [],
    });
  } catch (err) {
    console.error('Connect Fansly creator error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { connectFanslyCreator };
