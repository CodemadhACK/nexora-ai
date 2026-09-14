'use strict';

/**
 * An error the client is allowed to see. Anything thrown that is NOT an
 * ApiError is treated as an internal fault and reported as a generic message,
 * so a stack trace or a provider's raw response can never reach a browser.
 */
class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (msg, details) => new ApiError(400, 'BAD_REQUEST', msg, details);
const unauthorized = (msg = 'You need to sign in.') => new ApiError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = 'You do not have access to that.') => new ApiError(403, 'FORBIDDEN', msg);
const notFound = (msg = 'Not found.') => new ApiError(404, 'NOT_FOUND', msg);
const conflict = (msg) => new ApiError(409, 'CONFLICT', msg);
const tooMany = (msg = 'Too many requests. Try again shortly.') =>
  new ApiError(429, 'RATE_LIMITED', msg);
const paymentRequired = (msg, details) => new ApiError(402, 'PAYMENT_REQUIRED', msg, details);

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  paymentRequired,
};
