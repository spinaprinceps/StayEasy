-- Holds: a room kept for one traveller for 10 minutes at a frozen price, while they pay.
-- Creating a hold takes 1 from room_nights.available_count for EVERY night of the stay
-- (same transaction). Expiring or cancelling it must give those rooms back.

CREATE TABLE holds (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          int NOT NULL REFERENCES users(id),
  idempotency_key  text NOT NULL,                 -- sent by the client; same key = same request
  request_hash     text NOT NULL,                 -- sha256 of the request body: same key + different body -> 422
  room_type_id     int NOT NULL REFERENCES room_types(id),
  check_in         date NOT NULL,
  check_out        date NOT NULL,
  guests           smallint NOT NULL CHECK (guests > 0),
  rate_plan        text NOT NULL CHECK (rate_plan IN ('flexible', 'non_refundable')),
  price_breakdown  jsonb NOT NULL,                -- the frozen quote: per-night price + tax, totals
  total_paise      bigint NOT NULL CHECK (total_paise > 0),
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'payment_pending', 'converted', 'expired')),
  expires_at       timestamptz NOT NULL,          -- set with the DATABASE clock: now() + 10 minutes
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in),
  -- The idempotency guarantee lives HERE, not in JavaScript: even two identical requests
  -- arriving at the same instant can't both insert.
  UNIQUE (user_id, idempotency_key)
);

-- The expiry worker asks "which ACTIVE holds have expired?" every few seconds.
-- A partial index holds only active rows, so it stays small however many old holds pile up.
CREATE INDEX holds_active_expires_idx ON holds (expires_at) WHERE status = 'active';

-- The payment reconciler asks "which holds have been payment_pending too long?".
CREATE INDEX holds_payment_pending_idx ON holds (updated_at) WHERE status = 'payment_pending';
