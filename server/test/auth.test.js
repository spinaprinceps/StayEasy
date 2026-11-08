// Tests for src/auth.js: tokens, the "must be logged in" check, and the login limiter.
// No database needed. Run just this file: node --test test/auth.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// auth.js refuses to load without a strong secret, so set one before requiring it.
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.JWT_SECRET = SECRET;
const { issueToken, requireAuth, createLoginLimiter, hashPassword, checkPassword } = require('../src/auth');

// A tiny fake of Express's req/res: just enough to see what requireAuth did.
function runRequireAuth(authHeader) {
  const req = { get: (name) => (name.toLowerCase() === 'authorization' ? authHeader : undefined) };
  const out = { status: null, body: null, nextCalled: false };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  requireAuth(req, res, () => { out.nextCalled = true; });
  return { req, ...out };
}

// ---- requireAuth ----

test('a valid token lets the request through and sets req.userId', () => {
  const r = runRequireAuth(`Bearer ${issueToken(42)}`);
  assert.equal(r.nextCalled, true);
  assert.equal(r.req.userId, 42);
});

test('no header -> 401', () => {
  const r = runRequireAuth(undefined);
  assert.equal(r.status, 401);
  assert.equal(r.nextCalled, false);
});

test('wrong scheme ("Token x" instead of "Bearer x") -> 401', () => {
  assert.equal(runRequireAuth(`Token ${issueToken(1)}`).status, 401);
});

test('an expired token -> 401', () => {
  const expired = jwt.sign({}, SECRET, { subject: '1', expiresIn: -10 });
  assert.equal(runRequireAuth(`Bearer ${expired}`).status, 401);
});

test('a token signed with a different secret -> 401 (a forged token)', () => {
  const forged = jwt.sign({}, 'some-other-secret-also-32-characters-long!!', { subject: '1' });
  assert.equal(runRequireAuth(`Bearer ${forged}`).status, 401);
});

test('an unsigned token (alg "none") -> 401', () => {
  // The classic JWT attack: strip the signature and say "no algorithm".
  const unsigned = jwt.sign({}, null, { subject: '1', algorithm: 'none' });
  assert.equal(runRequireAuth(`Bearer ${unsigned}`).status, 401);
});

// ---- passwords ----

test('hashing: the right password matches, a wrong one does not, and the hash is not the password', async () => {
  const hash = await hashPassword('correct horse');
  assert.notEqual(hash, 'correct horse');
  assert.equal(await checkPassword('correct horse', hash), true);
  assert.equal(await checkPassword('wrong horse', hash), false);
});

// ---- login limiter ----

test('limiter: 5 attempts allowed, the 6th blocked, with a retry time', () => {
  const tryAttempt = createLoginLimiter({ limit: 5, windowMs: 60_000 });
  for (let i = 0; i < 5; i++) assert.equal(tryAttempt('a@x.com', 1000).allowed, true);
  const blocked = tryAttempt('a@x.com', 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
});

test('limiter: each email has its own budget', () => {
  const tryAttempt = createLoginLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal(tryAttempt('a@x.com', 0).allowed, true);
  assert.equal(tryAttempt('b@x.com', 0).allowed, true);
  assert.equal(tryAttempt('a@x.com', 0).allowed, false);
});

test('limiter: the window resets after windowMs', () => {
  const tryAttempt = createLoginLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal(tryAttempt('a@x.com', 0).allowed, true);
  assert.equal(tryAttempt('a@x.com', 59_999).allowed, false);
  assert.equal(tryAttempt('a@x.com', 60_000).allowed, true);
});

test('limiter: memory does not grow forever when attackers spray made-up emails', () => {
  const tryAttempt = createLoginLimiter({ limit: 5, windowMs: 1000, maxTracked: 100 });
  for (let i = 0; i < 100; i++) tryAttempt(`fake${i}@x.com`, 0);
  assert.equal(tryAttempt.size(), 100);
  tryAttempt('new@x.com', 5000); // all 100 old windows have ended -> swept
  assert.equal(tryAttempt.size(), 1);
});
