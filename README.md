# Mock Supplier API: Sandbox Latihan

Sandbox ini adalah **Supplier System tiruan** untuk course *REST API & System Integration for Non-Technical Team*. Semua latihan (Postman / browser) menembak API ini. Tujuannya bukan membangun API, tapi **membaca, menguji, dan memvalidasi** alur integrasi:

```
Supplier System  →  REST API  →  Company Internal System  →  Company Dashboard
 (sandbox API)     (endpoint)     (dashboard mock)            (index.html)
```

- **Zero dependency**: hanya memakai standard library Node.js. Tidak ada `npm install`.
- **Data in-memory**: di-load dari `sandbox/data/*.json` saat start, dan **reset tiap server di-restart** (default untuk lokal/kelas). Di Docker/Coolify, dengan volume `app_data`, data hasil mutasi tetap tersimpan setelah restart/redeploy.
- **Bahasa**: narasi Indonesia, istilah teknis English.

---

## 1. Cara Menjalankan

Prasyarat: **Node.js** terpasang (v18+; repo ini diuji dengan Node v23).

```bash
# Dari root repository
node sandbox/server/server.js

# atau via npm (dari folder sandbox/)
cd sandbox
npm start

# Port lain (default 4010)
PORT=4020 node sandbox/server/server.js
```

Setelah jalan, buka:

| URL | Isi |
|---|---|
| `http://localhost:4010/` | **Company Dashboard** (mock): stock, production planning, dan data supplier |
| `http://localhost:4010/docs` | Dokumentasi interaktif (Swagger UI + fallback offline) |
| `http://localhost:4010/openapi.json` | Spesifikasi OpenAPI 3.0 (machine-readable) |
| `http://localhost:4010/health` | Cek status service (publik) |

Hentikan server dengan `Ctrl + C`.

---

## 2. Dua Lapis Authentication

Course ini mengajarkan **API Key** (identitas aplikasi) dan **Bearer Token** (izin operasi).

**Lapis 1: API Key** (wajib untuk semua `/api/v1/*`):

```
X-API-Key: sup_demo_key_2026
```

**Lapis 2: Bearer Token** (wajib untuk operasi tulis: `POST`/`PUT`/`PATCH`/`DELETE`).
Ambil token dulu:

```bash
curl -X POST http://localhost:4010/auth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}'
```

Respons:

```json
{
  "access_token": "eyJhbGciOiJkZW1v...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

Token boleh berupa string apa pun yang tidak kosong (agar demo mudah). **Pengecualian edukasi:** token literal
`readonly-token` diizinkan untuk **membaca**, tetapi operasi tulis dibalas **403 Forbidden**: supaya peserta
bisa membedakan **401 Unauthorized** (belum/tidak terautentikasi) vs **403 Forbidden** (sudah terautentikasi tapi tidak berizin).

### Contoh copy-paste curl

```bash
# 1) Baca data: cukup API key
curl http://localhost:4010/api/v1/suppliers \
  -H "X-API-Key: sup_demo_key_2026"

# 2) Tulis data: API key + bearer token
TOKEN=$(curl -s -X POST http://localhost:4010/auth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' \
  | sed -n 's/.*"access_token": *"\([^"]*\)".*/\1/p')

curl -X POST http://localhost:4010/api/v1/suppliers/SUP-001/stock \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sup_demo_key_2026" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"part_number":"MJK-DEMO-01","part_name":"Part Demo","stock_quantity":50,"uom":"PCS","stock_location":"WH-JKT-01","stock_status":"available","unit_price":99000,"currency":"IDR"}'

# 3) Tambah supplier baru (201)
curl -X POST http://localhost:4010/api/v1/suppliers \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sup_demo_key_2026" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"supplier_id":"SUP-004","supplier_name":"PT Demo Supplier","country":"Indonesia","contact_email":"demo@supplier.co.id","api_status":"active"}'
# Kirim ulang body yang sama -> 409 Conflict (supplier_id sudah terdaftar)

# 4) Demonstrasi 403: token read-only untuk operasi tulis
curl -X POST http://localhost:4010/api/v1/suppliers/SUP-001/stock \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sup_demo_key_2026" \
  -H "Authorization: Bearer readonly-token" \
  -d '{"part_number":"X","part_name":"X","stock_quantity":1,"uom":"PCS","stock_location":"WH-X","stock_status":"available"}'
