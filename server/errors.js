'use strict';

/**
 * errors.js — Central place for the STANDARD error contract used everywhere.
 *
 * WHY: The whole course teaches one consistent error shape so a non-technical
 * student learns to recognise it by sight:
 *   { "error": { "code": "SNAKE_CASE", "message": "...", "details": [] } }
 * Keeping the mapping in one file guarantees every handler answers the same way.
 */

// Canonical HTTP status -> error code mapping (see AGENTS.md §4 / course contract).
const ERROR_CODES = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_SERVER_ERROR',
};

// Human friendly default messages (Bahasa Indonesia + technical term in parens).
const DEFAULT_MESSAGES = {
  400: 'Data request tidak valid (bad request). Periksa field yang wajib diisi.',
  401: 'Akses ditolak: header autentikasi tidak ada atau salah (unauthorized).',
  403: 'Akses dilarang: token Anda tidak punya izin untuk operasi ini (forbidden).',
  404: 'Data yang diminta tidak ditemukan (not found).',
  405: 'HTTP method ini tidak diizinkan untuk endpoint tersebut.',
  406: 'Format respons yang diminta tidak didukung (not acceptable). Gunakan Accept: application/json atau text/csv.',
  409: 'Terjadi konflik data (duplicate / conflict).',
  429: 'Terlalu banyak request. Silakan coba lagi nanti (rate limited).',
  500: 'Terjadi kesalahan di sisi server (internal server error).',
};

/**
 * Build a standard error payload object.
 * @param {number} status HTTP status code
 * @param {string} [message] override message
 * @param {Array} [details] optional machine-readable details array
 * @param {string} [code] override code (defaults from status)
 */
function errorBody(status, message, details = [], code) {
  return {
    error: {
      code: code || ERROR_CODES[status] || 'ERROR',
      message: message || DEFAULT_MESSAGES[status] || 'Terjadi kesalahan.',
      details: Array.isArray(details) ? details : [],
    },
  };
}

/**
 * If-None-Match may be a comma-separated list or "*". Values are compared
 * verbatim (strong validators), ignoring surrounding whitespace.
 */
function ifNoneMatchMatches(header, etag) {
  if (!header) return false;
  return String(header)
    .split(',')
    .some((candidate) => {
      const value = candidate.trim();
      return value === '*' || value === etag;
    });
}

/**
 * Send a JSON response with the correct content-type.
 * WHY a helper: guarantees every response carries the charset header the
 * course promises, and keeps handlers tiny and readable.
 *
 * Conditional GET: server.js parks a candidate ETag on res._conditional for
 * GET /api/v1 JSON requests. A 304 is ONLY possible for a successful 200
 * response, so a missing resource (404) can never be masked by a stale ETag.
 * Non-2xx responses never carry ETag/Cache-Control from this helper.
 */
function sendJson(res, status, payload, extraHeaders = {}) {
  const conditional = res._conditional;

  if (status === 200 && conditional && conditional.etag) {
    if (ifNoneMatchMatches(conditional.ifNoneMatch, conditional.etag)) {
      // 304 has no body and must not advertise a content length.
      res.writeHead(304, {
        ETag: conditional.etag,
        'Cache-Control': 'no-cache',
      });
      return res.end();
    }
  }

  const headers = { ...extraHeaders };
  if (status === 200 && conditional && conditional.etag) {
    headers.ETag = conditional.etag;
    headers['Cache-Control'] = headers['Cache-Control'] || 'no-cache';
  }

  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/**
 * Send a standard error response.
 */
function sendError(res, status, message, details = [], extraHeaders = {}) {
  sendJson(res, status, errorBody(status, message, details), extraHeaders);
}

module.exports = {
  ERROR_CODES,
  DEFAULT_MESSAGES,
  errorBody,
  ifNoneMatchMatches,
  sendJson,
  sendError,
};
