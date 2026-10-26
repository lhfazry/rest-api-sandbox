# TRAINER NOTES — Kunci Penilaian Paket Task

> ⚠️ **Jangan dibagikan ke peserta.** File ini memuat jawaban yang diharapkan, ambang penilaian, dan jebakan yang sengaja dipasang.
> Ringkasan skenario/goal per task untuk fasilitator: `tasks/TRAINER-OVERVIEW.md`.
> Dokumen siswa ada di `tasks/T1-*.md` … `tasks/T10-*.md`; index di `tasks/README.md`.

---

## 0. Fakta baseline yang dipakai semua task

| Fakta | Nilai |
|---|---|
| Supplier | 3 (`SUP-001`, `SUP-002`, `SUP-003`) |
| Stock | 24 baris (SUP-001: 6, SUP-002: 9, SUP-003: 9) |
| Production plan | 15 (`PLAN-001`…`PLAN-015`) |
| Default `limit` / maksimum | 10 / 50 |
| Auth baca | `X-API-Key: sup_demo_key_2026` |
| Auth tulis | bearer dari `POST /auth/token`; `readonly-token` → 403 |
| Rate limit default | 600 request/menit per API key |
| Idempotency | in-memory, 24 jam, replay + `Idempotency-Replayed: true` |
| ETag | strong, berbasis revisi global + method + path + query terurut |
| CSV | hanya `GET /api/v1/stock` |
| Webhook | subscription & delivery in-memory, retry 1s lalu 2s (maks 3 attempt) |

Data sengaja kotor. **Jangan** menormalkan `data/*.json`; seluruh nilai di bawah adalah bahan penilaian.

---

## 1. Peta anomali → task

| Kode | Anomali | Lokasi | Task yang memakainya |
|---|---|---|---|
| A1 | qty 0 tetapi status `available` | `SUP-001` / `MJK-LUB-EP2` | T1, T2 |
| A2 | `part_number` sama, UOM beda | `MJK-GSK-KIT` SET (SUP-001) vs PCS (SUP-002) | T1, T2 |
| A3 | qty 14 tetapi status `out` | `SUP-003` / `NEK-TRM-25` | T1 |
| A4 | qty string `"480"`, location null | `SUP-003` / `NEK-CBL-4C16` | T1, T2, T7 |
| A5 | `uom` lowercase `"pcs"` | `SUP-003` / `NEK-SEN-PR` | T1, T7 |
| A6 | timestamp basi + offset `+00:00` | `SUP-002` / `SNP-BLT-M12` | T3 |
| A7 | `unit_price` null, `currency` hilang | `SUP-002` / `SNP-SEA-2035` | T1, T7 |
| A8 | supplier `inactive` tetapi data mengalir | `SUP-003` | T1, T2, T3 |
| A9 | plan orphan (part tak ada di stock) | `PLAN-013` | T2, T9 |
| A10 | delivery sebelum production | `PLAN-014` | T2 |
| A11 | `part_name` beda untuk part sama | `PLAN-015` | T2 |

Baseline pagination yang dikunci materi: SUP-001 stock 6 baris (1 halaman), SUP-002 stock 9 baris (`limit=3` → 3 halaman), SUP-001 plan 4 baris, `PLAN-004` status `completed`.

---

## 2. Kunci per task

### T1 — Laporan Kekurangan Stok

**Jawaban minimum yang dapat diterima**
- Menarik **seluruh** 24 baris stock (bukan 10) dan seluruh 15 plan; menyebut `meta.total` sebagai bukti.
- Menemukan minimal 4 kontradiksi: A1, A3, A4, A5.
- Menjelaskan keputusan untuk SUP-003 (`inactive`): dipakai dengan label risiko, atau dikecualikan dengan konsekuensi.
- Tidak menjumlahkan `MJK-GSK-KIT` lintas supplier tanpa menyebut perbedaan UOM (A2).
- Setiap baris punya reason code; angka di `report.md` = `shortage-report.json`.

