# AGENTS.md

## What this is

Zero-dependency Node.js mock Supplier API (standard library only) plus a vanilla-JS dashboard, used as the practice target for a REST/integration course. No `npm install`, build, bundler, database, lint, typecheck, or test framework. **Do not add dependencies or a build step.**

The app root is this repository root. Some docs and script comments still show a `sandbox/` prefix (`node sandbox/server/server.js`, `bash sandbox/scripts/...`) from an older layout — ignore that prefix and use the paths below.

## Run and verify

```bash
node server/server.js              # from repo root; default port 4010
npm start                          # same thing
PORT=4020 node server/server.js
```

```bash
# server must already be running
bash scripts/smoke-test.sh
BASE_URL=http://localhost:4020 bash scripts/smoke-test.sh
```

- The smoke test is the only automated verification (67 curl checks; exits non-zero on failure). There is no CI.
- The smoke test **mutates data**: it creates `SUP-SMOKE-<epoch>` and `SUP-SMK-<pid>` suppliers, a `SMOKE-*` stock record, a production plan, and a webhook subscription (deleted again at the end; its deliveries stay in memory). Restart the server (or reset the persisted volume) before a clean demo run.
- Docs: `/docs`, spec: `/openapi.json`, dashboard: `/` on the same server. Quick check: `curl -H 'X-API-Key: sup_demo_key_2026' localhost:4010/api/v1/suppliers`.

## Architecture and change points

- `server/server.js` — `ROUTES` table and middleware order: CORS → static dashboard → route match → API-key auth → rate limit → bearer auth (writes) → JSON body (raw body kept) → Idempotency-Key → `?simulate=` → ETag candidate → handler. Auth runs before body parsing; a replay short-circuits before the handler, and webhooks are emitted by the handler after a successful mutation.
- Adding an endpoint: register it in `ROUTES` (literal routes such as `/suppliers/bulk` **must precede** `/:supplierId`), add the handler, then update `server/openapi.js` (served as `/openapi.json`), the fallback table in `server/docs.js`, and the Postman collection.
- `server/handlers.js` — per-endpoint validation, response shaping, CSV/content negotiation, webhook emit calls. `server/data-store.js` — in-memory arrays plus filter/pagination/sort; seeds itself on `require()`. Every mutation must call `persist()`.
- `server/ratelimit.js` — fixed-window limiter per API key (`RATE_LIMIT_MAX` default 600, `RATE_LIMIT_WINDOW_MS` default 60000). Sets `X-RateLimit-*` on every authenticated `/api/v1` response and answers 429 + `Retry-After`; `GET /api/v1/_ratelimit` reads the snapshot.
- `server/idempotency.js` — `Idempotency-Key` on POST/PUT/PATCH/DELETE `/api/v1/*`, scoped by key + method + path with a body hash. Replays set `Idempotency-Replayed: true`; a different body answers 409 `IDEMPOTENCY_KEY_REUSED`. In-memory 24h; 429 and 5xx are not cached.
- `server/webhooks.js` — in-memory subscriptions and deliveries, HMAC-SHA256 signature (`X-Sandbox-Signature: t=<unix>,v1=<hex>`), max 3 attempts with 1s/2s backoff, scheduled off the response path. Storage is wiped on restart.
- ETag/304: only **200 JSON** `/api/v1` GETs get an ETag (CSV excluded). The 304 decision lives in `sendJson` via `res._conditional`, so errors never carry an ETag. Webhook reads mix in the webhook revision.
- `dashboard/` is static, served by the same server at `/` and `/dashboard/*`. `API_BASE` defaults to `window.location.origin` (override via `window.SANDBOX_API_BASE`); the API key is intentionally hardcoded for the demo. Open it over HTTP, never `file://`.
- Dashboard asset URLs carry `?v=4`. Bump that version when editing `app.js` or `styles.css`; it is the existing cache-busting convention for browsers and the CDN in front of Coolify.

## Data

- Default is in-memory: every restart resets to `data/*.json` seeds. `PERSIST_DATA=1` snapshots mutations to `data/store/state.json` (override dir with `DATA_STORE_DIR`) and reloads on boot. Docker/Coolify mounts volume `app_data` at `/app/data`; reset with `docker compose down -v`.
- Seed data deliberately contains data-quality anomalies (e.g. `SUP-001/MJK-LUB-EP2` has qty 0 but `available`, a string `stock_quantity`, lowercase `uom`, orphan plans, delivery before production). These are lesson material — **do not normalize or "fix" them.**
- `data/ANOMALY-CATALOG.md` is trainer-only and pins baseline counts. If you change seed data, update that catalog and the smoke test in the same commit. Its verification line must match the current smoke count (67).

## API contract

- All `/api/v1/*` require `X-API-Key: sup_demo_key_2026`. Writes also require `Authorization: Bearer <token>` obtained from `POST /auth/token` (`client_id: company-dashboard`, `client_secret: s3cr3t-demo`). Any non-empty bearer token is accepted; literal `readonly-token` gets 403 on writes by design (teaching 401 vs 403). Keep auth demo-simple; do not harden it.
- Global reads: `GET /api/v1/stock` (all suppliers; `Accept: text/csv` returns CSV, any other unsupported `Accept` is 406 `NOT_ACCEPTABLE`) and `GET /api/v1/production-plans`. Supplier list filters: `api_status`, `country`, `q`.
- Webhooks: `POST`/`GET /api/v1/webhooks/subscriptions`, `DELETE /api/v1/webhooks/subscriptions/:subscriptionId`, `POST /api/v1/webhooks/subscriptions/:subscriptionId/test` (202), `GET /api/v1/webhooks/deliveries`. Registrable events: `stock.created|updated|deleted`, `plan.created|updated`; `webhook.test` is test-only.
- Errors always use `{ "error": { "code", "message", "details" } }`. Status→code mapping lives in `server/errors.js` (400/401/403/404/405/406/409/429/500).
- Required fields and enums live in `handlers.js` (`uom`: PCS|BOX|METER|SET; stock statuses: available|low|out; plan statuses: planned|in_progress|completed|delayed). Bulk endpoints are atomic by default; `?mode=partial` skips invalid or missing items and answers **207**. Bulk replace/patch never create records; only `POST .../stock/bulk` upserts.
- Pagination: `limit` defaults to 10 and is capped at 50; `sort=field:asc|desc`; `updated_since` filters on `last_updated`.
- Rate limiting counts authenticated `/api/v1/*` requests (public routes and the dashboard are exempt). Idempotency applies to writes only. Keep both demo-simple: no Redis, no persistence.

## Conventions

- User-facing narrative and seed text are Indonesian; identifiers, field names, and code comments are English.
- Server code is CommonJS with `'use strict'`; use Node built-ins (`node:http`, `node:fs`, …).
