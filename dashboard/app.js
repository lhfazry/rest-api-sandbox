'use strict';

/**
 * app.js — Mock "Company Internal System" dashboard logic.
 *
 * This file pretends to be the company's internal system that CONSUMES the
 * supplier API. It is a live picture of the integration flow:
 *   Supplier System -> REST API -> Company Internal System -> Dashboard
 *
 * Three views share one supplier selector:
 *   - Stock              : stock rows joined to production plans on part_number
 *   - Production Planning: plans for the selected supplier
 *   - Supplier           : all suppliers + computed stock/plan counts
 *
 * NOTE: the credentials below are DEMO values that ship with the sandbox on
 * purpose. In a real integration you would never hardcode a key in frontend
 * code — you would put it behind your own backend. It is hardcoded here only
 * so students can see a working integration with zero setup.
 */

// --- Demo configuration (safe to share: this is a training sandbox) --------
// Same-origin by default: the API server also serves this dashboard, so it works
// on http://localhost:4010 AND behind a domain/reverse proxy (Coolify, nginx, ...)
// without changing any code. Override only if the dashboard is hosted elsewhere:
//   <script>window.SANDBOX_API_BASE = 'https://api.example.com'</script>
const API_BASE = (
  window.SANDBOX_API_BASE ||
  (window.location.protocol === 'file:' ? 'http://localhost:4010' : window.location.origin)
).replace(/\/+$/, '');
const API_KEY = 'sup_demo_key_2026';

const SUPPLIERS_ENDPOINT = `${API_BASE}/api/v1/suppliers`;
const stockEndpoint = (supplierId) =>
  `${API_BASE}/api/v1/suppliers/${encodeURIComponent(supplierId)}/stock?limit=50&sort=stock_quantity:asc`;
const plansEndpoint = (supplierId) =>
  `${API_BASE}/api/v1/suppliers/${encodeURIComponent(supplierId)}/production-plans?limit=50`;

// --- Domain constants ------------------------------------------------------
const STOCK_STATUSES = ['available', 'low', 'out'];
const PRODUCTION_STATUSES = ['planned', 'in_progress', 'completed', 'delayed'];
const STOCK_LABELS = { available: 'Available', low: 'Low', out: 'Out' };
const PRODUCTION_LABELS = {
  planned: 'Planned',
  in_progress: 'In Progress',
  completed: 'Completed',
  delayed: 'Delayed',
};
const BADGE_CLASSES = new Set([
  ...STOCK_STATUSES,
  ...PRODUCTION_STATUSES,
  'active',
  'inactive',
]);
const TAB_PANELS = {
  stock: 'panel-stock',
  planning: 'panel-planning',
  suppliers: 'panel-suppliers',
};

