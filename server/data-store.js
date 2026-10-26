'use strict';

/**
 * data-store.js — In-memory data layer with optional file persistence.
 *
 * WHY: The sandbox has ZERO dependencies and no database. At startup we read
 * the seed JSON files once into memory. Every mutation (POST/PUT/PATCH/DELETE)
 * changes the in-memory arrays.
 *
 * DEFAULT (local/classroom): in-memory only, so restarting the server resets
 * the demo to a clean, known state — perfect for a classroom.
 *
 * PERSIST_DATA=1: state is snapshotted to data/store/state.json (or
 * DATA_STORE_DIR/state.json) after every mutation and reloaded on boot, so
 * mutations survive container restarts/redeploys when that directory lives on
 * a mounted volume.
 *
 * All query features the course needs (filtering, pagination, sorting) live
 * here so handlers stay thin.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_DIR = process.env.DATA_STORE_DIR
  ? path.resolve(process.env.DATA_STORE_DIR)
  : path.join(DATA_DIR, 'store');
const STATE_FILE = path.join(STORE_DIR, 'state.json');
const PERSIST = /^(1|true)$/i.test(process.env.PERSIST_DATA || '');

function loadJson(fileName) {
  const full = path.join(DATA_DIR, fileName);
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw);
}

// Deep-clone seed data so the in-memory store never aliases the parsed object
// graph in a way a mutation could accidentally share between records.
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---- In-memory state (seeded at startup) --------------------------------
let suppliers = [];
let stock = [];
let productionPlans = [];
let planCounter = 0;

// Unique suffix for the temp file so concurrent writes in the same process
// (and across restarted PIDs) never collide.
let persistSeq = 0;

/**
 * Revision counter backing the ETag cache validator. It changes on every
 * successful mutation AND once at seed time, regardless of PERSIST_DATA.
 * WHY a counter and not a hash of the data: it is cheap, monotonic and cannot
 * collide for two different states.
 */
let revision = 0;

function bumpRevision() {
  revision += 1;
}

function getRevision() {
  return revision;
}

/**
 * Snapshot the current state to STATE_FILE. No-op unless PERSIST_DATA is on.
 * Failures are logged and swallowed: the API keeps serving from memory.
 * Every mutation funnels through here, so the revision bump lives here too.
 */
