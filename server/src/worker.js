// Background process, separate from the API:  npm run worker
// Two jobs on one loop:
//   - expireHolds() every TICK_MS          (feature 5: give back rooms of unpaid holds)
//   - reconcile()  every RECONCILE_MS      (feature 7/9: ask the gateway about stuck payments, resend refunds)
//
// Decisions:
//   - setTimeout loop, not setInterval: the next tick is scheduled only AFTER this one finishes,
//     so a slow tick (big backlog, slow DB, slow gateway) can never overlap the next one.
//   - A job throws (DB restarting, gateway down): log it and try again next tick. Crashing
//     would just mean a restart loop; nothing is half-done because each step is one transaction.
//   - Expiry batch came back full: there is probably more, so go again straight away.
//   - SIGTERM/SIGINT: stop scheduling, let the CURRENT tick finish, close the pool, exit.

const { expireHolds } = require('./holds/expireHolds');
const { reconcile } = require('./payments/reconcile');
const pool = require('./db/pool');

const TICK_MS = 5000;
const RECONCILE_MS = 30000;
const BATCH = 100;

let stopping = false;
let wakeUp = () => {};
let lastReconcile = 0;

// A sleep that shutdown can cut short.
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeUp = () => { clearTimeout(t); resolve(); };
  });
}

const stamp = () => new Date().toISOString();

async function run() {
  console.log(`Worker started: expiry every ${TICK_MS / 1000}s, reconcile every ${RECONCILE_MS / 1000}s`);
  while (!stopping) {
    let expired = 0;
    try {
      expired = await expireHolds(pool, { limit: BATCH });
      if (expired > 0) console.log(`${stamp()} expired ${expired} hold(s)`);
    } catch (err) {
      console.error(`${stamp()} expireHolds failed:`, err.message);
    }

    if (Date.now() - lastReconcile >= RECONCILE_MS) {
      lastReconcile = Date.now();
      try {
        const s = await reconcile(pool);
        if (s.checked || s.refundsSent || s.errors) console.log(`${stamp()} reconcile`, s);
      } catch (err) {
        console.error(`${stamp()} reconcile failed:`, err.message);
      }
    }

    if (expired < BATCH && !stopping) await sleep(TICK_MS);
  }
  await pool.end();
  console.log('Worker stopped');
}

function shutdown(signal) {
  if (stopping) return;
  console.log(`${signal} received, finishing the current tick`);
  stopping = true;
  wakeUp();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

run();
