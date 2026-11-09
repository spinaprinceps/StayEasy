// Background process, separate from the API:  npm run worker
// Runs expireHolds() every few seconds. (The payment reconciler joins it in feature 7.)
//
// Decisions:
//   - setTimeout loop, not setInterval: the next tick is scheduled only AFTER this one finishes,
//     so a slow tick (big backlog, slow DB) can never overlap the next one.
//   - A tick throws (DB restarting, network blip): log it and try again next tick. Crashing
//     would just mean a restart loop; nothing is half-done because each tick is one transaction.
//   - Batch came back full: there is probably more, so go again straight away instead of sleeping.
//   - SIGTERM/SIGINT: stop scheduling, let the CURRENT tick finish (or it rolls back anyway),
//     close the pool, exit. Ctrl-C mid-tick never leaves a hold expired without its rooms.

const { expireHolds } = require('./holds/expireHolds');
const pool = require('./db/pool');

const TICK_MS = 5000;
const BATCH = 100;

let stopping = false;
let wakeUp = () => {};

// A sleep that shutdown can cut short.
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeUp = () => { clearTimeout(t); resolve(); };
  });
}

async function run() {
  console.log(`Worker started: expiring holds every ${TICK_MS / 1000}s, ${BATCH} per batch`);
  while (!stopping) {
    let expired = 0;
    try {
      expired = await expireHolds(pool, { limit: BATCH });
      if (expired > 0) console.log(`${new Date().toISOString()} expired ${expired} hold(s)`);
    } catch (err) {
      console.error(`${new Date().toISOString()} expireHolds failed:`, err.message);
    }
    if (expired < BATCH) await sleep(TICK_MS);
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
