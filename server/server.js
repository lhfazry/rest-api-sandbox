'use strict';

/**
 * server.js — HTTP server, router, middleware and startup banner.
 *
 * ZERO dependencies: only Node's standard library. Middleware order matters
 * and mirrors what a real API gateway does:
 *   1. CORS + OPTIONS preflight
 *   2. Route matching
 *   3. API-key auth (every /api/v1/*), then rate limiting, then bearer auth
 *      for writes. Rate limiting sits after the API key so a 429 is always
 *      attributable to a valid caller; a write without a bearer token still
 *      carries X-RateLimit-* headers because the API key already passed.
 *   4. Body parsing (raw body kept for the idempotency hash)
 *   5. Idempotency-Key replay/mismatch check (writes only)
 *   6. Status-code simulation (?simulate=...)
 *   7. Conditional-GET metadata (ETag candidates for successful JSON /api/v1 GETs)
 *   8. Handler (which may answer 304 via sendJson)
 * Every finished response is logged as: METHOD path -> status (Xms).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { sendJson, sendError } = require('./errors');
const { checkApiKey, checkBearer } = require('./auth');
const { applySimulation } = require('./simulate');
const {
  enforceRateLimit,
  LIMIT: RATE_LIMIT_MAX,
  WINDOW_MS: RATE_LIMIT_WINDOW_MS,
} = require('./ratelimit');
const { applyIdempotency, isIdempotentMethod } = require('./idempotency');
const { spec } = require('./openapi');
const { buildDocsHtml } = require('./docs');
const store = require('./data-store');
const handlers = require('./handlers');
const webhooks = require('./webhooks');

const PORT = parseInt(process.env.PORT, 10) || 4010;
const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const MAX_BODY_BYTES = 1_000_000; // 1 MB is plenty for classroom payloads.

// ---- Routing table ------------------------------------------------------
// Pattern syntax: literal segments plus ":param" captures.
// public: true  -> no auth at all
// write:  true  -> additionally needs a Bearer token
const ROUTES = [
  { method: 'GET', pattern: '/health', handler: handlers.health, public: true },
  { method: 'POST', pattern: '/auth/token', handler: handlers.createToken, public: true },
  { method: 'GET', pattern: '/openapi.json', handler: openapiHandler, public: true },
  { method: 'GET', pattern: '/docs', handler: docsHandler, public: true },

  { method: 'GET', pattern: '/api/v1/suppliers', handler: handlers.listSuppliers },
  { method: 'POST', pattern: '/api/v1/suppliers', handler: handlers.createSupplier, write: true },
  // Global stock list (all suppliers), JSON or CSV depending on Accept.
  { method: 'GET', pattern: '/api/v1/stock', handler: handlers.listAllStock },
  // Bulk supplier routes must come BEFORE the :supplierId pattern.
  { method: 'PUT', pattern: '/api/v1/suppliers/bulk', handler: handlers.bulkReplaceSuppliers, write: true },
  { method: 'PATCH', pattern: '/api/v1/suppliers/bulk', handler: handlers.bulkPatchSuppliers, write: true },
  { method: 'GET', pattern: '/api/v1/suppliers/:supplierId', handler: handlers.getSupplier },
  { method: 'PUT', pattern: '/api/v1/suppliers/:supplierId', handler: handlers.replaceSupplier, write: true },
  { method: 'PATCH', pattern: '/api/v1/suppliers/:supplierId', handler: handlers.patchSupplier, write: true },

  { method: 'GET', pattern: '/api/v1/suppliers/:supplierId/stock', handler: handlers.listStock },
  { method: 'POST', pattern: '/api/v1/suppliers/:supplierId/stock', handler: handlers.createStock, write: true },
  { method: 'POST', pattern: '/api/v1/suppliers/:supplierId/stock/bulk', handler: handlers.bulkUpsertStock, write: true },
  { method: 'PUT', pattern: '/api/v1/suppliers/:supplierId/stock/bulk', handler: handlers.bulkReplaceStock, write: true },
  { method: 'PATCH', pattern: '/api/v1/suppliers/:supplierId/stock/bulk', handler: handlers.bulkPatchStock, write: true },
  { method: 'GET', pattern: '/api/v1/suppliers/:supplierId/stock/:partNumber', handler: handlers.getStockItem },
  { method: 'PUT', pattern: '/api/v1/suppliers/:supplierId/stock/:partNumber', handler: handlers.replaceStock, write: true },
  { method: 'PATCH', pattern: '/api/v1/suppliers/:supplierId/stock/:partNumber', handler: handlers.patchStock, write: true },
  { method: 'DELETE', pattern: '/api/v1/suppliers/:supplierId/stock/:partNumber', handler: handlers.deleteStock, write: true },

  { method: 'GET', pattern: '/api/v1/suppliers/:supplierId/production-plans', handler: handlers.listProductionPlans },
  { method: 'POST', pattern: '/api/v1/suppliers/:supplierId/production-plans', handler: handlers.createProductionPlan, write: true },
  { method: 'PUT', pattern: '/api/v1/suppliers/:supplierId/production-plans/bulk', handler: handlers.bulkReplaceProductionPlans, write: true },
  { method: 'PATCH', pattern: '/api/v1/suppliers/:supplierId/production-plans/bulk', handler: handlers.bulkPatchProductionPlans, write: true },
  // Literal global plan list must come BEFORE the :planId pattern.
  { method: 'GET', pattern: '/api/v1/production-plans', handler: handlers.listAllProductionPlans },
  { method: 'GET', pattern: '/api/v1/production-plans/:planId', handler: handlers.getProductionPlan },
  { method: 'PUT', pattern: '/api/v1/production-plans/:planId', handler: handlers.replaceProductionPlan, write: true },
  { method: 'PATCH', pattern: '/api/v1/production-plans/:planId', handler: handlers.patchProductionPlan, write: true },

  // Webhooks: literal routes first, then the :subscriptionId patterns.
  { method: 'GET', pattern: '/api/v1/webhooks/subscriptions', handler: handlers.listWebhookSubscriptions },
  { method: 'POST', pattern: '/api/v1/webhooks/subscriptions', handler: handlers.createWebhookSubscription, write: true },
  { method: 'GET', pattern: '/api/v1/webhooks/deliveries', handler: handlers.listWebhookDeliveries },
  { method: 'POST', pattern: '/api/v1/webhooks/subscriptions/:subscriptionId/test', handler: handlers.testWebhookSubscription, write: true },
  { method: 'DELETE', pattern: '/api/v1/webhooks/subscriptions/:subscriptionId', handler: handlers.deleteWebhookSubscription, write: true },

  { method: 'GET', pattern: '/api/v1/_simulate/:code', handler: handlers.simulateCode },
  { method: 'GET', pattern: '/api/v1/_ratelimit', handler: handlers.getRateLimit },
];

// Pre-compile each pattern into a RegExp with named capture groups.
const COMPILED = ROUTES.map((route) => {
  const names = [];
  const regexSrc = route.pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, regex: new RegExp(`^${regexSrc}/?$`), names };
});

function matchRoute(method, pathname) {
  const pathMatches = [];
  for (const route of COMPILED) {
    const m = route.regex.exec(pathname);
    if (!m) continue;
    pathMatches.push(route);
    if (route.method === method) {
      const params = {};
      route.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      return { route, params };
    }
  }
  // Path exists but method not allowed -> 405 (nice teaching moment).
  if (pathMatches.length > 0) return { methodNotAllowed: true, allowed: pathMatches.map((r) => r.method) };
  return null;
}

// ---- Small route handlers defined here (need local helpers) -------------

function openapiHandler(ctx) {
  sendJson(ctx.res, 200, spec);
}

function docsHandler(ctx) {
  const html = buildDocsHtml(ctx.baseUrl);
  ctx.res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  ctx.res.end(html);
}

// ---- Static dashboard ---------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

async function serveDashboard(res, urlPath) {
  // Map "/" and "/dashboard" to index.html; everything else is a file name.
  let rel = urlPath.replace(/^\/dashboard\/?/, '');
  if (rel === '' || urlPath === '/') rel = 'index.html';
  const full = path.join(DASHBOARD_DIR, rel);
  // Guard against path traversal (e.g. /dashboard/../../etc/passwd).
  if (!full.startsWith(DASHBOARD_DIR)) {
    return sendError(res, 403, 'Akses file di luar folder dashboard dilarang.');
  }
  try {
    const file = await fs.promises.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Content-Length': file.length,
      // Classroom assets change with every deploy; do not let browsers/CDNs
      // (Cloudflare in front of a Coolify deployment) serve a stale app.js.
      'Cache-Control': 'no-cache',
    });
    res.end(file);
  } catch {
    sendError(res, 404, 'File dashboard tidak ditemukan.');
  }
}

// ---- Body parsing -------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- ETag / conditional GET ---------------------------------------------

/**
 * Canonical query string: parameters sorted by key so that
 * ?a=1&b=2 and ?b=2&a=1 produce the same ETag.
 */
