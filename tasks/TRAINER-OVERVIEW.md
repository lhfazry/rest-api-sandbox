# Ringkasan Task untuk Trainer (T1–T10)

> **Trainer-only.** Dokumen ini merangkum *apa, kenapa, dan bagaimana* setiap task agar fasilitator
> cepat memahami alurnya. Kunci jawaban, ambang nilai, dan analisis anomali ada di
> `tasks/TRAINER-NOTES.md`. Jangan dibagikan ke peserta.

Dokumen ini menjawab tiga pertanyaan untuk tiap task:

1. **Skenario** — situasi bisnis yang dihadapi peserta.
2. **Goal** — hasil akhir yang harus diserahkan dan keputusan yang harus diambil.
3. **Tujuan pembelajaran** — kemampuan yang dilatih, bukan sekadar fitur API yang dipakai.

---

## 0. Cara membaca dan memilih task

| Jalur | Task | Total waktu | Untuk siapa |
|---|---|---|---|
| Inti | T1 → T2 → T3 → T4 → T5 → T6 | ± 11 jam | Semua peserta; urutan wajib |
| Pendalaman | T7 → T8 | ± 2,75 jam | Pengganti bila waktu kelas terbatas |
| Capstone | T9 → T10 | ± 4,5 jam | Peserta cepat / take-home |

- T1–T4 **berurutan**: T3 memakai hasil T1–T2, T4 memakai pemahaman bulk dan idempotency.
- T5 dan T6 boleh ditukar.
- T9/T10 mengasumsikan T1–T6 selesai; T7–T8 disarankan, bukan wajib.

**Baseline yang diasumsikan semua task:** 3 supplier, 24 stock, 15 production plan, `limit` default 10/maks 50.
Reset server/volume sebelum setiap angkatan. `bash scripts/smoke-test.sh` **memutasi data**; jangan dijalankan di server demo tanpa reset sesudahnya.

| Task | Level | Waktu | Peran | Fokus utama | Output utama |
|---|---|---|---|---|---|
| T1 | Medium | 90 mnt | Supply Chain Analyst | Membaca data + prioritisasi shortage | `report.md`, `shortage-report.json`, `evidence.md` |
| T2 | Medium–Hard | 120 mnt | Production Planner | Join dua resource + alokasi | `reconciliation.csv`, `findings.md`, `decision-rules.md` |
| T3 | Hard | 150 mnt | Integration Analyst | Delta sync + cursor + drift | `sync-design.md`, `sync.js/.sh`, `sync-log.md`, `evidence.md` |
| T4 | Hard | 120 mnt | Integration Analyst | Bulk, 207, idempotency | `onboarding-log.md`, `batch.json`, `verification.md`, `idempotency-evidence.md` |
| T5 | Medium–Hard | 90 mnt | Integration Analyst | Klasifikasi kegagalan + retry | `playbook.md`, `evidence.csv`, `retry-policy.json`, `decision-tree.md` |
| T6 | Medium | 90 mnt | API Owner / Analyst | Audit kontrak + v2 | `audit.md`, `v2-proposal.md`, `evidence/` |
| T7 | Medium | 75 mnt | Procurement Analyst | Content negotiation + CSV | `export.sh/.js`, `sample.csv`, `validation.md`, `recommendation.md` |
| T8 | Medium–Hard | 90 mnt | Integration Analyst | ETag + invalidasi + polling | `cache-probe.md`, `poll.js`, `invalidation.md`, `design-notes.md` |
| T9 | Hard | 150 mnt | Integration Analyst | Webhook: signature, dedupe, retry | `receiver.js`, `subscription.json`, `delivery-log.md`, `security-notes.md`, `runbook.md` |
| T10 | Hard | 120 mnt | Platform Owner | Kuota, backoff, retry aman | `rate-limit-report.md`, `client.js`, `quota-policy.md`, `evidence-429.md` |

---

## T1 — Laporan Kekurangan Stok Mingguan

- **Level / waktu / peran:** Medium · 90 menit · Supply Chain Analyst.
- **Skenario:** Rapat expedite Senin pagi. Bulan lalu lini berhenti karena dashboard menampilkan
  sebuah part `available` padahal qty 0. Direktur meminta laporan mingguan yang tidak mempercayai
  satu field saja dan bisa direproduksi dari respons API.
- **Goal:** Menghasilkan daftar part berisiko per supplier, dengan reason code, rekomendasi, dan
  bukti request/response — bukan sekadar tabel “stok sedikit”.
