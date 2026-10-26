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
 * Snapshot the current state to STATE_FILE. No-op unless PERSIST_DATA is on.
 * Failures are logged and swallowed: the API keeps serving from memory.
 */
function persist() {
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
  if (PERSIST) console.log('[data] persistence ON -> ' + STATE_FILE);
}

seed(); // load immediately on require()

// ---- Suppliers ----------------------------------------------------------
function listSuppliers() {
  return clone(suppliers);
}

function getSupplier(supplierId) {
  const found = suppliers.find((s) => s.supplier_id === supplierId);
  return found ? clone(found) : null;
}

// ---- Stock --------------------------------------------------------------
// A stock row is uniquely identified by (supplier_id, part_number).

function findStockIndex(supplierId, partNumber) {
  return stock.findIndex(
    (r) => r.supplier_id === supplierId && r.part_number === partNumber
  );
}

/**
 * List stock for a supplier with optional filter/sort/pagination.
 * @param {string} supplierId
 * @param {{status?:string,page?:number,limit?:number,updated_since?:string,sort?:string}} opts
 */
function listStock(supplierId, opts = {}) {
  let rows = stock.filter((r) => r.supplier_id === supplierId);

  if (opts.status) {
    rows = rows.filter((r) => r.stock_status === opts.status);
  }
  if (opts.updated_since) {
    const since = Date.parse(opts.updated_since);
    if (!Number.isNaN(since)) {
      rows = rows.filter((r) => Date.parse(r.last_updated) >= since);
    }
  }
  if (opts.sort) {
    const [field, dirRaw] = String(opts.sort).split(':');
    const dir = dirRaw === 'desc' ? -1 : 1;
    rows = rows.slice().sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(50, Math.max(1, opts.limit || 10));
  const total = rows.length;
  const total_pages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const data = clone(rows.slice(start, start + limit));

  return { data, meta: { page, limit, total, total_pages } };
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

// ---- Production plans ---------------------------------------------------

function listProductionPlans(supplierId, opts = {}) {
  let rows = productionPlans.filter((r) => r.supplier_id === supplierId);
  if (opts.status) {
    rows = rows.filter((r) => r.production_status === opts.status);
  }
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(50, Math.max(1, opts.limit || 10));
  const total = rows.length;
  const total_pages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const data = clone(rows.slice(start, start + limit));
  return { data, meta: { page, limit, total, total_pages } };
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

module.exports = {
  seed,
  listSuppliers,
  getSupplier,
  listStock,
  getStockItem,
  createStock,
  replaceStock,
  patchStock,
  deleteStock,
  bulkUpsertStock,
  listProductionPlans,
  getProductionPlan,
  createProductionPlan,
};
