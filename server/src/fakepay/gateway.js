// FakePay: a pretend OUTSIDE payment company (think Razorpay / Stripe), for feature 7 to call.
// It runs as its own process (npm run fakepay, port 4000) and imports NOTHING from StayEasy:
// no database, no shared code. Everything StayEasy knows about a payment comes over HTTP,
// exactly like a real gateway. Its memory is in-process: restart it and every intent is gone.
//
// What it offers (Authorization: Bearer <FAKEPAY_API_KEY> on /payment_intents, /refunds and /_*):
//   POST /payment_intents            header Idempotency-Key, body { amountPaise, currency: 'INR', reference, returnUrl? }
//                                    -> 201 intent | 200 replay of the same key | 422 same key, different body
//   GET  /payment_intents/:id        -> 200 intent | 404              (what the reconciler asks)
//   GET  /payment_intents?reference=  -> 200 { data: [intents] }     (find intents when you lost the id)
//   POST /payment_intents/:id/cancel -> 200 canceled intent | 409 { error, intent } if it already moved on
//   POST /refunds                    header Idempotency-Key, body { paymentIntentId, amountPaise, reference }
//                                    -> 201 refund | 200 replay | 409 not paid / more than was paid | 422 key reused
//   GET  /refunds/:id                -> 200 refund | 404
//   GET  /checkout/:id               the payer's page: Pay / Decline / Bank is slow   (no API key: it's the payer)
//   POST /checkout/:id  outcome=...  -> 303 to returnUrl?intent=<id>
//   GET|POST /_chaos                 read / change the failure switches (see CHAOS below)
//   GET  /_deliveries                every webhook attempt, newest last
//
// Intent status:  requires_payment -> processing -> succeeded | failed      (succeeded/failed/canceled are final)
//                 requires_payment ------------------> succeeded | failed | canceled
// Refunds succeed at once (status 'succeeded'); the intent keeps amountRefundedPaise.
//
// Webhooks: on every intent status change and every refund, POST <webhookUrl> with
//   body    { id: 'evt_...', type: 'payment_intent.<status>' | 'refund.succeeded', createdAt, data: <intent | refund> }
//   header  FakePay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
// Any non-2xx, a timeout or a network error -> retried after each of retryDelaysMs, then given up.
// So the receiver WILL see: duplicates, events out of order, and events that never arrive.
const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');

// CHAOS: probabilities 0..1 (0 = never, 1 = always) and delays in ms.
const DEFAULT_CHAOS = {
  failCreate: 0,        // POST /payment_intents and POST /refunds answer 500 and create NOTHING
  dropResponse: 0,      // ...they DO create it, then cut the connection: "did it work?"
  slowMs: 0,            // ...they wait this long before doing anything
  dropWebhook: 0,       // an event is never delivered (only the reconciler can find out)
  duplicateWebhook: 0,  // an event is delivered twice
  webhookDelayMs: 0,    // wait before the first delivery attempt
};

const FINAL = new Set(['succeeded', 'failed', 'canceled']);
const OUTCOMES = ['succeeded', 'failed', 'processing'];

function sign(secret, rawBody, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const Paise = z.number().int().positive().max(10_000_000_000);
const IntentBody = z.object({
  amountPaise: Paise,
  currency: z.literal('INR'),
  reference: z.string().min(1).max(100),      // the merchant's own id for this payment, e.g. 'payment_42'
  returnUrl: z.url({ protocol: /^https?$/ }).optional(),
}).strict();
const RefundBody = z.object({
  paymentIntentId: z.string().min(1).max(100),
  amountPaise: Paise,
  reference: z.string().min(1).max(100),
}).strict();
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,255}$/);
const ChaosBody = z.object({
  failCreate: z.number().min(0).max(1),
  dropResponse: z.number().min(0).max(1),
  slowMs: z.number().int().min(0).max(120_000),
  dropWebhook: z.number().min(0).max(1),
  duplicateWebhook: z.number().min(0).max(1),
  webhookDelayMs: z.number().int().min(0).max(600_000),
}).partial().strict();

