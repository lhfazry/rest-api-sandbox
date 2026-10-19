#!/usr/bin/env bash
#
# smoke-test.sh — Verifies the Mock Supplier API end-to-end with curl.
#
# PREREQUISITE: the server must already be running:
#     node sandbox/server/server.js
#
# Usage:
#     bash sandbox/scripts/smoke-test.sh
#     BASE_URL=http://localhost:4020 bash sandbox/scripts/smoke-test.sh
#
# It prints PASS/FAIL per check with the observed HTTP status code.

set -u

BASE_URL="${BASE_URL:-http://localhost:4010}"
API_KEY="sup_demo_key_2026"
CLIENT_ID="company-dashboard"
CLIENT_SECRET="s3cr3t-demo"
READONLY_TOKEN="readonly-token"

PASS=0
FAIL=0
TMP_BODY="$(mktemp)"
trap 'rm -f "$TMP_BODY"' EXIT

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

echo "══════════════════════════════════════════════════════════════"
echo " Smoke test — Mock Supplier API @ $BASE_URL"
echo "══════════════════════════════════════════════════════════════"

# 0. Fail fast with a friendly message when the server is not running.
echo "─ Health ──────────────────────────────────────────────────────"
if ! curl -s -o /dev/null "$BASE_URL/health"; then
  echo "  $(red ERROR): server tidak berjalan di $BASE_URL"
  echo "  Jalankan dulu: node sandbox/server/server.js"
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
