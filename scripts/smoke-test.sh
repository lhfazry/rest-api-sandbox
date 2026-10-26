#!/usr/bin/env bash
#
# smoke-test.sh — Verifies the Mock Supplier API end-to-end with curl.
#
# PREREQUISITE: the server must already be running:
#     node server/server.js
#
# Usage:
#     bash scripts/smoke-test.sh
#     BASE_URL=http://localhost:4020 bash scripts/smoke-test.sh
#
# It prints PASS/FAIL per check with the observed HTTP status code.
#
# NOTE: the run mutates in-memory data. It creates `SUP-SMOKE-<epoch>` and
# `SUP-SMK-<pid>` suppliers, a `SMOKE-<epoch>` stock record, a production plan
# and a webhook subscription (deleted again at the end). Webhook deliveries stay
# in memory and the unreachable receiver (127.0.0.1:9) is contacted in the
# background only, so the script never waits for it.

set -u

BASE_URL="${BASE_URL:-http://localhost:4010}"
API_KEY="sup_demo_key_2026"
CLIENT_ID="company-dashboard"
CLIENT_SECRET="s3cr3t-demo"
READONLY_TOKEN="readonly-token"

PASS=0
FAIL=0
TMP_BODY="$(mktemp)"
TMP_HEADERS="$(mktemp)"
trap 'rm -f "$TMP_BODY" "$TMP_HEADERS"' EXIT

# Values captured from earlier responses (initialised for `set -u`).
ETAG=""
WH_ID=""
WH_URL=""
IDEM_KEY=""
IDEM_SUPPLIER=""

green() { printf "\033[32m%s\033[0m" "$1"; }
red()   { printf "\033[31m%s\033[0m" "$1"; }

# check <name> <expected_status> <curl args...>
check() {
  local name="$1" expected="$2"; shift 2
  local code
  code="$(curl -s -o "$TMP_BODY" -w "%{http_code}" "$@")"
  if [ "$code" = "$expected" ]; then
    printf "  %s [%s] %s\n" "$(green PASS)" "$code" "$name"
    PASS=$((PASS + 1))
  else
    printf "  %s [got %s, want %s] %s\n" "$(red FAIL)" "$code" "$expected" "$name"
    FAIL=$((FAIL + 1))
  fi
}

# header_value <header-name> — value of the last response header, CR stripped.
header_value() {
  grep -i "^$1:" "$TMP_HEADERS" | head -1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r'
}

# check_header_present <name> <header-name> <curl args...>
# Asserts the header exists and carries a non-empty value.
check_header_present() {
  local name="$1" header_name="$2"; shift 2
  local code value
  code="$(curl -s -o "$TMP_BODY" -D "$TMP_HEADERS" -w "%{http_code}" "$@")"
  value="$(header_value "$header_name")"
  if [ -n "$value" ]; then
    printf "  %s [%s] %s\n" "$(green PASS)" "$code" "$name"
    PASS=$((PASS + 1))
  else
    printf "  %s [%s, header %s kosong] %s\n" "$(red FAIL)" "$code" "$header_name" "$name"
    FAIL=$((FAIL + 1))
  fi
}

# check_header_contains <name> <header-name> <expected-substring> <curl args...>
check_header_contains() {
  local name="$1" header_name="$2" expected="$3"; shift 3
  local code value
  code="$(curl -s -o "$TMP_BODY" -D "$TMP_HEADERS" -w "%{http_code}" "$@")"
  value="$(header_value "$header_name")"
  if [ -n "$value" ] && printf '%s' "$value" | grep -qF -- "$expected"; then
    printf "  %s [%s] %s\n" "$(green PASS)" "$code" "$name"
    PASS=$((PASS + 1))
  else
    printf "  %s [%s, %s tanpa \"%s\"] %s\n" "$(red FAIL)" "$code" "$header_name" "$expected" "$name"
    FAIL=$((FAIL + 1))
  fi
}

# check_absent_header <name> <header-name> <curl args...>
check_absent_header() {
  local name="$1" header_name="$2"; shift 2
  local code value
  code="$(curl -s -o "$TMP_BODY" -D "$TMP_HEADERS" -w "%{http_code}" "$@")"
  value="$(header_value "$header_name")"
  if [ -z "$value" ]; then
    printf "  %s [%s] %s\n" "$(green PASS)" "$code" "$name"
    PASS=$((PASS + 1))
  else
    printf "  %s [%s, header %s = %s] %s\n" "$(red FAIL)" "$code" "$header_name" "$value" "$name"
    FAIL=$((FAIL + 1))
  fi
}

