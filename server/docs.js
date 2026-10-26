'use strict';

/**
 * docs.js — Human-friendly API documentation page served at GET /docs.
 *
 * WHY: The course teaches "reading API documentation". We render a
 * Swagger-UI-like page from /openapi.json. Swagger UI is loaded from a CDN,
 * but a plain, always-visible endpoint list is embedded in the HTML so the
 * page REMAINS USEFUL when the classroom is offline.
 */

function buildDocsHtml(baseUrl) {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mock Supplier API — Dokumentasi</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    :root { --ink:#0f172a; --muted:#475569; --line:#e2e8f0; --brand:#1d4ed8; }
    body { margin:0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:var(--ink); background:#f8fafc; }
    header { background:#0f172a; color:#fff; padding:20px 28px; }
    header h1 { margin:0 0 6px; font-size:20px; }
    header p { margin:0; color:#cbd5e1; font-size:14px; }
    .wrap { max-width:1100px; margin:0 auto; padding:24px 28px 60px; }
    .notice { background:#eff6ff; border:1px solid #bfdbfe; color:#1e3a8a; padding:12px 16px; border-radius:10px; font-size:14px; margin-bottom:18px; }
    #fallback h2 { font-size:16px; margin:24px 0 10px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; font-size:13.5px; }
    th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { background:#f1f5f9; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
    code { background:#f1f5f9; padding:1px 6px; border-radius:5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
    .m { display:inline-block; font-weight:700; font-size:11px; padding:2px 7px; border-radius:5px; color:#fff; min-width:46px; text-align:center; }
    .get { background:#059669; } .post { background:#2563eb; } .put { background:#d97706; }
    .patch { background:#7c3aed; } .delete { background:#dc2626; }
    .auth { color:var(--muted); font-size:12px; }
    #swagger-ui { background:#fff; border-radius:10px; }
    #swagger-host { display:none; }
  </style>
</head>
<body>
  <header>
    <h1>Mock Supplier API — Dokumentasi</h1>
    <p>Base URL: <code>${baseUrl}</code> · Spec: <code>${baseUrl}/openapi.json</code></p>
  </header>
  <div class="wrap">
    <div class="notice">
      Halaman ini mencoba memuat tampilan interaktif <strong>Swagger UI</strong> dari CDN.
      Jika internet mati, daftar endpoint di bawah tetap bisa dibaca (fallback).
      Header wajib untuk <code>/api/v1/*</code>: <code>X-API-Key: sup_demo_key_2026</code>.
      Operasi tulis juga butuh <code>Authorization: Bearer &lt;token&gt;</code>.
    </div>

    <div id="swagger-host"><div id="swagger-ui"></div></div>

    <div id="fallback">
      <h2>Daftar Endpoint (fallback offline)</h2>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Keterangan</th></tr></thead>
        <tbody>
          <tr><td><span class="m get">GET</span></td><td><code>/health</code></td><td class="auth">publik</td><td>Cek status service.</td></tr>
          <tr><td><span class="m post">POST</span></td><td><code>/auth/token</code></td><td class="auth">publik</td><td>Ambil bearer token (client_id company-dashboard / secret s3cr3t-demo).</td></tr>
          <tr><td><span class="m get">GET</span></td><td><code>/api/v1/suppliers</code></td><td class="auth">API Key</td><td>Daftar supplier.</td></tr>
          <tr><td><span class="m post">POST</span></td><td><code>/api/v1/suppliers</code></td><td class="auth">API Key + Bearer</td><td>Tambah supplier. 201 / 400 / 409.</td></tr>
          <tr><td><span class="m get">GET</span></td><td><code>/api/v1/suppliers/:supplierId</code></td><td class="auth">API Key</td><td>Detail supplier.</td></tr>
          <tr><td><span class="m get">GET</span></td><td><code>/api/v1/suppliers/:supplierId/stock</code></td><td class="auth">API Key</td><td>Daftar stock. Query: status, page, limit, updated_since, sort.</td></tr>
          <tr><td><span class="m get">GET</span></td><td><code>/api/v1/suppliers/:supplierId/stock/:partNumber</code></td><td class="auth">API Key</td><td>Detail satu part.</td></tr>
          <tr><td><span class="m post">POST</span></td><td><code>/api/v1/suppliers/:supplierId/stock</code></td><td class="auth">API Key + Bearer</td><td>Tambah record stock. 201 / 400.</td></tr>
          <tr><td><span class="m put">PUT</span></td><td><code>/api/v1/suppliers/:supplierId/stock/:partNumber</code></td><td class="auth">API Key + Bearer</td><td>Replace penuh. 200 / 404.</td></tr>
          <tr><td><span class="m patch">PATCH</span></td><td><code>/api/v1/suppliers/:supplierId/stock/:partNumber</code></td><td class="auth">API Key + Bearer</td><td>Update sebagian. 200 / 404.</td></tr>
          <tr><td><span class="m delete">DELETE</span></td><td><code>/api/v1/suppliers/:supplierId/stock/:partNumber</code></td><td class="auth">API Key + Bearer</td><td>Hapus. 204 / 404.</td></tr>
          <tr><td><span class="m post">POST</span></td><td><code>/api/v1/suppliers/:supplierId/stock/bulk</code></td><td class="auth">API Key + Bearer</td><td>Bulk upsert (integration sync). 201.</td></tr>
          <tr><td><span class="m get">GET</span></td><td><code>/api/v1/suppliers/:supplierId/production-plans</code></td><td class="auth">API Key</td><td>Daftar production plan. Query: status, page, limit.</td></tr>
          <tr><td><span class="m get">GET</span></td><td><code>/api/v1/production-plans/:planId</code></td><td class="auth">API Key</td><td>Detail plan.</td></tr>
          <tr><td><span class="m post">POST</span></td><td><code>/api/v1/suppliers/:supplierId/production-plans</code></td><td class="auth">API Key + Bearer</td><td>Tambah plan. 201 / 400.</td></tr>
          <tr><td><span class="m get">GET</span></td><td><code>/api/v1/_simulate/:code</code></td><td class="auth">API Key</td><td>Contoh status: 400/401/403/404/429/500.</td></tr>
        </tbody>
      </table>

      <h2>Simulator (query param)</h2>
      <table>
        <thead><tr><th>Contoh</th><th>Efek</th></tr></thead>
        <tbody>
          <tr><td><code>?simulate=latency&amp;ms=2000</code></td><td>Respons lambat 2 detik lalu sukses.</td></tr>
          <tr><td><code>?simulate=error500</code></td><td>Respons 500 internal error.</td></tr>
          <tr><td><code>?simulate=timeout&amp;ms=10000</code></td><td>Delay panjang (timeout di Postman).</td></tr>
          <tr><td><code>?simulate=ratelimit</code></td><td>Respons 429 + header Retry-After.</td></tr>
          <tr><td><code>?simulate=malformed</code></td><td>Respons JSON rusak (latihan deteksi).</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" onerror="window.__swaggerFailed=true"></script>
  <script>
    // Mount Swagger UI only when the CDN bundle actually loaded.
    (function () {
      function tryMount() {
        if (window.SwaggerUIBundle) {
          document.getElementById('fallback').style.display = 'none';
          document.getElementById('swagger-host').style.display = 'block';
          window.SwaggerUIBundle({ url: '${baseUrl}/openapi.json', dom_id: '#swagger-ui' });
          return true;
        }
        return false;
      }
      if (!tryMount()) {
        // Retry briefly in case the CDN script is still loading, then give up
        // and leave the readable fallback table on screen.
        let tries = 0;
        const timer = setInterval(function () {
          if (tryMount() || window.__swaggerFailed || ++tries > 20) clearInterval(timer);
        }, 300);
      }
    })();
  </script>
</body>
</html>`;
}

module.exports = { buildDocsHtml };
