const express = require('express');
const pool = require('./db/pool');
const searchRouter = require('./routes/search');
const authRouter = require('./routes/auth');
const hotelsRouter = require('./routes/hotels');
const holdsRouter = require('./routes/holds');

const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', error: err.message });
  }
});

app.use('/search', searchRouter);
app.use('/auth', authRouter);
app.use('/hotels', hotelsRouter);
app.use('/holds', holdsRouter);

// Last stop for any error a route didn't handle (Express 5 forwards async errors here).
// Log the details for us; never send stack traces or SQL to the user.
app.use((err, req, res, next) => {
  // Errors Express itself raises about the CLIENT's request (broken JSON, body too large)
  // carry a 4xx status and expose=true. Those are the caller's fault: say so, don't log as a crash.
  if (err.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.type === 'entity.parse.failed' ? 'Request body is not valid JSON' : err.message });
  }
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
