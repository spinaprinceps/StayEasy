// POST /auth/signup  { email, password }  -> 201 { id, email }
// POST /auth/login   { email, password }  -> 200 { token, expiresIn }
// GET  /auth/me      (needs token)        -> 200 { id, email }
const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const {
  hashPassword, checkPassword, DUMMY_HASH, issueToken, requireAuth, createLoginLimiter, TOKEN_TTL_SECONDS,
} = require('../auth');

const router = express.Router();
const loginLimiter = createLoginLimiter({ limit: 5, windowMs: 60_000 });

const Credentials = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('a valid email is required')),
  // bcrypt only looks at the first 72 bytes, so longer passwords would be silently cut.
  password: z.string().min(8, 'password must be at least 8 characters').max(72, 'password is too long'),
});

function parseCredentials(req, res) {
  const result = Credentials.safeParse(req.body ?? {});
  if (result.success) return result.data;
  res.status(400).json({
    errors: result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
  });
  return null;
}

router.post('/signup', async (req, res) => {
  const creds = parseCredentials(req, res);
  if (!creds) return;

  const hash = await hashPassword(creds.password);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [creds.email, hash]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    // 23505 = unique violation: the unique index caught a duplicate email (even a racing one).
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    throw err;
  }
});

router.post('/login', async (req, res) => {
  const creds = parseCredentials(req, res);
  if (!creds) return;

  const limit = loginLimiter(creds.email);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
  }

  const { rows } = await pool.query(
    'SELECT id, password_hash FROM users WHERE lower(email) = $1',
    [creds.email]
  );
  const user = rows[0];
  // Always run bcrypt, even for unknown emails, so both failures take the same time.
  const ok = await checkPassword(creds.password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    // Same message for "no such email" and "wrong password": don't reveal which.
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  res.json({ token: issueToken(user.id), expiresIn: TOKEN_TTL_SECONDS });
});

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.userId]);
  if (!rows.length) return res.status(401).json({ error: 'Account no longer exists' });
  res.json(rows[0]);
});

module.exports = router;