# check_body_contains <name> <expected-substring> <curl args...>
check_body_contains() {
  local name="$1" expected="$2"; shift 2
  local code
  code="$(curl -s -o "$TMP_BODY" -w "%{http_code}" "$@")"
  if grep -qF -- "$expected" "$TMP_BODY"; then
    printf "  %s [%s] %s\n" "$(green PASS)" "$code" "$name"
    PASS=$((PASS + 1))
  else
    printf "  %s [%s, body tanpa \"%s\"] %s\n" "$(red FAIL)" "$code" "$expected" "$name"
    FAIL=$((FAIL + 1))
  fi
}

# check_status_header_contains <name> <expected-status> <header-name> <expected-substring> <curl args...>
check_status_header_contains() {
  local name="$1" expected="$2" header_name="$3" needle="$4"; shift 4
  local code value
  code="$(curl -s -o "$TMP_BODY" -D "$TMP_HEADERS" -w "%{http_code}" "$@")"
  value="$(header_value "$header_name")"
  if [ "$code" = "$expected" ] && [ -n "$value" ] && printf '%s' "$value" | grep -qF -- "$needle"; then
    printf "  %s [%s] %s\n" "$(green PASS)" "$code" "$name"
    PASS=$((PASS + 1))
  else
    printf "  %s [got %s, want %s / %s tanpa \"%s\"] %s\n" \
      "$(red FAIL)" "$code" "$expected" "$header_name" "$needle" "$name"
    FAIL=$((FAIL + 1))
  fi
}

# check_status_body_contains <name> <expected-status> <expected-substring> <curl args...>
check_status_body_contains() {
  local name="$1" expected="$2" needle="$3"; shift 3
  local code
  code="$(curl -s -o "$TMP_BODY" -w "%{http_code}" "$@")"
  if [ "$code" = "$expected" ] && grep -qF -- "$needle" "$TMP_BODY"; then
    printf "  %s [%s] %s\n" "$(green PASS)" "$code" "$name"
    PASS=$((PASS + 1))
  else
    printf "  %s [got %s, want %s / body tanpa \"%s\"] %s\n" \
      "$(red FAIL)" "$code" "$expected" "$needle" "$name"
    FAIL=$((FAIL + 1))
  fi
}

# check_status_empty_body <name> <expected-status> <curl args...>
check_status_empty_body() {
  local name="$1" expected="$2"; shift 2
  local code
  # curl does not truncate -o on a 304 (no body is written), so start clean.
  : > "$TMP_BODY"
  code="$(curl -s -o "$TMP_BODY" -D "$TMP_HEADERS" -w "%{http_code}" "$@")"
  if [ "$code" = "$expected" ] && [ ! -s "$TMP_BODY" ]; then
    printf "  %s [%s, body kosong] %s\n" "$(green PASS)" "$code" "$name"
    PASS=$((PASS + 1))
  else
    local body_state="kosong"
    [ -s "$TMP_BODY" ] && body_state="tidak kosong"
    printf "  %s [got %s, want %s / body %s] %s\n" \
      "$(red FAIL)" "$code" "$expected" "$body_state" "$name"
    FAIL=$((FAIL + 1))
  fi
}

echo "══════════════════════════════════════════════════════════════"
echo " Smoke test — Mock Supplier API @ $BASE_URL"
echo "══════════════════════════════════════════════════════════════"

# 0. Fail fast with a friendly message when the server is not running.
echo "─ Health ──────────────────────────────────────────────────────"
if ! curl -s -o /dev/null "$BASE_URL/health"; then
  echo "  $(red ERROR): server tidak berjalan di $BASE_URL"
  echo "  Jalankan dulu: node server/server.js"
  exit 1
fi
check "GET /health" 200 "$BASE_URL/health"

echo "─ Authentication ──────────────────────────────────────────────"
check "POST /auth/token (kredensial benar)" 200 \
  -X POST -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$CLIENT_ID\",\"client_secret\":\"$CLIENT_SECRET\"}" \
  "$BASE_URL/auth/token"

check "POST /auth/token (kredensial salah) -> 401" 401 \
  -X POST -H "Content-Type: application/json" \
  -d "{\"client_id\":\"company-dashboard\",\"client_secret\":\"salah\"}" \
  "$BASE_URL/auth/token"

# Capture a real token for the write checks below.
TOKEN="$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$CLIENT_ID\",\"client_secret\":\"$CLIENT_SECRET\"}" \
  "$BASE_URL/auth/token" | sed -n 's/.*"access_token": *"\([^"]*\)".*/\1/p')"