**Sinyal nilai tinggi**
- Definisi “at-risk” ditulis sebelum menarik data, dan dipakai konsisten.
- Membedakan “stok 0” dari “data tidak dapat dibaca” (A4) dan dari “status out padahal ada qty” (A3).
- Menghitung dampak finansial hanya untuk baris dengan `unit_price` + `currency`; A7 ditandai “tidak tersedia”, bukan 0.
- Menjelaskan bahwa `status=available` tidak bisa dipakai untuk membuktikan ketersediaan — justru field yang sedang diuji.

**Kesalahan yang sering dinilai rendah**
- Hanya membaca halaman pertama (10 dari 24 baris).
- Mempercayai `stock_status` mentah tanpa membandingkan qty.
- Mengubah `"480"` menjadi angka di sumber, bukan di lapisan analisis.
- Menyebut SUP-003 “tidak ada” karena `inactive`, padahal datanya tetap dikembalikan API.

---

### T2 — Rekonsiliasi Stok vs Rencana

**Jawaban minimum**
- Join memakai `(supplier_id, part_number)`, **bukan** `part_name` (A11) dan bukan `plan_id`.
- Menemukan `PLAN-013` sebagai orphan, `PLAN-014` sebagai jadwal mustahil, dan minimal satu plan dengan `planned_quantity` > stok.
- Menangani A2 (part number sama di dua supplier) tanpa menggabungkan stoknya.
- Menyatakan bahwa **production plan tidak memiliki field UOM**; perbandingan kuantitas mengasumsikan UOM stock atau ditandai tidak dapat dibandingkan.
- Mengalokasikan stok untuk beberapa plan tanpa double counting.

**Sinyal nilai tinggi**
- Urutan alokasi eksplisit (tanggal produksi / tanggal kirim / plan_id) beserta alasannya.
- `completed` diperlakukan sebagai histori, bukan komitmen aktif; `delayed` punya verdict sendiri.
- Plan aman tetap muncul di CSV (bukan hanya yang bermasalah).
- Verdict dan reason code bisa diterapkan ke plan baru tanpa bertanya.

**Kesalahan umum**
- Join by name → kehilangan `PLAN-015`.
- Menghitung gap tiap plan terhadap stok penuh → double counting.
- Menganggap orphan = stok 0, sehingga masalah data menyamar sebagai masalah kuantitas.
- Mengarang kolom `uom_plan`.

---

### T3 — Sinkronisasi Incremental

**Jawaban minimum**
- Cursor berasal dari data (`last_updated` maksimum), bukan jam dinding.
- `updated_since` diuji dan **dinyatakan inklusif** (`>=`): record dengan timestamp sama tetap muncul.
- Normalisasi offset: `2025-12-01T00:00:00+00:00` dan `2025-12-01T07:00:00+07:00` adalah instant yang sama.
- Run kedua menghasilkan 0 baris baru (atau hanya baris overlap yang tersaring dedupe).
- Ada penanganan `429` (`Retry-After`) dan `5xx` (backoff), serta checkpoint/resume.

**Sinyal nilai tinggi**
- Overlap window eksplisit + jadwal full reconcile (karena delete tidak terlihat di delta).
- Tie-breaker di sisi klien karena `sort` hanya satu field.
- Mengakui risiko backdated/late-arriving dan menetapkan kebijakan.
- Membuktikan tidak ada baris terlewat dengan membandingkan `meta.total`, bukan `data.length`.

**Kesalahan umum**
- Cursor = `Date.now()` → melewatkan perubahan selama run.
- Membandingkan timestamp sebagai string.
- Menganggap `updated_since` eksklusif tanpa uji.
- Menganggap delete terlihat di delta.

---

### T4 — Onboarding 15 Baris (kontrak 24 SKU)

**Kunci data Lampiran A**

| Baris | Masalah | Perilaku server |
|---|---|---|
| 6 `SPR-GSK-KIT` | `uom: UNIT` tidak ada di enum | ditolak (400/207) |
| 11 (tanpa part_number) | field wajib hilang | ditolak (400/207) |
| 14 `SPR-HSE-32` | qty `"120"` (string) | **diterima** dan di-coerce menjadi angka |