const badInput = (res, issues) =>
  res.status(400).json({ errors: issues.map((i) => ({ field: i.path.join('.'), message: i.message })) });
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createGateway({
  apiKey,
  webhookSecret,
  webhookUrl,
  publicUrl,                                   // where the payer's browser reaches us, for checkoutUrl
  retryDelaysMs = [2_000, 10_000, 30_000, 60_000],
  processingMs = 15_000,                       // "bank is slow": processing -> succeeded after this
  webhookTimeoutMs = 5_000,
  chaos = {},
  log = console.log,
  random = Math.random,                        // tests can make chaos deterministic
}) {
  if (!apiKey || !webhookSecret || !webhookUrl || !publicUrl) {
    throw new Error('createGateway needs apiKey, webhookSecret, webhookUrl and publicUrl');
  }

  const intents = new Map();      // id -> intent
  const refunds = new Map();      // id -> refund
  const byKey = new Map();        // '<endpoint> <idempotency key>' -> { hash, id }
  const deliveries = [];          // webhook attempt log, newest last, capped at 500
  const timers = new Set();
  let settings = { ...DEFAULT_CHAOS, ...chaos };
  let stopped = false;

  const roll = (p) => p > 0 && random() < p;
  const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
  const later = (ms, fn) => {
    if (stopped) return;
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const view = (o) => ({ ...o }); // a copy: callers can never mutate our state

  // ---- webhooks ----

  function record(event, attempt, result) {
    deliveries.push({ at: new Date().toISOString(), eventId: event.id, type: event.type, objectId: event.data.id, attempt, result });
    if (deliveries.length > 500) deliveries.shift();
  }

  async function deliver(event, attempt) {
    if (stopped) return;
    const body = JSON.stringify(event); // same bytes every attempt; fresh timestamp in the signature
    let result;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'FakePay-Signature': sign(webhookSecret, body) },
        body,
        signal: AbortSignal.timeout(webhookTimeoutMs),
      });
      result = res.status;
    } catch (err) {
      result = err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code || err.message);
    }
    const ok = typeof result === 'number' && result >= 200 && result < 300;
    record(event, attempt, ok ? result : `${result}${attempt <= retryDelaysMs.length ? ', will retry' : ', giving up'}`);
    if (!ok && attempt <= retryDelaysMs.length) later(retryDelaysMs[attempt - 1], () => deliver(event, attempt + 1));
  }

  function emit(type, object) {
    const event = { id: newId('evt'), type, createdAt: new Date().toISOString(), data: view(object) };
    if (roll(settings.dropWebhook)) return record(event, 0, 'dropped (chaos)');
    const copies = roll(settings.duplicateWebhook) ? 2 : 1;
    for (let c = 0; c < copies; c++) later(settings.webhookDelayMs, () => deliver(event, 1));
  }

  // The only place an intent's status changes. Final states never change again.
  function settle(intent, outcome) {
    if (FINAL.has(intent.status)) return false;
    if (outcome === 'processing') {
      if (intent.status !== 'requires_payment') return false;
      intent.status = 'processing';
      later(processingMs, () => settle(intent, 'succeeded'));
    } else {
      intent.status = outcome;
      if (outcome === 'failed') intent.failureReason = 'card_declined';
      if (outcome === 'canceled') intent.failureReason = 'canceled_by_merchant';
    }
    intent.updatedAt = new Date().toISOString();
    log(`[fakepay] ${intent.id} (${intent.reference}) -> ${intent.status}`);
    emit(`payment_intent.${intent.status}`, intent);
    return true;
  }

  // ---- HTTP ----

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const requireApiKey = (req, res, next) => {
    const got = Buffer.from(req.get('authorization') ?? '');
    const want = Buffer.from(`Bearer ${apiKey}`);
    // timingSafeEqual: comparing byte by byte must not leak how many bytes matched
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    next();
  };

  // The shared shape of every "create" endpoint: key check, chaos, replay-or-create.
  // Between looking the key up and saving it there is NO await, so two requests with the
  // same key can't both create (Node runs one piece of synchronous code at a time).
  // make(body) returns { object } or { code, error, extra? }.
  function idempotentCreate(endpoint, schema, hashOf, make, find) {
    return async (req, res) => {
      const key = IdempotencyKey.safeParse(req.get('idempotency-key'));
      if (!key.success) {
        return res.status(400).json({ errors: [{ field: 'Idempotency-Key', message: 'header required: 8-255 letters, digits, - or _' }] });
      }
      const body = schema.safeParse(req.body ?? {});
      if (!body.success) return badInput(res, body.error.issues);

      if (settings.slowMs) await sleep(settings.slowMs);
      if (roll(settings.failCreate)) return res.status(500).json({ error: 'gateway_unavailable (chaos)' });

      const slot = `${endpoint} ${key.data}`;
      const hash = hashOf(body.data);
      const seen = byKey.get(slot);
      if (seen) {
        if (seen.hash !== hash) return res.status(422).json({ error: 'Idempotency-Key was already used with a different request' });
        return res.status(200).set('Idempotent-Replayed', 'true').json(view(find(seen.id)));
      }
      const made = make(body.data);
      if (made.error) return res.status(made.code).json({ error: made.error });
      byKey.set(slot, { hash, id: made.object.id });

      if (roll(settings.dropResponse)) {
        log(`[fakepay] chaos: created ${made.object.id} but dropping the response`);
        return req.socket.destroy();
      }
      res.status(201).json(view(made.object));
    };
  }

  app.post('/payment_intents', requireApiKey, idempotentCreate(
    'intent',
    IntentBody,
    (b) => JSON.stringify([b.amountPaise, b.currency, b.reference, b.returnUrl ?? null]),
    (b) => {
      const now = new Date().toISOString();
      const id = newId('pi');
      const intent = {
        id,
        status: 'requires_payment',
        amountPaise: b.amountPaise,
        amountRefundedPaise: 0,
        currency: b.currency,
        reference: b.reference,
        returnUrl: b.returnUrl ?? null,
        checkoutUrl: `${publicUrl}/checkout/${id}`,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      intents.set(id, intent);
      log(`[fakepay] created ${id} for ${intent.reference}, ${intent.amountPaise} paise`);
      return { object: intent };
    },
    (id) => intents.get(id),
  ));

  app.get('/payment_intents', requireApiKey, (req, res) => {
    const ref = typeof req.query.reference === 'string' ? req.query.reference : null;
    if (!ref) return res.status(400).json({ errors: [{ field: 'reference', message: 'required' }] });
    const data = [...intents.values()].filter((i) => i.reference === ref).map(view);
    res.json({ data });
  });

  app.get('/payment_intents/:id', requireApiKey, (req, res) => {
    const intent = intents.get(req.params.id);
    if (!intent) return res.status(404).json({ error: 'No such payment intent' });
    res.json(view(intent));
  });

  // The merchant gives up on a payment the payer never finished. Only possible while
  // nothing has happened yet; otherwise the 409 says what DID happen.
  app.post('/payment_intents/:id/cancel', requireApiKey, (req, res) => {
    const intent = intents.get(req.params.id);
    if (!intent) return res.status(404).json({ error: 'No such payment intent' });
    if (intent.status === 'canceled') return res.json(view(intent));
    if (intent.status !== 'requires_payment') {
      return res.status(409).json({ error: `Cannot cancel: payment is ${intent.status}`, intent: view(intent) });
    }
    settle(intent, 'canceled');
    res.json(view(intent));
  });

  app.post('/refunds', requireApiKey, idempotentCreate(
    'refund',
    RefundBody,
    (b) => JSON.stringify([b.paymentIntentId, b.amountPaise, b.reference]),
    (b) => {
      const intent = intents.get(b.paymentIntentId);
      if (!intent) return { code: 404, error: 'No such payment intent' };
      if (intent.status !== 'succeeded') return { code: 409, error: `Cannot refund a payment that is ${intent.status}` };
      if (intent.amountRefundedPaise + b.amountPaise > intent.amountPaise) {
        return { code: 409, error: 'Refund is more than what is left of the payment' };
      }
      const refund = {
        id: newId('re'),
        status: 'succeeded',
        paymentIntentId: intent.id,
        amountPaise: b.amountPaise,
        reference: b.reference,
        createdAt: new Date().toISOString(),
      };
      refunds.set(refund.id, refund);
      intent.amountRefundedPaise += b.amountPaise;
      intent.updatedAt = refund.createdAt;
      log(`[fakepay] refund ${refund.id}: ${refund.amountPaise} paise of ${intent.id}`);
      emit('refund.succeeded', refund);
      return { object: refund };
    },
    (id) => refunds.get(id),
  ));

  app.get('/refunds/:id', requireApiKey, (req, res) => {
    const refund = refunds.get(req.params.id);
    if (!refund) return res.status(404).json({ error: 'No such refund' });
    res.json(view(refund));
  });

  // ---- the payer's side: a page on the GATEWAY's site, not ours ----

  app.get('/checkout/:id', (req, res) => {
    const intent = intents.get(req.params.id);
    if (!intent) return res.status(404).type('html').send(page('Payment not found', '<p>This payment link is not valid.</p>'));
    const amount = (intent.amountPaise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
    const body = intent.status === 'requires_payment'
      ? `<p class="amount">${escapeHtml(amount)}</p>
         <p class="muted">to StayEasy · ${escapeHtml(intent.reference)}</p>
         <form method="post">
           <button name="outcome" value="succeeded" class="pay">Pay ${escapeHtml(amount)}</button>
           <button name="outcome" value="failed">Decline (card declined)</button>
           <button name="outcome" value="processing">Bank is slow (processing, succeeds in ${Math.round(processingMs / 1000)}s)</button>
         </form>`
      : `<p class="amount">${escapeHtml(amount)}</p><p>Status: <strong>${escapeHtml(intent.status)}</strong></p>${backLink(intent)}`;
    res.type('html').send(page('FakePay checkout', body));
  });

  app.post('/checkout/:id', (req, res) => {
    const intent = intents.get(req.params.id);
    if (!intent) return res.status(404).type('html').send(page('Payment not found', '<p>This payment link is not valid.</p>'));
    const outcome = req.body?.outcome;
    if (!OUTCOMES.includes(outcome)) return res.status(400).json({ errors: [{ field: 'outcome', message: `one of ${OUTCOMES.join(', ')}` }] });
    settle(intent, outcome); // a click on a final intent changes nothing
    if (!intent.returnUrl) return res.redirect(303, `/checkout/${intent.id}`);
    const back = new URL(intent.returnUrl);
    back.searchParams.set('intent', intent.id);
    res.redirect(303, back.toString());
  });

  // ---- test / demo controls ----

  app.get('/_chaos', requireApiKey, (req, res) => res.json(settings));
  app.post('/_chaos', requireApiKey, (req, res) => {
    const body = ChaosBody.safeParse(req.body ?? {});
    if (!body.success) return badInput(res, body.error.issues);
    settings = { ...settings, ...body.data };
    log('[fakepay] chaos now', settings);
    res.json(settings);
  });
  app.get('/_deliveries', requireApiKey, (req, res) => res.json({ data: deliveries }));

  app.use((err, req, res, next) => {
    if (err.expose && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(`[fakepay] ${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: 'Internal gateway error' });
  });

  function stop() {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  return { app, stop };
}

function backLink(intent) {
  if (!intent.returnUrl) return '';
  const back = new URL(intent.returnUrl);
  back.searchParams.set('intent', intent.id);
  return `<p><a href="${escapeHtml(back.toString())}">Back to StayEasy</a></p>`;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f3f1ff;margin:0;display:grid;place-items:center;min-height:100vh}
  main{background:#fff;border-radius:12px;padding:24px;max-width:360px;width:calc(100% - 32px);box-shadow:0 4px 20px #0001}
  h1{font-size:1rem;color:#5b3fd1;margin:0 0 12px}.amount{font-size:2rem;font-weight:700;margin:0}.muted{color:#666}
  button{display:block;width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}
  button.pay{background:#5b3fd1;color:#fff;border:0;font-weight:600}
</style></head><body><main><h1>FakePay · test mode</h1>${body}</main></body></html>`;
}

module.exports = { createGateway, sign, DEFAULT_CHAOS };
