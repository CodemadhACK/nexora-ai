'use strict';

/**
 * Fixed-window limiter held in memory.
 *
 * Sufficient for one process; a multi-instance deployment needs a shared store
 * (Redis) or the limit becomes per-instance. Noted in the deployment checklist
 * rather than pretended away.
 */

const { tooMany } = require('../lib/errors');

const buckets = new Map();

// Without this the map grows for the life of the process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

function rateLimit({ windowMs = 60_000, max = 60, key = null, message } = {}) {
  return (req, _res, next) => {
    // Test suites create far more accounts than a human would; the limiter is
    // covered by its own test rather than by getting in the way of every other.
    if (process.env.RATE_LIMIT_DISABLED === '1') return next();
    const id = key ? key(req) : `${req.clientIp}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const seconds = Math.ceil((bucket.resetAt - now) / 1000);
      return next(tooMany(message || `Too many requests. Try again in ${seconds}s.`));
    }
    next();
  };
}

module.exports = { rateLimit };