- **Tujuan pembelajaran:**
  - Memilih resource yang tepat (stock global vs nested vs detail) dan menjelaskan biayanya.
  - Menarik seluruh populasi dengan pagination yang benar.
  - Mencocokkan demand plan dengan ketersediaan memakai kunci stabil.
  - Mengubah kontradiksi data menjadi keputusan, bukan daftar “data aneh”.
  - Menulis bukti yang bisa diulang orang lain.
- **Keputusan inti:** sumber kebenaran qty (field, status, atau plan); perlakuan supplier `inactive`;
  UOM berbeda untuk `part_number` sama; definisi “berisiko”; cut-off tanggal; baris yang tidak bisa dihitung.
- **API kunci:** `GET /api/v1/stock`, `GET /api/v1/production-plans`, `GET /api/v1/suppliers?api_status=`,
  nested stock/plan. **Decoy:** dashboard, lookup per part, filter `status` saja.
- **Jebakan data:** qty 0 vs `available`; qty > 0 vs `out`; qty string; UOM lowercase; part sama di dua
  supplier dengan UOM berbeda; harga null; plan orphan; supplier nonaktif tetap mengirim data.
- **Fokus penilaian:** akurasi data 35 · penalaran 25 · penanganan anomali 20 · bukti 20.
- **Sinyal lulus:** total yang dipakai = 24 baris stock dan 15 plan; minimal 4 kontradiksi terdokumentasi;
  keputusan supplier nonaktif eksplisit.

---

## T2 — Rekonsiliasi Stok vs Rencana Produksi

- **Level / waktu / peran:** Medium–Hard · 120 menit · Production Planner.
- **Skenario:** Supplier mengirim production plan; sales sudah menjanjikan tanggal kirim. Ops harus tahu
  plan mana yang tidak bisa dipenuhi dengan stok saat ini, sebelum tanggal dikunci.
- **Goal:** Satu baris per plan dengan verdict, reason code, dan tindakan; plus aturan join/alokasi yang
  bisa diterapkan ke plan baru.
- **Tujuan pembelajaran:**
  - Menentukan kunci join `(supplier_id, part_number)` dan membuktikan tidak ada duplikasi.
  - Mengalokasikan stok terbatas ke beberapa plan tanpa double counting.
  - Memisahkan masalah data (orphan, jadwal mustahil) dari masalah kuantitas.
  - Menyusun eskalasi berbasis dampak ke janji kirim.
- **Keputusan inti:** kunci join; urutan alokasi; status plan yang dianggap komitmen; toleransi shortfall;
  orphan = nol atau tidak diketahui; kapan menahan tanggal.
- **API kunci:** `GET /api/v1/production-plans`, `GET /api/v1/stock`, filter status/supplier.
  **Decoy:** lookup per plan (N+1), join by `part_name`.
- **Jebakan data:** nama part beda untuk part sama; part number sama lintas supplier; stok dipakai
  beberapa plan; `completed` masih ada; plan orphan; delivery sebelum production; **plan tidak punya UOM**.
- **Fokus penilaian:** logika join 30 · kelengkapan temuan 25 · kualitas keputusan 25 · hygiene deliverable 20.
- **Sinyal lulus:** minimal satu orphan, satu shortfall, satu jadwal mustahil ditemukan; CSV memuat plan aman
  juga; tidak ada kolom `uom_plan` karangan.

---

## T3 — Sinkronisasi Harian Incremental

- **Level / waktu / peran:** Hard · 150 menit · Integration Analyst.
- **Skenario:** Sync malam menarik semua data, makin lambat, mulai kena 429. Tim mencoba delta sync dengan
  jam lokal sebagai cursor dan kehilangan record yang berubah saat proses berjalan.
- **Goal:** Kontrak sinkronisasi yang jelas: arti “berubah”, asal cursor, normalisasi waktu, penanganan
  drift, resume, dan bukti bahwa run kedua tidak kehilangan/duplikasi data.
- **Tujuan pembelajaran:**
  - Memilih dan menguji field cursor, termasuk semantik inklusif/eksklusif.
  - Menangani timestamp identik di batas halaman tanpa composite sort.
  - Menormalkan offset waktu (`+07:00` vs `+00:00`).
  - Merancang state machine + checkpoint + retry.
  - Membuktikan delta dengan angka, bukan klaim.
