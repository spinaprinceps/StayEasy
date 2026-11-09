# Decision log

Each entry: what we chose, what we rejected, and why. Newest last.

## Data and money
1. **Money is whole paise in `bigint`, and all arithmetic is in `server/src/pricing.js`.** *Rejected:* floats or `numeric` in JS. `0.1 + 0.2 ≠ 0.3`, and a second place doing maths eventually disagrees by a paisa. The browser only formats numbers.
2. **Tax is per night, 5% at or below ₹7,500 and 18% above, rounded half up with integers (`(x*pct + 50) / 100`).** The non-refundable rate is 88% of each night, and its tax band is decided on that lower price.
3. **The price is frozen on the hold (`price_breakdown` jsonb) and copied to the booking.** Pay charges that number and refunds are worked out from it. *Rejected:* re-quoting at pay or cancel time, because the price could change between Reserve and Pay.
4. **Dates are plain `'YYYY-MM-DD'` strings end to end.** *Rejected:* JS `Date` for calendar dates, which shifts them by the viewer's time zone (an off-by-one-day bug).

## Inventory under concurrency
5. **One row per room type per night with `available_count`.** Reserve takes 1 from every night in one transaction. *Rejected:* counting bookings at query time, which is slow and still racy without locks.
6. **The check and the take are one statement: `UPDATE … SET available_count = available_count - 1 WHERE … AND available_count > 0`.** If the number of rows changed ≠ the number of nights, everything rolls back. *Rejected:* `SELECT` then `UPDATE`, because two requests both see "1 left".
7. **Night rows are locked in date order** (`ORDER BY night FOR UPDATE`). Every writer, including room release, locks in (room type, night) order, so there are no deadlock cycles.
8. **Reserve is idempotent with an `Idempotency-Key` header.** `UNIQUE(user_id, key)` plus an advisory lock means a double click gets the same hold back. *Rejected:* "disable the button", which doesn't stop network retries.

## Hold, then pay
9. **A hold lasts 10 minutes, measured on the database clock** (`now()`), never on a server's or browser's clock.
10. **The expiry worker is a separate process with a `setTimeout` loop**, using `FOR UPDATE SKIP LOCKED` batches of 100. *Rejected:* running it inside the API (every API copy would run it, and deploys would kill it mid-batch), `setInterval` (runs can overlap) and `pg_cron` (an extra extension, harder to test).
11. **A hold becomes `payment_pending` the moment Pay is pressed, before the gateway answers.** The expiry worker skips it, so a guest paying at 9:59 doesn't lose the room at 10:00. Leaving `payment_pending` is up to the webhook or the reconciler.

## Calling the payment gateway
12. **The gateway is a separate process (FakePay) with chaos switches.** *Rejected:* a real gateway's test mode (needs internet and a public webhook URL, and can't fail on demand) and a mock inside the API (too easy to share code or the database).
13. **The request key (`payments.gateway_key`) is saved before the call. The call happens outside any transaction, and retries reuse the same key.** A lost response therefore can't create a second charge, and a slow gateway never holds database locks.
14. **The webhook is verified with HMAC-SHA256 over the raw body and a timestamp, and rejected if it's older than 5 minutes.** The route is mounted before `express.json()` so the bytes are untouched. A constant-time compare is used.
15. **A webhook inbox (`webhook_events.event_id PRIMARY KEY`) is written in the same transaction as the event's effect.** Duplicates do nothing. A failed effect isn't marked as seen, so the gateway's retry gets a clean second chance.
16. **One function, `applyIntent()`, decides what a gateway status means.** The webhook and the reconciler both call it, so they can't disagree.
17. **The reconciler asks the gateway about any payment that hasn't changed for 60s.** If the payer is gone after 15 minutes, it **cancels** the intent. Cancelling returns the final state, which may be "succeeded", so it never cancels a payment that went through.
18. **Money that arrives for a hold we let go is refunded automatically** (`late_payment`). *Rejected:* keeping it and booking anyway, because the room may already be sold to someone else.

## Cancel and refund
19. **The deadline is 14:00 hotel time on the check-in date minus 48h, worked out once in SQL** (`(check_in + time '14:00') AT TIME ZONE tz - interval '48 hours'`) **and stored as `timestamptz` on the booking.** "Before the deadline" uses the database clock.
20. **Refund rules:** flexible before the deadline gets everything back; flexible after the deadline gets everything except the first night and its tax; non-refundable gets ₹0. No cancelling after check-in time.
21. **The refund is queued in the cancel transaction and sent after commit,** with a key derived from the payment (`refund-payment-<id>`). A gateway outage leaves it `pending`, and the reconciler resends it with the same key, so the refund happens exactly once.

## Front end
22. **The browser never decides money or time:** totals, refunds, "seconds left" and "before the deadline" all come from the server.
23. **The token is stored in `localStorage`** (stated trade-off: script on the page can read it). *Rejected for now:* an httpOnly cookie, which needs CSRF protection.
24. **Returning from the gateway is not proof of payment.** The hold page checks with the server every 2s until the webhook (or the reconciler) has made the booking.
