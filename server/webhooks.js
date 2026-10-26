'use strict';

/**
 * webhooks.js — Webhook subscriptions + asynchronous delivery worker.
 *
 * WHY: the capstone (T9) needs a real outbound integration, not just a mock
 * response. This module lets a client register an HTTPS/HTTP endpoint, then the
 * sandbox POSTs signed event notifications to it whenever stock/plan data
 * changes.
 *
 * Storage is IN-MEMORY ONLY (deliberately): a restart wipes subscriptions and
 * deliveries, exactly like the seeded supplier data on a fresh boot.
 *
 * Delivery worker contract:
 *   - One delivery row per matching ACTIVE subscription, created at emit time
 *     (status "pending", attempts 0) so the caller can see it immediately.
 *   - The HTTP attempt itself is scheduled with setTimeout(..., 0): the API
 *     response is never blocked by the receiver.
 *   - POST JSON, headers X-Sandbox-Event / X-Sandbox-Delivery /
 *     X-Sandbox-Signature: t=<unixSeconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 *     and User-Agent sandbox-webhook/1.0.
 *   - 3s timeout per attempt, max 3 attempts, backoff 1s (before attempt 2)
 *     and 2s (before attempt 3).
 *   - 2xx => delivered; anything else (HTTP error, timeout, network error)
 *     => retry, and after the last attempt => failed with an error message.
 *   - Failures are swallowed: a broken receiver never crashes the sandbox.
 *
 * Event emission lives in handlers.js (after the store mutation succeeded) and
 * is always best-effort via emitBestEffort().
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

// ---- Public enums -------------------------------------------------------

/** Events a subscription may register for. `webhook.test` is test-only. */
const EVENT_TYPES = [
  'stock.created',
  'stock.updated',
  'stock.deleted',
  'plan.created',
  'plan.updated',
];

/** Synthetic event sent by POST .../test; never registrable. */
const TEST_EVENT = 'webhook.test';

const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'];

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 3000;
const RETRY_BACKOFF_MS = [1000, 2000]; // before attempt 2, then before attempt 3
const USER_AGENT = 'sandbox-webhook/1.0';

// Same pagination contract as data-store.js (default 10, capped at 50).
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// ---- In-memory state ----------------------------------------------------

const subscriptions = [];
const deliveries = [];

let subscriptionSeq = 0;
let deliverySeq = 0;

/**
 * Monotonic revision for the conditional-GET (ETag) validator. The supplier
 * data store already bumps its own revision; webhook reads combine both so a
 * 304 can never serve a stale subscription/delivery list.
 */
let revision = 0;

function bumpRevision() {
  revision += 1;
}

function getRevision() {
  return revision;
}

// ---- Small helpers ------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasFilter(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function nextSubscriptionId() {
  subscriptionSeq += 1;
  return `WH-${String(subscriptionSeq).padStart(3, '0')}`;
}

function nextDeliveryId() {
  deliverySeq += 1;
  return `DLV-${String(deliverySeq).padStart(3, '0')}`;
}