if [ -z "$TOKEN" ]; then
  echo "  $(red FAIL): tidak bisa mengambil token, cek /auth/token."
  FAIL=$((FAIL + 1))
fi

echo "─ Suppliers ───────────────────────────────────────────────────"
check "GET /api/v1/suppliers (dengan API key)" 200 -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers"
check "GET /api/v1/suppliers tanpa API key -> 401" 401 "$BASE_URL/api/v1/suppliers"
check "GET /api/v1/suppliers/SUP-001" 200 -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001"
check "GET /api/v1/suppliers/SUP-999 -> 404" 404 -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-999"

SUPPLIER_ID="SUP-SMOKE-$(date +%s)"
check "POST /api/v1/suppliers tanpa bearer -> 401" 401 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
  -d "{\"supplier_id\":\"$SUPPLIER_ID\",\"supplier_name\":\"Smoke Supplier\"}" \
  "$BASE_URL/api/v1/suppliers"

check "POST /api/v1/suppliers body tidak valid -> 400" 400 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"supplier_name\":\"Tanpa Supplier ID\"}" \
  "$BASE_URL/api/v1/suppliers"

check "POST /api/v1/suppliers valid -> 201" 201 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"supplier_id\":\"$SUPPLIER_ID\",\"supplier_name\":\"Smoke Supplier\",\"country\":\"Indonesia\",\"contact_email\":\"smoke@supplier.co.id\",\"api_status\":\"active\"}" \
  "$BASE_URL/api/v1/suppliers"

check "POST /api/v1/suppliers duplikat -> 409" 409 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"supplier_id\":\"$SUPPLIER_ID\",\"supplier_name\":\"Smoke Supplier\",\"country\":\"Indonesia\",\"contact_email\":\"smoke@supplier.co.id\",\"api_status\":\"active\"}" \
  "$BASE_URL/api/v1/suppliers"

check "GET /api/v1/suppliers/$SUPPLIER_ID -> 200" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/$SUPPLIER_ID"

echo "─ Stock (Read) ────────────────────────────────────────────────"
check "GET stock pagination page=1 limit=5" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/stock?page=1&limit=5"
check "GET stock filter status=low" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/stock?status=low"
check "GET stock sort stock_quantity:asc" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/stock?sort=stock_quantity:asc"
check "GET stock detail part MJK-BRG-6205" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/stock/MJK-BRG-6205"
check "GET stock detail part tidak ada -> 404" 404 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/stock/NOPE-000"

echo "─ Stock (Write) ───────────────────────────────────────────────"
PART="SMOKE-$(date +%s)"
check "POST stock tanpa API key -> 401" 401 \
  -X POST -H "Content-Type: application/json" \
  -d "{\"part_number\":\"$PART\",\"part_name\":\"X\",\"stock_quantity\":1,\"uom\":\"PCS\",\"stock_location\":\"WH-X\",\"stock_status\":\"available\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock"

check "POST stock tanpa bearer -> 401" 401 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
  -d "{\"part_number\":\"$PART\",\"part_name\":\"X\",\"stock_quantity\":1,\"uom\":\"PCS\",\"stock_location\":\"WH-X\",\"stock_status\":\"available\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock"

check "POST stock body tidak valid -> 400" 400 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"part_number\":\"$PART\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock"

