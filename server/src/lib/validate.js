'use strict';

/**
 * Small hand-rolled validators. A schema library would be more expressive, but
 * the surface here is narrow and every endpoint validates explicitly, which is
 * easier to audit than a schema defined somewhere else.
 */

const { badRequest } = require('./errors');

const str = (value, field, { min = 1, max = 5000, trim = true } = {}) => {
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`);
  const v = trim ? value.trim() : value;
  if (v.length < min) throw badRequest(`${field} is required.`);
  if (v.length > max) throw badRequest(`${field} must be under ${max} characters.`);
  return v;
};

const int = (value, field, { min = -Infinity, max = Infinity } = {}) => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${field} must be a whole number.`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}.`);
  return n;
};

const bool = (value) => value === true || value === 1 || value === '1' || value === 'true';

const email = (value) => {
  const v = str(value, 'Email', { max: 320 }).toLowerCase();
  // Deliberately permissive: the confirmation email is the real validator.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v)) throw badRequest('That email address looks wrong.');
  return v;
};

const password = (value) => {
  const v = str(value, 'Password', { min: 1, max: 200, trim: false });
  if (v.length < 10) throw badRequest('Use at least 10 characters for your password.');
  return v;
};

const oneOf = (value, options, field) => {
  if (!options.includes(value)) throw badRequest(`${field} must be one of: ${options.join(', ')}.`);
  return value;
};

const jsonArray = (value, field) => {
  const arr = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(arr)) throw badRequest(`${field} must be a list.`);
  return arr;
};

module.exports = { str, int, bool, email, password, oneOf, jsonArray };
