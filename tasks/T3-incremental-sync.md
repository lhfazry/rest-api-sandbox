# T3 — Sinkronisasi Harian Incremental

**Level:** Hard · **Estimasi:** 150 menit · **Peran:** Integration Analyst · **Prasyarat:** HTTP + header, pagination, timezone ISO 8601, scripting Node stdlib atau bash + `curl`, dan dasar retry.

## 1. Konteks bisnis

Setiap malam pukul 01.00 sistem internal menarik seluruh stok dan production plan dari Supplier API. Awalnya cara itu cukup: tiga supplier, beberapa halaman, selesai dalam hitungan detik. Enam bulan kemudian jumlah part bertambah, jendela sinkronisasi bertabrakan dengan backup database, dan tim mulai melihat `429` di log.

Permintaan dari manajer integrasi terdengar masuk akal: "jangan tarik semuanya, tarik yang berubah saja". Kalimat itu mudah diucapkan dan sulit dibuat benar. Pada percobaan pertama, tim memakai waktu server lokal sebagai cursor. Dua record yang berubah saat proses berjalan tidak pernah terambil, dan seorang planner sempat mengunci tanggal kirim berdasarkan stok lama.

Tugasmu bukan hanya membuat skrip yang lebih cepat. Kamu harus merancang **kontrak sinkronisasi**: apa artinya "berubah", dari mana cursor diambil, bagaimana waktu dibandingkan, apa yang terjadi jika proses gagal di tengah jalan, dan bagaimana membuktikan bahwa data tidak hilang.

Hasil akhir akan dibaca sebagai dokumen teknis: cukup jelas bagi engineer lain untuk menjalankannya, cukup jujur bagi manajer untuk mengetahui batasannya.

## 2. Tujuan pembelajaran

- Memilih field cursor dan merumuskan semantik delta berdasarkan pengujian, bukan asumsi.
- Menangani baris dengan timestamp identik di batas halaman tanpa kehilangan data.
- Menormalkan timestamp dengan offset berbeda ke satu representasi waktu yang dapat dibandingkan.
- Merancang state machine sinkronisasi beserta checkpoint, retry, dan aturan resume.
- Membuktikan secara empiris bahwa run kedua tidak menghasilkan duplikasi atau baris baru yang palsu.
- Mendokumentasikan perilaku untuk late-arriving, backdated, dan record yang hilang.

## 3. Yang harus kamu putuskan sendiri

1. **Field mana yang menjadi cursor?** `last_updated` dari server, waktu lokal saat sync mulai, atau mekanisme kondisional seperti ETag? Jelaskan mengapa pilihan itu yang paling tidak berisiko.
2. **Apakah `updated_since` inklusif atau eksklusif?** Kamu harus mengujinya sendiri. Keputusan ini menentukan apakah cursor digeser tepat ke nilai maksimum atau diberi mundur sedikit.
3. **Bagaimana mencegah baris dengan timestamp identik terlewat?** API hanya menerima satu field `sort`, jadi tidak ada tie-breaker dua kolom. Pilih strategi: jendela overlap, membaca seluruh grup timestamp di batas, atau dedupe lokal — dan sebutkan biayanya.
4. **Berapa besar jendela overlap, dan seberapa sering full reconcile?** Overlap memperbesar jaminan tetapi menambah request. Full reconcile menangkap hal yang tidak terlihat oleh delta. Tetapkan angka dan alasan.
5. **Bagaimana memperlakukan record yang terlambat masuk atau bertanggal mundur?** Apakah cursor boleh bergerak mundur? Apa yang terjadi pada record yang `last_updated`-nya lebih tua dari cursor terakhir?
6. **Apa kebijakan kegagalan?** Berapa kali retry untuk `429` dan `5xx`, apakah `Retry-After` dihormati, apakah proses melanjutkan dari halaman terakhir atau mengulang dari awal, dan bagaimana kamu mendeteksi pagination drift saat data berubah di tengah proses?

## 4. Peta kapabilitas API — pilih sendiri

