'use strict';

/**
 * simulate.js — Training-only "chaos" helpers for the Status Code module.
 *
 * Students append ?simulate=... to a real request so they can SEE latency,
 * timeouts, 429 rate limits and 500 errors without needing a broken supplier.
 *
 * Supported values (query param "simulate"):
 *   latency&ms=2000   -> wait ms then answer normally
 *   timeout&ms=10000  -> wait up to 15000ms (Postman shows a timeout)
 *   error500          -> respond 500 with the standard error body
 *   ratelimit         -> respond 429 with a Retry-After: 5 header
 *   malformed         -> respond with intentionally broken JSON (guarded)
 *
 * Returns true when it already produced the response (server should stop).
 */

const { sendError, errorBody } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hard cap so a curious student cannot hang the demo server forever.
const MAX_DELAY_MS = 15000;

function clampMs(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, MAX_DELAY_MS);
}

/**
 * @param {object} query parsed query-string object
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<boolean>} true if simulation produced the response
 */
async function applySimulation(query, res) {
  const sim = query.simulate;
  if (!sim) return false;

  switch (sim) {
    case 'latency': {
      // Simulate a slow-but-successful supplier API call.
      const ms = clampMs(query.ms || '2000') || 2000;
      await sleep(ms);
      return false; // continue to the normal handler
    }
    case 'timeout': {
      // Delay long enough that Postman reports a timeout to the student.
      const ms = clampMs(query.ms || '10000') || 10000;
      await sleep(ms);
      return false; // still answer, but the client has usually given up
    }
    case 'error500': {
      sendError(
        res,
        500,
        'Simulated internal error for training.'
      );
      return true;
    }
    case 'ratelimit': {
      sendError(
        res,
        429,
        'Simulated rate limit for training. Coba lagi setelah 5 detik.',
        [],
        { 'Retry-After': '5' }
      );
      return true;
    }
    case 'malformed': {
      // Intentionally invalid JSON so students learn to spot a broken payload.
      const broken = '{"data": [{"part_number": "MJK-BRG-6205", ';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(broken),
        'X-Simulated': 'malformed-json',
      });
      res.end(broken);
      return true;
    }
    default:
      return false;
  }
}

module.exports = { applySimulation, errorBody, MAX_DELAY_MS };