check "POST stock dengan bearer readonly -> 403" 403 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $READONLY_TOKEN" \
  -d "{\"part_number\":\"$PART\",\"part_name\":\"X\",\"stock_quantity\":1,\"uom\":\"PCS\",\"stock_location\":\"WH-X\",\"stock_status\":\"available\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock"

check "POST stock valid -> 201" 201 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"part_number\":\"$PART\",\"part_name\":\"Smoke Part\",\"stock_quantity\":10,\"uom\":\"PCS\",\"stock_location\":\"WH-JKT-09\",\"stock_status\":\"available\",\"unit_price\":1234,\"currency\":\"IDR\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock"

check "PATCH stock -> 200" 200 \
  -X PATCH -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"stock_quantity\":3,\"stock_status\":\"low\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock/$PART"

check "PUT stock (replace) -> 200" 200 \
  -X PUT -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"part_number\":\"$PART\",\"part_name\":\"Smoke Part Replaced\",\"stock_quantity\":7,\"uom\":\"BOX\",\"stock_location\":\"WH-JKT-09\",\"stock_status\":\"available\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock/$PART"

check "POST stock/bulk (integration sync) -> 201" 201 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"items\":[{\"part_number\":\"$PART\",\"part_name\":\"Smoke Bulk\",\"stock_quantity\":99,\"uom\":\"PCS\",\"stock_location\":\"WH-JKT-09\",\"stock_status\":\"available\"}]}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock/bulk"

check "POST stock/bulk strict (1 item invalid) -> 400" 400 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"items\":[{\"part_number\":\"$PART\",\"part_name\":\"Smoke Bulk\",\"stock_quantity\":99,\"uom\":\"PCS\",\"stock_location\":\"WH-JKT-09\",\"stock_status\":\"available\"},{\"part_number\":\"$PART-BAD\",\"part_name\":\"Bad Item\"}]}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock/bulk"

check "POST stock/bulk?mode=partial (1 item invalid) -> 207" 207 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"items\":[{\"part_number\":\"$PART\",\"part_name\":\"Smoke Bulk\",\"stock_quantity\":99,\"uom\":\"PCS\",\"stock_location\":\"WH-JKT-09\",\"stock_status\":\"available\"},{\"part_number\":\"$PART-BAD\",\"part_name\":\"Bad Item\"}]}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock/bulk?mode=partial"

check "DELETE stock -> 204" 204 \
  -X DELETE -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/suppliers/SUP-001/stock/$PART"

echo "─ Production Planning ─────────────────────────────────────────"
check "GET production-plans" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/production-plans"
check "GET production-plans filter status=planned" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/production-plans?status=planned"
check "GET production plan PLAN-001" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/production-plans/PLAN-001"
check "GET production plan PLAN-999 -> 404" 404 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/production-plans/PLAN-999"

check "POST production plan tanpa bearer -> 401" 401 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" \
  -d "{\"part_number\":\"SMOKE-PLAN-01\",\"part_name\":\"Smoke Plan Part\",\"production_plan\":\"Smoke Test Plan\",\"planned_quantity\":100,\"production_date\":\"2026-05-01\",\"production_status\":\"planned\",\"delivery_schedule\":\"2026-05-10\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/production-plans"

check "POST production plan body tidak valid -> 400" 400 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"part_number\":\"SMOKE-PLAN-01\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/production-plans"

check "POST production plan valid -> 201" 201 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"part_number\":\"SMOKE-PLAN-01\",\"part_name\":\"Smoke Plan Part\",\"production_plan\":\"Smoke Test Plan\",\"planned_quantity\":100,\"production_date\":\"2026-05-01\",\"production_status\":\"planned\",\"delivery_schedule\":\"2026-05-10\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-001/production-plans"

check "POST production plan SUP-999 -> 404" 404 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"part_number\":\"SMOKE-PLAN-01\",\"part_name\":\"Smoke Plan Part\",\"production_plan\":\"Smoke Test Plan\",\"planned_quantity\":100,\"production_date\":\"2026-05-01\",\"production_status\":\"planned\",\"delivery_schedule\":\"2026-05-10\"}" \
  "$BASE_URL/api/v1/suppliers/SUP-999/production-plans"

echo "─ Global Reads & CSV ─────────────────────────────────────────"
check "GET /api/v1/stock" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/stock"
check "GET /api/v1/stock?status=low&limit=5" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/stock?status=low&limit=5"
check_status_header_contains "GET /api/v1/stock Accept: text/csv -> 200 + Content-Type" 200 \
  "Content-Type" "text/csv" \
  -H "X-API-Key: $API_KEY" -H "Accept: text/csv" "$BASE_URL/api/v1/stock"
check_status_body_contains "GET /api/v1/stock Accept: application/xml -> 406 NOT_ACCEPTABLE" 406 \
  "NOT_ACCEPTABLE" \
  -H "X-API-Key: $API_KEY" -H "Accept: application/xml" "$BASE_URL/api/v1/stock"
check "GET /api/v1/production-plans" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/production-plans"
check "GET /api/v1/suppliers?api_status=active&limit=1" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers?api_status=active&limit=1"

echo "─ Cache ───────────────────────────────────────────────────────"
STOCK_CACHE_URL="$BASE_URL/api/v1/suppliers/SUP-001/stock"
check_header_present "GET stock -> header ETag (non-kosong)" "ETag" \
  -H "X-API-Key: $API_KEY" "$STOCK_CACHE_URL"
ETAG="$(header_value "ETag")"
check_status_empty_body "GET stock If-None-Match -> 304 + body kosong" 304 \
  -H "X-API-Key: $API_KEY" -H "If-None-Match: $ETAG" "$STOCK_CACHE_URL"

echo "─ Rate Limit ──────────────────────────────────────────────────"
check_header_present "GET /api/v1/suppliers -> header X-RateLimit-Limit" "X-RateLimit-Limit" \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers"
check_status_body_contains "GET /api/v1/_ratelimit -> 200 + remaining" 200 \
  "remaining" \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/_ratelimit"

echo "─ Idempotency ─────────────────────────────────────────────────"
# $$ keeps the key and supplier unique per run, so reruns do not collide.
IDEM_KEY="smoke-idem-$$"
IDEM_SUPPLIER="SUP-SMK-$$"
check "POST /api/v1/suppliers + Idempotency-Key -> 201" 201 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -d "{\"supplier_id\":\"$IDEM_SUPPLIER\",\"supplier_name\":\"Smoke Idempotent\",\"api_status\":\"active\"}" \
  "$BASE_URL/api/v1/suppliers"
check_status_header_contains "POST ulang (key + body sama) -> 201 + Idempotency-Replayed" 201 \
  "Idempotency-Replayed" "true" \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -d "{\"supplier_id\":\"$IDEM_SUPPLIER\",\"supplier_name\":\"Smoke Idempotent\",\"api_status\":\"active\"}" \
  "$BASE_URL/api/v1/suppliers"
check_status_body_contains "POST key sama + body beda -> 409 IDEMPOTENCY_KEY_REUSED" 409 \
  "IDEMPOTENCY_KEY_REUSED" \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -d "{\"supplier_id\":\"$IDEM_SUPPLIER\",\"supplier_name\":\"Smoke Idempotent Berubah\",\"api_status\":\"active\"}" \
  "$BASE_URL/api/v1/suppliers"

echo "─ Webhooks ────────────────────────────────────────────────────"
# Port 9 is unreachable: delivery attempts fail in the background, never block.
WH_URL="http://127.0.0.1:9/smoke-hook-$$"
check "POST /api/v1/webhooks/subscriptions -> 201" 201 \
  -X POST -H "Content-Type: application/json" -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  -d "{\"url\":\"$WH_URL\",\"events\":[\"stock.updated\"]}" \
  "$BASE_URL/api/v1/webhooks/subscriptions"
WH_ID="$(grep -o 'WH-[0-9]*' "$TMP_BODY" | head -1)"
check "GET /api/v1/webhooks/subscriptions" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/webhooks/subscriptions"
check "POST /api/v1/webhooks/subscriptions/$WH_ID/test -> 202" 202 \
  -X POST -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/webhooks/subscriptions/$WH_ID/test"
check "GET /api/v1/webhooks/deliveries?subscription_id=$WH_ID" 200 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/webhooks/deliveries?subscription_id=$WH_ID"
check "DELETE /api/v1/webhooks/subscriptions/$WH_ID -> 204" 204 \
  -X DELETE -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/webhooks/subscriptions/$WH_ID"

echo "─ Method Not Allowed ──────────────────────────────────────────"
check "DELETE /api/v1/suppliers/SUP-001 -> 405" 405 \
  -X DELETE -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/suppliers/SUP-001"

echo "─ Status Code Simulator ───────────────────────────────────────"
for code in 400 401 403 404 429 500; do
  check "GET /api/v1/_simulate/$code -> $code" "$code" \
    -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/_simulate/$code"
done
check "GET stock ?simulate=error500 -> 500" 500 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/stock?simulate=error500"
check "GET stock ?simulate=ratelimit -> 429" 429 \
  -H "X-API-Key: $API_KEY" "$BASE_URL/api/v1/suppliers/SUP-001/stock?simulate=ratelimit"

echo "─ Docs & Dashboard ────────────────────────────────────────────"
check "GET /docs (HTML)" 200 "$BASE_URL/docs"
check "GET /openapi.json" 200 "$BASE_URL/openapi.json"
check "GET / (dashboard)" 200 "$BASE_URL/"
check "GET /dashboard/app.js" 200 "$BASE_URL/dashboard/app.js"

echo "══════════════════════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  printf " %s  %d/%d checks passed\n" "$(green "ALL PASS")" "$PASS" "$TOTAL"
  echo "══════════════════════════════════════════════════════════════"
  exit 0
else
  printf " %s  %d/%d passed, %d failed\n" "$(red "FAILURES")" "$PASS" "$TOTAL" "$FAIL"
  echo "══════════════════════════════════════════════════════════════"
  exit 1
fi