```

---

## 3. Tabel Endpoint

Base URL: `http://localhost:4010`

| Method | Endpoint | Auth | Keterangan |
|---|---|---|---|
| GET | `/health` | publik | Status service |
| POST | `/auth/token` | publik | Ambil bearer token |
| GET | `/docs` | publik | Dokumentasi HTML |
| GET | `/openapi.json` | publik | OpenAPI 3.0 |
| GET | `/api/v1/suppliers` | API Key | Daftar supplier `{ data, meta.total }` |
| POST | `/api/v1/suppliers` | API Key + Bearer | Tambah supplier → **201** / **400** / **409** |
| GET | `/api/v1/suppliers/:supplierId` | API Key | Detail supplier |
| GET | `/api/v1/suppliers/:supplierId/stock` | API Key | Daftar stock (query: `status`, `page`, `limit`, `updated_since`, `sort`) |
| GET | `/api/v1/suppliers/:supplierId/stock/:partNumber` | API Key | Detail satu part |
| POST | `/api/v1/suppliers/:supplierId/stock` | API Key + Bearer | Tambah record → **201** / **400** / **409** |
| PUT | `/api/v1/suppliers/:supplierId/stock/:partNumber` | API Key + Bearer | Replace penuh → **200** / **404** |
| PATCH | `/api/v1/suppliers/:supplierId/stock/:partNumber` | API Key + Bearer | Update sebagian → **200** / **404** |
| DELETE | `/api/v1/suppliers/:supplierId/stock/:partNumber` | API Key + Bearer | Hapus → **204** / **404** |
| POST | `/api/v1/suppliers/:supplierId/stock/bulk` | API Key + Bearer | **Bulk upsert** → **201** (semua valid) / **207** (`?mode=partial`: sebagian berhasil) / **400** (strict, ada item invalid) |
| GET | `/api/v1/suppliers/:supplierId/production-plans` | API Key | Daftar production plan (query: `status`, `page`, `limit`) |
| GET | `/api/v1/production-plans/:planId` | API Key | Detail plan |
| POST | `/api/v1/suppliers/:supplierId/production-plans` | API Key + Bearer | Tambah plan → **201** / **400** |
| GET | `/api/v1/_simulate/:code` | API Key | Contoh status: `400/401/403/404/429/500` |

**Envelope pagination** (`stock` & `production-plans`):

```json
{ "data": [ ... ], "meta": { "page": 1, "limit": 10, "total": 6, "total_pages": 1 } }
```

**Envelope error standar** (selalu sama, di semua endpoint):

```json
{ "error": { "code": "NOT_FOUND", "message": "Supplier \"SUP-999\" tidak ditemukan.", "details": [] } }
```

Peta code: `400 → VALIDATION_ERROR`, `401 → UNAUTHORIZED`, `403 → FORBIDDEN`, `404 → NOT_FOUND`,
`429 → RATE_LIMITED`, `500 → INTERNAL_SERVER_ERROR`.

---

## 4. Cheat-sheet Status Code Simulator

Gunakan query param `?simulate=...` pada request nyata, atau endpoint `GET /api/v1/_simulate/:code`.

| Contoh | Efek |
|---|---|
| `?simulate=latency&ms=2000` | Respons lambat 2 detik, lalu sukses **200** |
| `?simulate=timeout&ms=10000` | Delay panjang (Postman akan melaporkan **timeout**). `ms` di-cap 15000 |
| `?simulate=error500` | **500** `INTERNAL_SERVER_ERROR` |
| `?simulate=ratelimit` | **429** + header `Retry-After: 5` |
| `?simulate=malformed` | Body JSON **sengaja rusak** (latihan mendeteksi payload tidak valid) |
| `GET /api/v1/_simulate/400` | **400** dengan error body standar (idem untuk 401/403/404/429/500) |

Contoh:

```bash
curl -i "http://localhost:4010/api/v1/suppliers/SUP-001/stock?simulate=ratelimit" \
  -H "X-API-Key: sup_demo_key_2026"

curl -i "http://localhost:4010/api/v1/_simulate/500" \
  -H "X-API-Key: sup_demo_key_2026"
```

---

## 5. Data Seed

