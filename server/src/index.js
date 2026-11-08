const app = require('./app');
const pool = require('./db/pool');

const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// Docker sends SIGTERM on `docker compose stop/down`.
// Finish in-flight requests, close DB connections, then exit.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
