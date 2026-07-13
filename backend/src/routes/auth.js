const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { seedRolesAndPermissions } = require('../db/seed');
const { authenticate } = require('../middleware/auth');
const {
  getUserPermissions,
  getUserById,
  toSafeUser,
  OWNER_ROLE_SLUG,
} = require('../services/rbac');
const { validatePassword } = require('../services/passwordUtils');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerOwnerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many registration attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || null;
}

async function buildAuthResponse(row) {
  const userInfo = await getUserById(row.id);
  const permissions = await getUserPermissions(row.id);
  const safeUser = toSafeUser(
    { ...row, roleName: userInfo?.roleName },
    permissions
  );

  const token = jwt.sign(
    {
      id: safeUser.id,
      email: safeUser.email,
      role: safeUser.role,
      name: safeUser.name,
      permissions,
    },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  return { token, user: safeUser };
}

router.get('/setup-status', async (_req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    const count = result.rows[0].count;
    res.json({ needsOwnerSetup: count === 0 });
  } catch (err) {
    console.error('Setup status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/register-owner', registerOwnerLimiter, async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const countResult = await client.query('SELECT COUNT(*)::int AS count FROM users');
    if (countResult.rows[0].count > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Owner setup has already been completed' });
    }

    const existing = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email already in use' });
    }

    const rolesResult = await client.query('SELECT COUNT(*)::int AS count FROM roles');
    if (rolesResult.rows[0].count === 0) {
      await seedRolesAndPermissions(client);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const clientIp = getClientIp(req);

    const inserted = await client.query(
      `INSERT INTO users (name, email, "passwordHash", role, status, "lastLoginAt", "ipAddressLast")
       VALUES ($1, $2, $3, $4, 'active', NOW(), $5)
       RETURNING id, name, email, role, status, "mustChangePassword",
                 "lastLoginAt", "createdAt", "updatedAt", "ipAddressLast"`,
      [name, email, passwordHash, OWNER_ROLE_SLUG, clientIp]
    );

    await client.query('COMMIT');

    const authResponse = await buildAuthResponse(inserted.rows[0]);
    res.status(201).json(authResponse);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Register owner error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, "passwordHash", role, status, "mustChangePassword",
              "lastLoginAt", "createdAt", "updatedAt", "ipAddressLast"
       FROM users
       WHERE LOWER(email) = LOWER($1)`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    if (user.status !== 'active') {
      return res.status(401).json({ error: 'Account is inactive' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const clientIp = getClientIp(req);

    const updated = await pool.query(
      `UPDATE users
       SET "lastLoginAt" = NOW(),
           "ipAddressLast" = $1,
           "updatedAt" = NOW()
       WHERE id = $2
       RETURNING id, name, email, role, status, "mustChangePassword",
                 "lastLoginAt", "createdAt", "updatedAt", "ipAddressLast"`,
      [clientIp, user.id]
    );

    const authResponse = await buildAuthResponse(updated.rows[0]);
    res.json(authResponse);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, status, "mustChangePassword",
              "lastLoginAt", "createdAt", "updatedAt", "ipAddressLast"
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userInfo = await getUserById(req.user.id);
    const permissions = await getUserPermissions(req.user.id);
    const safeUser = toSafeUser(
      { ...result.rows[0], roleName: userInfo?.roleName },
      permissions
    );

    res.json({ user: safeUser });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', authenticate, (_req, res) => {
  res.json({ message: 'Logged out successfully' });
});

router.post('/change-password', authenticate, async (req, res) => {
  const { newPassword, confirmPassword } = req.body;

  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'New password and confirmation are required' });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  const passwordCheck = validatePassword(newPassword);
  if (!passwordCheck.valid) {
    return res.status(400).json({ error: passwordCheck.error });
  }

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, status, "passwordHash", "mustChangePassword",
              "lastLoginAt", "createdAt", "updatedAt", "ipAddressLast"
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    if (!user.mustChangePassword) {
      return res.status(403).json({ error: 'Password change is not required' });
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.passwordHash);
    if (isSamePassword) {
      return res.status(400).json({ error: 'New password must be different from the temporary password' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    const updated = await pool.query(
      `UPDATE users
       SET "passwordHash" = $1,
           "mustChangePassword" = false,
           "updatedAt" = NOW()
       WHERE id = $2
       RETURNING id, name, email, role, status, "mustChangePassword",
                 "lastLoginAt", "createdAt", "updatedAt", "ipAddressLast"`,
      [passwordHash, req.user.id]
    );

    const userInfo = await getUserById(req.user.id);
    const permissions = await getUserPermissions(req.user.id);
    const safeUser = toSafeUser(
      { ...updated.rows[0], roleName: userInfo?.roleName },
      permissions
    );

    res.json({ user: safeUser });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
