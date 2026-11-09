# Rough numbers

Measured on a laptop (Postgres 16 in Docker) on 2026-11-09, unless marked *estimate*.

## Data size (seeded)
| Thing | Count |
|---|---|
| Cities | 6 |
| Hotels | 1,500 |
| Room types | 4,496 |
| Physical rooms (sum of `total_rooms`) | 27,884 |
| `room_nights` rows (one per room type per night, 365 nights) | 1,641,040 |
| `room_nights` size, with indexes | 117 MB |
| Whole database | 128 MB |

**Rule of thumb:** each extra year of inventory adds ~1.6M rows and ~115 MB. That's fine for one Postgres for years.

## Speed (from the test runs)
| Scenario | Result |
|---|---|
| 50 people reserve the last room at once | 1 hold, 49 × 409, never below 0, **~0.5s for all 50** |
| 30 overlapping stays (1–3 nights) on 20 rooms | exactly 20 succeed, no deadlocks, ~0.2s |
| Full flow: reserve → pay → webhook → booking | ~0.1–0.3s locally (the webhook is the slow part) |
| Expiry: 20 holds, 4 workers at once | each hold expired exactly once, ~0.13s |

## Capacity (*estimates*, with reasoning)
- **Reserve is limited by the rows being fought over, not by the total load.** A reserve transaction holds its night-row locks for about 2–5 ms, so **one room type on one night** can take roughly **200–500 reserves/s**. Different room types or nights don't block each other.
- **The database connection pool is 10 per API process.** With transactions of ~5–10 ms, that's about **1,000–2,000 simple writes/s per API process**. Search reads run alongside.
- **Search** runs one indexed query per page (`hotels.city_id`, then `room_nights` by primary key range), so it's typically tens of ms. At a 50 ms p95 (95% of searches finish within it) and 10 connections, that's about **~200 searches/s per API process**. *Next step if needed:* cache search results for a few seconds per city and date range.
- **Holds** expire within ~5s of their time (the worker tick). One tick handles 100 holds in one short transaction, and runs again at once while backlog remains.
- **Payments:** gateway calls have a 4s timeout and up to 3 tries, so the worst case for a Pay click is ~13s and then "try again", with the room still held.
- **The reconciler** looks at stuck payments every 30s, after 60s without news. An abandoned checkout is cancelled after 15 min, so the worst-case room lock-up is ~10 min (hold) + 15 min (paying) ≈ **25 min**.

## Webhook retry schedule (FakePay)
Attempts: immediately, then after 2s, 10s, 30s and 60s, then it gives up. That's ~1m42s of retries. If all of them fail, the reconciler still catches the payment within 60–90s.
