'use strict';

/**
 * handlers.js — All business logic for the mock Supplier API.
 *
 * Each handler receives a single ctx object (req, res, query, params, body)
 * and is responsible for exactly one endpoint. Routing + auth + simulation
 * live in server.js so these functions stay focused on the DOMAIN.
 *
 * Domain matches the course syllabus: supplier stock + production planning.
 */

const crypto = require('node:crypto');
const store = require('./data-store');
const { sendJson, sendError } = require('./errors');
const {
  TOKEN_CLIENT_ID,
  TOKEN_CLIENT_SECRET,
} = require('./auth');
const webhooks = require('./webhooks');

// ---- shared helpers -----------------------------------------------------

const UOM_VALUES = ['PCS', 'BOX', 'METER', 'SET'];
const STOCK_STATUS_VALUES = ['available', 'low', 'out'];
const PRODUCTION_STATUS_VALUES = ['planned', 'in_progress', 'completed', 'delayed'];
const SUPPLIER_API_STATUS_VALUES = ['active', 'inactive'];

function nowIso() {
  return new Date().toISOString();
}

function parseIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

// ---- content negotiation (CSV on the global stock list) ------------------

const CSV_COLUMNS = [
  'supplier_id',
  'supplier_name',
  'part_number',
  'part_name',
  'stock_quantity',
  'uom',
  'stock_location',
  'stock_status',
  'unit_price',
  'currency',
  'last_updated',
];

/**
 * Decision for GET /api/v1/stock.
 * - no Accept header                    -> JSON
 * - text/csv acceptable (q > 0)         -> CSV (wins even if JSON is accepted)
 * - application/json or * / * accepted  -> JSON
 * - header present but nothing acceptable (incl. every range q=0) -> 406
 * Quality values are honoured: q=0 means "not acceptable".
 */
function parseMediaRange(part) {
  const [rawType, ...params] = String(part).split(';');
  const type = rawType.trim().toLowerCase();
  if (!type) return null;
  let q = 1;
  for (const param of params) {
    const [name, value] = param.split('=');
    if (name && name.trim().toLowerCase() === 'q') {
      const parsed = Number.parseFloat(String(value ?? '').trim());
      q = Number.isNaN(parsed) ? 1 : parsed;
    }
  }
  return { type, q };
}

function negotiateStockAccept(acceptHeader) {
  if (acceptHeader === undefined || acceptHeader === null || String(acceptHeader).trim() === '') {
    return { csv: false, acceptable: true };
  }
  const ranges = String(acceptHeader)
    .split(',')
    .map(parseMediaRange)
    .filter(Boolean);
  // Header made only of separators/whitespace: treat as absent.
  if (ranges.length === 0) return { csv: false, acceptable: true };

  const usable = ranges.filter((range) => range.q > 0);
  if (usable.length === 0) return { csv: false, acceptable: false };

  const csv = usable.some((range) => range.type === 'text/csv');
  const json = usable.some(
    (range) => range.type === 'application/json' || range.type === '*/*'
  );
  return { csv, acceptable: csv || json };
}