Jadi klaim vendor “3 baris bermasalah” benar sebagai kualitas sumber, tetapi **hanya 2 yang ditolak validator**. Peserta harus menemukan selisih ini, bukan menebak.

**Jawaban minimum**
- `POST /api/v1/suppliers` berhasil (201) atau 409 ditangani sebagai re-run, bukan langsung ganti ID.
- `POST .../stock/bulk?mode=partial`; `errors[].index` dipetakan ke baris sumber (0-based vs 1-based).
- Baris 6 dan 11 diperbaiki atau dikembalikan ke vendor dengan alasan; baris 14 diputuskan secara eksplisit (biarkan string? normalisasi ke angka?) dan dicatat.
- 9 baris yang tidak ada di lampiran dilaporkan sebagai coverage gap, bukan dikarang.
- `Idempotency-Key` yang sama menghasilkan replay (`Idempotency-Replayed: true`); body berbeda dengan key sama → 409 `IDEMPOTENCY_KEY_REUSED`.
- Verifikasi akhir memakai `meta.total`, bukan `data.length`.

**Sinyal nilai tinggi**
- Memilih strict dulu untuk mendapat daftar error lengkap, lalu partial untuk melanjutkan — atau sebaliknya, dengan alasan.
- Retry setelah timeout memakai key yang sama dan membuktikan jumlah baris tidak bertambah.
- Menjelaskan mengapa `PUT/PATCH bulk` tidak boleh dipakai untuk membuat baris baru.

**Kesalahan umum**
- Menganggap 207 = sukses.
- Offset index salah.
- Mengulang seluruh batch setelah 207 tanpa mempertimbangkan item yang sudah masuk.
- Mengisi `part_number` karangan untuk baris 11 lalu tidak mencatatnya.

---

### T5 — Playbook Kegagalan

**Klasifikasi yang diharapkan**

| Gejala | Keputusan |
|---|---|
| 429 + `Retry-After` | retry setelah menunggu nilai header (bukan backoff sendiri) |
| 500/502/503/504 | retry terbatas + backoff + jitter |
| timeout klien | retry **hanya** jika operasi idempoten atau memakai `Idempotency-Key` |
| 200 tetapi body bukan JSON (`malformed`) | jangan retry membabi buta; satu retry maksimum lalu eskalasi sebagai pelanggaran kontrak |
| 400/404/409 | fatal/deterministik, jangan retry |
| 401 | refresh token satu kali, lalu fatal |
| 403 | fatal (scope), jangan retry |
| 409 `IDEMPOTENCY_KEY_REUSED` | fatal, perbaiki key/body |

**Jawaban minimum**
- `evidence.csv` konsisten dengan output mentah; latency diukur, bukan dikira.
- `retry-policy.json` punya attempt, timeout, budget, backoff+jitter, daftar retry/no-retry, aturan `Retry-After`, kebutuhan idempotency.
- Worst case waktu dihitung dan dibandingkan dengan jendela sync.
- Decision tree punya minimal 8 node dan terminal RETRY/STOP/ESCALATE.

**Sinyal nilai tinggi**
- Circuit breaker punya scope dan kriteria half-open.
- Membedakan “timeout klien” dari “server gagal”; menyadari server bisa tetap memproses.
- Menyebut jitter dan dampaknya pada retry storm.

---

### T6 — Audit Kontrak

**Temuan yang sah (pilih minimal 6, harus dibuktikan probe)**

