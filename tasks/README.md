# Paket Task Mandiri — REST API & System Integration

Kumpulan task mandiri untuk peserta course **REST API & System Integration for Non-Technical Team**.
Semua task memakai sandbox **Mock Supplier API** di repository ini, bukan API palsu di atas kertas.

Task di paket ini **bukan tutorial langkah-demi-langkah**. Setiap task sengaja memberi *kebutuhan bisnis* dan *peta kapabilitas*, lalu peserta harus:

1. memilih endpoint yang tepat (dan menolak yang mirip tapi salah),
2. menentukan urutan pemanggilan serta strategi pagination/filter,
3. memutuskan cara menangani data kotor dan kegagalan,
4. membuktikan keputusannya dengan bukti request/response.

> Sebagian besar nilai ada pada **penalaran dan bukti**, bukan pada skrip yang “jalan”.

---

## 1. Menyiapkan sandbox

```bash
# dari root repository
node server/server.js            # default http://localhost:4010
PORT=4020 node server/server.js  # port lain
```

- Dokumentasi interaktif: <http://localhost:4010/docs>
- Spesifikasi mesin: <http://localhost:4010/openapi.json>
- Dashboard: <http://localhost:4010/>
- Postman: `postman/supplier-api.postman_collection.json` (+ environment di folder yang sama)
- Verifikasi server: `bash scripts/smoke-test.sh`

> ⚠️ **Smoke test mengubah data.** Perintah itu membuat supplier `SUP-SMOKE-*`, satu record stock, dan satu production plan. Jalankan sebelum demo bersih, lalu restart server (atau reset volume Docker) agar data seed kembali.

Data default ada di `data/suppliers.json`, `data/stock.json`, dan `data/production_plans.json`. Data ini **sengaja tidak bersih** — jangan dinormalisasi sebelum task selesai.

---

## 2. Auth dalam 30 detik

```bash
# Baca: cukup API key
curl -s -H 'X-API-Key: sup_demo_key_2026' \
  http://localhost:4010/api/v1/suppliers

# Tulis: API key + bearer token
TOKEN=$(curl -s -X POST http://localhost:4010/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).access_token))")

curl -s -X POST http://localhost:4010/api/v1/suppliers/SUP-001/stock \
  -H 'X-API-Key: sup_demo_key_2026' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"part_number":"TASK-DEMO-01","part_name":"Demo Part","stock_quantity":10,"uom":"PCS","stock_status":"available"}'
```

Token `readonly-token` diterima untuk baca tetapi **403** untuk tulis — ini sengaja, untuk membedakan 401 dan 403.

---

## 3. Konvensi API yang berlaku di semua task

