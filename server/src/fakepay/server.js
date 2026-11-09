// Starts FakePay on its own port:  npm run fakepay
// Needs in .env:  FAKEPAY_API_KEY, FAKEPAY_WEBHOOK_SECRET   (StayEasy's API uses the same two values)
// Optional:       FAKEPAY_PORT (4000), FAKEPAY_WEBHOOK_URL (http://localhost:3000/payments/webhook)
const { createGateway } = require('./gateway');

function need(name) {
  const value = process.env[name];
  if (!value || value.length < 16) {
    console.error(`${name} must be set in .env (16+ characters)`);
    process.exit(1);
  }
  return value;
}

const port = Number(process.env.FAKEPAY_PORT) || 4000;
const webhookUrl = process.env.FAKEPAY_WEBHOOK_URL || 'http://localhost:3000/payments/webhook';

const { app, stop } = createGateway({
  apiKey: need('FAKEPAY_API_KEY'),
  webhookSecret: need('FAKEPAY_WEBHOOK_SECRET'),
  webhookUrl,
  publicUrl: `http://localhost:${port}`,
});

const server = app.listen(port, () => {
  console.log(`FakePay listening on http://localhost:${port}, webhooks -> ${webhookUrl}`);
});

function shutdown() {
  stop();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