1. `DELETE` tidak tersedia untuk supplier dan production plan → 405; stock punya DELETE.
2. Respons 405 **tidak** mengirim header `Allow`.
3. Hanya `POST .../stock/bulk` yang upsert; `PUT/PATCH bulk` tidak pernah membuat record.
4. Bulk supplier/plan juga tidak bisa membuat record baru, padahal `POST` tunggal bisa.
5. `207` hanya muncul dengan `?mode=partial`; tanpa itu 400/404 atomik.
6. Bentuk sukses tidak seragam: 201 (create stock), 200 (replace), 204 (delete stock), 207 (partial).
7. `GET /api/v1/suppliers` tidak punya `updated_since`; stock dan plan punya.
8. ETag hanya pada GET JSON 2xx; CSV tanpa ETag; error tanpa ETag.
9. 406 hanya untuk `Accept` yang tidak didukung di `/api/v1/stock`; endpoint lain mengabaikan `Accept`.
10. Auth: 401 vs 403 hanya relevan pada write; GET tidak memakai bearer.
11. Parameter `status` memfilter `production_status` (nama query ≠ nama field).
12. `limit` default 10/maks 50 konsisten, tetapi `total_pages` untuk hasil kosong = 0 (bukan 1).

**Jawaban minimum**
- Matriks 3×7 terisi dengan ID bukti.
- 6 temuan berbeda, masing-masing dengan pasangan request/response.
- Klasifikasi breaking/non-breaking dari sudut klien, bukan server.
- v2 proposal punya timeline deprecation relatif dan kriteria keluar.

**Kesalahan umum**
- Menyalin isi `/openapi.json` tanpa probe.
- Menyebut “tidak konsisten” tanpa dua respons.
- Menganggap semua penambahan field non-breaking (klien dengan skema ketat bisa rusak).
- Menghapus data seed saat probing; gunakan `SUP-AUDIT-01` dan restart.

---

### T7 — CSV Export

**Jawaban minimum**
- Menemukan `Accept: text/csv` pada `GET /api/v1/stock` (bukan nested).
- Menyadari CSV mengikuti `limit`/`page` yang sama: `?limit=5` mengirim 5 baris, `X-Total-Count` tetap total filter.
- 406 untuk `Accept: application/xml`; `NOT_ACCEPTABLE`.
- Quoting RFC 4180 (koma, kutip, CRLF) dibuktikan dengan fixture sementara.
- `X-Total-Count` dibandingkan dengan `meta.total` dari request JSON identik.
- Anomali (string qty, null price, lowercase uom) diekspor apa adanya atau ditandai, tidak diubah diam-diam.

**Sinyal nilai tinggi**
- Skrip menulis ke file sementara lalu rename; gagal dengan exit code non-zero.
- Menjelaskan kapan CSV lebih baik dari JSON+paging (dan sebaliknya).
- Menyebut risiko locale Excel (`id-ID` memakai titik koma) dan formula injection.

---

### T8 — Cache & ETag

**Jawaban minimum**
- 200 membawa `ETag` + `Cache-Control: no-cache`; `If-None-Match` → 304 body 0 byte.
- PATCH mengubah ETag; ETag lama → 200, ETag baru → 304.
- Kunci cache = method + URL lengkap termasuk query; urutan query tidak mengubah ETag.
- 404 **tidak** membawa ETag (tidak boleh dianggap cache valid). `If-None-Match: *` pada resource yang tidak ada → 404, bukan 304.
- 304 tetap memakai satu request; tidak menghemat kuota request.
- Restart server mereset revisi → ETag berubah.

**Catatan implementasi untuk trainer**
- ETag dihitung dari **revisi global**, jadi satu PATCH mengubah ETag semua koleksi JSON.
- Replay `Idempotency-Key` tidak menaikkan revisi (tidak ada mutasi kedua), jadi ETag tidak berubah.
- CSV tidak memakai ETag.
- 304 dihitung dalam rate limit.

---

### T9 — Webhook

**Jawaban minimum**
- Registrasi dengan Bearer; `secret` disimpan, tidak dipublikasikan.
- Signature diverifikasi atas **raw body**: `HMAC-SHA256(secret, "<t>.<rawBody>")`, header `X-Sandbox-Signature: t=...,v1=...`.
- Signature salah / timestamp kedaluwarsa / header hilang ditolak.
- `delivery_id` dipakai untuk dedupe; `occurred_at` untuk urutan per entity.
- Retry maksimal 3 attempt (1s, 2s) terlihat di `GET /webhooks/deliveries` (`attempts`, `response_status`, `status`).
- Rekonsiliasi via `updated_since` setelah receiver mati.
- Menjelaskan bahwa `stock.deleted` tidak muncul di delta pull, sehingga delete hanya bisa disimpulkan dari event atau full snapshot.