| Hal | Aturan |
|---|---|
| Bentuk list | `{ "data": [...], "meta": { "total", "page", "limit", "total_pages" } }` |
| Pagination | `page` mulai 1, `limit` default 10, **maksimum 50** |
| Sorting | `sort=field:asc` atau `sort=field:desc` |
| Filter waktu | `updated_since=<ISO-8601>` (inklusif) |
| Error | `{ "error": { "code", "message", "details" } }`; kode 400/401/403/404/405/406/409/429/500 |
| Bulk | Atomik secara default; `?mode=partial` melewati item tidak valid dan menjawab **207** dengan `details[].index` |
| Bulk replace/patch | Tidak pernah membuat record baru; hanya `POST .../stock/bulk` yang upsert |
| Idempotency | Kirim `Idempotency-Key` pada operasi tulis; retry mengembalikan respons tersimpan + header `Idempotency-Replayed: true`; key sama dengan body berbeda → **409** |
| Cache | GET JSON mengembalikan `ETag`; kirim `If-None-Match` untuk **304** tanpa body |
| Rate limit | Header `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; melebihi kuota → **429** + `Retry-After` |
| CSV | `GET /api/v1/stock` dengan `Accept: text/csv`; format lain → **406** |
| Webhook | `POST/GET/DELETE /api/v1/webhooks/subscriptions`, `POST .../:id/test`, `GET /api/v1/webhooks/deliveries`; signature `t=...,v1=...`, retry 3× (1s lalu 2s) |
| Simulator | `?simulate=latency|timeout|error500|ratelimit|malformed` dan `GET /api/v1/_simulate/{code}` |

Semua angka di atas juga terdokumentasi di `/openapi.json`. Peserta dianjurkan membaca spesifikasi sebelum menebak.

---

## 4. Peta task

| ID | Judul | Level | Estimasi | Fokus analitis | API utama yang perlu dipilih |
|---|---|---|---|---|---|
| T1 | [Laporan Kekurangan Stok Mingguan](T1-shortage-report.md) | Medium | 90 mnt | Prioritisasi shortage + keputusan supplier nonaktif | daftar stock (global vs nested), plan, pagination |
| T2 | [Rekonsiliasi Stok vs Rencana Produksi](T2-reconciliation.md) | Medium–Hard | 120 mnt | Kunci join yang benar, orphan, jadwal mustahil | stock + production plan (global), filter |
| T3 | [Sinkronisasi Harian Incremental](T3-incremental-sync.md) | Hard | 150 mnt | Delta sync, cursor, pagination drift, timezone | `updated_since`, `sort`, kedua resource |
| T4 | [Onboarding Supplier Baru: 24 SKU, 3 Data Rusak](T4-bulk-onboarding.md) | Hard | 120 mnt | 207 vs 400, pemetaan index, retry aman | create supplier, stock bulk upsert, idempotency |
| T5 | [Playbook Kegagalan & Retry](T5-failure-playbook.md) | Medium–Hard | 90 mnt | Transient vs fatal, backoff, timeout budget | simulator, semua operasi |
| T6 | [Audit Kontrak API & Proposal v2](T6-contract-audit.md) | Medium | 90 mnt | Asimetri kontrak, breaking change | `/openapi.json` + probing |
| T7 | [Export Stok untuk Procurement (CSV)](T7-csv-export.md) | Medium | 75 mnt | Content negotiation vs paging manual | `Accept: text/csv`, filter, 406 |
| T8 | [Cache & Conditional GET](T8-cache-etag.md) | Medium–Hard | 90 mnt | ETag, invalidasi, efisiensi polling | GET JSON + `If-None-Match`, write untuk invalidasi |
| T9 | [Webhook Perubahan Stok](T9-webhooks.md) | Hard (capstone) | 150 mnt | Signature, duplikat, urutan, rekonsiliasi | subscriptions, deliveries, test, stock write |
| T10 | [Rate Limit Governance](T10-rate-limit.md) | Hard (capstone) | 120 mnt | Kuota, backoff, retry tanpa duplikat | header rate limit, `_ratelimit`, idempotency |

**Total estimasi jalur inti (T1–T6): ± 11 jam.** T7–T8 dapat dipakai sebagai task pengganti bila waktu kelas terbatas; T9–T10 untuk peserta tercepat atau take-home.

---

## 5. Jalur pengerjaan yang disarankan

| Sesi | Task | Fokus sesi |
|---|---|---|
| 1 | T1 → T2 | Membaca data, memilih endpoint, join dua resource, menulis temuan |
| 2 | T3 → T4 | Sinkronisasi dan operasi tulis; delta, bulk, partial failure, idempotency |
| 3 | T5 → T6 | Ketahanan integrasi dan kualitas kontrak; retry serta audit spesifikasi |
| 4 (opsional) | T7 → T8 | Content negotiation dan HTTP caching |
| 5 (opsional) | T9 → T10 | Capstone: event-driven integration dan tata kelola kuota |

Aturan main:

- T1–T4 wajib berurutan (T3 memakai hasil T1/T2; T4 memakai pemahaman bulk).
- T5 dan T6 boleh ditukar.
- T9/T10 mengasumsikan peserta sudah menyelesaikan minimal T3 dan T4.

---

## 6. Format penyerahan

Setiap task punya daftar deliverable sendiri. Secara umum, kumpulkan dalam satu folder:

```text
submission/
  T1/
    report.md
    shortage-report.json
    evidence.md
  T2/
    ...
```

Ketentuan bukti:

- Sertakan **request dan response** (curl atau Postman) untuk klaim penting. Screenshot dashboard bukan bukti integrasi.
- Sebutkan **total record** dan **jumlah halaman** yang benar-benar dibaca. Klaim “sudah semua” tanpa angka dianggap belum terbukti.
- Bila data seed diubah oleh eksperimen, tuliskan reset yang dilakukan (`restart server`, `docker compose down -v`, atau `PERSIST_DATA`).

---

## 7. Penilaian

- Setiap task memiliki rubrik dengan bobot total **100**.
- Ambang lulus yang disarankan: **70**.
- Nilai tinggi diberikan pada keputusan yang **eksplisit alasannya**, bukan pada solusi yang kebetulan benar.
- Anomali data bukan bug yang harus “diperbaiki” di seed; anomali adalah bahan analisis. Peserta dinilai dari cara mendeteksi, melaporkan, dan memutuskan.

---

## 8. Etika data & lingkungan

- Jangan menambah dependency, build step, atau framework. Gunakan `curl`, Postman, atau Node.js standard library.
- Jangan mengubah `data/*.json` untuk “membuat task lebih mudah”. Jika terpaksa, catat perubahan dan kembalikan sebelum penilaian.
- Jangan mengirim data sandbox ke layanan publik. Untuk T9, jalankan receiver di `localhost`; bila memakai layanan eksternal, gunakan data dummy.
- API ini sengaja tidak hardened (token demo, API key tertulis). Jangan menyalin pola auth-nya ke produksi.