function canonicalQuery(searchParams) {
  const pairs = Array.from(searchParams.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  );
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

/**
 * Strong ETag over (data revision, method, path, sorted query). Any mutation
 * bumps the revision, so cached bodies are invalidated automatically.
 */
function computeEtag(revision, method, pathname, searchParams) {
  const digest = crypto
    .createHash('sha1')
    .update(`${revision}:${method}:${pathname}:${canonicalQuery(searchParams)}`)
    .digest('hex');
  return `"${digest}"`;
}

// (If-None-Match matching now lives in errors.js, next to the 304 decision.)

// ---- CORS + logging -----------------------------------------------------

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-API-Key, Authorization, X-Simulate, Idempotency-Key'
  );
  // Browser JS can read these response headers (pagination, caching, throttling).
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Total-Count, ETag, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, Idempotency-Replayed'
  );
  res.setHeader('Access-Control-Max-Age', '600');
}

function logRequest(req, method, pathname, status, durationMs) {
  // Compact, colour-free (portable) log line. Kept readable for a classroom.
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${method.padEnd(6)} ${pathname} -> ${status} (${durationMs}ms)`);
}

// ---- Main request handler ----------------------------------------------

const server = http.createServer(async (req, res) => {
  const startNs = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  const method = req.method || 'GET';

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startNs) / 1e6;
    logRequest(req, method, pathname, res.statusCode, Math.round(ms * 10) / 10);
  });

  applyCors(res);

  // 1. Preflight — answer immediately for every route.
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 2. Static dashboard + favicon.
  if (pathname === '/' || pathname.startsWith('/dashboard')) {
    return serveDashboard(res, pathname);
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  // 3. Route match.
  const matched = matchRoute(method, pathname);
  if (!matched) {
    return sendError(res, 404, `Endpoint ${method} ${pathname} tidak ditemukan. Lihat /docs untuk daftar endpoint.`);
  }
  if (matched.methodNotAllowed) {
    return sendError(res, 405, `Method ${method} tidak diizinkan. Gunakan: ${matched.allowed.join(', ')}.`);
  }

  const { route, params } = matched;
  const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `localhost:${PORT}`}`;
  const ctx = { req, res, query, params, body: null, rawBody: '', baseUrl };

  try {
    // 4. API-key auth, then rate limiting, then bearer auth for writes.
    //    The split matters: a write without a bearer token is still a valid
    //    caller (API key OK), so its 401 must carry X-RateLimit-* headers.
    if (!route.public && pathname.startsWith('/api/v1')) {
      const api = checkApiKey(req);
      if (!api.ok) return sendError(res, api.status, api.message);

      // 4b. Every authenticated /api/v1 request counts — 304, 404, 406, 429,
      //     _simulate/* and _ratelimit included. A 429 consumes quota too.
      const limitResult = enforceRateLimit(req, res);
      ctx.rateLimit = limitResult.snapshot;
      if (limitResult.blocked) return;

      // 4c. Write scope.
      if (route.write) {
        const bearer = checkBearer(req);
        if (!bearer.ok) return sendError(res, bearer.status, bearer.message);
      }
    }

    // 5. Parse the body. The raw text is kept for the Idempotency-Key hash.
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const raw = await readBody(req);
      ctx.rawBody = raw;
      // DELETE has no JSON contract; only hash its (usually empty) body.
      if (method !== 'DELETE') {
        if (raw.trim() !== '') {
          try {
            ctx.body = JSON.parse(raw);
          } catch {
            return sendError(res, 400, 'Body request bukan JSON yang valid.', [
              { field: 'body', issue: 'JSON parse error' },
            ]);
          }
        } else {
          ctx.body = {};
        }
      }
    }

    // 5b. Idempotency-Key (writes only). Runs BEFORE ?simulate and the handler:
    //     a replay returns the cached response and never mutates the store.
    if (pathname.startsWith('/api/v1') && isIdempotentMethod(method)) {
      const rawKey = req.headers['idempotency-key'];
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (key !== '') {
        const handled = applyIdempotency({
          res,
          method,
          pathname,
          key,
          rawBody: ctx.rawBody,
        });
        if (handled) return;
      }
    }

    // 6. Status-code simulation (?simulate=...).
    if (pathname.startsWith('/api/v1')) {
      const handled = await applySimulation(query, res);
      if (handled) return;
    }

    // 7. Conditional-GET metadata for JSON responses under /api/v1.
    //    The ETag is computed here from the current revision, but the 304
    //    decision belongs to sendJson AFTER the handler has chosen the status:
    //    the pre-handler short-circuit used to answer 304 for resources that
    //    do not exist (404). Errors now never carry an ETag and never get 304.
    //    CSV output is excluded (its ETag would not describe the CSV body).
    if (method === 'GET' && pathname.startsWith('/api/v1')) {
      const { csv } = handlers.negotiateStockAccept(req.headers.accept);
      if (!(pathname === '/api/v1/stock' && csv)) {
        // Webhook lists live outside the supplier store, so their ETag must also
        // track the webhook revision (a created delivery changes the body).
        const webhookTag = pathname.startsWith('/api/v1/webhooks/')
          ? `:wh-${webhooks.getRevision()}`
          : '';
        res._conditional = {
          etag: computeEtag(`${store.getRevision()}${webhookTag}`, method, pathname, url.searchParams),
          ifNoneMatch: req.headers['if-none-match'],
        };
      }
    }

    // 8. Business handler.
    await route.handler(ctx);
  } catch (err) {
    if (String(err && err.message) === 'PAYLOAD_TOO_LARGE') {
      return sendError(res, 400, 'Body request terlalu besar (maksimal 1 MB).');
    }
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      sendError(res, 500, 'Terjadi kesalahan internal pada server sandbox.');
    } else {
      res.end();
    }
  }
});