- **Keputusan inti:** cursor; inklusif/eksklusif; tie-breaker; overlap vs full reconcile; late/backdated
  records; retry dan resume; deteksi delete.
- **API kunci:** `updated_since` pada stock **dan** plan, `sort=last_updated:desc`, `limit=50`, ETag.
  **Decoy:** CSV, `HEAD`, cursor dari jam dinding.
- **Jebakan data:** offset `+00:00`; timestamp basi; delete tidak terlihat di delta; `limit` default 10;
  pagination drift; `sort` hanya satu field.
- **Fokus penilaian:** kebenaran delta 35 · bukti eksekusi 25 · failure handling 20 · dokumentasi 20.
- **Sinyal lulus:** run kedua 0 baris baru (atau hanya overlap yang ter-dedupe); semantik `updated_since`
  dibuktikan; timezone dinormalkan; retry `429` menghormati `Retry-After`.

---

## T4 — Onboarding Supplier Baru: 24 SKU, 3 Data Rusak

- **Level / waktu / peran:** Hard · 120 menit · Integration Analyst.
- **Skenario:** Supplier baru harus live Senin. Vendor mengklaim 24 SKU dan “hanya 3 baris bermasalah”,
  tetapi baru mengirim 15 baris. File berisi UOM tidak valid, `part_number` kosong, dan qty berupa string.
- **Goal:** Onboarding yang aman dan dapat diulang: supplier dibuat, batch dikirim dengan partial mode,
  index error dipetakan ke baris sumber, baris rusak diputuskan, retry tidak menggandakan data.
- **Tujuan pembelajaran:**
  - Memilih create vs upsert vs replace vs patch berdasarkan semantik.
  - Membaca `207` + `summary` + `errors[].index` dan memetakannya (0-based vs 1-based).
  - Membedakan data sumber rusak dari payload tidak sesuai kontrak.
  - Memakai `Idempotency-Key` untuk retry aman.
  - Melaporkan coverage gap tanpa mengarang data.
- **Keputusan inti:** identitas supplier; ukuran batch; strict vs partial lebih dulu; lokasi perbaikan 3 baris;
  scope idempotency key; kriteria “onboarding selesai” untuk 15/24.
- **API kunci:** `POST /api/v1/suppliers`, `POST .../stock/bulk?mode=partial`, `GET` stock/detail,
  `Idempotency-Key`. **Decoy:** `PUT/PATCH .../stock/bulk` (tidak membuat record), POST satuan.
- **Jebakan data:** `errors[].index` 0-based; **qty string diterima validator** sehingga hanya 2 dari 3 baris
  yang benar-benar ditolak; 9 baris tidak ada di lampiran; `207` bukan sukses total; replay key.
- **Fokus penilaian:** partial failure 30 · idempotency/retry 25 · perbaikan data 25 · dokumentasi 20.
- **Sinyal lulus:** supplier dibuat sekali; 13 baris valid masuk; 2 baris ditolak ditangani eksplisit;
  baris string diputuskan sadar; replay tidak menambah baris; coverage gap dilaporkan.

---

## T5 — Playbook Kegagalan & Retry

- **Level / waktu / peran:** Medium–Hard · 90 menit · Integration Analyst (ops).
- **Skenario:** Sync malam gagal intermiten. Tim tidak bisa membedakan gangguan sementara, kegagalan
  permanen, dan “200 tetapi body rusak”. Retry blind memperburuk keadaan.
- **Goal:** Playbook satu halaman + kebijakan retry yang bisa dieksekusi orang lain pada pukul 02.00,
  didukung eksperimen terkontrol.
- **Tujuan pembelajaran:**
  - Mengukur status, latency, body, dan exit code, bukan menebak.
  - Mengklasifikasikan retryable vs fatal vs tidak terlihat.
  - Merancang backoff + jitter + timeout + total budget.
  - Menentukan operasi yang aman diulang dan kapan idempotency wajib.
  - Menyusun eskalasi dan batasan “jangan lakukan”.
- **Keputusan inti:** timeout; `429` vs backoff sendiri; `malformed` 200; `401` vs `403`; aturan berhenti;
  circuit breaker; retry untuk write.
- **API kunci:** `?simulate=latency|timeout|error500|ratelimit|malformed`, `_simulate/{code}`,
  `_ratelimit`, write + `Idempotency-Key`.
