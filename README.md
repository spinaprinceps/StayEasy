# StayEasy

A hotel booking system built to get the hard parts right: two people racing for the last room, holding a room while the guest pays, calling an outside payment company safely, money rules, and time zones.

**Stack:** Node 24 + Express 5 · React 19 + Vite · Postgres 16 (Docker) · zod · no ORM, plain SQL.

## What it does

1. **Search** a city for dates and guests. Prices include tax and are shown per night.
2. **Hotel page:** every room type is either available or shows why it isn't (too small, not on sale, sold out on at least one night).
3. **Reserve** puts a 10-minute hold on the room at a frozen price.
4. **Pay** on the payment company's page. A signed webhook turns the hold into a booking.
5. **My bookings** lists your bookings. **Cancel** before the deadline (14:00 hotel time, 48 hours before check-in) for a full refund.

## The five hard problems, and where they're solved

| Problem | How | Code |
|---|---|---|
| **Last room, many buyers** | One `UPDATE … WHERE available_count > 0` per night, nights locked in date order, all nights or none | [server/src/holds/createHold.js](server/src/holds/createHold.js) |
| **Hold, then pay** | 10-minute hold measured on the database clock. A worker returns expired holds with `FOR UPDATE SKIP LOCKED` | [server/src/holds/expireHolds.js](server/src/holds/expireHolds.js) |
| **Calling the payment company safely** | Request key saved before the call, retries with the same key, HMAC-signed webhooks, a deduplicating inbox, and a reconciler that asks the gateway directly | [server/src/payments/](server/src/payments/) |
| **Money** | Whole paise as integers only, tax per night (5% / 18% around ₹7,500), round half up, frozen price, refunds from the frozen price | [server/src/pricing.js](server/src/pricing.js) |
| **Time** | Timestamps stored in UTC, "today" judged in the hotel's time zone, cancel deadline worked out in SQL with `AT TIME ZONE` | [server/src/bookings/bookings.js](server/src/bookings/bookings.js) |

The reasoning behind each choice, and the alternatives rejected, is in [docs/DECISIONS.md](docs/DECISIONS.md).

## Running it locally

**You need:** Node 24, Docker Desktop.

### 1. Create `.env` in the repo root
```ini
POSTGRES_USER=stayeasy
POSTGRES_PASSWORD=change-me
POSTGRES_DB=stayeasy

PGHOST=localhost
PGPORT=5432
PGUSER=stayeasy
PGPASSWORD=change-me
PGDATABASE=stayeasy

# 32+ random characters
JWT_SECRET=replace-with-a-long-random-string-at-least-32-chars

# Shared by the API and FakePay (16+ characters each)
FAKEPAY_API_KEY=replace-with-a-random-string
FAKEPAY_WEBHOOK_SECRET=replace-with-another-random-string
```
To make a random value: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

### 2. Database and data (once)
```powershell
docker compose up -d postgres
cd server
npm install
npm run migrate      # creates the tables
npm run gen          # generates synthetic hotels and a year of inventory (CSV)
npm run seed         # loads it: 1,500 hotels, ~1.6M room-nights
cd ..\client
npm install
```

### 3. Start everything (four terminals)
| Terminal | Command | Port |
|---|---|---|
| API | `cd server; npm run dev` | 3000 |
| FakePay (pretend payment company) | `cd server; npm run fakepay` | 4000 |
| Worker (hold expiry + reconciler) | `cd server; npm run worker` | none |
| Website | `cd client; npm run dev` | **http://localhost:5173** |

Vite forwards `/api/*` to the API, so the browser only talks to one address.

## Tests
```powershell
cd server
npm test          # unit tests, no database needed (pricing, auth, FakePay, signatures)
npm run test:db   # real-database tests: concurrency, expiry, the full pay/cancel flow
```
`test:db` changes rows in your local database and puts every one of them back. The concurrency tests fire 50 reserves at the last room at once and check that exactly one wins.

## FakePay: the payment company you can break on purpose
FakePay runs as its own process and talks to StayEasy only over HTTP, like a real payment company would. It has switches that make it misbehave:

| Switch | What it simulates |
|---|---|
| `failCreate` | The gateway is down (500) |
| `dropResponse` | The charge is created but the answer is lost |
| `dropWebhook` / `duplicateWebhook` | A webhook never arrives / arrives twice |
| `slowMs`, `webhookDelayMs` | Slow responses and late events |

Set them with `POST http://localhost:4000/_chaos` (with the API key header). [docs/DEMO.md](docs/DEMO.md) walks through each one on stage.

## API at a glance
| Method | Path | Login | |
|---|---|---|---|
| POST | `/auth/signup`, `/auth/login` | | JWT, 1 hour |
| GET | `/search?city&checkIn&checkOut&guests&page` | | |
| GET | `/hotels/:id?checkIn&checkOut&guests` | | status per room type |
| POST | `/holds` | ✓ | needs an `Idempotency-Key` header |
| GET | `/holds/:id` | ✓ | |
| POST | `/holds/:id/pay` | ✓ | returns `checkoutUrl` |
| POST | `/payments/webhook` | signature | called by FakePay |
| GET | `/bookings`, `/bookings/:id` | ✓ | |
| POST | `/bookings/:id/cancel` | ✓ | repeating it returns the same result |

Errors: `400 { errors: [{ field, message }] }` for bad input, `{ error }` for everything else.

## Project layout
```
server/
  db/migrations/      SQL, run in name order (never rename one that has run)
  db/seed/            synthetic data generator + loader
  src/
    routes/           HTTP layer: validation and status codes
    holds/            reserve, expiry, room release
    payments/         gateway client, webhook signature, applyIntent, reconciler, refunds
    bookings/         list, detail, cancel
    fakepay/          the pretend payment company (separate process)
    pricing.js        ALL money arithmetic
    worker.js         background loop (expiry + reconciler)
  test/               unit tests (no database)
  test-db/            real-database tests
client/src/
  pages/              Search, Hotel, Hold (pay), Bookings, Booking (cancel), Login/Signup
  api.js, useApi.js   the one place the browser talks to the API
docs/
  DEMO.md             8-minute demo script
  DECISIONS.md        decision log
  NUMBERS.md          data sizes, measured timings, capacity estimates
```

## Known limits
- FakePay keeps everything in memory. Restarting it forgets all payments.
- The login token is stored in `localStorage` (simple, but readable by scripts on the page). The safer option is an httpOnly cookie plus CSRF protection.
- A room can stay locked for up to ~25 minutes when a guest abandons the payment page: 10 minutes of hold, then 15 before the reconciler cancels the payment.
- The `server` service in `docker-compose.yml` doesn't pass the `FAKEPAY_*` variables. Run the API with `npm run dev` as shown above.