| File | Isi |
|---|---|
| `data/suppliers.json` | 3 supplier: `SUP-001` PT Maju Jaya Komponen, `SUP-002` CV Sentosa Parts, `SUP-003` PT Nusantara Elektrik (**`inactive`**, anomali A8) |
| `data/stock.json` | 24 record stock (6/9/9 per supplier), termasuk status `available`/`low`/`out` dan anomali terkontrol |
| `data/production_plans.json` | 15 record production plan, sebagian sengaja orphan / tanggal tidak logis |
| `data/ANOMALY-CATALOG.md` | **Trainer only** — daftar anomali + baseline angka yang dikunci materi |

Field stock: `supplier_id`, `supplier_name`, `part_number`, `part_name`, `stock_quantity`, `uom` (`PCS/BOX/METER/SET`),
`stock_location`, `stock_status` (`available/low/out`), `unit_price`, `currency` (`IDR`), `last_updated`.
Field supplier: `supplier_id` (`SUP-...`), `supplier_name`, `country`, `contact_email`, `api_status` (`active/inactive`).
Field production plan: `plan_id`, `supplier_id`, `part_number`, `part_name`, `production_plan`, `planned_quantity`,
`production_date`, `production_status` (`planned/in_progress/completed/delayed`), `delivery_schedule`, `last_updated`.

> Catatan: `plan_id` ditambahkan sebagai identifier unik karena endpoint `GET /api/v1/production-plans/:planId` memerlukannya.

### Persistence di Docker/Coolify

- Set `PERSIST_DATA=1` (sudah default di `Dockerfile` & `docker-compose.yml`) dan mount named volume `app_data` ke `/app/data`.
- Setiap mutasi (`POST`/`PUT`/`PATCH`/`DELETE`) disimpan ke `data/store/state.json` di dalam volume, lalu di-load ulang saat container restart, sehingga data tetap ada setelah restart/redeploy.
- Reset ke data seed: `docker compose down -v`, atau hapus volume lewat Coolify UI (**Persistent Storage**).

### Data untuk latihan

> **Anomali data yang disengaja (bukan data nyata).** Record `MJK-LUB-EP2` milik supplier `SUP-001`
> sengaja dibuat tidak konsisten: `"stock_quantity": 0` tetapi `"stock_status": "available"`.
> Ini adalah **artefak demo/teaching**, dipakai di latihan untuk mengajarkan *deteksi data-quality &
> data-mapping*: pertanyaan kelasnya: **“Kalau supplier bilang stok 0 tapi status `available`,
> ini masalah data mapping siapa?”** Semua record lain tetap wajar (status `out` selalu berarti qty 0).
> Kalau peserta menemukan keanehan ini, jawabannya memang ada di sini, bukan bug.

---

## 6. Cara Kerja Dashboard

`http://localhost:4010/` menampilkan **Company Internal System: Supplier Integration Dashboard** dengan tiga tab:

1. **Stock** — tabel stock supplier. Summary card **Total Items**, **Low Stock**, **Out of Stock**,
   **Available** dihitung dari baris yang sedang tampil. Filter yang tersedia:
   - **Status Stock**: `available` / `low` / `out`
   - **Production Plan**: nama plan supplier, mis. `Weekly Rolling Plan Q1-2026`
   - **Status Produksi**: `planned` / `in_progress` / `completed` / `delayed`
   - **Cari Part**: part number atau part name

   Filter production plan dan status produksi menyaring **plan** terlebih dahulu, lalu stock
   digabungkan lewat `part_number`. Jadi kombinasi `Weekly Rolling Plan Q1-2026` + `delayed`
   hanya menampilkan part yang punya plan tersebut dengan status delayed. Kolom **Production**
   menampilkan badge status + nama plan; kolom **Planned Qty** dan **Delivery** muncul saat
   filter produksi aktif. Filter yang aktif tampil sebagai chip yang bisa dihapus, dan ada
   tombol **Reset filter**.
2. **Production Planning** — daftar plan supplier (Plan ID, part, nama plan, planned qty,
   production date, delivery schedule, status), diurutkan berdasarkan `production_date`.
   Ada filter status produksi dan summary card **Total Plans**, **In Progress**, **Delayed**,
   **Completed**.
3. **Supplier** — semua supplier dari `GET /api/v1/suppliers` beserta negara, kontak, status API,
   dan jumlah stock/low/out/plan tiap supplier. Baris supplier yang sedang dipilih ditandai
   **Aktif**; tombol **Pilih** mengganti supplier aktif.