- **Jebakan data/perilaku:** timeout klien ≠ server berhenti; body malformed tetap 200; `Retry-After`
  mengalahkan rumus; backoff tanpa jitter; budget tidak dihitung.
- **Fokus penilaian:** klasifikasi 25 · kebijakan retry 30 · bukti 25 · kejelasan runbook 20.
- **Sinyal lulus:** matriks status → aksi lengkap; `429` menghormati `Retry-After`; timeout write memakai
  kunci; worst-case waktu dihitung.

---

## T6 — Audit Kontrak API & Proposal v2

- **Level / waktu / peran:** Medium · 90 menit · API Owner / Integration Analyst.
- **Skenario:** Kontrak v1 akan dibekukan. Tiga konsumen (dashboard, ERP, Postman) sudah berjalan.
  API owner meminta audit independen dan usulan v2.
- **Goal:** Matriks resource × operation berbasis bukti, minimal 6 asimetri, klasifikasi breaking, dan
  proposal v2 dengan migrasi/deprecation.
- **Tujuan pembelajaran:**
  - Membaca OpenAPI sebagai kontrak, lalu membandingkannya dengan runtime.
  - Menemukan asimetri secara sistematis, bukan dari ingatan.
  - Menilai breaking change dari sudut klien.
  - Menyusun versi, sinyal deprecation, dan kriteria penghentian v1.
- **Keputusan inti:** definisi konsisten; jenis temuan (bug/desain/dokumentasi); perbaikan v1 vs v2;
  DELETE/soft delete; strategi versi; `207` default atau opt-in.
- **API kunci:** `/openapi.json`, `/docs`, probe `DELETE` supplier/plan (405), bulk semantics, CSV/406,
  ETag, auth, simulator. **Decoy:** mengaudit spec saja.
- **Jebakan:** menyamakan 405 dengan 404; 405 tanpa `Allow`; menganggap tambah field selalu non-breaking;
  merusak seed saat probing (gunakan supplier scratch); severity inflasi.
- **Fokus penilaian:** kelengkapan bukti 30 · kualitas temuan 30 · penalaran breaking 25 · rekomendasi 15.
- **Sinyal lulus:** 21 sel matriks terisi; 6 temuan berbeda dengan bukti; v2 punya timeline relatif dan
  dampak per klien; tidak ada klaim tanpa probe.

---

## T7 — Export Stok untuk Procurement (CSV)

- **Level / waktu / peran:** Medium · 75 menit · Procurement Analyst.
- **Skenario:** Finance minta spreadsheet tiap pagi. Dashboard read-only; JSON mentah tidak bisa dipivot.
  Procurement hanya butuh item `low`/`out`.
- **Goal:** Export harian yang tervalidasi: memilih mekanisme (CSV vs JSON paging), menghasilkan file
  RFC 4180, membuktikan total, dan menangani data kotor secara jujur.
- **Tujuan pembelajaran:**
  - Membandingkan content negotiation dengan paging manual berdasarkan bukti.
  - Membaca filter/pagination dan memverifikasi yang tidak dijanjikan.
  - Menulis CSV valid (quoting, CRLF, UTF-8).
  - Menjaga konsistensi `X-Total-Count`, `meta.total`, dan jumlah baris file.
  - Memisahkan masalah format dari masalah data.
- **Keputusan inti:** mekanisme; cakupan status; menggabungkan `low` + `out`; CSV mengikuti pagination;
  per supplier vs gabungan; konversi data kotor; locale Excel.
- **API kunci:** `GET /api/v1/stock` + `Accept: text/csv`, 406, filter. **Decoy:** nested stock tanpa CSV,
  scrape dashboard.
- **Jebakan:** CSV tetap kena `limit` default 10; `X-Total-Count` = total filter; quoting; BOM; duplikasi
  saat menggabungkan dua request status; formula injection.
- **Fokus penilaian:** pemilihan mekanisme 25 · kualitas skrip 25 · validasi data 30 · rekomendasi 20.
- **Sinyal lulus:** 406 terbukti; fixture koma/kutip ter-escape; total konsisten; file bisa dibuka tanpa
  pergeseran kolom; anomaly diekspor apa adanya/ditandai.

---

## T8 — Cache & Conditional GET

- **Level / waktu / peran:** Medium–Hard · 90 menit · Integration Analyst.
- **Skenario:** Dashboard polling empat endpoint tiap 30 detik (>11.000 request/hari) padahal data jarang
  berubah. Manajer minta bukti penghematan dan risiko stale sebelum mengubah arsitektur.