| Kebutuhan | Kandidat endpoint (2–4) | Kenapa perlu dicek |
|---|---|---|
| Delta stok lintas supplier | `GET /api/v1/stock?updated_since=` · loop `GET /api/v1/suppliers/:supplierId/stock?updated_since=` · full pull lalu diff lokal | Global lebih sedikit request; loop lebih mudah diisolasi per supplier. Full pull adalah fallback, bukan delta. |
| Delta production plan | `GET /api/v1/production-plans?updated_since=` · loop per supplier · full pull berkala | Plan juga punya `last_updated`; jangan berasumsi hanya stock yang bisa di-delta. |
| Mengambil batas waktu dengan aman | `sort=last_updated:desc` · `sort=last_updated:asc` · tanpa `sort` | Arah sort menentukan halaman mana yang berisi kandidat cursor; tanpa sort, urutan tidak bisa diandalkan. |
| Mengambil halaman efisien | `limit=50` · `limit` default · satu request per part | Default 10 memperbanyak putaran dan memperbesar peluang drift. |
| Memastikan halaman tidak berubah | `ETag` + `If-None-Match` · GET biasa · `HEAD` | `304` bisa menghemat transfer; `HEAD` tidak dijamin didukung dan tidak menggantikan data. |
| Transfer lebih kecil | `GET /api/v1/stock` + `Accept: text/csv` · JSON | CSV hanya untuk stock dan tidak membawa `meta` yang sama; jangan campur dua format tanpa aturan. |
| Menguji kegagalan | `?simulate=ratelimit` · `?simulate=error500` · `?simulate=latency&ms=` | Simulasi terjadi sebelum handler; bagus untuk latihan retry, bukan bukti data berubah. |
| Verifikasi satu record | `GET /api/v1/suppliers/:id/stock/:partNumber` · filter list | Untuk spot-check, bukan untuk enumerasi delta. |
| Autentikasi | `X-API-Key` untuk GET · `POST /auth/token` hanya untuk write | Menambahkan bearer ke GET tidak menambah keamanan dan tidak memperbaiki delta. |

> Catatan kontrak: `GET /api/v1/stock`, `GET /api/v1/production-plans`, dan `updated_since` pada kedua resource tersedia. Parameter `updated_since` menerima date-time ISO 8601; zona waktu harus eksplisit. Semantik inklusif/eksklusif tetap wajib kamu uji sendiri (langkah 1).

## 5. Alur kerja yang diharapkan

0. **Siapkan baseline.** Jalankan server, catat waktu, dan pastikan data masih seed. Jika kamu akan menulis ke sistem lokal, siapkan direktori state yang bisa dihapus.
1. **Uji semantik delta.** Ambil satu halaman, catat nilai `last_updated` maksimum, lalu panggil `updated_since` dengan nilai itu dan dengan nilai sedikit di bawahnya. Simpan hasilnya sebagai bukti inklusif/eksklusif.
   *Checkpoint:* dua respons dengan jumlah baris berbeda atau sama, beserta penjelasannya.
2. **Ukur full pull.** Catat jumlah halaman, baris, durasi, dan ukuran respons untuk stock dan plan. Ini pembanding efektivitas delta.
   *Checkpoint:* tabel baseline full pull.
3. **Rancang state machine.** Tulis `sync-design.md`: status `BOOTSTRAP`, `DELTA`, `RECONCILE`, `RETRY`, `FAILED`; aturan transisi; isi state file; definisi cursor.
   *Checkpoint:* diagram atau daftar transisi yang bisa diimplementasikan tanpa bertanya.
4. **Implementasikan sinkronisasi.** Node stdlib atau bash + `curl`. Wajib: pagination sampai habis, retry `429` menghormati `Retry-After`, backoff untuk `5xx`, dedupe berdasarkan kunci komposit, dan log jumlah per halaman.
   *Checkpoint:* satu kali jalan menghasilkan ringkasan `fetched`, `new`, `updated`, `skipped`, `pages`.
5. **Jalankan run pertama.** Simpan state dan log. Jangan menimpa log dengan run berikutnya.
   *Checkpoint:* cursor awal dan akhir, jumlah per resource.
