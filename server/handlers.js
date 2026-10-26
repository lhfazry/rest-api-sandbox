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

function validatePlanPayload(body) {
  const errors = [];
  const required = [
    'part_number',
    'part_name',
    'production_plan',
    'planned_quantity',
    'production_date',
    'production_status',
    'delivery_schedule',
  ];
  for (const f of required) {
    const v = body[f];
    if (v === undefined || v === null || v === '') {
      errors.push({ field: f, issue: 'field wajib tidak boleh kosong' });
    }
  }
  const qty = Number(body.planned_quantity);
  if (body.planned_quantity !== undefined && (Number.isNaN(qty) || qty < 0)) {
    errors.push({ field: 'planned_quantity', issue: 'harus angka >= 0' });
  }
  if (body.production_status && !PRODUCTION_STATUS_VALUES.includes(body.production_status)) {
    errors.push({
      field: 'production_status',
      issue: `harus salah satu dari ${PRODUCTION_STATUS_VALUES.join(', ')}`,
    });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a supplier payload. Returns { valid, errors, normalized }.
 * supplier_id is normalized to uppercase so "sup-004" and "SUP-004" collide
 * as the same supplier. Unknown fields are ignored on purpose.
 */
function validateSupplierPayload(body) {
  const errors = [];
  const out = {};
  const has = (f) => body[f] !== undefined && body[f] !== null && String(body[f]).trim() !== '';

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

// ---- suppliers ----------------------------------------------------------

const listSuppliers = (ctx) => {
  const data = store.listSuppliers();
  sendJson(ctx.res, 200, { data, meta: { total: data.length } });
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
};

const deleteStock = (ctx) => {
  const { supplierId, partNumber } = ctx.params;
  const ok = store.deleteStock(supplierId, partNumber);
  if (!ok) {
    return sendError(ctx.res, 404, `Part "${partNumber}" tidak ditemukan, tidak ada yang dihapus.`);
  }
  ctx.res.writeHead(204);
  ctx.res.end();
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
    page: parseIntOr(ctx.query.page, 1),
    limit: parseIntOr(ctx.query.limit, 10),
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
};

module.exports = {
  health,
  createToken,
  simulateCode,
  listSuppliers,
  getSupplier,
  createSupplier,
  listStock,
  getStockItem,
  createStock,
  replaceStock,
  patchStock,
  deleteStock,
  bulkUpsertStock,
  bulkReplaceStock,
  bulkPatchStock,
  listProductionPlans,
  getProductionPlan,
  createProductionPlan,
};