/** RFC4180 field: quote when it contains a comma, quote, CR or LF. */
function csvField(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** RFC4180 document: header row + CRLF line endings. */
function toStockCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvField(row[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** stock-YYYYMMDD-HHmmss.csv stamp (UTC, matching the ISO data timestamps). */
function csvFilenameStamp(date = new Date()) {
  const iso = date.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return `stock-${day}-${time}.csv`;
}

/** Build a JWT-like opaque token. Not verified cryptographically — demo only. */
function makeToken(clientId) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = encode({ alg: 'demo', typ: 'JWT' });
  const payload = encode({
    sub: clientId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto.randomBytes(16).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Validate a stock payload. Returns { valid, errors, normalized }.
 * WHY: one validator for POST/PUT keeps the teaching of "required fields"
 * consistent, and returns a details[] array the student can read.
 */
function validateStockPayload(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = (f) => body[f] !== undefined && body[f] !== null && body[f] !== '';

  const required = ['part_number', 'part_name', 'stock_quantity', 'uom', 'stock_location', 'stock_status'];
  if (!partial) {
    for (const f of required) {
      if (!has(f)) errors.push({ field: f, issue: 'field wajib tidak boleh kosong' });
    }
  }

  if (has('part_number')) out.part_number = String(body.part_number);
  if (has('part_name')) out.part_name = String(body.part_name);

  if (has('stock_quantity')) {
    const q = Number(body.stock_quantity);
    if (Number.isNaN(q) || q < 0 || !Number.isInteger(q)) {
      errors.push({ field: 'stock_quantity', issue: 'harus berupa angka bulat >= 0' });
    } else {
      out.stock_quantity = q;
    }
  }

  if (has('uom')) {
    if (!UOM_VALUES.includes(body.uom)) {
      errors.push({ field: 'uom', issue: `harus salah satu dari ${UOM_VALUES.join(', ')}` });
    } else {
      out.uom = body.uom;
    }
  }

  if (has('stock_status')) {
    if (!STOCK_STATUS_VALUES.includes(body.stock_status)) {
      errors.push({ field: 'stock_status', issue: `harus salah satu dari ${STOCK_STATUS_VALUES.join(', ')}` });
    } else {
      out.stock_status = body.stock_status;
    }
  }

  if (has('stock_location')) out.stock_location = String(body.stock_location);

  if (body.unit_price !== undefined) {
    const p = Number(body.unit_price);
    if (Number.isNaN(p) || p < 0) errors.push({ field: 'unit_price', issue: 'harus angka >= 0' });
    else out.unit_price = p;
  }
  if (has('currency')) out.currency = String(body.currency);
  if (has('last_updated')) out.last_updated = String(body.last_updated);

  return { valid: errors.length === 0, errors, normalized: out };
}

/** Fill sensible defaults so created/updated records always look complete. */
function withStockDefaults(record, supplier) {
  return {
    supplier_id: supplier.supplier_id,
    supplier_name: supplier.supplier_name,
    part_number: record.part_number,
    part_name: record.part_name,
    stock_quantity: record.stock_quantity ?? 0,
    uom: record.uom,
    stock_location: record.stock_location,
    stock_status: record.stock_status,
    unit_price: record.unit_price ?? 0,
    currency: record.currency || 'IDR',
    last_updated: record.last_updated || nowIso(),
  };
}

/**
 * Validate a production-plan payload. Returns { valid, errors, normalized }.
 * Full (default) keeps the POST /production-plans rules; partial:true is for
 * PATCH — require nothing and only normalize fields the caller sent.
 * plan_id/supplier_id are identity fields and are ignored here.
 */
function validatePlanPayload(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = (f) => body[f] !== undefined && body[f] !== null && String(body[f]).trim() !== '';
  const required = [
    'part_number',
    'part_name',
    'production_plan',
    'planned_quantity',
    'production_date',
    'production_status',
    'delivery_schedule',
  ];

  if (!partial) {
    for (const f of required) {
      const v = body[f];
      if (v === undefined || v === null || v === '') {
        errors.push({ field: f, issue: 'field wajib tidak boleh kosong' });
      }
    }
  }

  // Only fields actually provided are normalized.
  if (has('part_number')) out.part_number = body.part_number;
  if (has('part_name')) out.part_name = body.part_name;
  if (has('production_plan')) out.production_plan = body.production_plan;
  if (has('production_date')) out.production_date = body.production_date;
  if (has('delivery_schedule')) out.delivery_schedule = body.delivery_schedule;

  if (has('planned_quantity')) {
    const qty = Number(body.planned_quantity);
    if (Number.isNaN(qty) || qty < 0) {
      errors.push({ field: 'planned_quantity', issue: 'harus angka >= 0' });
    } else {
      out.planned_quantity = qty;
    }
  }

  if (has('production_status')) {
    if (!PRODUCTION_STATUS_VALUES.includes(body.production_status)) {
      errors.push({
        field: 'production_status',
        issue: `harus salah satu dari ${PRODUCTION_STATUS_VALUES.join(', ')}`,
      });
    } else {
      out.production_status = body.production_status;
    }
  }

  if (has('last_updated')) out.last_updated = body.last_updated;

  return { valid: errors.length === 0, errors, normalized: out };
}

/**
 * Validate a supplier payload. Returns { valid, errors, normalized }.
 * supplier_id is normalized to uppercase so "sup-004" and "SUP-004" collide
 * as the same supplier. Unknown fields are ignored on purpose.
 *
 * partial:true is for PATCH — require nothing and only normalize fields the
 * caller actually sent (no country/api_status defaults).
 */
function validateSupplierPayload(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = (f) => body[f] !== undefined && body[f] !== null && String(body[f]).trim() !== '';

  if (!partial) {
    if (!has('supplier_id')) {
      errors.push({ field: 'supplier_id', issue: 'field wajib tidak boleh kosong' });
    } else {
      const supplierId = String(body.supplier_id).trim().toUpperCase();
      if (!/^SUP-[A-Z0-9-]{2,32}$/.test(supplierId)) {
        errors.push({
          field: 'supplier_id',
          issue: 'format harus "SUP-" diikuti 2-32 karakter huruf, angka, atau tanda hubung',
        });
      } else {
        out.supplier_id = supplierId;
      }
    }

    if (!has('supplier_name')) {
      errors.push({ field: 'supplier_name', issue: 'field wajib tidak boleh kosong' });
    } else {
      const supplierName = String(body.supplier_name).trim();
      if (supplierName.length > 120) {
        errors.push({ field: 'supplier_name', issue: 'maksimal 120 karakter' });
      } else {
        out.supplier_name = supplierName;
      }
    }

    if (has('country')) {
      out.country = String(body.country).trim();
    } else {
      out.country = 'Indonesia';
    }

    if (has('contact_email')) {
      const email = String(body.contact_email).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push({ field: 'contact_email', issue: 'format email tidak valid' });
      } else {
        out.contact_email = email;
      }
    }

    if (has('api_status')) {
      if (!SUPPLIER_API_STATUS_VALUES.includes(body.api_status)) {
        errors.push({
          field: 'api_status',
          issue: `harus salah satu dari ${SUPPLIER_API_STATUS_VALUES.join(', ')}`,
        });
      } else {
        out.api_status = body.api_status;
      }
    } else {
      out.api_status = 'active';
    }

    return { valid: errors.length === 0, errors, normalized: out };
  }

  // Partial: normalize only the fields that were actually provided.
  if (body.supplier_id !== undefined && body.supplier_id !== null) {
    const supplierId = String(body.supplier_id).trim().toUpperCase();
    if (!supplierId) {
      errors.push({ field: 'supplier_id', issue: 'field tidak boleh kosong' });
    } else if (!/^SUP-[A-Z0-9-]{2,32}$/.test(supplierId)) {
      errors.push({
        field: 'supplier_id',
        issue: 'format harus "SUP-" diikuti 2-32 karakter huruf, angka, atau tanda hubung',
      });
    } else {
      out.supplier_id = supplierId;
    }
  }

  if (body.supplier_name !== undefined && body.supplier_name !== null) {
    const supplierName = String(body.supplier_name).trim();
    if (!supplierName) {
      errors.push({ field: 'supplier_name', issue: 'field tidak boleh kosong' });
    } else if (supplierName.length > 120) {
      errors.push({ field: 'supplier_name', issue: 'maksimal 120 karakter' });
    } else {
      out.supplier_name = supplierName;
    }
  }

  if (body.country !== undefined && body.country !== null) {
    const country = String(body.country).trim();
    if (!country) {
      errors.push({ field: 'country', issue: 'field tidak boleh kosong' });
    } else {
      out.country = country;
    }
  }

  if (body.contact_email !== undefined && body.contact_email !== null) {
    const email = String(body.contact_email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ field: 'contact_email', issue: 'format email tidak valid' });
    } else {
      out.contact_email = email;
    }
  }

  if (body.api_status !== undefined && body.api_status !== null) {
    if (!SUPPLIER_API_STATUS_VALUES.includes(body.api_status)) {
      errors.push({
        field: 'api_status',
        issue: `harus salah satu dari ${SUPPLIER_API_STATUS_VALUES.join(', ')}`,
      });
    } else {
      out.api_status = body.api_status;
    }
  }

  return { valid: errors.length === 0, errors, normalized: out };
}

/** Identity is immutable: a body supplier_id may not disagree with the path. */
function supplierIdMismatch(bodyId, pathId) {
  if (bodyId === undefined || bodyId === null) return false;
  return String(bodyId).trim().toUpperCase() !== String(pathId).trim().toUpperCase();
}

// ---- webhook helpers ----------------------------------------------------

/**
 * Validate a webhook subscription payload.
 * Returns { valid, errors, normalized } like the other validators.
 * `webhook.test` is rejected here on purpose: it is a synthetic event that only
 * POST .../subscriptions/:id/test may produce, never a registrable one.
 */
function validateSubscriptionPayload(body) {
  const errors = [];
  const normalized = {};
  const has = (f) => body[f] !== undefined && body[f] !== null;

  // url: required, parseable, http(s) only.
  if (!has('url') || String(body.url).trim() === '') {
    errors.push({ field: 'url', issue: 'field wajib tidak boleh kosong' });
  } else if (typeof body.url !== 'string') {
    errors.push({ field: 'url', issue: 'harus berupa string URL' });
  } else {
    let parsed = null;
    try {
      parsed = new URL(body.url.trim());
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      errors.push({
        field: 'url',
        issue: 'harus URL http atau https yang valid, contoh: https://example.com/webhooks/supplier',
      });
    } else {
      normalized.url = body.url.trim();
    }
  }

  // events: required non-empty array, every value from the registrable enum.
  if (!has('events')) {
    errors.push({ field: 'events', issue: 'field wajib tidak boleh kosong' });
  } else if (!Array.isArray(body.events)) {
    errors.push({ field: 'events', issue: 'harus berupa array event' });
  } else if (body.events.length === 0) {
    errors.push({ field: 'events', issue: 'array event minimal 1 item' });
  } else {
    const accepted = [];
    body.events.forEach((event, index) => {
      if (typeof event !== 'string' || !webhooks.EVENT_TYPES.includes(event)) {
        const hint =
          event === webhooks.TEST_EVENT
            ? 'event "webhook.test" hanya untuk uji coba (POST .../test) dan tidak bisa didaftarkan'
            : `event tidak dikenal. Gunakan: ${webhooks.EVENT_TYPES.join(', ')}`;
        errors.push({ field: `events[${index}]`, issue: hint });
      } else {
        accepted.push(event);
      }
    });
    if (accepted.length > 0) normalized.events = accepted;
  }

  // description: optional string, max 200 characters.
  if (has('description')) {
    if (typeof body.description !== 'string') {
      errors.push({ field: 'description', issue: 'harus berupa string' });
    } else if (body.description.length > 200) {
      errors.push({ field: 'description', issue: 'maksimal 200 karakter' });
    } else {
      normalized.description = body.description;
    }
  }

  return { valid: errors.length === 0, errors, normalized };
}

/** Emit stock.updated for the parts a bulk/bulk-upsert request actually wrote. */
function emitStockUpdated(supplierId, partNumbers) {
  if (!Array.isArray(partNumbers)) return;
  for (const partNumber of partNumbers) {
    const record = store.getStockItem(supplierId, partNumber);
    if (record) webhooks.emitBestEffort('stock.updated', record);
  }
}

/** Emit plan.updated for the plans a bulk request actually wrote. */
function emitPlanUpdated(supplierId, planIds) {
  if (!Array.isArray(planIds)) return;
  for (const planId of planIds) {
    const plan = store.getProductionPlan(planId);
    if (plan && plan.supplier_id === supplierId) {
      webhooks.emitBestEffort('plan.updated', plan);
    }
  }
}

// ---- health & auth ------------------------------------------------------
const health = (ctx) => {
  sendJson(ctx.res, 200, {
    status: 'ok',
    service: 'supplier-mock-api',
    time: nowIso(),
  });
};

const createToken = (ctx) => {
  const body = ctx.body || {};
  if (body.client_id !== TOKEN_CLIENT_ID || body.client_secret !== TOKEN_CLIENT_SECRET) {
    return sendError(
      ctx.res,
      401,
      'client_id atau client_secret salah. Gunakan client_id "company-dashboard" dan client_secret "s3cr3t-demo".'
    );
  }
  sendJson(ctx.res, 200, {
    access_token: makeToken(body.client_id),
    token_type: 'Bearer',
    expires_in: 3600,
  });
};

// ---- status code simulator ---------------------------------------------

const SIMULATED_CODES = [400, 401, 403, 404, 429, 500];

const simulateCode = (ctx) => {
  const code = parseIntOr(ctx.params.code, 0);
  if (!SIMULATED_CODES.includes(code)) {
    return sendError(
      ctx.res,
      400,
      `Kode simulasi tidak dikenal. Gunakan salah satu dari: ${SIMULATED_CODES.join(', ')}.`
    );
  }
  const extra = code === 429 ? { 'Retry-After': '5' } : {};
  sendError(ctx.res, code, `Contoh respons untuk HTTP ${code} (simulator training).`, [], extra);
};

// ---- rate limit introspection -------------------------------------------

/**
 * GET /api/v1/_ratelimit — shows the caller's window. The middleware counted
 * this very request already, so `used` includes it. remaining may be 0.
 */
const getRateLimit = (ctx) => {
  const snapshot = ctx.rateLimit;
  sendJson(ctx.res, 200, {
    data: {
      limit: snapshot.limit,
      window_ms: snapshot.window_ms,
      window_started_at: new Date(snapshot.window_started_at).toISOString(),
      used: snapshot.used,
      remaining: snapshot.remaining,
      reset_at: new Date(snapshot.reset_at).toISOString(),
    },
  });
};

// ---- webhook subscriptions & deliveries ---------------------------------

/** POST /api/v1/webhooks/subscriptions — register an endpoint. */
const createWebhookSubscription = (ctx) => {
  const { valid, errors, normalized } = validateSubscriptionPayload(ctx.body || {});
  if (!valid) {
    return sendError(
      ctx.res,
      400,
      'Data subscription webhook tidak valid. Periksa field berikut.',
      errors
    );
  }
  const created = webhooks.createSubscription(normalized);
  sendJson(
    ctx.res,
    201,
    { data: created },
    { Location: `/api/v1/webhooks/subscriptions/${created.subscription_id}` }
  );
};

/** GET /api/v1/webhooks/subscriptions — list every subscription. */
const listWebhookSubscriptions = (ctx) => {
  sendJson(ctx.res, 200, webhooks.listSubscriptions());
};

/** DELETE /api/v1/webhooks/subscriptions/:subscriptionId — 204 on success. */
const deleteWebhookSubscription = (ctx) => {
  const { subscriptionId } = ctx.params;
  const removed = webhooks.deleteSubscription(subscriptionId);
  if (!removed) {
    return sendError(ctx.res, 404, `Subscription webhook "${subscriptionId}" tidak ditemukan.`);
  }
  ctx.res.writeHead(204);
  ctx.res.end();
};

/** POST /api/v1/webhooks/subscriptions/:subscriptionId/test — synthetic event. */
const testWebhookSubscription = (ctx) => {
  const { subscriptionId } = ctx.params;
  const delivery = webhooks.enqueueTest(subscriptionId);
  if (!delivery) {
    return sendError(ctx.res, 404, `Subscription webhook "${subscriptionId}" tidak ditemukan.`);
  }
  sendJson(ctx.res, 202, {
    data: {
      delivery_id: delivery.delivery_id,
      event: delivery.event,
    },
  });
};

/**
 * GET /api/v1/webhooks/deliveries — delivery log, newest first.
 * An unknown status yields an empty page (filter semantics), never a 400.
 */
const listWebhookDeliveries = (ctx) => {
  const result = webhooks.listDeliveries({
    subscription_id: ctx.query.subscription_id,
    status: ctx.query.status,
    page: ctx.query.page,
    limit: ctx.query.limit,
  });
  sendJson(ctx.res, 200, result);
};

// ---- suppliers ----------------------------------------------------------

const listSuppliers = (ctx) => {
  const result = store.listSuppliers({
    api_status: ctx.query.api_status,
    country: ctx.query.country,
    q: ctx.query.q,
    page: ctx.query.page,
    limit: ctx.query.limit,
    sort: ctx.query.sort,
  });
  sendJson(ctx.res, 200, result);
};

const getSupplier = (ctx) => {
  const supplier = store.getSupplier(ctx.params.supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${ctx.params.supplierId}" tidak ditemukan.`);
  }
  sendJson(ctx.res, 200, { data: supplier });
};

const createSupplier = (ctx) => {
  const { valid, errors, normalized } = validateSupplierPayload(ctx.body || {});
  if (!valid) {
    return sendError(ctx.res, 400, 'Data supplier tidak valid. Periksa field berikut.', errors);
  }
  const existing = store.getSupplier(normalized.supplier_id);
  if (existing) {
    return sendError(
      ctx.res,
      409,
      `Supplier "${normalized.supplier_id}" sudah terdaftar sebagai "${existing.supplier_name}". Gunakan GET /api/v1/suppliers/${normalized.supplier_id} untuk melihat detailnya.`
    );
  }
  const created = store.createSupplier(normalized);
  sendJson(
    ctx.res,
    201,
    { data: created },
    { Location: `/api/v1/suppliers/${created.supplier_id}` }
  );
};

/** PUT /api/v1/suppliers/:supplierId — full replace (identity from the path). */
const replaceSupplier = (ctx) => {
  const { supplierId } = ctx.params;
  if (!store.getSupplier(supplierId)) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  if (supplierIdMismatch(body.supplier_id, supplierId)) {
    return sendError(ctx.res, 400, 'Data supplier tidak valid.', [
      { field: 'supplier_id', issue: 'tidak boleh berbeda dari supplierId di path' },
    ]);
  }
  // Identity always comes from the path; the rest of the body is a full record.
  const { valid, errors, normalized } = validateSupplierPayload({ ...body, supplier_id: supplierId });
  if (!valid) {
    return sendError(ctx.res, 400, 'Data supplier tidak valid. Periksa field berikut.', errors);
  }
  const updated = store.replaceSupplier(supplierId, normalized);
  sendJson(ctx.res, 200, {
    message: 'Supplier berhasil di-replace (full replace).',
    data: updated,
  });
};

/** PATCH /api/v1/suppliers/:supplierId — partial update (merge semantics). */
const patchSupplier = (ctx) => {
  const { supplierId } = ctx.params;
  if (!store.getSupplier(supplierId)) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  if (supplierIdMismatch(body.supplier_id, supplierId)) {
    return sendError(ctx.res, 400, 'Data supplier tidak valid.', [
      { field: 'supplier_id', issue: 'tidak boleh berbeda dari supplierId di path' },
    ]);
  }
  const { valid, errors, normalized } = validateSupplierPayload(body, { partial: true });
  if (!valid) {
    return sendError(ctx.res, 400, 'Data supplier tidak valid. Periksa field berikut.', errors);
  }
  // supplier_id is identity-only and may not be changed by a patch.
  const patch = { ...normalized };
  delete patch.supplier_id;
  const updated = store.patchSupplier(supplierId, patch);
  sendJson(ctx.res, 200, {
    message: 'Supplier berhasil di-patch (partial update).',
    data: updated,
  });
};

/** Shared: duplicate supplier_id detection for both bulk supplier handlers. */
function findDuplicateSupplierErrors(items) {
  const seen = new Set();
  const duplicates = [];
  items.forEach((item, i) => {
    const raw = item && item.supplier_id;
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    const supplierId = String(raw).trim().toUpperCase();
    if (seen.has(supplierId)) {
      duplicates.push({
        index: i,
        field: 'supplier_id',
        issue: `duplikat supplier_id "${supplierId}" di dalam items`,
      });
    } else {
      seen.add(supplierId);
    }
  });
  return duplicates;
}

/** PUT /api/v1/suppliers/bulk — batch full replace of existing suppliers. */
const bulkReplaceSuppliers = (ctx) => {
  const body = ctx.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return sendError(
      ctx.res,
      400,
      'Body harus berisi "items" berupa array minimal 1 item.',
      [{ field: 'items', issue: 'array tidak boleh kosong' }]
    );
  }

  const duplicates = findDuplicateSupplierErrors(body.items);
  if (duplicates.length > 0) {
    return sendError(ctx.res, 400, 'Data bulk replace supplier tidak valid.', duplicates);
  }

  // Validate each item as a FULL supplier record; keep the original index.
  const validationErrors = [];
  const validEntries = []; // { index, record }
  body.items.forEach((item, i) => {
    const { valid, errors, normalized } = validateSupplierPayload(item || {});
    if (!valid) {
      errors.forEach((e) => validationErrors.push({ index: i, ...e }));
    } else {
      validEntries.push({ index: i, record: normalized });
    }
  });

  const isPartial = ctx.query && ctx.query.mode === 'partial';

  if (!isPartial) {
    if (validationErrors.length > 0) {
      return sendError(ctx.res, 400, 'Data bulk replace supplier tidak valid.', validationErrors);
    }
    // Store checks existence atomically: if anything is missing, nothing is written.
    const result = store.bulkReplaceSuppliers(validEntries.map((e) => e.record));
    if (result.missing) {
      const details = validEntries
        .filter((e) => result.missing.includes(e.record.supplier_id))
        .map((e) => ({
          index: e.index,
          field: 'supplier_id',
          issue: `supplier "${e.record.supplier_id}" tidak ditemukan`,
        }));
      return sendError(
        ctx.res,
        404,
        'Sebagian supplier tidak ditemukan, tidak ada data yang diubah.',
        details
      );
    }
    return sendJson(ctx.res, 200, {
      message: 'Bulk replace supplier berhasil (semua item diperbarui).',
      data: result,
    });
  }

  // ?mode=partial: keep only valid items that already exist, report the rest.
  const missingErrors = [];
  const existingRecords = [];
  for (const entry of validEntries) {
    if (store.getSupplier(entry.record.supplier_id)) {
      existingRecords.push(entry.record);
    } else {
      missingErrors.push({
        index: entry.index,
        field: 'supplier_id',
        issue: `supplier "${entry.record.supplier_id}" tidak ditemukan`,
      });
    }
  }
  const allErrors = validationErrors
    .concat(missingErrors)
    .sort((a, b) => a.index - b.index);
  const result =
    existingRecords.length > 0
      ? store.bulkReplaceSuppliers(existingRecords)
      : { updated: 0, items: [] };
  if (allErrors.length > 0) {
    return sendJson(ctx.res, 207, {
      message: 'Bulk replace supplier selesai sebagian (partial success).',
      summary: {
        received: body.items.length,
        succeeded: result.updated,
        failed: body.items.length - result.updated,
      },
      data: result,
      errors: allErrors,
    });
  }
  sendJson(ctx.res, 200, {
    message: 'Bulk replace supplier berhasil (semua item diperbarui).',
    data: result,
  });
};

/** PATCH /api/v1/suppliers/bulk — batch partial update of existing suppliers. */
const bulkPatchSuppliers = (ctx) => {
  const body = ctx.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return sendError(
      ctx.res,
      400,
      'Body harus berisi "items" berupa array minimal 1 item.',
      [{ field: 'items', issue: 'array tidak boleh kosong' }]
    );
  }

  const duplicates = findDuplicateSupplierErrors(body.items);
  if (duplicates.length > 0) {
    return sendError(ctx.res, 400, 'Data bulk patch supplier tidak valid.', duplicates);
  }

  // Partial validation does not require supplier_id, so enforce it explicitly.
  const validationErrors = [];
  const validEntries = []; // { index, supplierId, patch }
  body.items.forEach((item, i) => {
    const payload = item || {};
    const { errors, normalized } = validateSupplierPayload(payload, { partial: true });
    const hasId =
      payload.supplier_id !== undefined &&
      payload.supplier_id !== null &&
      String(payload.supplier_id).trim() !== '';
    if (!hasId) {
      errors.push({ field: 'supplier_id', issue: 'field wajib tidak boleh kosong' });
    }
    if (errors.length > 0) {
      errors.forEach((e) => validationErrors.push({ index: i, ...e }));
    } else {
      const patch = { ...normalized };
      delete patch.supplier_id; // identity is immutable
      validEntries.push({ index: i, supplierId: normalized.supplier_id, patch });
    }
  });

  const isPartial = ctx.query && ctx.query.mode === 'partial';

  if (!isPartial) {
    if (validationErrors.length > 0) {
      return sendError(ctx.res, 400, 'Data bulk patch supplier tidak valid.', validationErrors);
    }
    const result = store.bulkPatchSuppliers(
      validEntries.map((e) => ({ ...e.patch, supplier_id: e.supplierId }))
    );
    if (result.missing) {
      const details = validEntries
        .filter((e) => result.missing.includes(e.supplierId))
        .map((e) => ({
          index: e.index,
          field: 'supplier_id',
          issue: `supplier "${e.supplierId}" tidak ditemukan`,
        }));
      return sendError(
        ctx.res,
        404,
        'Sebagian supplier tidak ditemukan, tidak ada data yang diubah.',
        details
      );
    }
    return sendJson(ctx.res, 200, {
      message: 'Bulk patch supplier berhasil (semua item diperbarui).',
      data: result,
    });
  }

  // ?mode=partial: keep only valid items that already exist, report the rest.
  const missingErrors = [];
  const existingPatches = [];
  for (const entry of validEntries) {
    if (store.getSupplier(entry.supplierId)) {
      existingPatches.push({ ...entry.patch, supplier_id: entry.supplierId });
    } else {
      missingErrors.push({
        index: entry.index,
        field: 'supplier_id',
        issue: `supplier "${entry.supplierId}" tidak ditemukan`,
      });
    }
  }
  const allErrors = validationErrors
    .concat(missingErrors)
    .sort((a, b) => a.index - b.index);
  const result =
    existingPatches.length > 0
      ? store.bulkPatchSuppliers(existingPatches)
      : { updated: 0, items: [] };
  if (allErrors.length > 0) {
    return sendJson(ctx.res, 207, {
      message: 'Bulk patch supplier selesai sebagian (partial success).',
      summary: {
        received: body.items.length,
        succeeded: result.updated,
        failed: body.items.length - result.updated,
      },
      data: result,
      errors: allErrors,
    });
  }
  sendJson(ctx.res, 200, {
    message: 'Bulk patch supplier berhasil (semua item diperbarui).',
    data: result,
  });
};

