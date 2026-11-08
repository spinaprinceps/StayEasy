# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How to work in this repo

StayEasy is a hotel-booking system built as hackathon practice. The user's goal is to learn system-design thinking, good coding practice, and how things fail. **Workflow: Claude gives the complete code for each file in chat, and the user pastes it and runs the commands.** Don't create or edit project files directly. Test the code in the scratchpad first, so what the user pastes already works. Work one step at a time. For each step, give: what we're building and why; the full file contents with their paths; the exact commands and the expected output; what else could have been done, with the trade-off; what can fail and how the code guards against it; and one or two short check questions. When a term comes up for the first time (e.g. "worker", "idempotency"), explain it in plain words.

HLD diagrams (Eraser): https://app.eraser.io/workspace/IlcxeGxPZfFIFK3Hqd5O

## Commands

Postgres runs in Docker. Scripts run from the laptop read the root `.env` (via `node --env-file=../.env`), which points `PG*` at `localhost`. Inside Docker, `docker-compose.yml` sets `PGHOST=postgres`.

```sh
docker compose up -d postgres      # database only
docker compose up --build          # database + API server (port 3000)

cd server
npm run migrate                    # apply new db/migrations/*.sql files, in name order
npm run gen                        # write synthetic CSVs to db/seed/data/medium (1,500 hotels)
npm run gen -- --tier=large        # small=200 | medium=1500 | large=20000; also --hotels=N --days=N --start=YYYY-MM-DD
npm run seed                       # load hotels + room types + 365 nights (safe to re-run)
npm run dev                        # API with nodemon on the host
node --env-file=../.env src/worker.js   # background worker (no npm script yet)

cd client
npm run dev                        # Vite dev server
npm run lint                       # oxlint
npm run build
```

There is no test runner set up yet. `GET /health` checks that the API can reach the database.

## Architecture

There are three processes and one database: the **API** (`server/src/index.js` → `app.js`, Express 5), the **worker** (`server/src/worker.js`, which runs background jobs on a timer), and the **React client** (`client/`, Vite). They all share **one PostgreSQL** database. The payment gateway is simulated. The API and the worker share `server/src/db/pool.js`, which reads its connection settings from the `PG*` environment variables. Both handle SIGTERM by finishing in-flight work and then closing the pool.

**Migrations** (`server/db/migrate.js`): plain SQL files with numbered names (`NNN_name.sql`). Each one runs once, inside its own transaction, and is recorded in `schema_migrations`. To change the schema, add a new file. Never edit a migration that has already been applied.

**Inventory model:** `cities → hotels → room_types → room_nights`. `room_nights` has one row per room type per night, holding the price and `available_count`, with primary key `(room_type_id, night)`. Search reads this table. Reserve locks these rows and decrements them. `CHECK (available_count >= 0)` is the last guard against overbooking.

**Synthetic data** is a two-stage pipeline. Stage 1: `server/db/seed/synthetic.js` holds pure, deterministic generators (`generateHotels`, `generateRoomTypes`, `generateNight`), and `generate-data.js` (`npm run gen`) writes one CSV per table into `db/seed/data/<tier>/`, with stable integer ids (hotel `i+1`, room type `hotel_id*10 + catalog index`). Stage 2: `load-csv.js` (`npm run seed [tier]`) loads those CSVs in one transaction. For each table, in foreign-key order, it `COPY`s the CSV into a temp staging table, then runs `INSERT … SELECT … ON CONFLICT` into the real table, then `setval`s the identity counter. `load-hotels.js` is the old Kaggle loader and is no longer used. All randomness is seeded: `hashInt` plus `seededRandom` (mulberry32), so every run produces the same data. `(name, address)` is the natural key used for upserts. A re-run updates hotels and room types in place and inserts missing nights with `ON CONFLICT DO NOTHING`. It never changes `total_rooms` or existing nights, because those would corrupt availability and bookings.

## Invariants from the design brief

These hold across features that are not built yet, so keep them in mind for new code:

- **Money:** whole paise in `bigint`. Never use floats. Tax is worked out per night on the price actually charged: 5% if the night is ≤ ₹7,500 (750000 paise), 18% above that, rounded half up to the paisa. A stay's total is the sum of its nights. The non-refundable rate is 88% of the normal price, and its tax band is decided on that lower price.
- **Time:** stored in UTC and shown in the hotel's local time (`cities.timezone`).
- **Reserve:** one transaction that locks the stay's nights **in date order** (so concurrent bookings can't deadlock), checks that every night has a room, takes one room off each night, and creates a 10-minute hold that stores the full price breakdown. A traveller can have at most 3 active holds.
- **Pay/Cancel:** commit a "pending" state first, then call the gateway with **no transaction open** (20-second timeout), then finish in a new transaction. The cancel deadline is 14:00 hotel time on the check-in day minus 48 hours, saved on the booking when it's created.
- **Idempotency:** Reserve and Pay take an `Idempotency-Key` that is unique per traveller and stored with a hash of the request. The same key with the same request returns the original result. The same key with a different request returns 422. The key is passed on to the gateway.
- **Worker:** the reaper (every 30 s) expires holds and puts their nights back on sale in the same transaction. The reconciler (every 60 s) re-sends charges or refunds that have been pending more than 2 minutes, and raises an alert after 15 minutes.
- **Out of scope for v1:** more than one room per booking, changing a booking's dates, a real payment gateway, admin screens, emails, refresh tokens, a read-only database copy.