6. **Jalankan run kedua segera.** Targetnya nol baris baru, atau baris yang sama muncul lagi karena overlap dan tersaring oleh dedupe.
   *Checkpoint:* tabel dua run; jelaskan setiap selisih, termasuk yang berasal dari overlap.
7. **Buktikan penanganan timezone.** Panggil `updated_since` dengan instant yang sama dalam dua offset berbeda. Tunjukkan hasilnya identik, dan tunjukkan bagaimana record ber-offset lain tetap masuk.
   *Checkpoint:* tabel konversi waktu + dua respons pembanding.
8. **Latih kegagalan.** Picu `429` dan `500`, tunjukkan retry, waktu tunggu, dan bahwa resume tidak menghasilkan duplikat. Uji juga kegagalan di tengah pagination.
   *Checkpoint:* potongan log dengan status, percobaan ke-n, dan jumlah baris setelah pulih.
9. **Tulis runbook.** Dokumentasikan late-arriving, backdated, record hilang, dan kapan full reconcile harus dijalankan manual.
   *Checkpoint:* satu halaman yang bisa diikuti orang lain saat pukul 02.00.

## 6. Deliverable

| File | Isi | Format |
|---|---|---|
| `sync-design.md` | State machine + transisi, definisi cursor, aturan overlap, timezone, pagination drift, retry/backoff, deteksi delete, asumsi, dan versi desain. | Markdown (diagram ASCII/bagan boleh) |
| `sync.js` atau `sync.sh` | Hanya Node stdlib atau bash + `curl`. Idempotent, punya `--full` dan `--dry-run`, log jumlah per resource, tidak menyimpan kredensial di kode. | JavaScript CommonJS / shell |
| `sync-log.md` | Dua run berurutan: waktu, cursor awal/akhir, jumlah halaman, `fetched`/`new`/`updated`/`skipped`, durasi, dan kesimpulan. | Markdown tabel |
| `evidence.md` | Bukti semantik `updated_since`, konversi timezone, header `Retry-After`, log retry, dan contoh isi state file. | Markdown + code block |

Sertakan contoh `sync-state.json` (boleh di dalam `evidence.md`) yang memuat minimal: `cursor_utc`, `overlap_minutes`, `last_run_at`, `last_status`, dan penghitung per resource.

## 7. Kriteria penilaian

| Komponen | Bobot | Yang dinilai |
|---|---|---|
| Kebenaran logika delta | 35 | Cursor tepat; batas inklusif/eksklusif terbukti; tie-breaker dan overlap masuk akal; timezone dinormalkan; tidak ada baris terlewat pada skenario uji. |
| Bukti eksekusi | 25 | Dua run terdokumentasi; run kedua benar-benar bersih; angka per halaman konsisten; log dapat direproduksi. |
| Failure handling | 20 | `429` menghormati `Retry-After`; `5xx` di-backoff; checkpoint/resume tidak menduplikasi; perilaku saat gagal di tengah halaman jelas. |
| Dokumentasi | 20 | Desain cukup untuk diimplementasikan ulang; batasan jujur; runbook operasional; asumsi dan versi tercatat. |
| **Total** | **100** | |

## 8. Jebakan data & kesalahan umum

