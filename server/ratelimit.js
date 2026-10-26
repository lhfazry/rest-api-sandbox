'use strict';

/**
 * ratelimit.js — Fixed-window rate limiting per API key.
 *
 * WHY: the course needs a real 429 (bukan hanya ?simulate=ratelimit) so
 * students can see throttling headers, Retry-After and window recovery.
 *
 * Model (deliberately simple, no external storage):
 *   - One bucket per API key, fixed window.
 *   - The window starts at the first request for that key and resets
 *     window_ms later; reset_at = window_started_at + window_ms.
 *   - Requests are counted AFTER a valid API key is known, so unauthenticated
 *     traffic (401) never burns the caller's quota.
 *   - A request that is itself rejected with 429 still increments the counter.
 *
 * Configuration (env, positive integers only; invalid values are ignored):
 *   RATE_LIMIT_MAX        default 600 requests
 *   RATE_LIMIT_WINDOW_MS  default 60000 ms
 */

const { sendError } = require('./errors');

const DEFAULT_MAX = 600;
const DEFAULT_WINDOW_MS = 60_000;

/** Accept only positive integers from the environment. */
function positiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

const LIMIT = positiveInt(process.env.RATE_LIMIT_MAX, DEFAULT_MAX);
const WINDOW_MS = positiveInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);

// key -> { window_started_at, used, reset_at }. Expired entries are replaced
// lazily on access, which is enough for a sandbox (no background sweeper).
const buckets = new Map();

/**
 * Count one request for `key` and return a snapshot of the bucket.
 * `used` already includes the current request; `remaining` may be negative
 * when the caller has exceeded the limit.
 */
function consume(key) {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now >= bucket.reset_at) {
    bucket = {
      window_started_at: now,
      used: 0,
      reset_at: now + WINDOW_MS,
    };
    buckets.set(key, bucket);
  }

  bucket.used += 1;
  const remaining = LIMIT - bucket.used;

  return {
    limit: LIMIT,
    window_ms: WINDOW_MS,
    window_started_at: bucket.window_started_at,
    used: bucket.used,
    remaining,
    reset_at: bucket.reset_at,
    allowed: remaining >= 0,
  };
}

/** Read-only snapshot (does not increment). */
function peek(key) {
  const bucket = buckets.get(key);
  if (!bucket || Date.now() >= bucket.reset_at) return null;
  return {
    limit: LIMIT,
    window_ms: WINDOW_MS,
    window_started_at: bucket.window_started_at,
    used: bucket.used,
    remaining: LIMIT - bucket.used,
    reset_at: bucket.reset_at,
  };
}

/** X-RateLimit-* on every /api/v1 response (200, 304, 4xx, 429, ...). */
function applyHeaders(res, snapshot) {
  res.setHeader('X-RateLimit-Limit', String(snapshot.limit));
  res.setHeader('X-RateLimit-Remaining', String(snapshot.remaining));
  // Epoch seconds, the convention clients expect from rate-limit headers.
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(snapshot.reset_at / 1000)));
}

/** Retry-After in whole seconds until the window resets; never below 1. */
function retryAfterSeconds(snapshot) {
  const seconds = Math.ceil((snapshot.reset_at - Date.now()) / 1000);
  return Math.max(1, seconds);
}

/**
 * Middleware step: assumes the API key has already been validated.
 * Always sets the X-RateLimit-* headers and answers 429 when exhausted.
 *
 * @returns {{blocked: boolean, snapshot: object}}
 */
function enforceRateLimit(req, res) {
  const key = req.headers['x-api-key'];
  const snapshot = consume(key);
  applyHeaders(res, snapshot);

  if (!snapshot.allowed) {
    sendError(
      res,
      429,
      `Batas ${snapshot.limit} request per ${Math.round(snapshot.window_ms / 1000)} detik terlampaui. ` +
        'Silakan coba lagi setelah jendela waktu (window) direset.',
      [
        {
          field: 'X-API-Key',
          issue: 'kuota request untuk API key ini habis pada window berjalan',
        },
      ],
      { 'Retry-After': String(retryAfterSeconds(snapshot)) }
    );
    return { blocked: true, snapshot };
  }

  return { blocked: false, snapshot };
}

module.exports = {
  LIMIT,
  WINDOW_MS,
  consume,
  peek,
  applyHeaders,
  retryAfterSeconds,
  enforceRateLimit,
};