- **Goal:** Bukti siklus `ETag` → `If-None-Match` → `304`, logika invalidasi, pengukuran penghematan,
  dan desain polling yang aman.
- **Tujuan pembelajaran:**
  - Membuktikan 304 benar-benar tanpa body.
  - Menjelaskan `no-cache` sebagai revalidasi, bukan larangan menyimpan.
  - Merancang cache key per URL+query dan kebijakan per status.
  - Mengukur byte/request dan memproyeksikan biaya.
  - Menilai stale risk setelah mutasi, bulk, replay, dan restart.
- **Keputusan inti:** resource yang dipantau; perlakuan query; aksi untuk 200/304/404/429/5xx; cara mengukur;
  cakupan invalidasi; efek replay idempotency; interval uji.
- **API kunci:** GET JSON + ETag/`If-None-Match`, PATCH dengan key, bulk `207`, rate headers, 404.
  **Decoy:** `Last-Modified`, `HEAD`.
- **Jebakan:** `no-cache` disalahartikan; tidak menyimpan body; menganggap 304 gratis; revisi global;
  ETag beda URL; 404 tidak membawa ETag; restart mereset revisi; CSV tanpa ETag.
- **Fokus penilaian:** bukti 304 30 · logika invalidasi 25 · efisiensi terukur 20 · analisis produksi 25.
- **Sinyal lulus:** 304 0 byte; ETag berubah setelah PATCH; replay tidak mengubah ETag; query order sama;
  penghematan dihitung; risiko multi-klien/CDN/restart dibahas.

---

## T9 — Webhook Perubahan Stok (capstone)

- **Level / waktu / peran:** Hard · 150 menit · Integration Analyst.
- **Skenario:** Polling 5 menit melewatkan perubahan singkat. Supplier setuju mengirim webhook
  at-least-once, bisa duplikat dan tidak berurutan.
- **Goal:** Receiver yang aman dan idempoten, bukti signature/retry, serta strategi rekonsiliasi karena
  webhook bukan database.
- **Tujuan pembelajaran:**
  - Memilih event set dan cakupan subscriber dari kebutuhan bisnis.
  - Memverifikasi HMAC atas **raw body** dan menolak replay.
  - Dedupe `delivery_id`, urutkan per entity dengan `occurred_at`.
  - Membaca delivery log dan membuktikan retry.
  - Menulis runbook backfill/insiden.
- **Keputusan inti:** event set; satu vs banyak subscription; URL receiver; replay window; kunci dedupe;
  urutan; sync vs queue; data yang tidak boleh dipercaya dari event; retensi; rotasi secret; fallback polling.
- **API kunci:** subscriptions (POST/GET/DELETE), `.../:id/test`, deliveries, stock/plan writes,
  `updated_since` untuk rekonsiliasi. **Decoy:** ETag, filter status, `?simulate=ratelimit`.
- **Jebakan:** re-stringify body; `===` untuk signature; tanpa dedupe; urut berdasarkan waktu terima;
  mempercayai event sebagai state; kerja berat > 3 detik; `localhost` di container; secret bocor;
  delivery in-memory.
- **Fokus penilaian:** signature 25 · duplikat/urutan 20 · desain event + rekonsiliasi 25 · bukti retry 15 ·
  dokumentasi 15.
- **Sinyal lulus:** signature MATCH untuk delivery nyata; 503 → retry → delivered; duplikat tidak mengubah
  state dua kali; event lama tidak menimpa state baru; gap ditutup dengan pull.

---

## T10 — Rate Limit Governance (capstone)

- **Level / waktu / peran:** Hard · 120 menit · Platform Owner / Integration Analyst.
- **Skenario:** Nightly sync kena 429, tim retry tanpa batas dan tanpa kunci idempotensi, sehingga
  beberapa write tercatat ganda. Dashboard memakai API key yang sama.
- **Goal:** Client sadar anggaran, bukti 429 + pemulihan, retry tanpa duplikat, dan kebijakan kuota
  untuk dashboard/sync/analis.
- **Tujuan pembelajaran:**
  - Membaca `X-RateLimit-*` dan `_ratelimit` tanpa menebak.
  - Membedakan 429, 409, 401/403/404.
  - Menghitung anggaran per job dan pacing.
  - Menerapkan `Retry-After` + backoff + jitter.
  - Menjaga idempotency agar retry tidak menggandakan write.
  - Menyusun kebijakan kuota, alert, dan kepemilikan.