// ---- Startup banner -----------------------------------------------------

function printBanner() {
  const base = `http://localhost:${PORT}`;
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  MOCK SUPPLIER API — REST API & System Integration course');
  console.log(`  Base URL   : ${base}`);
  console.log(`  Dashboard  : ${base}/`);
  console.log(`  Docs       : ${base}/docs   (OpenAPI: ${base}/openapi.json)`);
  console.log(`  API key    : X-API-Key: sup_demo_key_2026`);
  console.log(`  Write auth : Authorization: Bearer <token>  (POST ${base}/auth/token)`);
  console.log('');
  console.log('  Key endpoints:');
  console.log(`    GET    ${base}/health`);
  console.log(`    POST   ${base}/auth/token`);
  console.log(`    GET    ${base}/api/v1/suppliers`);
  console.log(`    POST   ${base}/api/v1/suppliers`);
  console.log(`    PUT    ${base}/api/v1/suppliers/bulk`);
  console.log(`    PATCH  ${base}/api/v1/suppliers/bulk`);
  console.log(`    GET    ${base}/api/v1/suppliers/SUP-001/stock?page=1&limit=5`);
  console.log(`    POST   ${base}/api/v1/suppliers/SUP-001/stock`);
  console.log(`    POST   ${base}/api/v1/suppliers/SUP-001/stock/bulk`);
  console.log(`    PUT    ${base}/api/v1/suppliers/SUP-001/stock/bulk`);
  console.log(`    PATCH  ${base}/api/v1/suppliers/SUP-001/stock/bulk`);
  console.log(`    GET    ${base}/api/v1/suppliers/SUP-001/production-plans`);
  console.log(`    PUT    ${base}/api/v1/suppliers/SUP-001/production-plans/bulk`);
  console.log(`    PATCH  ${base}/api/v1/suppliers/SUP-001/production-plans/bulk`);
  console.log(`    POST   ${base}/api/v1/webhooks/subscriptions`);
  console.log(`    GET    ${base}/api/v1/webhooks/deliveries`);
  console.log(`    GET    ${base}/api/v1/_simulate/500`);
  console.log(`    GET    ${base}/api/v1/_ratelimit`);
  console.log('');
  console.log(`  Rate limit : ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS} ms per API key (X-RateLimit-*)`);
  console.log('  Idempotency: Idempotency-Key pada POST/PUT/PATCH/DELETE /api/v1/*');
  console.log('');
  console.log('  Simulator: ?simulate=latency&ms=2000 | error500 | timeout | ratelimit | malformed');
  console.log(`${line}\n`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} sudah dipakai proses lain.`);
    console.error(`   Jalankan dengan port lain, contoh: PORT=4020 node sandbox/server/server.js\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  printBanner();
});
