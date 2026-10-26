'use strict';

/**
 * idempotency.js — Idempotency-Key support for /api/v1 write requests.
 *
 * WHY: integrations retry on network timeouts. Without an idempotency key a
 * retried POST creates a duplicate supplier/stock row. This module lets a
 * client safely repeat the SAME write: the server answers the cached response
 * instead of running the handler twice.
 *
 * Contract:
 *   - Scope is header key + HTTP method + pathname. Query string is ignored,
 *     matching the course definition ("same key + method + path").
 *   - Each entry also stores a SHA-256 of the raw request body. Reusing a key
 *     for a DIFFERENT body is a client bug and answers 409
 *     IDEMPOTENCY_KEY_REUSED without touching the cached entry.
 *   - Only POST/PUT/PATCH/DELETE are eligible. GET is never cached or replayed.
 *   - Cacheable statuses: 200-499 except 429 (rate limiting is transient and
 *     must be retryable) and except 5xx (the write may or may not have happened).
 *     204 caches an empty body; 207 is cacheable like any 2xx.
 *   - Entries live 24 hours in memory.
 *
 * Ordering matters: server.js calls applyIdempotency() AFTER body parsing and
 * BEFORE ?simulate / ETag / the handler, so a replay can never mutate the store
 * or run the status-code simulator.
 */

const crypto = require('node:crypto');
const { sendJson, errorBody } = require('./errors');

const TTL_MS = 24 * 60 * 60 * 1000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// cacheKey -> { body_hash, status, body, content_type, location, created_at }
const entries = new Map();

function isIdempotentMethod(method) {
  return WRITE_METHODS.has(method);
}

/** SHA-256 of the raw request body (empty body hashes too). */
function hashBody(rawBody) {
  return crypto.createHash('sha256').update(rawBody || '', 'utf8').digest('hex');
}

function cacheKey(method, pathname, key) {
  return `${method}\u0000${pathname}\u0000${key}`;
}

function isExpired(entry, now) {
  return now - entry.created_at >= TTL_MS;
}

function getEntry(id) {
  const entry = entries.get(id);
  if (!entry) return null;
  if (isExpired(entry, Date.now())) {
    entries.delete(id);
    return null;
  }
  return entry;
}

/** 200-499, never 429 (transient) and never 5xx (outcome unknown). */
function isCacheableStatus(status) {
  return status >= 200 && status <= 499 && status !== 429;
}

/** Drop expired keys so a long-running sandbox does not grow forever. */
function prune() {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (isExpired(entry, now)) entries.delete(id);
  }
}

/** Re-send a cached response byte-for-byte, flagged as a replay. */
function replay(res, entry) {
  const headers = {
    'Content-Length': Buffer.byteLength(entry.body),
    'Idempotency-Replayed': 'true',
  };
  if (entry.content_type) headers['Content-Type'] = entry.content_type;
  if (entry.location) headers.Location = entry.location;
  res.writeHead(entry.status, headers);
  res.end(entry.body);
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  }
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

/**
 * Record the outgoing response without changing it. res.write/res.end are
 * wrapped (for this request only) so streaming still works and the normal
 * response goes out untouched.
 */
function captureResponse(res, id, bodyHash) {
  const chunks = [];
  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = function write(chunk, encoding, callback) {
    const buffer = toBuffer(chunk, encoding);
    if (buffer) chunks.push(buffer);
    return originalWrite.apply(res, arguments);
  };

  res.end = function end(chunk, encoding, callback) {
    const buffer = toBuffer(chunk, encoding);
    if (buffer) chunks.push(buffer);

    const status = res.statusCode;
    if (isCacheableStatus(status)) {
      const contentType = res.getHeader('Content-Type');
      const location = res.getHeader('Location');
      entries.set(id, {
        body_hash: bodyHash,
        status,
        body: Buffer.concat(chunks).toString('utf8'),
        content_type: typeof contentType === 'string' ? contentType : undefined,
        location: typeof location === 'string' ? location : undefined,
        created_at: Date.now(),
      });
    }

    return originalEnd.apply(res, arguments);
  };
}

/**
 * Apply the Idempotency-Key middleware for one request.
 *
 * @param {object} params
 * @param {import('node:http').ServerResponse} params.res
 * @param {string} params.method
 * @param {string} params.pathname
 * @param {string} params.key Header value
 * @param {string} params.rawBody Raw request body ('' when absent)
 * @returns {boolean} true when a response was already sent (replay or 409)
 */
function applyIdempotency({ res, method, pathname, key, rawBody }) {
  if (!isIdempotentMethod(method)) return false;

  if (entries.size > 500) prune();

  const id = cacheKey(method, pathname, key);
  const bodyHash = hashBody(rawBody);
  const existing = getEntry(id);

  if (existing) {
    if (existing.body_hash !== bodyHash) {
      // Same key, different payload: do not run the handler and do not
      // overwrite the cached response (the first request stays authoritative).
      sendJson(
        res,
        409,
        errorBody(
          409,
          'Idempotency-Key ini sudah dipakai untuk request lain dengan body berbeda pada method dan path yang sama. ' +
            'Gunakan Idempotency-Key baru untuk payload baru.',
          [
            {
              field: 'Idempotency-Key',
              issue: 'key sudah terikat pada body yang berbeda (IDEMPOTENCY_KEY_REUSED)',
            },
          ],
          'IDEMPOTENCY_KEY_REUSED'
        )
      );
      return true;
    }

    replay(res, existing);
    return true;
  }

  // First execution: let it run normally, record the response if cacheable.
  captureResponse(res, id, bodyHash);
  return false;
}

module.exports = {
  TTL_MS,
  isIdempotentMethod,
  hashBody,
  isCacheableStatus,
  applyIdempotency,
};
