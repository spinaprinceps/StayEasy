-- Feature 7-9: payments, bookings, refunds, and the webhook inbox.
--
-- The inventory rule grows one term:
--   available_count + (active/payment_pending holds) + (confirmed bookings) == rooms that exist
-- Paying MOVES a room from a hold to a booking (available_count unchanged).
-- Expiring a hold or cancelling a booking gives the room back.

-- One row per attempt to pay for a hold. A failed card -> a new attempt (new row).
CREATE TABLE payments (
  id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hold_id         int NOT NULL REFERENCES holds(id),
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),  -- copied from the hold's frozen total
  gateway_key     text NOT NULL UNIQUE,   -- the Idempotency-Key WE send to the gateway, saved BEFORE the call
  intent_id       text UNIQUE,            -- the gateway's id ('pi_...'); NULL until the gateway answers
  checkout_url    text,
  status          text NOT NULL DEFAULT 'creating'
                  CHECK (status IN ('creating', 'pending', 'succeeded', 'failed')),
  --   creating  = saved, gateway not (yet) answered: "did it go through?"
  --   pending   = the gateway has an intent; waiting for the payer
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- At most ONE unfinished attempt per hold: the database refuses a second, whatever the code does.
CREATE UNIQUE INDEX payments_one_open_per_hold ON payments (hold_id) WHERE status IN ('creating', 'pending');
-- The reconciler asks "which unfinished payments haven't moved for a while?"
CREATE INDEX payments_open_idx ON payments (updated_at) WHERE status IN ('creating', 'pending');

-- A paid hold becomes a booking. Everything is COPIED from the hold, so later changes
-- to prices or room types never touch what the guest paid for.
CREATE TABLE bookings (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hold_id          int NOT NULL UNIQUE REFERENCES holds(id),     -- UNIQUE: one hold can never make two bookings
  payment_id       int NOT NULL UNIQUE REFERENCES payments(id),
  user_id          int NOT NULL REFERENCES users(id),
  room_type_id     int NOT NULL REFERENCES room_types(id),
  check_in         date NOT NULL,
  check_out        date NOT NULL,
  guests           smallint NOT NULL,
  rate_plan        text NOT NULL CHECK (rate_plan IN ('flexible', 'non_refundable')),
  price_breakdown  jsonb NOT NULL,     -- the frozen quote, refunds are worked out from THIS
  total_paise      bigint NOT NULL CHECK (total_paise > 0),
  cancel_deadline  timestamptz NOT NULL,  -- 14:00 hotel time on check-in day, minus 48h; fixed at booking time
  status           text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  refund_paise     bigint CHECK (refund_paise >= 0),
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX bookings_user_idx ON bookings (user_id, check_in);

-- Money going back. One per payment at most: a full-booking cancel, or a payment that
-- arrived after its hold was gone ('late_payment').
CREATE TABLE refunds (
  id                 int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id         int NOT NULL UNIQUE REFERENCES payments(id),
  booking_id         int UNIQUE REFERENCES bookings(id),           -- NULL for a late_payment refund
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  reason             text NOT NULL CHECK (reason IN ('cancelled', 'late_payment')),
  gateway_key        text NOT NULL UNIQUE,   -- Idempotency-Key for the gateway: retries can't refund twice
  gateway_refund_id  text UNIQUE,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_pending_idx ON refunds (updated_at) WHERE status = 'pending';

-- Every webhook event we have accepted. The PRIMARY KEY on the gateway's event id is the
-- duplicate check: the same event delivered twice inserts once.
CREATE TABLE webhook_events (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  outcome      text,
  received_at  timestamptz NOT NULL DEFAULT now()
);