**Catatan implementasi**
- Event: `stock.created`, `stock.updated`, `stock.deleted`, `plan.created`, `plan.updated`; `webhook.test` hanya dari endpoint test dan **tidak** boleh didaftarkan.
- `data` = snapshot record; untuk delete, snapshot terakhir.
- Subscription & delivery in-memory; restart menghapus keduanya.
- Tidak ada rotasi secret; solusinya subscription baru + nonaktifkan yang lama.

---

### T10 — Rate Limit

**Jawaban minimum**
- Membaca `X-RateLimit-Limit/Remaining/Reset` dari response nyata dan membandingkan dengan `GET /api/v1/_ratelimit`.
- 429 nyata (bukan hanya `?simulate=ratelimit`) dan pemulihan setelah `Retry-After`.
- Backoff eksponensial + jitter; `Retry-After` menang atas rumus.
- `Idempotency-Key` stabil antar retry; 409 `IDEMPOTENCY_KEY_REUSED` tidak di-retry.
- Anggaran per job dihitung dari 600/menit; dashboard memakai key yang sama.
- 401/403/404/409 fatal; 429/5xx retryable.

**Catatan implementasi**
- Limiter dihitung per API key; 401 tanpa key tidak masuk hitungan karena auth gagal lebih dulu.
- 304, 404, dan 429 tetap memakai kuota.
- `/health`, `/auth/token`, `/openapi.json`, `/docs` exempt.
- `/api/v1/_simulate/:code` **tidak** exempt (tetap kena kuota).
- Idempotency disimpan in-memory 24 jam; restart menghapusnya.

---

## 3. Panduan penilaian umum

| Pola | Nilai |
|---|---|
| Klaim tanpa request/response | maksimal 50% komponen bukti |
| Angka tidak konsisten antar-deliverable | −10 s/d −20 |
| Solusi “jalan” tetapi keputusan tidak dijelaskan | maksimal 60% komponen penalaran |
| Data seed diubah/dinormalisasi tanpa catatan | −15 dan wajib reset |
| Menemukan anomali di luar daftar A1–A11 dengan bukti | bonus komponen temuan |
| Menjelaskan trade-off yang tidak diminta | bonus kecil, maksimal +5 |

Ambang lulus yang disarankan: **70**. Untuk capstone T9/T10, pertimbangkan ambang **75** karena kompleksitasnya.

---

## 4. Reset lingkungan antar sesi

```bash
# In-memory (default): cukup restart
node server/server.js

# Dengan PERSIST_DATA=1: hapus state snapshot
rm -f data/store/state.json

# Docker
docker compose down -v
```

`bash scripts/smoke-test.sh` membuat `SUP-SMOKE-*`, stok `SMOKE-*`, dan satu plan. Jalankan hanya sebelum demo bersih, lalu restart.

Webhook subscription/delivery dan idempotency cache juga in-memory: restart menghapus semuanya.

---

## 5. Catatan implementasi yang boleh diketahui trainer

- `total_pages` = 0 untuk hasil kosong di semua list endpoint (bukan 1).
- `limit=0` di-clamp ke 1; `limit` non-numerik → 10.
- 405 tidak mengirim header `Allow` — ini sengaja dibiarkan sebagai bahan temuan T6.
- ETag hanya pada GET JSON 2xx; error tidak membawa ETag.
- CSV mengikuti pagination JSON dan mengirim `X-Total-Count`.
- Filter `status` pada plan membandingkan field `production_status`.
- `q` adalah substring case-insensitive, bukan exact match; `part_number` adalah exact.
- Anomali tipe (string qty) dipertahankan; sorting numerik menoleransi nilai non-angka.