- **Keputusan inti:** anggaran per job; satuan kerja (record/halaman/bulk); kepemilikan key; model pacing;
  matriks error; backoff; derivasi key; perilaku saat kuota habis; ambang alert; kapan burst; deadline job.
- **API kunci:** header rate limit, `GET /api/v1/_ratelimit`, 429 simulator, `Idempotency-Key`, bulk,
  `limit=50`, `updated_since`. **Decoy:** `GET /health`, ETag, dashboard.
- **Jebakan:** retry semua error; mengabaikan `Retry-After`; key baru tiap attempt; `Remaining` negatif
  saat 429; satu key untuk semua job; 304 tetap request; mengulang seluruh bulk setelah 207;
  `?simulate=ratelimit` dianggap bukti kuota; restart sebagai strategi.
- **Fokus penilaian:** pengukuran 25 · backoff 25 · retry/idempotency 25 · kebijakan kuota 25.
- **Sinyal lulus:** 429 nyata (bukan simulator) + pemulihan; key stabil; 409 tidak di-retry; jumlah record
  sebelum/sesudah sama; kebijakan angka diturunkan dari 600/menit.

---

## Lampiran A — Pemetaan tujuan kursus → task

| Tujuan kursus | Task yang melatih |
|---|---|
| Menemukan dan memilih endpoint yang tepat | T1, T2, T7, T8 |
| Pagination, filter, sort, dan membaca `meta` | T1, T2, T3, T6 |
| Menulis data dengan aman (bulk, 207, idempotency) | T4, T5 |
| Menangani kegagalan, retry, dan timeout | T3, T5, T10 |
| Membaca kontrak dan menilai perubahan | T6 |
| Content negotiation dan format data | T7 |
| HTTP caching dan efisiensi | T8 |
| Integrasi event-driven | T9 |
| Tata kelola kuota dan operasi | T10 |

## Lampiran B — Peta anomali → task (ringkas)

| Anomali | Task |
|---|---|
| qty 0 / status `available`; qty > 0 / `out` | T1 |
| part number sama, UOM beda | T1, T2 |
| qty string; lokasi null | T1, T2, T7 |
| UOM lowercase | T1, T7 |
| timestamp basi + offset `+00:00` | T3 |
| harga null / currency hilang | T1, T7 |
| supplier `inactive` tetap mengirim data | T1, T2, T3 |
| plan orphan | T2, T9 |
| delivery sebelum production | T2 |
| nama part berbeda untuk part sama | T2 |

## Lampiran C — Catatan fasilitasi

- **Reset sebelum angkatan.** Seed baseline 3/24/15. Dengan `PERSIST_DATA=1`, data latihan tersimpan di
  volume; reset lewat Coolify Persistent Storage atau hapus `data/store/state.json` lalu restart.
- **Jangan jalankan smoke test di server demo** tanpa reset; script menambah supplier/stock/plan.
- **T10 burst:** 600 request/menit default. Untuk kelas, kecilkan `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`
  agar 429 nyata bisa dipicu tanpa membebani server. Umumkan agar peserta tidak berebut kuota.
- **T9 receiver:** jalankan di `localhost` mesin peserta. Kalau server ada di container, `127.0.0.1`
  bukan host yang sama; gunakan alamat yang dapat dijangkau atau tunnel.
- **Jangan membocorkan endpoint.** Peta kapabilitas sengaja memuat decoy. Biarkan peserta membaca
  `/openapi.json`, memilih, dan menjustifikasi.
- **Nilai bukti, bukan kebetulan benar.** Klaim tanpa request/response dibatasi maksimal 50% komponen bukti.
- **Pantau waktu.** T3, T4, T9, dan T10 paling sering melebihi estimasi. Sediakan checkpoint di tengah sesi.

## Lampiran D — Perbedaan dengan `TRAINER-NOTES.md`

| Dokumen | Isi | Audiens |
|---|---|---|
| `TRAINER-OVERVIEW.md` (file ini) | Ringkasan skenario, goal, tujuan, alur, output | Fasilitator yang baru memegang kelas |
| `TRAINER-NOTES.md` | Kunci jawaban, ambang nilai, detail anomali, catatan implementasi | Penilai / pembuat soal |
| `tasks/T1..T10-*.md` | Instruksi lengkap untuk peserta | Peserta |