// ---- stock (read) -------------------------------------------------------

const listStock = (ctx) => {
  const { supplierId } = ctx.params;
  const supplier = store.getSupplier(supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const result = store.listStock(supplierId, {
    status: ctx.query.status,
    page: parseIntOr(ctx.query.page, 1),
    limit: parseIntOr(ctx.query.limit, 10),
    updated_since: ctx.query.updated_since,
    sort: ctx.query.sort,
  });
  sendJson(ctx.res, 200, result);
};

/**
 * GET /api/v1/stock — stock across all suppliers.
 * Content negotiation: JSON by default, CSV when the client asks for it.
 */
const listAllStock = (ctx) => {
  const { csv, acceptable } = negotiateStockAccept(ctx.req.headers.accept);
  if (!acceptable) {
    return sendError(
      ctx.res,
      406,
      'Format respons yang diminta tidak didukung. Gunakan Accept: application/json atau text/csv.'
    );
  }

  const result = store.listAllStock({
    supplier_id: ctx.query.supplier_id,
    status: ctx.query.status,
    part_number: ctx.query.part_number,
    q: ctx.query.q,
    updated_since: ctx.query.updated_since,
    page: ctx.query.page,
    limit: ctx.query.limit,
    sort: ctx.query.sort,
  });

  if (csv) {
    // Same filtered + paginated rows as JSON, serialised per RFC4180.
    const body = toStockCsv(result.data);
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Total-Count': String(result.meta.total),
      'Content-Disposition': `attachment; filename="${csvFilenameStamp()}"`,
      'Cache-Control': 'no-cache',
    });
    return ctx.res.end(body);
  }

  sendJson(ctx.res, 200, result);
};

