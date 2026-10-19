'use strict';

/**
 * auth.js — Demonstrates the TWO authentication layers taught in the course.
 *
 * Layer 1: API Key      -> header "X-API-Key" (identifies the calling app)
 * Layer 2: Bearer Token -> header "Authorization: Bearer <token>" (for writes)
 *
 * The goal is teaching, so the rules are intentionally simple and visible:
 *   - Any non-empty opaque bearer token is accepted.
 *   - The literal token "readonly-token" is accepted for reads but receives
 *     403 Forbidden on write operations (to teach 401 vs 403).
 */

const { sendError } = require('./errors');

// Demo credentials embedded in the sandbox on purpose (no real secrets here).
const API_KEY = 'sup_demo_key_2026';
const TOKEN_CLIENT_ID = 'company-dashboard';
const TOKEN_CLIENT_SECRET = 's3cr3t-demo';
const READONLY_TOKEN = 'readonly-token';

/**
 * Validate the API key header.
 * @returns {{ok: true} | {ok: false, status: number, message: string}}
 */
function checkApiKey(req) {
  const key = req.headers['x-api-key'];
  if (!key) {
    return {
      ok: false,
      status: 401,
      message:
        'Header "X-API-Key" tidak ditemukan. Tambahkan X-API-Key: ' + API_KEY + ' untuk mengakses endpoint /api/v1/*.',
    };
  }
  if (key !== API_KEY) {
    return {
      ok: false,
      status: 401,
      message: 'API key salah. Nilai yang benar untuk demo: ' + API_KEY + '.',
    };
  }
  return { ok: true };
}

/**
 * Validate the bearer token for WRITE operations.
 * Returns 401 when missing/malformed, 403 when the token lacks write scope.
 * @returns {{ok: true, token: string} | {ok: false, status: number, message: string}}
 */
function checkBearer(req) {
  const raw = req.headers['authorization'];
  if (!raw || !raw.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      message:
        'Header "Authorization: Bearer <token>" wajib untuk operasi tulis (POST/PUT/PATCH/DELETE). ' +
        'Ambil token dari POST /auth/token terlebih dahulu.',
    };
  }
  const token = raw.slice('Bearer '.length).trim();
  if (!token) {
    return { ok: false, status: 401, message: 'Token bearer kosong.' };
  }
  if (token === READONLY_TOKEN) {
    return {
      ok: false,
      status: 403,
      message:
        'Token "readonly-token" hanya boleh membaca (read-only scope). Operasi tulis tidak diizinkan.',
    };
  }
  return { ok: true, token };
}

/**
 * Apply the auth middleware for a route.
 * @param {boolean} isWrite true when the route mutates data
 * @returns {boolean} true if the request was rejected (response already sent)
 */
function enforceAuth(req, res, isWrite) {
  const api = checkApiKey(req);
  if (!api.ok) {
    sendError(res, api.status, api.message);
    return true;
  }
  if (isWrite) {
    const bearer = checkBearer(req);
    if (!bearer.ok) {
      sendError(res, bearer.status, bearer.message);
      return true;
    }
  }
  return false;
}

module.exports = {
  API_KEY,
  TOKEN_CLIENT_ID,
  TOKEN_CLIENT_SECRET,
  READONLY_TOKEN,
  checkApiKey,
  checkBearer,
  enforceAuth,
};
