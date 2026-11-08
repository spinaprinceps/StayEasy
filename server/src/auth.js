// Passwords, tokens, the "must be logged in" check, and the login rate limit.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const BCRYPT_COST = 10;            // each +1 doubles the time to hash (and to brute-force)
const TOKEN_TTL_SECONDS = 60 * 60; // tokens last 1 hour (per the brief)

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  // Refuse to start rather than sign tokens with a weak or missing secret.
  throw new Error('JWT_SECRET must be set to at least 32 characters');
}

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);
const checkPassword = (password, hash) => bcrypt.compare(password, hash);

// A real hash of a random string. Used when the email doesn't exist, so a wrong email
// takes as long as a wrong password and attackers can't tell which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-' + Math.random(), BCRYPT_COST);

function issueToken(userId) {
  return jwt.sign({}, SECRET, { subject: String(userId), expiresIn: TOKEN_TTL_SECONDS });
}

// Middleware: put it in front of any route that needs a logged-in traveller.
// Expects the header  Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Log in first' });
  }
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.userId = Number(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired or invalid. Log in again.' });
  }
}

// At most `limit` login attempts per email per window. Kept in this process's memory:
// fine for ONE API server; with several servers you'd need a shared store (Redis or the DB).
function createLoginLimiter({ limit = 5, windowMs = 60_000, maxTracked = 10_000 } = {}) {
  const attempts = new Map(); // email -> { count, windowStart }

  // Someone trying thousands of made-up emails would grow this Map forever.
  // Once it gets big, drop entries whose window has already ended.
  function sweep(now) {
    for (const [key, e] of attempts) {
      if (now - e.windowStart >= windowMs) attempts.delete(key);
    }
  }

  function tryAttempt(email, now = Date.now()) {
    if (attempts.size >= maxTracked) sweep(now);
    const entry = attempts.get(email);
    if (!entry || now - entry.windowStart >= windowMs) {
      attempts.set(email, { count: 1, windowStart: now });
      return { allowed: true };
    }
    if (entry.count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.windowStart + windowMs - now) / 1000) };
    }
    entry.count++;
    return { allowed: true };
  }

  tryAttempt.size = () => attempts.size; // for tests
  return tryAttempt;
}

module.exports = {
  hashPassword, checkPassword, DUMMY_HASH, issueToken, requireAuth, createLoginLimiter, TOKEN_TTL_SECONDS,
};