const getStockItem = (ctx) => {
  const { supplierId, partNumber } = ctx.params;
  const item = store.getStockItem(supplierId, partNumber);
  if (!item) {
    return sendError(
      ctx.res,
      404,
      `Part "${partNumber}" untuk supplier "${supplierId}" tidak ditemukan.`
    );
  }
  sendJson(ctx.res, 200, { data: item });
};

// ---- stock (write) ------------------------------------------------------

const createStock = (ctx) => {
  const { supplierId } = ctx.params;
  const supplier = store.getSupplier(supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  const { valid, errors, normalized } = validateStockPayload(body);
  if (!valid) {
    return sendError(ctx.res, 400, 'Data stock tidak valid. Periksa field berikut.', errors);
  }
  if (store.getStockItem(supplierId, normalized.part_number)) {
    return sendError(
      ctx.res,
      409,
      `Part "${normalized.part_number}" sudah ada untuk supplier "${supplierId}". Gunakan PUT/PATCH untuk memperbarui.`
    );
  }
  const created = store.createStock(withStockDefaults(normalized, supplier));
  sendJson(ctx.res, 201, { data: created }, { Location: `/api/v1/suppliers/${supplierId}/stock/${created.part_number}` });
  // Best-effort, after the response: never fails the request.
  webhooks.emitBestEffort('stock.created', created);
};

const replaceStock = (ctx) => {
  const { supplierId, partNumber } = ctx.params;
  const supplier = store.getSupplier(supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  if (!store.getStockItem(supplierId, partNumber)) {
    return sendError(ctx.res, 404, `Part "${partNumber}" tidak ditemukan, tidak bisa di-replace.`);
  }
  const { valid, errors, normalized } = validateStockPayload(ctx.body || {});
  if (!valid) {
    return sendError(ctx.res, 400, 'Data stock tidak valid untuk PUT (full replace).', errors);
  }
  const record = withStockDefaults({ ...normalized, part_number: partNumber }, supplier);
  const updated = store.replaceStock(supplierId, partNumber, record);
  sendJson(ctx.res, 200, { data: updated });
  webhooks.emitBestEffort('stock.updated', updated);
};

const patchStock = (ctx) => {
  const { supplierId, partNumber } = ctx.params;
  const supplier = store.getSupplier(supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  if (!store.getStockItem(supplierId, partNumber)) {
    return sendError(ctx.res, 404, `Part "${partNumber}" tidak ditemukan, tidak bisa di-patch.`);
  }
  const { valid, errors, normalized } = validateStockPayload(ctx.body || {}, { partial: true });
  if (!valid) {
    return sendError(ctx.res, 400, 'Data patch tidak valid.', errors);
  }
  const patch = { ...normalized };
  if (!patch.last_updated) patch.last_updated = nowIso();
  const updated = store.patchStock(supplierId, partNumber, patch);
  sendJson(ctx.res, 200, { data: updated });
  webhooks.emitBestEffort('stock.updated', updated);
};

const deleteStock = (ctx) => {
  const { supplierId, partNumber } = ctx.params;
  // Snapshot BEFORE deleting: the event payload carries the removed record.
  const snapshot = store.getStockItem(supplierId, partNumber);
  const ok = store.deleteStock(supplierId, partNumber);
  if (!ok) {
    return sendError(ctx.res, 404, `Part "${partNumber}" tidak ditemukan, tidak ada yang dihapus.`);
  }
  ctx.res.writeHead(204);
  ctx.res.end();
  if (snapshot) webhooks.emitBestEffort('stock.deleted', snapshot);
};

const bulkUpsertStock = (ctx) => {
  const { supplierId } = ctx.params;
  const supplier = store.getSupplier(supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return sendError(
      ctx.res,
      400,
      'Body harus berisi "items" berupa array minimal 1 item.',
      [{ field: 'items', issue: 'array tidak boleh kosong' }]
    );
  }
  // Validate each item; report all problems at once (friendly for students).
  const allErrors = [];
  const normalizedItems = [];
  body.items.forEach((item, i) => {
    const { valid, errors, normalized } = validateStockPayload(item);
    if (!valid) {
      errors.forEach((e) => allErrors.push({ index: i, ...e }));
    } else {
      normalizedItems.push(withStockDefaults(normalized, supplier));
    }
  });
  // ?mode=partial lets the valid items through and reports the rest (207).
  // Default stays strict/all-or-nothing so existing material and clients keep working.
  const isPartial = ctx.query && ctx.query.mode === 'partial';
  if (allErrors.length > 0 && !isPartial) {
    return sendError(ctx.res, 400, 'Sebagian item pada bulk sync tidak valid.', allErrors);
  }
  const result = store.bulkUpsertStock(supplierId, normalizedItems);
  // Only successfully written items (partial mode skips the invalid ones).
  emitStockUpdated(supplierId, normalizedItems.map((item) => item.part_number));
  if (isPartial && allErrors.length > 0) {
    const failedIndexes = new Set(allErrors.map((e) => e.index));
    return sendJson(ctx.res, 207, {
      message: 'Bulk upsert selesai sebagian (partial success).',
      summary: {
        received: body.items.length,
        succeeded: normalizedItems.length,
        failed: failedIndexes.size,
      },
      data: result,
      errors: allErrors,
    });
  }
  sendJson(ctx.res, 201, {
    message: 'Bulk upsert (integration sync) berhasil.',
    data: result,
  });
};

/**
 * Bulk replace — update many EXISTING parts in one request.
 * Distinct from bulkUpsertStock: this endpoint never creates a row.
 * Strict (default) is all-or-nothing: validate every item AND verify every
 * part exists before touching the store. ?mode=partial skips invalid/missing
 * items, applies the rest, and answers 207.
 */
const bulkReplaceStock = (ctx) => {
  const { supplierId } = ctx.params;
  const supplier = store.getSupplier(supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return sendError(
      ctx.res,
      400,
      'Body harus berisi "items" berupa array minimal 1 item.',
      [{ field: 'items', issue: 'array tidak boleh kosong' }]
    );
  }

  // Duplicate part_number in one batch would make the result ambiguous -> 400.
  const seen = new Set();
  const duplicateErrors = [];
  body.items.forEach((item, i) => {
    const raw = item && item.part_number;
    if (raw === undefined || raw === null || raw === '') return; // validation reports it
    const partNumber = String(raw);
    if (seen.has(partNumber)) {
      duplicateErrors.push({
        index: i,
        field: 'part_number',
        issue: `duplikat part_number "${partNumber}" di dalam items`,
      });
    } else {
      seen.add(partNumber);
    }
  });
  if (duplicateErrors.length > 0) {
    return sendError(ctx.res, 400, 'Data bulk replace tidak valid.', duplicateErrors);
  }

  // Validate each item as a FULL replace (default partial=false) and keep the
  // original index so errors still point at the right element.
  const validationErrors = [];
  const validEntries = []; // { index, record }
  body.items.forEach((item, i) => {
    const { valid, errors, normalized } = validateStockPayload(item || {});
    if (!valid) {
      errors.forEach((e) => validationErrors.push({ index: i, ...e }));
    } else {
      // supplier_id/supplier_name come from the path's supplier; part_number
      // comes from the item and is never changed by the replacement.
      validEntries.push({ index: i, record: withStockDefaults(normalized, supplier) });
    }
  });

  const isPartial = ctx.query && ctx.query.mode === 'partial';

  if (!isPartial) {
    if (validationErrors.length > 0) {
      return sendError(ctx.res, 400, 'Data bulk replace tidak valid.', validationErrors);
    }
    // Store checks existence atomically: if anything is missing, nothing is written.
    const result = store.bulkReplaceStock(supplierId, validEntries.map((e) => e.record));
    if (result.missing) {
      const details = validEntries
        .filter((e) => result.missing.includes(e.record.part_number))
        .map((e) => ({
          index: e.index,
          field: 'part_number',
          issue: `part "${e.record.part_number}" tidak ditemukan`,
        }));
      return sendError(
        ctx.res,
        404,
        'Sebagian part tidak ditemukan, tidak ada data yang diubah.',
        details
      );
    }
    emitStockUpdated(supplierId, validEntries.map((e) => e.record.part_number));
    return sendJson(ctx.res, 200, {
      message: 'Bulk replace berhasil (semua item diperbarui).',
      data: result,
    });
  }

  // ?mode=partial: keep only valid items that already exist, report the rest.
  const missingErrors = [];
  const existingRecords = [];
  for (const entry of validEntries) {
    if (store.getStockItem(supplierId, entry.record.part_number)) {
      existingRecords.push(entry.record);
    } else {
      missingErrors.push({
        index: entry.index,
        field: 'part_number',
        issue: `part "${entry.record.part_number}" tidak ditemukan`,
      });
    }
  }
  const allErrors = validationErrors
    .concat(missingErrors)
    .sort((a, b) => a.index - b.index);
  const result =
    existingRecords.length > 0
      ? store.bulkReplaceStock(supplierId, existingRecords)
      : { updated: 0, items: [] };
  // Skipped (invalid/missing) items emit nothing.
  emitStockUpdated(supplierId, existingRecords.map((r) => r.part_number));
  if (allErrors.length > 0) {
    return sendJson(ctx.res, 207, {
      message: 'Bulk replace selesai sebagian (partial success).',
      summary: {
        received: body.items.length,
        succeeded: result.updated,
        failed: body.items.length - result.updated,
      },
      data: result,
      errors: allErrors,
    });
  }
  sendJson(ctx.res, 200, {
    message: 'Bulk replace berhasil (semua item diperbarui).',
    data: result,
  });
};

/**
 * Bulk patch — partial-update many EXISTING parts in one request.
 * Mirrors bulkReplaceStock but each item only changes the fields it sends.
 * Never creates a row. Strict (default) is all-or-nothing; ?mode=partial
 * skips invalid/missing items, applies the rest, and answers 207.
 */
const bulkPatchStock = (ctx) => {
  const { supplierId } = ctx.params;
  if (!store.getSupplier(supplierId)) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return sendError(
      ctx.res,
      400,
      'Body harus berisi "items" berupa array minimal 1 item.',
      [{ field: 'items', issue: 'array tidak boleh kosong' }]
    );
  }

  // Duplicate part_number in one batch would make the result ambiguous -> 400.
  const seen = new Set();
  const duplicateErrors = [];
  body.items.forEach((item, i) => {
    const raw = item && item.part_number;
    if (raw === undefined || raw === null || raw === '') return; // validation reports it
    const partNumber = String(raw);
    if (seen.has(partNumber)) {
      duplicateErrors.push({
        index: i,
        field: 'part_number',
        issue: `duplikat part_number "${partNumber}" di dalam items`,
      });
    } else {
      seen.add(partNumber);
    }
  });
  if (duplicateErrors.length > 0) {
    return sendError(ctx.res, 400, 'Data bulk patch tidak valid.', duplicateErrors);
  }

  // Validate each item as a PARTIAL update. validateStockPayload(partial:true)
  // does not require part_number, so enforce it explicitly as the item identity.
  const validationErrors = [];
  const validEntries = []; // { index, patch }
  body.items.forEach((item, i) => {
    const payload = item || {};
    const { errors, normalized } = validateStockPayload(payload, { partial: true });
    const hasPartNumber =
      payload.part_number !== undefined &&
      payload.part_number !== null &&
      String(payload.part_number).trim() !== '';
    if (!hasPartNumber) {
      errors.push({ field: 'part_number', issue: 'field wajib tidak boleh kosong' });
    }
    if (errors.length > 0) {
      errors.forEach((e) => validationErrors.push({ index: i, ...e }));
    } else {
      // supplier_id comes from the path; part_number stays the item's identity.
      if (!normalized.last_updated) normalized.last_updated = nowIso();
      validEntries.push({ index: i, patch: normalized });
    }
  });

  const isPartial = ctx.query && ctx.query.mode === 'partial';

  if (!isPartial) {
    if (validationErrors.length > 0) {
      return sendError(ctx.res, 400, 'Data bulk patch tidak valid.', validationErrors);
    }
    // Store checks existence atomically: if anything is missing, nothing is written.
    const result = store.bulkPatchStock(supplierId, validEntries.map((e) => e.patch));
    if (result.missing) {
      const details = validEntries
        .filter((e) => result.missing.includes(e.patch.part_number))
        .map((e) => ({
          index: e.index,
          field: 'part_number',
          issue: `part "${e.patch.part_number}" tidak ditemukan`,
        }));
      return sendError(
        ctx.res,
        404,
        'Sebagian part tidak ditemukan, tidak ada data yang diubah.',
        details
      );
    }
    emitStockUpdated(supplierId, validEntries.map((e) => e.patch.part_number));
    return sendJson(ctx.res, 200, {
      message: 'Bulk patch berhasil (semua item diperbarui).',
      data: result,
    });
  }

  // ?mode=partial: keep only valid items that already exist, report the rest.
  const missingErrors = [];
  const existingPatches = [];
  for (const entry of validEntries) {
    if (store.getStockItem(supplierId, entry.patch.part_number)) {
      existingPatches.push(entry.patch);
    } else {
      missingErrors.push({
        index: entry.index,
        field: 'part_number',
        issue: `part "${entry.patch.part_number}" tidak ditemukan`,
      });
    }
  }
  const allErrors = validationErrors
    .concat(missingErrors)
    .sort((a, b) => a.index - b.index);
  const result =
    existingPatches.length > 0
      ? store.bulkPatchStock(supplierId, existingPatches)
      : { updated: 0, items: [] };
  // Skipped (invalid/missing) items emit nothing.
  emitStockUpdated(supplierId, existingPatches.map((p) => p.part_number));
  if (allErrors.length > 0) {
    return sendJson(ctx.res, 207, {
      message: 'Bulk patch selesai sebagian (partial success).',
      summary: {
        received: body.items.length,
        succeeded: result.updated,
        failed: body.items.length - result.updated,
      },
      data: result,
      errors: allErrors,
    });
  }
  sendJson(ctx.res, 200, {
    message: 'Bulk patch berhasil (semua item diperbarui).',
    data: result,
  });
};

// ---- production planning ------------------------------------------------

const listProductionPlans = (ctx) => {
  const { supplierId } = ctx.params;
  const supplier = store.getSupplier(supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const result = store.listProductionPlans(supplierId, {
    status: ctx.query.status,
    updated_since: ctx.query.updated_since,
    page: parseIntOr(ctx.query.page, 1),
    limit: parseIntOr(ctx.query.limit, 10),
    sort: ctx.query.sort,
  });
  sendJson(ctx.res, 200, result);
};

/** GET /api/v1/production-plans — plans across all suppliers. */
const listAllProductionPlans = (ctx) => {
  const result = store.listAllProductionPlans({
    supplier_id: ctx.query.supplier_id,
    status: ctx.query.status,
    part_number: ctx.query.part_number,
    q: ctx.query.q,
    updated_since: ctx.query.updated_since,
    page: ctx.query.page,
    limit: ctx.query.limit,
    sort: ctx.query.sort,
  });
  sendJson(ctx.res, 200, result);
};

const getProductionPlan = (ctx) => {
  const plan = store.getProductionPlan(ctx.params.planId);
  if (!plan) {
    return sendError(ctx.res, 404, `Production plan "${ctx.params.planId}" tidak ditemukan.`);
  }
  sendJson(ctx.res, 200, { data: plan });
};

const createProductionPlan = (ctx) => {
  const { supplierId } = ctx.params;
  const supplier = store.getSupplier(supplierId);
  if (!supplier) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  const { valid, errors } = validatePlanPayload(body);
  if (!valid) {
    return sendError(ctx.res, 400, 'Data production plan tidak valid.', errors);
  }
  const created = store.createProductionPlan({
    supplier_id: supplierId,
    part_number: body.part_number,
    part_name: body.part_name,
    production_plan: body.production_plan,
    planned_quantity: Number(body.planned_quantity),
    production_date: body.production_date,
    production_status: body.production_status,
    delivery_schedule: body.delivery_schedule,
    last_updated: body.last_updated || nowIso(),
  });
  sendJson(
    ctx.res,
    201,
    { data: created },
    { Location: `/api/v1/production-plans/${created.plan_id}` }
  );
  webhooks.emitBestEffort('plan.created', created);
};

/** Identity is immutable: plan_id/supplier_id may not change via an update. */
function planIdentityErrors(body, plan) {
  const errors = [];
  if (
    body.plan_id !== undefined &&
    body.plan_id !== null &&
    String(body.plan_id).trim() !== String(plan.plan_id)
  ) {
    errors.push({ field: 'plan_id', issue: 'tidak boleh berbeda dari planId di path' });
  }
  if (
    body.supplier_id !== undefined &&
    body.supplier_id !== null &&
    String(body.supplier_id).trim() !== String(plan.supplier_id)
  ) {
    errors.push({ field: 'supplier_id', issue: 'tidak boleh berbeda dari supplier_id plan' });
  }
  return errors;
}

/** Shared: duplicate plan_id detection for both bulk plan handlers. */
function findDuplicatePlanErrors(items) {
  const seen = new Set();
  const duplicates = [];
  items.forEach((item, i) => {
    const raw = item && item.plan_id;
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    const planId = String(raw).trim();
    if (seen.has(planId)) {
      duplicates.push({
        index: i,
        field: 'plan_id',
        issue: `duplikat plan_id "${planId}" di dalam items`,
      });
    } else {
      seen.add(planId);
    }
  });
  return duplicates;
}

/** PUT /api/v1/production-plans/:planId — full replace (identity immutable). */
const replaceProductionPlan = (ctx) => {
  const { planId } = ctx.params;
  const plan = store.getProductionPlan(planId);
  if (!plan) {
    return sendError(ctx.res, 404, `Production plan "${planId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  const identityErrors = planIdentityErrors(body, plan);
  if (identityErrors.length > 0) {
    return sendError(ctx.res, 400, 'Data production plan tidak valid.', identityErrors);
  }
  const { valid, errors, normalized } = validatePlanPayload(body);
  if (!valid) {
    return sendError(ctx.res, 400, 'Data production plan tidak valid.', errors);
  }
  if (!normalized.last_updated) normalized.last_updated = nowIso();
  const updated = store.replaceProductionPlan(planId, normalized);
  sendJson(ctx.res, 200, {
    message: 'Production plan berhasil di-replace (full replace).',
    data: updated,
  });
  webhooks.emitBestEffort('plan.updated', updated);
};

/** PATCH /api/v1/production-plans/:planId — partial update (merge). */
const patchProductionPlan = (ctx) => {
  const { planId } = ctx.params;
  const plan = store.getProductionPlan(planId);
  if (!plan) {
    return sendError(ctx.res, 404, `Production plan "${planId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  const identityErrors = planIdentityErrors(body, plan);
  if (identityErrors.length > 0) {
    return sendError(ctx.res, 400, 'Data production plan tidak valid.', identityErrors);
  }
  const { valid, errors, normalized } = validatePlanPayload(body, { partial: true });
  if (!valid) {
    return sendError(ctx.res, 400, 'Data production plan tidak valid.', errors);
  }
  // plan_id/supplier_id are identity-only and may not be changed by a patch.
  const patch = { ...normalized };
  delete patch.plan_id;
  delete patch.supplier_id;
  if (!patch.last_updated) patch.last_updated = nowIso();
  const updated = store.patchProductionPlan(planId, patch);
  sendJson(ctx.res, 200, {
    message: 'Production plan berhasil di-patch (partial update).',
    data: updated,
  });
  webhooks.emitBestEffort('plan.updated', updated);
};

/** PUT /api/v1/suppliers/:supplierId/production-plans/bulk — batch full replace. */
const bulkReplaceProductionPlans = (ctx) => {
  const { supplierId } = ctx.params;
  if (!store.getSupplier(supplierId)) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return sendError(
      ctx.res,
      400,
      'Body harus berisi "items" berupa array minimal 1 item.',
      [{ field: 'items', issue: 'array tidak boleh kosong' }]
    );
  }

  const duplicates = findDuplicatePlanErrors(body.items);
  if (duplicates.length > 0) {
    return sendError(ctx.res, 400, 'Data bulk replace production plan tidak valid.', duplicates);
  }

  const validationErrors = [];
  const validEntries = []; // { index, record }
  body.items.forEach((item, i) => {
    const payload = item || {};
    const { errors, normalized } = validatePlanPayload(payload);
    // plan_id is the batch identity and must be present even though the
    // generic validator ignores identity fields.
    const hasPlanId =
      payload.plan_id !== undefined &&
      payload.plan_id !== null &&
      String(payload.plan_id).trim() !== '';
    if (!hasPlanId) {
      errors.push({ field: 'plan_id', issue: 'field wajib tidak boleh kosong' });
    }
    // Items may not target a different supplier than the path.
    if (
      payload.supplier_id !== undefined &&
      payload.supplier_id !== null &&
      String(payload.supplier_id).trim() !== String(supplierId)
    ) {
      errors.push({ field: 'supplier_id', issue: 'tidak boleh berbeda dari supplierId di path' });
    }
    if (errors.length > 0) {
      errors.forEach((e) => validationErrors.push({ index: i, ...e }));
    } else {
      if (!normalized.last_updated) normalized.last_updated = nowIso();
      validEntries.push({
        index: i,
        record: {
          ...normalized,
          plan_id: String(payload.plan_id).trim(),
          supplier_id: supplierId,
        },
      });
    }
  });

  const isPartial = ctx.query && ctx.query.mode === 'partial';

  if (!isPartial) {
    if (validationErrors.length > 0) {
      return sendError(ctx.res, 400, 'Data bulk replace production plan tidak valid.', validationErrors);
    }
    // Store checks plan_id AND supplier_id atomically: nothing is written on a miss.
    const result = store.bulkReplaceProductionPlans(
      supplierId,
      validEntries.map((e) => e.record)
    );
    if (result.missing) {
      const details = validEntries
        .filter((e) => result.missing.includes(e.record.plan_id))
        .map((e) => ({
          index: e.index,
          field: 'plan_id',
          issue: `plan "${e.record.plan_id}" tidak ditemukan untuk supplier "${supplierId}"`,
        }));
      return sendError(
        ctx.res,
        404,
        'Sebagian production plan tidak ditemukan, tidak ada data yang diubah.',
        details
      );
    }
    emitPlanUpdated(supplierId, validEntries.map((e) => e.record.plan_id));
    return sendJson(ctx.res, 200, {
      message: 'Bulk replace production plan berhasil (semua item diperbarui).',
      data: result,
    });
  }

  // ?mode=partial: keep valid items that exist for this supplier, report the rest.
  const missingErrors = [];
  const existingRecords = [];
  for (const entry of validEntries) {
    const existing = store.getProductionPlan(entry.record.plan_id);
    if (existing && existing.supplier_id === supplierId) {
      existingRecords.push(entry.record);
    } else {
      missingErrors.push({
        index: entry.index,
        field: 'plan_id',
        issue: `plan "${entry.record.plan_id}" tidak ditemukan untuk supplier "${supplierId}"`,
      });
    }
  }
  const allErrors = validationErrors
    .concat(missingErrors)
    .sort((a, b) => a.index - b.index);
  const result =
    existingRecords.length > 0
      ? store.bulkReplaceProductionPlans(supplierId, existingRecords)
      : { updated: 0, items: [] };
  // Skipped (invalid/missing) items emit nothing.
  emitPlanUpdated(supplierId, existingRecords.map((r) => r.plan_id));
  if (allErrors.length > 0) {
    return sendJson(ctx.res, 207, {
      message: 'Bulk replace production plan selesai sebagian (partial success).',
      summary: {
        received: body.items.length,
        succeeded: result.updated,
        failed: body.items.length - result.updated,
      },
      data: result,
      errors: allErrors,
    });
  }
  sendJson(ctx.res, 200, {
    message: 'Bulk replace production plan berhasil (semua item diperbarui).',
    data: result,
  });
};

/** PATCH /api/v1/suppliers/:supplierId/production-plans/bulk — batch partial update. */
const bulkPatchProductionPlans = (ctx) => {
  const { supplierId } = ctx.params;
  if (!store.getSupplier(supplierId)) {
    return sendError(ctx.res, 404, `Supplier "${supplierId}" tidak ditemukan.`);
  }
  const body = ctx.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return sendError(
      ctx.res,
      400,
      'Body harus berisi "items" berupa array minimal 1 item.',
      [{ field: 'items', issue: 'array tidak boleh kosong' }]
    );
  }

  const duplicates = findDuplicatePlanErrors(body.items);
  if (duplicates.length > 0) {
    return sendError(ctx.res, 400, 'Data bulk patch production plan tidak valid.', duplicates);
  }

  // Partial validation does not require plan_id, so enforce it as the identity.
  const validationErrors = [];
  const validEntries = []; // { index, planId, patch }
  body.items.forEach((item, i) => {
    const payload = item || {};
    const { errors, normalized } = validatePlanPayload(payload, { partial: true });
    const hasPlanId =
      payload.plan_id !== undefined &&
      payload.plan_id !== null &&
      String(payload.plan_id).trim() !== '';
    if (!hasPlanId) {
      errors.push({ field: 'plan_id', issue: 'field wajib tidak boleh kosong' });
    }
    if (
      payload.supplier_id !== undefined &&
      payload.supplier_id !== null &&
      String(payload.supplier_id).trim() !== String(supplierId)
    ) {
      errors.push({ field: 'supplier_id', issue: 'tidak boleh berbeda dari supplierId di path' });
    }
    if (errors.length > 0) {
      errors.forEach((e) => validationErrors.push({ index: i, ...e }));
    } else {
      const patch = { ...normalized };
      delete patch.plan_id; // identity is immutable
      delete patch.supplier_id;
      if (!patch.last_updated) patch.last_updated = nowIso();
      validEntries.push({ index: i, planId: String(payload.plan_id).trim(), patch });
    }
  });

  const isPartial = ctx.query && ctx.query.mode === 'partial';

  if (!isPartial) {
    if (validationErrors.length > 0) {
      return sendError(ctx.res, 400, 'Data bulk patch production plan tidak valid.', validationErrors);
    }
    const result = store.bulkPatchProductionPlans(
      supplierId,
      validEntries.map((e) => ({ ...e.patch, plan_id: e.planId }))
    );
    if (result.missing) {
      const details = validEntries
        .filter((e) => result.missing.includes(e.planId))
        .map((e) => ({
          index: e.index,
          field: 'plan_id',
          issue: `plan "${e.planId}" tidak ditemukan untuk supplier "${supplierId}"`,
        }));
      return sendError(
        ctx.res,
        404,
        'Sebagian production plan tidak ditemukan, tidak ada data yang diubah.',
        details
      );
    }
    emitPlanUpdated(supplierId, validEntries.map((e) => e.planId));
    return sendJson(ctx.res, 200, {
      message: 'Bulk patch production plan berhasil (semua item diperbarui).',
      data: result,
    });
  }

  // ?mode=partial: keep valid items that exist for this supplier, report the rest.
  const missingErrors = [];
  const existingPatches = [];
  for (const entry of validEntries) {
    const existing = store.getProductionPlan(entry.planId);
    if (existing && existing.supplier_id === supplierId) {
      existingPatches.push({ ...entry.patch, plan_id: entry.planId });
    } else {
      missingErrors.push({
        index: entry.index,
        field: 'plan_id',
        issue: `plan "${entry.planId}" tidak ditemukan untuk supplier "${supplierId}"`,
      });
    }
  }
  const allErrors = validationErrors
    .concat(missingErrors)
    .sort((a, b) => a.index - b.index);
  const result =
    existingPatches.length > 0
      ? store.bulkPatchProductionPlans(supplierId, existingPatches)
      : { updated: 0, items: [] };
  // Skipped (invalid/missing) items emit nothing.
  emitPlanUpdated(supplierId, existingPatches.map((p) => p.plan_id));
  if (allErrors.length > 0) {
    return sendJson(ctx.res, 207, {
      message: 'Bulk patch production plan selesai sebagian (partial success).',
      summary: {
        received: body.items.length,
        succeeded: result.updated,
        failed: body.items.length - result.updated,
      },
      data: result,
      errors: allErrors,
    });
  }
  sendJson(ctx.res, 200, {
    message: 'Bulk patch production plan berhasil (semua item diperbarui).',
    data: result,
  });
};

module.exports = {
  negotiateStockAccept,
  health,
  createToken,
  simulateCode,
  getRateLimit,
  createWebhookSubscription,
  listWebhookSubscriptions,
  deleteWebhookSubscription,
  testWebhookSubscription,
  listWebhookDeliveries,
  listSuppliers,
  getSupplier,
  createSupplier,
  replaceSupplier,
  patchSupplier,
  bulkReplaceSuppliers,
  bulkPatchSuppliers,
  listStock,
  listAllStock,
  getStockItem,
  createStock,
  replaceStock,
  patchStock,
  deleteStock,
  bulkUpsertStock,
  bulkReplaceStock,
  bulkPatchStock,
  listProductionPlans,
  listAllProductionPlans,
  getProductionPlan,
  createProductionPlan,
  replaceProductionPlan,
  patchProductionPlan,
  bulkReplaceProductionPlans,
  bulkPatchProductionPlans,
};
