'use strict';

require('./lib/loadEnv');

const { buildApp } = require('./app');
const { migrate } = require('./db');

const PORT = Number(process.env.PORT || 4000);

// Fail loudly at boot rather than at the first secret write.
try {
  require('./lib/crypto').encryptSecret('startup-check');
} catch (err) {
  console.error(`\nRefusing to start: ${err.message}\n`);
  process.exit(1);
}

migrate();

// Drains the notification outbox in the background. With no SMTP configured it
// prints each message, so verification links stay usable in development.
const mailer = require('./services/mailer');
mailer.startWorker();

const app = buildApp();
const server = app.listen(PORT, () => {
  console.log(`Nexora API listening on http://localhost:${PORT}`);
  console.log(`  mode        ${process.env.NODE_ENV || 'development'}`);
  console.log(`  cors        ${process.env.CORS_ORIGINS || 'http://localhost:5173'}`);
  console.log(`  google auth ${process.env.GOOGLE_CLIENT_ID ? 'configured' : 'not configured'}`);
  console.log(`  email       ${mailer.configured() ? 'SMTP' : 'log transport (no SMTP configured)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