function persist() {
  bumpRevision();
  if (!PERSIST) return;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    persistSeq += 1;
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.${persistSeq}.tmp`;
    const payload = JSON.stringify({
      version: 1,
      saved_at: new Date().toISOString(),
      planCounter,
      suppliers,
      stock,
      productionPlans,
    });
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[data] gagal menyimpan state:', err.message);
  }
}

/**
 * Load a previously persisted snapshot. Returns true on success, false when
 * persistence is off, the file is missing/empty, or the content is corrupt.
 */
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    console.warn('[data] state belum ada, memakai seed JSON');
    return false;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw.trim()) throw new Error('file kosong');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('format tidak valid');
    // Never treat a partial/incomplete snapshot as empty state: falling back to
    // the seed files is safer than silently wiping the volume.
    if (
      !Array.isArray(parsed.suppliers) ||
      !Array.isArray(parsed.stock) ||
      !Array.isArray(parsed.productionPlans)
    ) {
      throw new Error('struktur state tidak lengkap');
    }
    suppliers = clone(parsed.suppliers);
    stock = clone(parsed.stock);
    productionPlans = clone(parsed.productionPlans);
    planCounter = Number.isFinite(Number(parsed.planCounter))
      ? Number(parsed.planCounter)
      : productionPlans.length;
    return true;
  } catch (err) {
    console.warn('[data] state rusak/tidak terbaca, fallback ke seed JSON:', err.message);
    return false;
  }
}

function seed() {
  if (!(PERSIST && loadState())) {
    suppliers = clone(loadJson('suppliers.json'));
    stock = clone(loadJson('stock.json'));
    productionPlans = clone(loadJson('production_plans.json'));
    planCounter = productionPlans.length;
    // Create state.json immediately so the volume starts with a snapshot.
    if (PERSIST) persist();
  }
  // Seed initialisation is itself a state change: start the ETag lineage here.
  bumpRevision();
  if (PERSIST) console.log('[data] persistence ON -> ' + STATE_FILE);
}

seed(); // load immediately on require()

// ---- Shared query helpers (filter / sort / paginate) --------------------

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** page: non-numeric or < 1 falls back to 1. */
function normalizePage(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

/** limit: default 10, capped at 50, floored at 1. */
function normalizeLimit(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/**
 * Paginate a filtered row array. `total_pages` is 0 when nothing matched, for
 * every list endpoint (nested and global alike), and at least 1 otherwise.
 */
function paginate(rows, opts = {}) {
  const page = normalizePage(opts.page);
  const limit = normalizeLimit(opts.limit);
  const total = rows.length;
  const total_pages = total === 0 ? 0 : Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const data = clone(rows.slice(start, start + limit));
  return { data, meta: { total, page, limit, total_pages } };
}

/** True when the caller actually sent a usable filter value. */
function hasFilter(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function containsIgnoreCase(haystack, needle) {
  return String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());
}

/** Parse "field:asc|desc". Unknown direction means ascending. */
function parseSort(sort) {
  if (!hasFilter(sort)) return null;
  const [field, dirRaw] = String(sort).split(':');
  return { field, dir: dirRaw === 'desc' ? -1 : 1 };
}

/** Numeric view of a value, or null when it is not a finite number. */
function toNumberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const NUMERIC_SORT_FIELDS = new Set(['stock_quantity', 'unit_price', 'planned_quantity']);
const DATE_SORT_FIELDS = new Set(['last_updated', 'production_date', 'delivery_schedule']);

/**
 * Comparator tolerant of the seed anomalies (string quantities, null cells,
 * missing fields): numbers compare numerically, dates chronologically,
 * everything else as strings. Missing values always sort last.
 */
function buildComparator(field, dir) {
  return (a, b) => {
    const av = a[field];
    const bv = b[field];
    const aMissing = av === undefined || av === null || av === '';
    const bMissing = bv === undefined || bv === null || bv === '';
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;

    if (DATE_SORT_FIELDS.has(field)) {
      const at = Date.parse(av);
      const bt = Date.parse(bv);
      if (!Number.isNaN(at) && !Number.isNaN(bt)) return (at - bt) * dir;
    }

    const an = toNumberOrNull(av);
    const bn = toNumberOrNull(bv);
    const numericOnly =
      NUMERIC_SORT_FIELDS.has(field) || (an !== null && bn !== null);
    if (numericOnly && an !== null && bn !== null) return (an - bn) * dir;

    return String(av).localeCompare(String(bv)) * dir;
  };
}

/** Sort a copy of rows when `sort` names an allowed field; else keep order. */
function applySort(rows, sort, allowedFields) {
  const parsed = parseSort(sort);
  if (!parsed || !allowedFields.includes(parsed.field)) return rows;
  return rows.slice().sort(buildComparator(parsed.field, parsed.dir));
}

/** updated_since accepts any ISO date-time; unparseable values are ignored. */
function filterUpdatedSince(rows, updatedSince) {
  if (!hasFilter(updatedSince)) return rows;
  const since = Date.parse(updatedSince);
  if (Number.isNaN(since)) return rows;
  return rows.filter((r) => Date.parse(r.last_updated) >= since);
}

// ---- Suppliers ----------------------------------------------------------

const SUPPLIER_SORT_FIELDS = ['supplier_id', 'supplier_name', 'country', 'api_status'];

/**
 * List suppliers with filtering + pagination + sorting.
 * @param {{api_status?:string,country?:string,q?:string,page?:*,limit?:*,sort?:string}} opts
 */
function listSuppliers(opts = {}) {
  let rows = suppliers;

  if (hasFilter(opts.api_status)) {
    // Exact match only. An unknown value is a legitimate "no results" filter,
    // not a validation error (students learn filtering by observation).
    rows = rows.filter((s) => s.api_status === opts.api_status);
  }
  if (hasFilter(opts.country)) {
    const country = String(opts.country).toLowerCase();
    rows = rows.filter((s) => String(s.country ?? '').toLowerCase() === country);
  }
  if (hasFilter(opts.q)) {
    rows = rows.filter(
      (s) =>
        containsIgnoreCase(s.supplier_id, opts.q) ||
        containsIgnoreCase(s.supplier_name, opts.q)
    );
  }

  rows = applySort(rows, opts.sort, SUPPLIER_SORT_FIELDS);
  return paginate(rows, opts);
}

function getSupplier(supplierId) {
  const found = suppliers.find((s) => s.supplier_id === supplierId);
  return found ? clone(found) : null;
}

function findSupplierIndex(supplierId) {
  return suppliers.findIndex((s) => s.supplier_id === supplierId);
}

function createSupplier(record) {
  suppliers.push(clone(record));
  persist();
  return clone(record);
}

/** Full replace: identity is forced from the existing record. */
function replaceSupplier(supplierId, record) {
  const idx = findSupplierIndex(supplierId);
  if (idx === -1) return null;
  suppliers[idx] = clone({ ...record, supplier_id: suppliers[idx].supplier_id });
  persist();
  return clone(suppliers[idx]);
}

/** Partial update: merge the patch, identity fields stay immutable. */
function patchSupplier(supplierId, patch) {
  const idx = findSupplierIndex(supplierId);
  if (idx === -1) return null;
  const current = suppliers[idx];
  const next = { ...current, ...clone(patch) };
  next.supplier_id = current.supplier_id;
  suppliers[idx] = next;
  persist();
  return clone(next);
}

/**
 * Bulk replace suppliers — never creates. Pre-checks every supplier_id so a
 * missing supplier leaves the store untouched; then writes in one pass and
 * persists once. Returns { missing: [ids] } or { updated, items }.
 */
function bulkReplaceSuppliers(items) {
  const targets = new Map(); // supplier index -> replacement record
  const missing = [];
  for (const record of items) {
    const idx = findSupplierIndex(record.supplier_id);
    if (idx === -1) {
      missing.push(record.supplier_id);
    } else {
      targets.set(idx, record);
    }
  }
  if (missing.length > 0) return { missing };
  for (const [idx, record] of targets) {
    suppliers[idx] = clone({ ...record, supplier_id: suppliers[idx].supplier_id });
  }
  persist();
  return {
    updated: items.length,
    items: items.map((record) => ({ supplier_id: record.supplier_id, action: 'updated' })),
  };
}

/** Bulk patch suppliers — merge-only, atomic, never creates. */
function bulkPatchSuppliers(items) {
  const targets = new Map(); // supplier index -> patch
  const missing = [];
  for (const patch of items) {
    const idx = findSupplierIndex(patch.supplier_id);
    if (idx === -1) {
      missing.push(patch.supplier_id);
    } else {
      targets.set(idx, patch);
    }
  }
  if (missing.length > 0) return { missing };
  for (const [idx, patch] of targets) {
    const current = suppliers[idx];
    const next = { ...current, ...clone(patch) };
    next.supplier_id = current.supplier_id;
    suppliers[idx] = next;
  }
  persist();
  return {
    updated: items.length,
    items: items.map((patch) => ({ supplier_id: patch.supplier_id, action: 'updated' })),
  };
}

// ---- Stock --------------------------------------------------------------
// A stock row is uniquely identified by (supplier_id, part_number).

function findStockIndex(supplierId, partNumber) {
  return stock.findIndex(
    (r) => r.supplier_id === supplierId && r.part_number === partNumber
  );
}

const STOCK_SORT_FIELDS = [
  'part_number',
  'stock_quantity',
  'last_updated',
  'supplier_id',
  'unit_price',
];

/**
 * List stock for one supplier with optional filter/sort/pagination.
 * @param {string} supplierId
 * @param {{status?:string,page?:*,limit?:*,updated_since?:string,sort?:string}} opts
 */
function listStock(supplierId, opts = {}) {
  let rows = stock.filter((r) => r.supplier_id === supplierId);

  if (hasFilter(opts.status)) {
    rows = rows.filter((r) => r.stock_status === opts.status);
  }
  rows = filterUpdatedSince(rows, opts.updated_since);
  rows = applySort(rows, opts.sort, STOCK_SORT_FIELDS);

  return paginate(rows, opts);
}

/**
 * Global stock list (all suppliers) with the same filters as the nested list
 * plus part_number/q. Rows keep the nested shape (supplier_id + supplier_name).
 * @param {{supplier_id?:string,status?:string,part_number?:string,q?:string,
 *          updated_since?:string,page?:*,limit?:*,sort?:string}} opts
 */
function listAllStock(opts = {}) {
  let rows = stock;

  if (hasFilter(opts.supplier_id)) {
    rows = rows.filter((r) => r.supplier_id === opts.supplier_id);
  }
  if (hasFilter(opts.status)) {
    rows = rows.filter((r) => r.stock_status === opts.status);
  }
  if (hasFilter(opts.part_number)) {
    // Exact as stored: part numbers keep their original casing.
    rows = rows.filter((r) => r.part_number === opts.part_number);
  }
  if (hasFilter(opts.q)) {
    rows = rows.filter(
      (r) =>
        containsIgnoreCase(r.part_number, opts.q) || containsIgnoreCase(r.part_name, opts.q)
    );
  }
  rows = filterUpdatedSince(rows, opts.updated_since);
  rows = applySort(rows, opts.sort, STOCK_SORT_FIELDS);

  return paginate(rows, opts);
}

function getStockItem(supplierId, partNumber) {
  const idx = findStockIndex(supplierId, partNumber);
  return idx === -1 ? null : clone(stock[idx]);
}

function createStock(record) {
  stock.push(clone(record));
  persist();
  return clone(record);
}

function replaceStock(supplierId, partNumber, record) {
  const idx = findStockIndex(supplierId, partNumber);
  if (idx === -1) return null;
  stock[idx] = clone(record);
  persist();
  return clone(record);
}

function patchStock(supplierId, partNumber, patch) {
  const idx = findStockIndex(supplierId, partNumber);
  if (idx === -1) return null;
  // Entity key fields may not be changed through a PATCH.
  const next = { ...stock[idx], ...patch };
  next.supplier_id = stock[idx].supplier_id;
  next.part_number = stock[idx].part_number;
  stock[idx] = next;
  persist();
  return clone(next);
}

function deleteStock(supplierId, partNumber) {
  const idx = findStockIndex(supplierId, partNumber);
  if (idx === -1) return false;
  stock.splice(idx, 1);
  persist();
  return true;
}

/**
 * Bulk upsert — the "integration sync" endpoint.
 * For each item: update if (supplier_id, part_number) exists, else insert.
 * Returns a per-item result summary for the student to inspect.
 */
function bulkUpsertStock(supplierId, items) {
  const results = { created: 0, updated: 0, items: [] };
  for (const raw of items) {
    const record = { ...raw, supplier_id: supplierId };
    const idx = findStockIndex(supplierId, record.part_number);
    if (idx === -1) {
      stock.push(clone(record));
      results.created += 1;
      results.items.push({ part_number: record.part_number, action: 'created' });
    } else {
      stock[idx] = clone({ ...stock[idx], ...record });
      results.updated += 1;
      results.items.push({ part_number: record.part_number, action: 'updated' });
    }
  }
  persist();
  return results;
}

/**
 * Bulk replace — update existing rows only, all-or-nothing.
 * WHY: unlike upsert, a batch replace must NEVER create a row. We check every
 * (supplier_id, part_number) BEFORE writing, so one missing part leaves the
 * store untouched. Records passed in are already normalized by the handler.
 * Returns { missing: [partNumber] } when at least one part is absent (no
 * writes), otherwise { updated, items: [{ part_number, action: 'updated' }] }.
 */
function bulkReplaceStock(supplierId, items) {
  const replacements = new Map(); // stock index -> replacement record
  const missing = [];
  for (const raw of items) {
    const idx = findStockIndex(supplierId, raw.part_number);
    if (idx === -1) {
      missing.push(raw.part_number);
    } else {
      replacements.set(idx, raw);
    }
  }
  if (missing.length > 0) return { missing };
  // Every part exists: replace all matched rows in one pass, persist once.
  for (const [idx, raw] of replacements) {
    stock[idx] = clone({ ...raw, supplier_id: supplierId, part_number: raw.part_number });
  }
  persist();
  return {
    updated: items.length,
    items: items.map((raw) => ({ part_number: raw.part_number, action: 'updated' })),
  };
}

/**
 * Bulk patch — partial-update existing rows only, all-or-nothing.
 * Pre-checks every (supplier_id, part_number) so a missing part leaves the
 * store untouched. Identity fields are immutable: supplier_id comes from the
 * path and part_number from the existing row.
 * Returns { missing: [partNumber] } when at least one part is absent (no
 * writes), otherwise { updated, items: [{ part_number, action: 'updated' }] }.
 */
function bulkPatchStock(supplierId, patches) {
  const targets = new Map(); // stock index -> patch
  const missing = [];
  for (const patch of patches) {
    const idx = findStockIndex(supplierId, patch.part_number);
    if (idx === -1) {
      missing.push(patch.part_number);
    } else {
      targets.set(idx, patch);
    }
  }
  if (missing.length > 0) return { missing };
  // Every part exists: merge all patches in one pass, persist once.
  for (const [idx, patch] of targets) {
    const current = stock[idx];
    const next = { ...current, ...clone(patch) };
    next.supplier_id = current.supplier_id;
    next.part_number = current.part_number;
    stock[idx] = next;
  }
  persist();
  return {
    updated: patches.length,
    items: patches.map((patch) => ({ part_number: patch.part_number, action: 'updated' })),
  };
}

// ---- Production plans ---------------------------------------------------

const PLAN_SORT_FIELDS = [
  'plan_id',
  'production_date',
  'delivery_schedule',
  'last_updated',
  'planned_quantity',
];

/**
 * List production plans for one supplier (status/updated_since/sort/pagination).
 * @param {string} supplierId
 * @param {{status?:string,updated_since?:string,page?:*,limit?:*,sort?:string}} opts
 */
function listProductionPlans(supplierId, opts = {}) {
  let rows = productionPlans.filter((r) => r.supplier_id === supplierId);
  if (hasFilter(opts.status)) {
    rows = rows.filter((r) => r.production_status === opts.status);
  }
  rows = filterUpdatedSince(rows, opts.updated_since);
  rows = applySort(rows, opts.sort, PLAN_SORT_FIELDS);
  return paginate(rows, opts);
}

/**
 * Global production plans list (all suppliers).
 * @param {{supplier_id?:string,status?:string,part_number?:string,q?:string,
 *          updated_since?:string,page?:*,limit?:*,sort?:string}} opts
 */
function listAllProductionPlans(opts = {}) {
  let rows = productionPlans;

  if (hasFilter(opts.supplier_id)) {
    rows = rows.filter((r) => r.supplier_id === opts.supplier_id);
  }
  if (hasFilter(opts.status)) {
    rows = rows.filter((r) => r.production_status === opts.status);
  }
  if (hasFilter(opts.part_number)) {
    rows = rows.filter((r) => r.part_number === opts.part_number);
  }
  if (hasFilter(opts.q)) {
    rows = rows.filter(
      (r) =>
        containsIgnoreCase(r.part_number, opts.q) || containsIgnoreCase(r.part_name, opts.q)
    );
  }
  rows = filterUpdatedSince(rows, opts.updated_since);
  rows = applySort(rows, opts.sort, PLAN_SORT_FIELDS);

  return paginate(rows, opts);
}

function getProductionPlan(planId) {
  const found = productionPlans.find((p) => p.plan_id === planId);
  return found ? clone(found) : null;
}

function createProductionPlan(record) {
  planCounter += 1;
  const plan_id = record.plan_id || `PLAN-${String(planCounter).padStart(3, '0')}`;
  const created = { plan_id, ...clone(record) };
  productionPlans.push(created);
  persist();
  return clone(created);
}

function findPlanIndex(planId) {
  return productionPlans.findIndex((p) => p.plan_id === planId);
}

/** Full replace: plan_id/supplier_id are forced from the existing plan. */
function replaceProductionPlan(planId, record) {
  const idx = findPlanIndex(planId);
  if (idx === -1) return null;
  const current = productionPlans[idx];
  productionPlans[idx] = clone({
    ...record,
    plan_id: current.plan_id,
    supplier_id: current.supplier_id,
  });
  persist();
  return clone(productionPlans[idx]);
}

/** Partial update: merge the patch, identity fields stay immutable. */
function patchProductionPlan(planId, patch) {
  const idx = findPlanIndex(planId);
  if (idx === -1) return null;
  const current = productionPlans[idx];
  const next = { ...current, ...clone(patch) };
  next.plan_id = current.plan_id;
  next.supplier_id = current.supplier_id;
  productionPlans[idx] = next;
  persist();
  return clone(next);
}

/**
 * Bulk replace plans for one supplier — never creates. Pre-checks every item
 * against BOTH plan_id and supplier_id, so a missing/foreign plan leaves the
 * store untouched. Writes in one pass and persists once.
 */
function bulkReplaceProductionPlans(supplierId, items) {
  const targets = new Map(); // plan index -> replacement record
  const missing = [];
  for (const record of items) {
    const idx = findPlanIndex(record.plan_id);
    if (idx === -1 || productionPlans[idx].supplier_id !== supplierId) {
      missing.push(record.plan_id);
    } else {
      targets.set(idx, record);
    }
  }
  if (missing.length > 0) return { missing };
  for (const [idx, record] of targets) {
    const current = productionPlans[idx];
    productionPlans[idx] = clone({
      ...record,
      plan_id: current.plan_id,
      supplier_id: current.supplier_id,
    });
  }
  persist();
  return {
    updated: items.length,
    items: items.map((record) => ({ plan_id: record.plan_id, action: 'updated' })),
  };
}

/** Bulk patch plans for one supplier — merge-only, atomic, never creates. */
function bulkPatchProductionPlans(supplierId, items) {
  const targets = new Map(); // plan index -> patch
  const missing = [];
  for (const patch of items) {
    const idx = findPlanIndex(patch.plan_id);
    if (idx === -1 || productionPlans[idx].supplier_id !== supplierId) {
      missing.push(patch.plan_id);
    } else {
      targets.set(idx, patch);
    }
  }
  if (missing.length > 0) return { missing };
  for (const [idx, patch] of targets) {
    const current = productionPlans[idx];
    const next = { ...current, ...clone(patch) };
    next.plan_id = current.plan_id;
    next.supplier_id = current.supplier_id;
    productionPlans[idx] = next;
  }
  persist();
  return {
    updated: items.length,
    items: items.map((patch) => ({ plan_id: patch.plan_id, action: 'updated' })),
  };
}

module.exports = {
  seed,
  getRevision,
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
