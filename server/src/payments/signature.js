// Is this webhook really from the gateway, and is it fresh?
//
// Header: FakePay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
//   - HMAC with a shared secret: only someone who knows the secret can make a valid v1.
//   - It covers the RAW body bytes. Re-serialising parsed JSON can change spacing or key
//     order and break the match, so the route must keep the body exactly as received.
//   - t is inside the signed text, so it can't be changed; rejecting old t stops someone
//     who captured one real webhook from replaying it later (a "replay attack").
const crypto = require('crypto');

const TOLERANCE_SEC = 300;

function verifySignature(secret, rawBody, header, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof header !== 'string' || typeof rawBody !== 'string') return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => kv.trim().split('=')).filter((kv) => kv.length === 2),
  );
  const t = Number(parts.t);
  if (!Number.isSafeInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(nowSec - t) > TOLERANCE_SEC) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  // Constant-time compare: a normal === stops at the first wrong byte, and the time it takes
  // tells an attacker how many leading bytes they got right.
  return crypto.timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}

module.exports = { verifySignature, TOLERANCE_SEC };
