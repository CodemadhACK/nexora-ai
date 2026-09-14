'use strict';

/**
 * Append-only admin audit trail (§23). There is deliberately no update() or
 * delete() exported here, and no route that writes to audit_logs any other way.
 */

const { run, all, get } = require('../db');
const { newId } = require('./crypto');

const serialise = (v) =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v);

function log({ actorId = null, actorEmail = '', action, targetType = '', targetId = '', previous = null, next = null, ip = '', userAgent = '' }) {
  run(
    `INSERT INTO audit_logs
       (id, actor_id, actor_email, action, target_type, target_id, previous_value, new_value, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('aud'), actorId, actorEmail, action, targetType, String(targetId ?? ''),
    serialise(previous), serialise(next), ip, userAgent,
  );
}

/** Convenience for routes: pulls actor and request metadata off `req`. */
function fromRequest(req, entry) {
  return log({
    actorId: req.user?.id ?? null,
    actorEmail: req.user?.email ?? '',
    ip: req.clientIp || '',
    userAgent: req.get?.('user-agent') || '',
    ...entry,
  });
}

function list({ limit = 50, offset = 0, action = null, actorId = null } = {}) {
  const where = [];
  const params = [];
  if (action) { where.push('action LIKE ?'); params.push(`%${action}%`); }
  if (actorId) { where.push('actor_id = ?'); params.push(actorId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  const total = get(`SELECT COUNT(*) AS n FROM audit_logs ${clause}`, ...params).n;
  return { rows, total };
}

module.exports = { log, fromRequest, list };
