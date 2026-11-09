// The ONE place StayEasy talks to the payment gateway (FakePay). Plain HTTP + JSON.
//
// Every failure becomes a GatewayError with:
//   status = the HTTP status if the gateway answered (402, 409, 500...)
//   status = null if it did NOT answer (timeout, connection refused, connection cut).
//            null means "we don't know if it happened", so only retry with the SAME Idempotency-Key.
//
// Settings are read from the environment on every call (not at load), so tests can point
// this at a gateway on a random port, and the API still starts if they're missing.
const TIMEOUT_MS = 4000;

class GatewayError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.body = body;
  }
  // Worth trying again (with the same key): no answer, or the gateway's own fault.
  get retryable() { return this.status === null || this.status >= 500; }
}

function settings() {
  const apiKey = process.env.FAKEPAY_API_KEY;
  if (!apiKey) throw new Error('FAKEPAY_API_KEY is not set');
  return { baseUrl: process.env.FAKEPAY_URL || 'http://localhost:4000', apiKey };
}

async function call(method, path, { body, idempotencyKey } = {}) {
  const { baseUrl, apiKey } = settings();
  let res, text;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text(); // the connection can also die halfway through the body
  } catch (err) {
    throw new GatewayError(`gateway did not answer ${method} ${path}: ${err.cause?.code || err.name}`);
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    throw new GatewayError(`gateway ${res.status} on ${method} ${path}: ${data?.error ?? text.slice(0, 100)}`, { status: res.status, body: data });
  }
  return data;
}

// Try up to `attempts` times, but only for retryable errors. Safe ONLY for requests that are
// read-only or carry an Idempotency-Key: a retried create with the same key can't create twice.
async function withRetry(fn, { attempts = 3, delaysMs = [200, 600] } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof GatewayError) || !err.retryable || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delaysMs[i - 1] ?? delaysMs.at(-1)));
    }
  }
}

const createIntent = ({ key, amountPaise, reference, returnUrl }) =>
  withRetry(() => call('POST', '/payment_intents', {
    idempotencyKey: key,
    body: { amountPaise, currency: 'INR', reference, ...(returnUrl ? { returnUrl } : {}) },
  }));

// null if the gateway has never heard of it (404)
async function getIntent(id) {
  try {
    return await withRetry(() => call('GET', `/payment_intents/${encodeURIComponent(id)}`));
  } catch (err) {
    if (err instanceof GatewayError && err.status === 404) return null;
    throw err;
  }
}

const findIntentsByReference = async (reference) =>
  (await withRetry(() => call('GET', `/payment_intents?reference=${encodeURIComponent(reference)}`))).data;

// Returns the intent as it ends up: 'canceled', or whatever it already was if it was too late
// to cancel (409 carries the intent). That second case is the important one: it may have SUCCEEDED.
async function cancelIntent(id) {
  try {
    return await withRetry(() => call('POST', `/payment_intents/${encodeURIComponent(id)}/cancel`));
  } catch (err) {
    if (err instanceof GatewayError && err.status === 409 && err.body?.intent) return err.body.intent;
    throw err;
  }
}

const createRefund = ({ key, paymentIntentId, amountPaise, reference }) =>
  withRetry(() => call('POST', '/refunds', { idempotencyKey: key, body: { paymentIntentId, amountPaise, reference } }));

module.exports = { GatewayError, createIntent, getIntent, findIntentsByReference, cancelIntent, createRefund };
