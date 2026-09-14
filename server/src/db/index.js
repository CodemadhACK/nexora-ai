'use strict';

/**
 * The single database handle. node:sqlite is built into Node 22+, so the
 * platform has no native module to compile — which matters on Windows, where
 * better-sqlite3 needs a full toolchain.
 */

const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { mkdirSync } = require('node:fs');

const DB_PATH = process.env.DATABASE_PATH || resolve(__dirname, '../../data/nexora.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Enforced per connection, not stored in the file — without this, every
// ON DELETE CASCADE in the schema is decorative.
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

function migrate() {
  db.exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf8'));
}

// Nesting depth, so transaction() can be re-entrant. SQLite has no nested
// BEGIN: a second one raises "cannot start a transaction within a transaction".
let depth = 0;

/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * Re-entrant by design. Activating a payment opens a transaction and then calls
 * the credit ledger, which opens one of its own; without this the whole
 * successful-payment path throws. A nested call simply joins the outer
 * transaction, which is the semantics we want — if granting credits fails, the
 * subscription that was being activated in the same breath must roll back too.
 *
 * Deliberately not SAVEPOINT: that would let an inner failure be swallowed
 * while the outer commits, which for money is the wrong default.
 */
function transaction(fn) {
  if (depth > 0) {
    // Already inside one; join it and let errors propagate to the owner.
    depth += 1;
    try {
      return fn();
    } finally {
      depth -= 1;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  depth = 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the connection is already unwound */
    }
    throw err;
  } finally {
    depth = 0;
  }
}

/** True while a transaction is open on this connection. Used by tests. */
const inTransaction = () => depth > 0;

const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

module.exports = { db, migrate, transaction, inTransaction, get, all, run, DB_PATH };
