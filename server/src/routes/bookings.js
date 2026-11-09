// GET  /bookings              (login) -> 200 { data: [booking] }   your bookings only
// GET  /bookings/:id          (login) -> 200 booking | 404
// POST /bookings/:id/cancel   (login) -> 200 booking (cancelled, with refund) | 404 | 409 too late
//                                       Cancelling twice returns the same cancelled booking.
const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const { requireAuth } = require('../auth');
const { listBookings, getBooking, cancelBooking } = require('../bookings/bookings');

const router = express.Router();
router.use(requireAuth);

const Id = z.coerce.number().int().min(1).max(2147483647);

router.get('/', async (req, res) => {
  res.json({ data: await listBookings(pool, req.userId) });
});

router.get('/:id', async (req, res) => {
  const id = Id.safeParse(req.params.id);
  const booking = id.success ? await getBooking(pool, req.userId, id.data) : null;
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json(booking);
});

router.post('/:id/cancel', async (req, res) => {
  const id = Id.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: 'Booking not found' });
  const out = await cancelBooking(pool, { userId: req.userId, bookingId: id.data });
  res.status(out.status).json(out.body);
});

module.exports = router;