/** setTimeout wrapper that never keeps the process alive on its own. */
function schedule(fn, delayMs) {
  const timer = setTimeout(fn, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function isSuccessStatus(status) {
  return typeof status === 'number' && status >= 200 && status < 300;
}

/** HMAC-SHA256(secret, `${t}.${rawBody}`) as lowercase hex. */
function signPayload(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
}

// ---- Subscriptions ------------------------------------------------------

/**
 * Create a subscription. Validation happens in handlers.js; this function
 * only assigns identity, secret and timestamps.
 */
function createSubscription({ url, events, description }) {
  const subscription = {
    subscription_id: nextSubscriptionId(),
    url,
    events: [...events],
    description: description === undefined ? '' : description,
    active: true,
    // 32 hex characters (16 random bytes). Demo material, not a real vault.
    secret: `whsec_${crypto.randomBytes(16).toString('hex')}`,
    created_at: nowIso(),
  };
  subscriptions.push(subscription);
  bumpRevision();
  return clone(subscription);
}

function getSubscription(subscriptionId) {
  const found = subscriptions.find((s) => s.subscription_id === subscriptionId);
  return found ? clone(found) : null;
}

function listSubscriptions() {
  return {
    data: subscriptions.map(clone),
    meta: { total: subscriptions.length },
  };
}

/** @returns {boolean} true when a subscription was removed. */
function deleteSubscription(subscriptionId) {
  const index = subscriptions.findIndex((s) => s.subscription_id === subscriptionId);
  if (index === -1) return false;
  subscriptions.splice(index, 1);
  bumpRevision();
  return true;
}

// ---- Deliveries ---------------------------------------------------------

/** Create one pending delivery row and schedule its first attempt. */
function enqueueDelivery(subscription, event, data) {
  const delivery_id = nextDeliveryId();
  const occurred_at = nowIso();
  const delivery = {
    delivery_id,
    subscription_id: subscription.subscription_id,
    event,
    status: 'pending',
    attempts: 0,
    last_attempt_at: null,
    response_status: null,
    error: null,
    created_at: occurred_at,
    // The signed body is JSON.stringify(this object) — see sendAttempt().
    payload: { event, delivery_id, occurred_at, data },
  };
  deliveries.push(delivery);
  bumpRevision();
  schedule(() => sendAttempt(delivery), 0);
  return delivery;
}

/**
 * Emit a domain event: one delivery per matching ACTIVE subscription.
 * Synchronous part = create the rows; HTTP calls stay deferred.
 * @returns {Array<object>} the created deliveries (internal references).
 */
function emit(event, data) {
  const targets = subscriptions.filter(
    (subscription) =>
      subscription.active &&
      Array.isArray(subscription.events) &&
      subscription.events.includes(event)
  );
  return targets.map((subscription) => enqueueDelivery(subscription, event, data));
}

/**
 * Best-effort wrapper used by handlers: webhook bookkeeping must never fail an
 * API response. No subscriptions => nothing happens.
 */
function emitBestEffort(event, data) {
  try {
    return emit(event, data);
  } catch (err) {
    console.error(`[webhooks] gagal emit "${event}":`, err && err.message);
    return [];
  }
}

/**
 * Enqueue the synthetic webhook.test event for one subscription.
 * @returns {object|null} delivery snapshot, or null when unknown.
 */
function enqueueTest(subscriptionId) {
  const subscription = subscriptions.find((s) => s.subscription_id === subscriptionId);
  if (!subscription) return null;
  const delivery = enqueueDelivery(subscription, TEST_EVENT, {
    message: 'Test delivery',
    subscription_id: subscription.subscription_id,
  });
  return clone({
    delivery_id: delivery.delivery_id,
    event: delivery.event,
    status: delivery.status,
  });
}

function normalizePage(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

function normalizeLimit(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/**
 * List deliveries newest-first with optional filters.
 * An unknown `status` is a legitimate "no results" filter (200, not 400).
 * @param {{subscription_id?:string,status?:string,page?:*,limit?:*}} opts
 */
function listDeliveries(opts = {}) {
  let rows = deliveries.slice().reverse(); // newest-first

  if (hasFilter(opts.subscription_id)) {
    rows = rows.filter((d) => d.subscription_id === String(opts.subscription_id));
  }
  if (hasFilter(opts.status)) {
    const status = String(opts.status).trim();
    rows = DELIVERY_STATUSES.includes(status) ? rows.filter((d) => d.status === status) : [];
  }

  const page = normalizePage(opts.page);
  const limit = normalizeLimit(opts.limit);
  const total = rows.length;
  const total_pages = total === 0 ? 0 : Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;

  return {
    data: clone(rows.slice(start, start + limit)),
    meta: { total, page, limit, total_pages },
  };
}

// ---- Delivery worker ----------------------------------------------------

/** Record the outcome of one attempt and either finish or schedule a retry. */
function finishAttempt(delivery, responseStatus, errorText) {
  if (typeof responseStatus === 'number') delivery.response_status = responseStatus;

  if (isSuccessStatus(responseStatus)) {
    delivery.status = 'delivered';
    delivery.error = null;
    bumpRevision();
    return;
  }

  delivery.error = errorText || 'Pengiriman webhook gagal.';
  if (delivery.attempts >= MAX_ATTEMPTS) {
    delivery.status = 'failed';
    bumpRevision();
    return;
  }

  delivery.status = 'pending';
  bumpRevision();
  const delay =
    RETRY_BACKOFF_MS[Math.min(delivery.attempts - 1, RETRY_BACKOFF_MS.length - 1)] ||
    RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
  schedule(() => sendAttempt(delivery), delay);
}

/**
 * Perform one delivery attempt. Never throws: every failure path ends in
 * finishAttempt() (retry or failed), so a dead receiver cannot crash us.
 */
function sendAttempt(delivery) {
  const subscription = subscriptions.find(
    (s) => s.subscription_id === delivery.subscription_id
  );
  if (!subscription || !subscription.active) {
    delivery.status = 'failed';
    delivery.last_attempt_at = nowIso();
    delivery.error = 'Subscription tidak aktif atau sudah dihapus.';
    bumpRevision();
    return;
  }

  delivery.attempts += 1;
  delivery.last_attempt_at = nowIso();
  delivery.error = null;

  let target = null;
  try {
    target = new URL(subscription.url);
  } catch {
    target = null;
  }
  if (!target) {
    finishAttempt(delivery, null, `URL subscription tidak valid: ${subscription.url}`);
    return;
  }

  const transport = target.protocol === 'https:' ? https : http;
  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(subscription.secret, timestamp, rawBody);

  let settled = false;
  let timer = null;

  const settle = (responseStatus, errorText) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    finishAttempt(delivery, responseStatus, errorText);
  };

  let request;
  try {
    request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          'X-Sandbox-Event': delivery.event,
          'X-Sandbox-Delivery': delivery.delivery_id,
          'X-Sandbox-Signature': `t=${timestamp},v1=${signature}`,
          'User-Agent': USER_AGENT,
        },
      },
      (response) => {
        const status = typeof response.statusCode === 'number' ? response.statusCode : 0;
        // Swallow receiver-side socket errors; the attempt outcome is decided
        // by the status code we already know.
        response.on('error', () => {});
        response.resume();
        if (isSuccessStatus(status)) {
          settle(status, null);
        } else {
          settle(status, `Endpoint membalas HTTP ${status}.`);
        }
      }
    );
  } catch (err) {
    settle(null, `Gagal mengirim request: ${err && err.message}`);
    return;
  }

  timer = setTimeout(() => {
    settle(null, `Timeout: endpoint tidak merespons dalam ${ATTEMPT_TIMEOUT_MS} ms.`);
    request.destroy();
  }, ATTEMPT_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  request.on('error', (err) => {
    settle(null, `Gagal menghubungi endpoint: ${err && err.message}`);
  });

  try {
    request.end(rawBody);
  } catch (err) {
    settle(null, `Gagal mengirim body: ${err && err.message}`);
  }
}

module.exports = {
  EVENT_TYPES,
  TEST_EVENT,
  DELIVERY_STATUSES,
  MAX_ATTEMPTS,
  ATTEMPT_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  getRevision,
  createSubscription,
  getSubscription,
  listSubscriptions,
  deleteSubscription,
  enqueueTest,
  listDeliveries,
  emit,
  emitBestEffort,
  signPayload,
};
