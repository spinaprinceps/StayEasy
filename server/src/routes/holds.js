// POST /holds      (login)  header Idempotency-Key, body { roomTypeId, checkIn, checkOut, guests, ratePlan }
//                  -> 201 hold | 400 bad input | 404 no such room type | 409 no room | 422 key reused
// GET  /holds/:id  (login)  -> 200 hold (your own only) | 404
// POST /holds/:id/pay (login) -> 200 { paymentId, checkoutUrl } (see below)
const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { requireAuth } = require('../auth');
const { parseStayQuery } = require('../search/validate');
const { createHold, findHoldById, toHoldView } = require('../holds/createHold');
const { startPayment } = require('../payments/startPayment');

const router = express.Router();
router.use(requireAuth); // every hold route needs a logged-in traveller

const Id = z.coerce.number().int().min(1).max(2147483647);
const HoldExtras = z.object({
  roomTypeId: Id,
  ratePlan: z.enum(['flexible', 'non_refundable']),
});
// Long enough to be random (a UUID is 36), short enough not to be abused as storage.
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);

router.post('/', async (req, res) => {
  const key = IdempotencyKey.safeParse(req.get('idempotency-key'));
  if (!key.success) {
    return res.status(400).json({
      errors: [{ field: 'Idempotency-Key', message: 'header required: 8-100 letters, digits, - or _ (a UUID is ideal)' }],
    });
  }

  const body = req.body ?? {};
  const stay = parseStayQuery(body);     // same date/guest rules as search and hotel details
  const extras = HoldExtras.safeParse(body);
  const errors = [
    ...stay.errors,
    ...(extras.success ? [] : extras.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))),
  ];
  if (errors.length) return res.status(400).json({ errors });

  const out = await createHold(pool, {
    userId: req.userId,
    key: key.data,
    req: { ...stay.stay, ...extras.data },
  });
  res.status(out.status).set(out.headers).json(out.body);
});

// POST /holds/:id/pay -> 200 { paymentId, checkoutUrl } | 404 | 409 expired/already paid | 503 gateway down
// No Idempotency-Key needed: the hold itself is the scope. While a payment is open, every
// click gets the same checkout page back (see payments/startPayment.js).
router.post('/:id/pay', async (req, res) => {
  const id = Id.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: 'Hold not found' });
  const out = await startPayment(pool, { userId: req.userId, holdId: id.data });
  res.status(out.status).json(out.body);
});

router.get('/:id', async (req, res) => {
  const id = Id.safeParse(req.params.id);
  const row = id.success ? await findHoldById(pool, req.userId, id.data) : null;
  if (!row) return res.status(404).json({ error: 'Hold not found' });
  res.json(toHoldView(row));
});

module.exports = router;
