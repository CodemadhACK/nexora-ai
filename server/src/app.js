'use strict';

/**
 * Express wiring: middleware order, the webhook's raw-body carve-out, and the
 * error boundary that decides what a client is allowed to be told.
 */

const express = require('express');
const { attachUser } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');
const { ApiError, notFound } = require('./lib/errors');
const cashfree = require('./services/cashfree');

function buildApp() {
  const app = express();

  // We sit behind a proxy in production; without this every client IP is the
  // proxy's, which would make rate limiting and lockout useless.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    req.clientIp = req.ip || req.socket.remoteAddress || '';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Browser app and API are separate origins in development. Credentials are
  // required because the session lives in a cookie, and an explicit allow-list
  // is mandatory — `*` is illegal with credentials, and rightly so.
  const origins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  /**
   * The webhook is mounted before the JSON parser and takes the raw body.
   * Cashfree signs the exact bytes it sent; re-serialising parsed JSON would
   * change them and the signature would never verify.
   */
  app.post(
    '/api/webhooks/cashfree',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      const rawBody = req.body.toString('utf8');
      try {
        const result = await cashfree.handleWebhook({
          rawBody,
          signature: req.get('x-webhook-signature'),
          timestamp: req.get('x-webhook-timestamp'),
        });
        // 200 on a duplicate too: anything else invites Cashfree to keep retrying
        // an event we have already handled.
        res.json({ received: true, ...result });
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 500;
        console.error('[webhook] failed', { status, message: err.message });
        res.status(status).json({ received: false });
      }
    },
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(attachUser);

  // Broad ceiling; individual routers set tighter limits where it matters.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 300 }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: require('../package.json').version });
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/billing', require('./routes/billing'));
  app.use('/api/ai', require('./routes/ai'));
  app.use('/api/account', require('./routes/account'));
  app.use('/api/admin', require('./routes/admin'));

  app.use('/api', (_req, _res, next) => next(notFound('No such endpoint.')));

  // The error boundary. An ApiError is deliberate and its message is shown;
  // anything else is a bug, and the client gets a generic message while the
  // real one goes to the log. No stack trace ever crosses this line.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details ?? undefined },
      });
    }
    console.error('[error]', req.method, req.originalUrl, err);
    res.status(500).json({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' },
    });
  });

  return app;
}

module.exports = { buildApp };