Endpoint yang dipakai dashboard (selalu dengan header `X-API-Key`):

```
GET /api/v1/suppliers
GET /api/v1/suppliers/<id>/stock?limit=50&sort=stock_quantity:asc
GET /api/v1/suppliers/<id>/production-plans?limit=50
```

Ada **supplier selector** (SUP-001..003), tombol **Refresh**, auto-refresh tiap 30 detik, dan
**last sync** timestamp. Refresh tidak mereset pilihan filter atau tab. Jika server mati,
dashboard menampilkan **error state** yang menyuruh menjalankan `node sandbox/server/server.js`;
jika hanya sebagian request yang gagal, data yang berhasil tetap tampil dengan banner peringatan.

> **Penting untuk peserta:** `API_BASE` dan `API_KEY` di-hardcode di `dashboard/app.js` dengan komentar. Di sistem
> produksi nyata, API key **tidak boleh** ditulis di frontend: harus lewat backend. Ini contoh demo agar bisa jalan tanpa setup.

---

## 7. Postman

Import dua file dari `sandbox/postman/`:

1. `supplier-api.postman_collection.json`: 7 folder: Health, Authentication, Suppliers, Stock (Read), Stock (Write),
   Production Planning, Status Code Simulator. Setiap request punya `pm.test` yang meng-assert status code.
2. `supplier-api.postman_environment.json`: environment variabel `base_url`, `api_key`, `client_id`, `client_secret`.

Pilih environment **“Supplier API: Local Sandbox”**. Jalankan request **“Ambil Bearer Token”** terlebih dahulu: 
test script-nya otomatis menyimpan `access_token` ke collection variable `{{token}}` sehingga request tulis siap jalan.

---

## 8. Smoke Test

Memverifikasi semua endpoint sekaligus (server harus sudah jalan):

```bash
bash sandbox/scripts/smoke-test.sh
# atau ke port lain:
BASE_URL=http://localhost:4020 bash sandbox/scripts/smoke-test.sh
```

Output: `PASS`/`FAIL` per pengecekan beserta HTTP status code, dan ringkasan di akhir.

---

## 9. Troubleshooting

| Masalah | Penyebab | Solusi |
|---|---|---|
| `EADDRINUSE` / port 4010 dipakai | Ada proses lain di port 4010 | Jalankan `PORT=4020 node sandbox/server/server.js`, atau hentikan proses lama: `lsof -ti:4010 \| xargs kill` |
| Dashboard “Tidak bisa terhubung” | Server belum jalan | Jalankan `node sandbox/server/server.js`, lalu klik **Refresh** |
| Dashboard kosong / CORS error | Membuka `index.html` lewat `file://` | Buka lewat `http://localhost:4010/`, **bukan** file langsung |
| `/docs` tidak menampilkan Swagger UI | Tidak ada internet (CDN diblok) | Tidak masalah: daftar endpoint fallback tetap tampil di halaman |
| Postman dapat **401** | Lupa `X-API-Key` atau salah nilai | Tambahkan `X-API-Key: sup_demo_key_2026` |
| Operasi tulis dapat **403** | Pakai token `readonly-token` | Ambil token asli dari `POST /auth/token` |
| Data kembali seperti semula | Data in-memory di-reset saat restart | Ini memang perilaku sandbox (by design) |

---

## 10. Struktur Folder sandbox/

```
sandbox/
├── package.json              # hanya script "start": tanpa dependencies
├── README.md
├── server/
│   ├── server.js             # http server, router, CORS, logger, banner
│   ├── handlers.js           # logika bisnis tiap endpoint
│   ├── data-store.js         # loader + store in-memory
│   ├── auth.js               # API key + bearer/readonly-token
│   ├── simulate.js           # simulator status code & latency
│   ├── errors.js             # error body standar + helper kirim JSON
│   ├── openapi.js            # spesifikasi OpenAPI 3.0
│   └── docs.js               # halaman /docs (Swagger UI + fallback)
├── data/                     # seed JSON (suppliers, stock, production_plans)
├── dashboard/                # mock Company Dashboard (HTML/CSS/JS vanilla)
├── postman/                  # collection + environment
└── scripts/smoke-test.sh     # verifikasi end-to-end via curl
```
