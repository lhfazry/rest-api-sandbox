'use strict';

/**
 * app.js — Mock "Company Internal System" dashboard logic.
 *
 * This file pretends to be the company's internal system that CONSUMES the
 * supplier API. It is a live picture of the integration flow:
 *   Supplier System -> REST API -> Company Internal System -> Dashboard
 *
 * NOTE: the credentials below are DEMO values that ship with the sandbox on
 * purpose. In a real integration you would never hardcode a key in frontend
 * code — you would put it behind your own backend. It is hardcoded here only
 * so students can see a working integration with zero setup.
 */

// --- Demo configuration (safe to share: this is a training sandbox) --------
const API_BASE = 'http://localhost:4010';
const API_KEY = 'sup_demo_key_2026';

// --- Element references ----------------------------------------------------
const els = {
  supplierSelect: document.getElementById('supplier-select'),
  refreshBtn: document.getElementById('refresh-btn'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  total: document.getElementById('stat-total'),
  low: document.getElementById('stat-low'),
  out: document.getElementById('stat-out'),
  available: document.getElementById('stat-available'),
  tbody: document.getElementById('stock-body'),
  lastSync: document.getElementById('last-sync'),
  errorState: document.getElementById('error-state'),
  errorEndpoint: document.getElementById('error-endpoint'),
  apiHost: document.getElementById('api-host'),
};

els.apiHost.textContent = API_BASE.replace(/^https?:\/\//, '');

// --- Helpers ---------------------------------------------------------------
function setStatus(kind, text) {
  els.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  els.statusText.textContent = text;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(n) {
  return new Intl.NumberFormat('id-ID').format(n);
}

function showError(endpoint) {
  els.errorState.hidden = false;
  els.errorEndpoint.textContent = endpoint;
  els.tbody.innerHTML =
    '<tr><td colspan="6" class="empty">Data tidak tersedia (offline).</td></tr>';
  els.total.textContent = '—';
  els.low.textContent = '—';
  els.out.textContent = '—';
  els.available.textContent = '—';
  setStatus('err', 'Tidak terhubung');
}

function hideError() {
  els.errorState.hidden = true;
}

// --- Rendering -------------------------------------------------------------
function renderSummary(items) {
  const count = (status) => items.filter((i) => i.stock_status === status).length;
  els.total.textContent = formatNumber(items.length);
  els.low.textContent = formatNumber(count('low'));
  els.out.textContent = formatNumber(count('out'));
  els.available.textContent = formatNumber(count('available'));
}

function renderTable(items) {
  if (!items.length) {
    els.tbody.innerHTML = '<tr><td colspan="6" class="empty">Tidak ada stock untuk supplier ini.</td></tr>';
    return;
  }
  els.tbody.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td><strong>${escapeHtml(item.part_number)}</strong></td>
        <td>${escapeHtml(item.part_name)}</td>
        <td class="num">${formatNumber(item.stock_quantity)}</td>
        <td>${escapeHtml(item.uom)}</td>
        <td>${escapeHtml(item.stock_location)}</td>
        <td><span class="badge ${escapeHtml(item.stock_status)}">${escapeHtml(item.stock_status)}</span></td>
      </tr>`
    )
    .join('');
}

// --- Data loading ----------------------------------------------------------
async function loadStock() {
  const supplierId = els.supplierSelect.value;
  // limit=50 so the dashboard shows every part regardless of the default page size.
  const endpoint = `${API_BASE}/api/v1/suppliers/${supplierId}/stock?limit=50&sort=stock_quantity:asc`;
  setStatus('', 'Memuat data…');

  try {
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
      throw new Error(detail);
    }

    const body = await res.json();
    const items = Array.isArray(body.data) ? body.data : [];
    hideError();
    renderSummary(items);
    renderTable(items);
    els.lastSync.textContent = new Date().toLocaleString('id-ID');
    setStatus('ok', `Terhubung · ${items.length} item`);
  } catch (err) {
    // Fetch rejects on network failure (server down) — show the friendly state.
    showError(endpoint);
    console.warn('Dashboard gagal memuat stock:', err.message);
  }
}

// --- Wiring ----------------------------------------------------------------
els.refreshBtn.addEventListener('click', loadStock);
els.supplierSelect.addEventListener('change', loadStock);

// First load + gentle auto-refresh so the "live" timestamp updates.
loadStock();
setInterval(loadStock, 30000);