// --- Element references ----------------------------------------------------
const els = {
  supplierSelect: document.getElementById('supplier-select'),
  refreshBtn: document.getElementById('refresh-btn'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  apiHost: document.getElementById('api-host'),

  errorState: document.getElementById('error-state'),
  errorEndpoint: document.getElementById('error-endpoint'),
  warningBanner: document.getElementById('warning-banner'),
  warningEndpoint: document.getElementById('warning-endpoint'),
  lastSync: document.getElementById('last-sync'),

  stockStatusFilter: document.getElementById('stock-status-filter'),
  stockPlanFilter: document.getElementById('stock-plan-filter'),
  stockProductionFilter: document.getElementById('stock-production-filter'),
  stockSearch: document.getElementById('stock-search'),
  stockFilterState: document.getElementById('stock-filter-state'),
  stockResultCount: document.getElementById('stock-result-count'),
  stockFilterChips: document.getElementById('stock-filter-chips'),
  stockReset: document.getElementById('stock-reset'),
  stockMeta: document.getElementById('stock-meta'),
  stockTable: document.getElementById('stock-table'),
  stockBody: document.getElementById('stock-body'),

  statTotal: document.getElementById('stat-total'),
  statTotalHint: document.getElementById('stat-total-hint'),
  statLow: document.getElementById('stat-low'),
  statLowHint: document.getElementById('stat-low-hint'),
  statOut: document.getElementById('stat-out'),
  statOutHint: document.getElementById('stat-out-hint'),
  statAvailable: document.getElementById('stat-available'),
  statAvailableHint: document.getElementById('stat-available-hint'),

  planStatusFilter: document.getElementById('plan-status-filter'),
  planFilterState: document.getElementById('plan-filter-state'),
  planResultCount: document.getElementById('plan-result-count'),
  planReset: document.getElementById('plan-reset'),
  planMeta: document.getElementById('plan-meta'),
  planBody: document.getElementById('plan-body'),
  planStatTotal: document.getElementById('plan-stat-total'),
  planStatTotalHint: document.getElementById('plan-stat-total-hint'),
  planStatInProgress: document.getElementById('plan-stat-in-progress'),
  planStatInProgressHint: document.getElementById('plan-stat-in-progress-hint'),
  planStatDelayed: document.getElementById('plan-stat-delayed'),
  planStatDelayedHint: document.getElementById('plan-stat-delayed-hint'),
  planStatCompleted: document.getElementById('plan-stat-completed'),
  planStatCompletedHint: document.getElementById('plan-stat-completed-hint'),

  supplierMeta: document.getElementById('supplier-meta'),
  supplierBody: document.getElementById('supplier-body'),
};

els.apiHost.textContent = API_BASE.replace(/^https?:\/\//, '');

// --- State -----------------------------------------------------------------
const state = {
  supplierId: els.supplierSelect.value || 'SUP-001',
  suppliers: [],
  // supplierId -> { stock: [], plans: [], stockOk, plansOk }
  directory: new Map(),
  stock: [],
  plans: [],
  stockOk: false,
  plansOk: false,
  errors: [],
  lastSync: null,
  loading: false,
  activeTab: 'stock',
  filters: {
    stockStatus: '',
    plan: '',
    productionStatus: '',
    search: '',
    planStatus: '',
  },
};

let supplierSignature = '';
let planOptionSignature = null;

// --- Helpers ---------------------------------------------------------------
function setStatus(kind, text) {
  els.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  els.statusText.textContent = text;
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(
    /[&<>"']/g,
    (ch) => HTML_ESCAPES[ch]
  );
}

const numberFormatter = new Intl.NumberFormat('id-ID');
const dateFormatter = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const syncFormatter = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? numberFormatter.format(n) : '—';
}

/** Format a date-only string without letting time zones shift the day. */
function formatDate(value) {
  if (!value) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

function stockLabel(status) {
  return STOCK_LABELS[status] || status || '—';
}

function productionLabel(status) {
  return PRODUCTION_LABELS[status] || status || '—';
}

function badgeClass(status) {
  return BADGE_CLASSES.has(status) ? status : 'neutral';
}

function comparePlans(a, b) {
  const byDate = String(a.production_date || '').localeCompare(String(b.production_date || ''));
  return byDate || String(a.plan_id || '').localeCompare(String(b.plan_id || ''));
}

function plansForPartMap(plans) {
  const map = new Map();
  plans.forEach((plan) => {
    if (!plan || !plan.part_number) return;
    if (!map.has(plan.part_number)) map.set(plan.part_number, []);
    map.get(plan.part_number).push(plan);
  });
  map.forEach((list) => list.sort(comparePlans));
  return map;
}

function emptyRow(colspan, title, message, actionAttribute) {
  const action = actionAttribute
    ? `<button class="btn btn--ghost btn--sm" type="button" ${actionAttribute}>Reset filter</button>`
    : '';
  return `
    <tr class="empty-row">
      <td colspan="${colspan}" class="empty-cell">
        <div class="empty-state">
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(message)}</p>
          ${action}
        </div>
      </td>
    </tr>`;
}

async function fetchJson(endpoint) {
  const res = await fetch(endpoint, {
    headers: { 'X-API-Key': API_KEY },
  });

  if (!res.ok) {
    // Read the standard error body so students see the shape on screen too.
    let detail = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      if (errBody && errBody.error && errBody.error.message) {
        detail = `HTTP ${res.status} — ${errBody.error.message}`;
      }
    } catch {
      /* response was not JSON; keep the status text */
    }
    const error = new Error(detail);
    error.endpoint = endpoint;
    throw error;
  }

  return res.json();
}

function dedupeErrors(errors) {
  const seen = new Set();
  return errors.filter((entry) => {
    if (!entry || !entry.endpoint || seen.has(entry.endpoint)) return false;
    seen.add(entry.endpoint);
    return true;
  });
}

// --- Connection / warning states ------------------------------------------
function endpointSummary(errors) {
  const endpoints = [...new Set(errors.map((entry) => entry.endpoint))];
  if (!endpoints.length) return '—';
  return endpoints[0] + (endpoints.length > 1 ? ` (+${endpoints.length - 1} endpoint lain)` : '');
}

function showConnectionError(errors) {
  els.errorEndpoint.textContent = endpointSummary(errors);
  els.errorState.hidden = false;
  els.warningBanner.hidden = true;
}

function hideConnectionError() {
  els.errorState.hidden = true;
}

function showWarning(errors) {
  els.warningEndpoint.textContent = endpointSummary(errors);
  els.warningBanner.hidden = false;
}

function hideWarning() {
  els.warningBanner.hidden = true;
}

function markLastSync() {
  state.lastSync = new Date();
  els.lastSync.textContent = syncFormatter.format(state.lastSync);
}

// --- Supplier selector -----------------------------------------------------
function fallbackSuppliers() {
  return Array.from(els.supplierSelect.options)
    .filter((option) => option.value)
    .map((option) => {
      const segments = option.textContent.split('—');
      const name = segments.length > 1 ? segments.slice(1).join('—').trim() : option.textContent.trim();
      return {
        supplier_id: option.value,
        supplier_name: name || option.value,
        country: '—',
        contact_email: '',
        api_status: '',
      };
    });
}

function renderSupplierSelect() {
  const suppliers = state.suppliers.length ? state.suppliers : fallbackSuppliers();
  const previous = state.supplierId || els.supplierSelect.value;

  const signature = suppliers
    .map((supplier) => `${supplier.supplier_id}:${supplier.supplier_name}`)
    .join('|');
  if (signature !== supplierSignature) {
    supplierSignature = signature;
    els.supplierSelect.innerHTML = suppliers
      .map(
        (supplier) =>
          `<option value="${escapeHtml(supplier.supplier_id)}">${escapeHtml(
            supplier.supplier_id
          )} — ${escapeHtml(supplier.supplier_name)}</option>`
      )
      .join('');
  }

  const exists = suppliers.some((supplier) => supplier.supplier_id === previous);
  state.supplierId = exists ? previous : suppliers[0]?.supplier_id || '';
  els.supplierSelect.value = state.supplierId;
}

function syncSelectedFromDirectory() {
  const entry = state.directory.get(state.supplierId);
  if (entry) {
    state.stock = entry.stock;
    state.plans = entry.plans;
    state.stockOk = entry.stockOk;
    state.plansOk = entry.plansOk;
  } else {
    state.stock = [];
    state.plans = [];
    state.stockOk = false;
    state.plansOk = false;
  }

  // Keep the chosen plan only while it still exists for this supplier.
  if (
    state.filters.plan &&
    !state.plans.some((plan) => plan.production_plan === state.filters.plan)
  ) {
    state.filters.plan = '';
  }
}

// --- Data loading ----------------------------------------------------------
async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  els.refreshBtn.disabled = true;
  els.refreshBtn.classList.add('is-loading');
  els.refreshBtn.setAttribute('aria-busy', 'true');
  setStatus('', 'Memuat data…');

  const errors = [];
  try {
    let suppliers = state.suppliers;
    let suppliersOk = false;

    try {
      const body = await fetchJson(SUPPLIERS_ENDPOINT);
      suppliers = Array.isArray(body.data) ? body.data : [];
      suppliersOk = true;
    } catch (err) {
      errors.push({ endpoint: SUPPLIERS_ENDPOINT, message: err.message });
      if (!state.suppliers.length) suppliers = fallbackSuppliers();
    }
    state.suppliers = suppliers;

    const supplierIds = suppliers.map((supplier) => supplier.supplier_id).filter(Boolean);
    if (!supplierIds.includes(state.supplierId)) {
      state.supplierId = supplierIds[0] || state.supplierId;
    }

    // Small sandbox, tiny payloads: fetch every supplier so the Supplier tab
    // can show real counts without a second loading path.
    const results = await Promise.all(
      supplierIds.map(async (supplierId) => {
        const [stockResult, planResult] = await Promise.allSettled([
          fetchJson(stockEndpoint(supplierId)),
          fetchJson(plansEndpoint(supplierId)),
        ]);
        return { supplierId, stockResult, planResult };
      })
    );

    const nextDirectory = new Map();
    let stockSuccesses = 0;
    let planSuccesses = 0;

    results.forEach(({ supplierId, stockResult, planResult }) => {
      const previous = state.directory.get(supplierId);
      const stockOk = stockResult.status === 'fulfilled';
      const plansOk = planResult.status === 'fulfilled';

      const stock =
        stockOk && Array.isArray(stockResult.value.data)
          ? stockResult.value.data
          : previous
            ? previous.stock
            : [];
      const plans =
        plansOk && Array.isArray(planResult.value.data)
          ? planResult.value.data
          : previous
            ? previous.plans
            : [];

      if (stockOk) stockSuccesses += 1;
      else {
        errors.push({
          endpoint: stockEndpoint(supplierId),
          message: stockResult.reason ? stockResult.reason.message : 'gagal',
        });
      }

      if (plansOk) planSuccesses += 1;
      else {
        errors.push({
          endpoint: plansEndpoint(supplierId),
          message: planResult.reason ? planResult.reason.message : 'gagal',
        });
      }

      nextDirectory.set(supplierId, { stock, plans, stockOk, plansOk });
    });

    state.directory = nextDirectory;
    renderSupplierSelect();
    syncSelectedFromDirectory();

    state.errors = dedupeErrors(errors);
    const successfulRequests = (suppliersOk ? 1 : 0) + stockSuccesses + planSuccesses;

    if (successfulRequests === 0) {
      showConnectionError(state.errors);
      hideWarning();
      setStatus('err', 'Tidak terhubung');
    } else {
      hideConnectionError();
      if (state.errors.length) {
        showWarning(state.errors);
        setStatus('warn', `Sebagian data · ${state.errors.length} request gagal`);
      } else {
        hideWarning();
        setStatus('ok', `Terhubung · ${state.stock.length} item · ${state.plans.length} plan`);
      }
      markLastSync();
    }

    renderAll();

    if (state.errors.length) {
      console.warn(
        'Dashboard gagal memuat sebagian data:',
        state.errors.map((entry) => `${entry.endpoint} (${entry.message})`).join(' | ')
      );
    }
  } catch (err) {
    // Last-resort guard so the dashboard never gets stuck in "Memuat data…".
    state.errors = [{ endpoint: API_BASE, message: err.message }];
    showConnectionError(state.errors);
    hideWarning();
    setStatus('err', 'Tidak terhubung');
    renderAll();
    console.warn('Dashboard gagal memuat data:', err.message);
  } finally {
    state.loading = false;
    els.refreshBtn.disabled = false;
    els.refreshBtn.classList.remove('is-loading');
    els.refreshBtn.removeAttribute('aria-busy');
  }
}

// --- Filter option rendering ----------------------------------------------
function syncStockFilterControls() {
  els.stockStatusFilter.value = state.filters.stockStatus;
  els.stockPlanFilter.value = state.filters.plan;
  els.stockProductionFilter.value = state.filters.productionStatus;
  if (document.activeElement !== els.stockSearch && els.stockSearch.value !== state.filters.search) {
    els.stockSearch.value = state.filters.search;
  }
}

function renderStockFilterOptions() {
  const names = [...new Set(state.plans.map((plan) => plan.production_plan).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, 'id')
  );

  if (state.filters.plan && !names.includes(state.filters.plan)) state.filters.plan = '';
  if (!['', ...STOCK_STATUSES].includes(state.filters.stockStatus)) state.filters.stockStatus = '';
  if (!['', ...PRODUCTION_STATUSES].includes(state.filters.productionStatus)) {
    state.filters.productionStatus = '';
  }

  const signature = names.join('|');
  if (signature !== planOptionSignature) {
    planOptionSignature = signature;
    els.stockPlanFilter.innerHTML =
      '<option value="">Semua production plan</option>' +
      names
        .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
        .join('');
  }
  els.stockPlanFilter.disabled = names.length === 0;
  syncStockFilterControls();
}

// --- Stock rendering -------------------------------------------------------
function renderStockSummary(rows, hasData, filtersActive) {
  const total = state.stock.length;
  const count = (status) => rows.filter((item) => item.stock_status === status).length;
  const low = count('low');
  const out = count('out');
  const available = count('available');

  if (!hasData) {
    els.statTotal.textContent = '—';
    els.statLow.textContent = '—';
    els.statOut.textContent = '—';
    els.statAvailable.textContent = '—';
    els.statTotalHint.textContent = 'data stock tidak tersedia';
    els.statLowHint.textContent = 'data stock tidak tersedia';
    els.statOutHint.textContent = 'data stock tidak tersedia';
    els.statAvailableHint.textContent = 'data stock tidak tersedia';
    return;
  }

  els.statTotal.textContent = formatNumber(rows.length);
  els.statLow.textContent = formatNumber(low);
  els.statOut.textContent = formatNumber(out);
  els.statAvailable.textContent = formatNumber(available);

  els.statTotalHint.textContent = filtersActive
    ? `dari ${formatNumber(total)} item`
    : 'part number terdaftar';
  els.statLowHint.textContent = filtersActive ? `dari ${formatNumber(total)} item` : 'status = low';
  els.statOutHint.textContent = filtersActive ? `dari ${formatNumber(total)} item` : 'status = out';
  els.statAvailableHint.textContent = filtersActive
    ? `dari ${formatNumber(total)} item`
    : 'status = available';
}

function renderPlanContext(plans) {
  if (!plans.length) return '<span class="cell-muted">—</span>';
  return `<div class="plan-stack">${plans
    .map(
      (plan) => `
        <div class="plan-line">
          <span class="badge ${badgeClass(plan.production_status)}">${escapeHtml(
            productionLabel(plan.production_status)
          )}</span>
          <span class="plan-name" title="${escapeHtml(plan.production_plan)}">${escapeHtml(
            plan.production_plan
          )}</span>
        </div>`
    )
    .join('')}</div>`;
}

function renderPlanQty(plans) {
  if (!plans.length) return '<span class="cell-muted">—</span>';
  return `<div class="plan-values">${plans
    .map((plan) => `<span>${formatNumber(plan.planned_quantity)}</span>`)
    .join('')}</div>`;
}

function renderPlanDelivery(plans) {
  if (!plans.length) return '<span class="cell-muted">—</span>';
  return `<div class="plan-values">${plans
    .map((plan) => `<span>${escapeHtml(formatDate(plan.delivery_schedule))}</span>`)
    .join('')}</div>`;
}

function renderStockRows(rows, plansByPart, productionFilterActive, hasData) {
  const colspan = productionFilterActive ? 9 : 7;

  if (!hasData) {
    return emptyRow(
      colspan,
      'Data stock tidak tersedia',
      'Permintaan ke endpoint stock gagal. Coba klik Refresh untuk memuat ulang.'
    );
  }

  if (!state.stock.length) {
    return emptyRow(
      colspan,
      'Belum ada stock',
      'Supplier ini belum memiliki data stock. Data akan muncul setelah supplier mengirimkannya.'
    );
  }

  if (!rows.length) {
    return emptyRow(
      colspan,
      'Tidak ada baris yang cocok',
      'Tidak ada stock yang cocok dengan kombinasi filter ini. Coba longgarkan atau reset filter.',
      'data-reset-stock'
    );
  }

  return rows
    .map((item) => {
      const plans = plansByPart.get(item.part_number) || [];
      return `
        <tr>
          <td><span class="part">${escapeHtml(item.part_number)}</span></td>
          <td>${escapeHtml(item.part_name)}</td>
          <td class="num">${formatNumber(item.stock_quantity)}</td>
          <td>${escapeHtml(item.uom || '—')}</td>
          <td>${escapeHtml(item.stock_location || '—')}</td>
          <td>${renderPlanContext(plans)}</td>
          <td class="num col-plan-detail">${renderPlanQty(plans)}</td>
          <td class="col-plan-detail">${renderPlanDelivery(plans)}</td>
          <td><span class="badge ${badgeClass(item.stock_status)}">${escapeHtml(
            stockLabel(item.stock_status)
          )}</span></td>
        </tr>`;
    })
    .join('');
}

function renderStockView() {
  const filters = state.filters;
  const allStock = state.stock;
  const filtersActive = Boolean(
    filters.stockStatus || filters.plan || filters.productionStatus || filters.search
  );
  const productionFilterActive = Boolean(filters.plan || filters.productionStatus);
  const hasData = state.stockOk || allStock.length > 0;

  // Step 1: narrow the plan set by plan name + production status.
  const matchingPlans = productionFilterActive
    ? state.plans.filter(
        (plan) =>
          (!filters.plan || plan.production_plan === filters.plan) &&
          (!filters.productionStatus || plan.production_status === filters.productionStatus)
      )
    : state.plans;

  // Step 2: keep stock rows whose part_number exists in that plan set.
  const matchingParts = new Set(matchingPlans.map((plan) => plan.part_number));
  const search = filters.search.toLowerCase();
  const rows = allStock.filter((item) => {
    if (productionFilterActive && !matchingParts.has(item.part_number)) return false;
    if (filters.stockStatus && item.stock_status !== filters.stockStatus) return false;
    if (search) {
      const haystack = `${item.part_number || ''} ${item.part_name || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const plansByPart = plansForPartMap(matchingPlans);

  renderStockSummary(rows, hasData, filtersActive);

  // Active-filter chips + count.
  const chips = [];
  if (filters.stockStatus) {
    chips.push({ key: 'stockStatus', label: `Status: ${stockLabel(filters.stockStatus)}` });
  }
  if (filters.plan) chips.push({ key: 'plan', label: `Plan: ${filters.plan}` });
  if (filters.productionStatus) {
    chips.push({
      key: 'productionStatus',
      label: `Produksi: ${productionLabel(filters.productionStatus)}`,
    });
  }
  if (filters.search) chips.push({ key: 'search', label: `Cari: “${filters.search}”` });

  els.stockFilterState.hidden = chips.length === 0;
  if (chips.length) {
    els.stockResultCount.textContent = `Menampilkan ${formatNumber(rows.length)} dari ${formatNumber(
      allStock.length
    )} item`;
    els.stockFilterChips.innerHTML = chips
      .map(
        (chip) => `
          <button class="chip" type="button" data-clear-filter="${chip.key}"
                  aria-label="${escapeHtml(`Hapus filter ${chip.label}`)}">
            ${escapeHtml(chip.label)}<span aria-hidden="true">×</span>
          </button>`
      )
      .join('');
  } else {
    els.stockFilterChips.innerHTML = '';
  }

  els.stockMeta.textContent = hasData
    ? `${state.supplierId} · ${
        filtersActive
          ? `${formatNumber(rows.length)} dari ${formatNumber(allStock.length)}`
          : formatNumber(allStock.length)
      } part`
    : `${state.supplierId} · data tidak tersedia`;

  els.stockTable.classList.toggle('show-plan-detail', productionFilterActive);
  els.stockBody.innerHTML = renderStockRows(rows, plansByPart, productionFilterActive, hasData);
}

// --- Production planning rendering ----------------------------------------
function renderPlanningView() {
  const allPlans = state.plans;
  const hasData = state.plansOk || allPlans.length > 0;
  const active = Boolean(state.filters.planStatus);
  if (!['', ...PRODUCTION_STATUSES].includes(state.filters.planStatus)) {
    state.filters.planStatus = '';
  }

  const rows = allPlans
    .filter(
      (plan) => !state.filters.planStatus || plan.production_status === state.filters.planStatus
    )
    .slice()
    .sort(comparePlans);

  const count = (status) => rows.filter((plan) => plan.production_status === status).length;

  if (!hasData) {
    els.planStatTotal.textContent = '—';
    els.planStatInProgress.textContent = '—';
    els.planStatDelayed.textContent = '—';
    els.planStatCompleted.textContent = '—';
    els.planStatTotalHint.textContent = 'data plan tidak tersedia';
    els.planStatInProgressHint.textContent = 'data plan tidak tersedia';
    els.planStatDelayedHint.textContent = 'data plan tidak tersedia';
    els.planStatCompletedHint.textContent = 'data plan tidak tersedia';
  } else {
    els.planStatTotal.textContent = formatNumber(rows.length);
    els.planStatInProgress.textContent = formatNumber(count('in_progress'));
    els.planStatDelayed.textContent = formatNumber(count('delayed'));
    els.planStatCompleted.textContent = formatNumber(count('completed'));
    if (active) {
      const baseHint = `dari ${formatNumber(allPlans.length)} plan`;
      els.planStatTotalHint.textContent = baseHint;
      els.planStatInProgressHint.textContent = baseHint;
      els.planStatDelayedHint.textContent = baseHint;
      els.planStatCompletedHint.textContent = baseHint;
    } else {
      els.planStatTotalHint.textContent = 'plan untuk supplier ini';
      els.planStatInProgressHint.textContent = 'status = in_progress';
      els.planStatDelayedHint.textContent = 'status = delayed';
      els.planStatCompletedHint.textContent = 'status = completed';
    }
  }

  els.planStatusFilter.value = state.filters.planStatus;
  els.planFilterState.hidden = !active;
  els.planResultCount.textContent = active
    ? `Menampilkan ${formatNumber(rows.length)} dari ${formatNumber(allPlans.length)} plan`
    : '';
  els.planMeta.textContent = hasData
    ? `${state.supplierId} · ${
        active
          ? `${formatNumber(rows.length)} dari ${formatNumber(allPlans.length)}`
          : formatNumber(allPlans.length)
      } plan`
    : `${state.supplierId} · data tidak tersedia`;

  if (!hasData) {
    els.planBody.innerHTML = emptyRow(
      8,
      'Data production plan tidak tersedia',
      'Permintaan ke endpoint production plan gagal. Coba klik Refresh untuk memuat ulang.'
    );
    return;
  }

  if (!allPlans.length) {
    els.planBody.innerHTML = emptyRow(
      8,
      'Belum ada production plan',
      'Supplier ini belum memiliki production plan. Data akan muncul setelah supplier mengirimkannya.'
    );
    return;
  }

  if (!rows.length) {
    els.planBody.innerHTML = emptyRow(
      8,
      'Tidak ada plan yang cocok',
      'Tidak ada production plan dengan status ini. Reset filter untuk melihat semua plan.',
      'data-reset-plan'
    );
    return;
  }

  els.planBody.innerHTML = rows
    .map(
      (plan) => `
        <tr>
          <td><span class="part">${escapeHtml(plan.plan_id)}</span></td>
          <td><span class="part">${escapeHtml(plan.part_number)}</span></td>
          <td>${escapeHtml(plan.part_name)}</td>
          <td>${escapeHtml(plan.production_plan)}</td>
          <td class="num">${formatNumber(plan.planned_quantity)}</td>
          <td>${escapeHtml(formatDate(plan.production_date))}</td>
          <td>${escapeHtml(formatDate(plan.delivery_schedule))}</td>
          <td><span class="badge ${badgeClass(plan.production_status)}">${escapeHtml(
            productionLabel(plan.production_status)
          )}</span></td>
        </tr>`
    )
    .join('');
}

// --- Supplier rendering ----------------------------------------------------
function renderSuppliersView() {
  const suppliers = state.suppliers.length ? state.suppliers : fallbackSuppliers();
  els.supplierMeta.textContent = suppliers.length ? `${suppliers.length} supplier` : '—';

  if (!suppliers.length) {
    els.supplierBody.innerHTML = emptyRow(
      9,
      'Data supplier tidak tersedia',
      'Permintaan ke endpoint supplier gagal. Coba klik Refresh untuk memuat ulang.'
    );
    return;
  }

  els.supplierBody.innerHTML = suppliers
    .map((supplier) => {
      const entry = state.directory.get(supplier.supplier_id);
      const stock = entry ? entry.stock : [];
      const plans = entry ? entry.plans : [];
      const hasStockCounts = Boolean(entry) && (entry.stockOk || stock.length > 0);
      const hasPlanCounts = Boolean(entry) && (entry.plansOk || plans.length > 0);
      const low = stock.filter((item) => item.stock_status === 'low').length;
      const out = stock.filter((item) => item.stock_status === 'out').length;
      const isSelected = supplier.supplier_id === state.supplierId;
      const apiStatus = supplier.api_status || '';
      const apiClass =
        apiStatus === 'active' ? 'active' : apiStatus === 'inactive' ? 'inactive' : 'neutral';

      const contact = supplier.contact_email
        ? `<a class="contact-link" href="mailto:${escapeHtml(supplier.contact_email)}">${escapeHtml(
            supplier.contact_email
          )}</a>`
        : '<span class="cell-muted">—</span>';

      return `
        <tr class="${isSelected ? 'is-selected' : ''}"${
          isSelected ? ' aria-current="true"' : ''
        }>
          <td><span class="part">${escapeHtml(supplier.supplier_id)}</span></td>
          <td><span class="supplier-name">${escapeHtml(supplier.supplier_name)}</span>${
            isSelected ? '<span class="tag">Aktif</span>' : ''
          }</td>
          <td>${escapeHtml(supplier.country || '—')}</td>
          <td>${contact}</td>
          <td><span class="badge ${apiClass}">${escapeHtml(apiStatus || 'tidak diketahui')}</span></td>
          <td class="num">${hasStockCounts ? formatNumber(stock.length) : '—'}</td>
          <td>${
            hasStockCounts
              ? `<span class="count-pair"><span class="badge low">low ${formatNumber(
                  low
                )}</span><span class="badge out">out ${formatNumber(out)}</span></span>`
              : '<span class="cell-muted">—</span>'
          }</td>
          <td class="num">${hasPlanCounts ? formatNumber(plans.length) : '—'}</td>
          <td>${
            isSelected
              ? '<span class="cell-muted">—</span>'
              : `<button class="btn btn--ghost btn--sm" type="button" data-select-supplier="${escapeHtml(
                  supplier.supplier_id
                )}">Pilih</button>`
          }</td>
        </tr>`;
    })
    .join('');
}

// --- All views -------------------------------------------------------------
function renderAll() {
  renderStockFilterOptions();
  renderStockView();
  renderPlanningView();
  renderSuppliersView();
}

// --- Stock filter actions --------------------------------------------------
function clearStockFilter(key) {
  if (!(key in state.filters)) return;
  state.filters[key] = '';
  if (key === 'search') els.stockSearch.value = '';
  syncStockFilterControls();
  renderStockView();
}

function resetStockFilters() {
  state.filters.stockStatus = '';
  state.filters.plan = '';
  state.filters.productionStatus = '';
  state.filters.search = '';
  els.stockSearch.value = '';
  syncStockFilterControls();
  renderStockView();
}

function resetPlanFilter() {
  state.filters.planStatus = '';
  els.planStatusFilter.value = '';
  renderPlanningView();
}

function chooseSupplier(supplierId) {
  if (!supplierId || supplierId === state.supplierId) return;
  state.supplierId = supplierId;
  els.supplierSelect.value = supplierId;
  syncSelectedFromDirectory();
  renderAll();
  loadAll();
}

// --- Tabs ------------------------------------------------------------------
const tabButtons = Array.from(document.querySelectorAll('[role="tab"]'));

function activateTab(name, { focus = false } = {}) {
  if (!TAB_PANELS[name]) return;
  state.activeTab = name;

  tabButtons.forEach((tab) => {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });

  Object.entries(TAB_PANELS).forEach(([tabName, panelId]) => {
    document.getElementById(panelId).hidden = tabName !== name;
  });
}

tabButtons.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    let nextIndex = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(tabButtons[nextIndex].dataset.tab, { focus: true });
  });
});

// --- Wiring ----------------------------------------------------------------
els.refreshBtn.addEventListener('click', () => loadAll());

els.supplierSelect.addEventListener('change', (event) => {
  chooseSupplier(event.target.value);
});

els.stockStatusFilter.addEventListener('change', (event) => {
  state.filters.stockStatus = event.target.value;
  renderStockView();
});

els.stockPlanFilter.addEventListener('change', (event) => {
  state.filters.plan = event.target.value;
  renderStockView();
});

els.stockProductionFilter.addEventListener('change', (event) => {
  state.filters.productionStatus = event.target.value;
  renderStockView();
});

els.stockSearch.addEventListener('input', (event) => {
  state.filters.search = event.target.value.trim();
  renderStockView();
});

els.stockFilterChips.addEventListener('click', (event) => {
  const button = event.target.closest('[data-clear-filter]');
  if (!button) return;
  clearStockFilter(button.dataset.clearFilter);
});

els.stockReset.addEventListener('click', resetStockFilters);

els.stockBody.addEventListener('click', (event) => {
  if (event.target.closest('[data-reset-stock]')) resetStockFilters();
});

els.planStatusFilter.addEventListener('change', (event) => {
  state.filters.planStatus = event.target.value;
  renderPlanningView();
});

els.planReset.addEventListener('click', resetPlanFilter);

els.planBody.addEventListener('click', (event) => {
  if (event.target.closest('[data-reset-plan]')) resetPlanFilter();
});

els.supplierBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-select-supplier]');
  if (!button) return;
  chooseSupplier(button.dataset.selectSupplier);
});

// First load + gentle auto-refresh so the "live" timestamp updates. Filters and
// the selected tab live in `state`, so a refresh never resets them.
loadAll();
setInterval(() => loadAll(), 30000);