- **Membandingkan timestamp sebagai string.** Offset berbeda membuat urutan teks tidak sama dengan urutan waktu. Parse ke instant, lalu bandingkan.
- **Mengandalkan `Date.parse` tanpa menyadari zona lokal.** String tanpa offset akan ditafsirkan menurut zona mesin; selalu simpan dan kirim dengan offset eksplisit.
- **Memakai jam dinding sebagai cursor.** `since = now` sebelum run akan melewatkan record yang berubah selama run berlangsung. Cursor harus berasal dari data, bukan dari niat.
- **Mengasumsikan semantik inklusif/eksklusif tanpa uji.** Selisih satu milidetik bisa berarti satu record hilang atau satu record terkirim dua kali.
- **Mengabaikan timestamp identik.** Banyak baris bisa berbagi `last_updated` yang sama; `sort` hanya satu field, jadi batas halaman adalah titik paling rawan.
- **Tidak mendeteksi pagination drift.** Data yang berubah saat paging bisa membuat baris terlewat atau muncul dua kali. Dedupe berdasarkan kunci komposit dan bandingkan jumlah dengan `meta.total`.
- **Membaca hanya halaman pertama.** `limit` default 10; delta yang "kosong" bisa berarti halaman berikutnya belum dicek.
- **Menganggap delete terlihat di delta.** Record yang dihapus tidak muncul sebagai perubahan. Tanpa full reconcile berkala, sistemmu akan mempertahankan data hantu.
- **Mengabaikan `Retry-After`.** Retry instan saat `429` hanya menambah beban dan memperpanjang blokir.
- **Retry tanpa idempotensi.** Jika sinkronisasi menulis ke sistem lain, pengulangan tanpa `Idempotency-Key` bisa membuat duplikat.
- **Menganggap `sort` mendukung dua kolom.** `last_updated:desc,id:asc` bukan kontrak yang dijanjikan; tie-breaker harus diselesaikan di sisi klien.
- **Mencampur CSV dan JSON.** CSV hanya tersedia untuk stock dan tidak membawa metadata yang sama; jangan membandingkan jumlah baris antar format tanpa penjelasan.
- **Record dengan timestamp lebih tua dari cursor.** Backdate tidak akan pernah terambil oleh delta murni; ini alasan full reconcile tetap ada.

## 9. Verifikasi mandiri

```bash
BASE=http://localhost:4010
KEY='X-API-Key: sup_demo_key_2026'

# 1. Ambil token (hanya perlu untuk write)
curl -s -X POST "$BASE/auth/token" -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' | jq '{token_type, expires_in}'

# 2. Kredensial salah
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/auth/token" \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"salah"}'                 # 401

# 3. Cursor jauh di masa depan: kosong, bukan error
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-001/stock?updated_since=2030-01-01T00:00:00Z" \
  | jq '{total: .meta.total, rows: (.data | length)}'                            # 0 dan 0

# 4. Urutan descending benar-benar berlaku
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-002/stock?sort=last_updated:desc&limit=5" \
  | jq '[.data[].last_updated]'
# bandingkan sebagai instant, bukan string

# 5. Rate limit dan Retry-After
curl -s -D - -o /dev/null -H "$KEY" "$BASE/api/v1/suppliers?simulate=ratelimit" \
  | grep -iE '^HTTP/|^Retry-After|^X-RateLimit'                                  # 429, Retry-After: 5

# 6. Kegagalan server
curl -s -H "$KEY" "$BASE/api/v1/suppliers?simulate=error500" | jq '.error.code'
# "INTERNAL_SERVER_ERROR"

# 7. Method tidak diizinkan (aman, tidak mengubah data)
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "$KEY" "$BASE/api/v1/suppliers/SUP-001"  # 405

# 8. Conditional GET
ETAG=$(curl -s -D - -o /dev/null -H "$KEY" "$BASE/api/v1/suppliers?limit=1" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
echo "ETag: $ETAG"                                                                 # header ada
curl -s -o /dev/null -w '%{http_code}\n' -H "$KEY" -H "If-None-Match: $ETAG" "$BASE/api/v1/suppliers?limit=1"
# 304, body kosong
```

Tidak ada perintah di atas yang mengubah data supplier. Jangan memakai `scripts/smoke-test.sh` sebagai bukti karena skrip itu menulis data. Untuk eksperimen yang membutuhkan mutasi, jalankan pada server terpisah dan restart sebelum demo.

## 10. Ekstensi opsional

- Tambahkan mode `RECONCILE` mingguan yang membandingkan full pull dengan state lokal, lalu melaporkan record hilang, record hantu, dan drift cursor.
- Ukur penghematan: bandingkan jumlah request dan byte antara full pull dan delta pada rentang yang sama, lalu simpulkan kapan delta tidak lagi layak.
- Buat overlap adaptif berdasarkan lag maksimum yang kamu amati, dan jelaskan risiko jika lag berubah tanpa peringatan.
