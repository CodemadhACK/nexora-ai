'use strict';

/**
 * Minimal .env loader. Avoids a dependency for ~20 lines, and deliberately does
 * not override variables already present in the real environment — a deployed
 * process's configuration must win over a file that happens to be on disk.
 */

const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

const envPath = process.env.ENV_FILE || resolve(__dirname, '../../.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

module.exports = {};
