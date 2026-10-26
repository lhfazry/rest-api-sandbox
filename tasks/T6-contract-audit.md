# T6 — Audit Kontrak API & Proposal v2

**Level:** Medium · **Estimasi:** 90 menit · **Peran:** Integration Analyst / API Owner · **Prasyarat:** paham REST verbs dan status code; pernah membaca `/openapi.json`; bisa menjalankan curl dan membandingkan dua respons

## 1. Konteks bisnis

Kontrak API v1 akan dipakai tiga tim sekaligus: dashboard internal, sync ERP (job mingguan), dan tim procurement yang memakai koleksi Postman. Sebelum kontrak dibekukan, API owner meminta **audit independen**: seberapa konsisten perilaku antar-resource, di mana dokumentasi berbeda dari kenyataan, dan perubahan apa yang layak masuk v2.

Aturan main:

- **Tidak ada perubahan kode server.** Deliverable-mu adalah dokumen dan bukti, bukan patch.
- Dua klien existing (dashboard dan ERP) tidak bisa deploy cepat. Setiap usulan harus menyebut siapa yang terdampak dan apa yang harus mereka ubah.
- `/openapi.json` adalah **kontrak yang dipublikasikan**, sedangkan perilaku runtime adalah **kebenaran**. Selisih antara keduanya adalah temuan, bukan alasan untuk mengabaikan salah satunya.
- Dataset seed sengaja berisi anomali. Jangan "memperbaiki" data; audit menilai kontrak, bukan kebersihan data.
- Semua klaim harus punya bukti request/response. Opini tanpa probe tidak dihitung.

## 2. Tujuan pembelajaran

- Membaca OpenAPI sebagai kontrak (path, method, status, header), bukan sekadar halaman dokumentasi.
- Menyusun matriks resource × operation dan menemukan asimetri secara sistematis, bukan dari ingatan.
- Membedakan *belum diimplementasikan*, *tidak didokumentasikan*, dan *memang dirancang berbeda*.
- Menilai breaking vs non-breaking dari sudut klien yang sudah berjalan.
- Mengusulkan v2 dengan jalur migrasi, sinyal deprecation, dan kriteria penghentian v1.
- Menjaga disiplin bukti: setiap temuan dapat direproduksi orang lain dalam satu perintah.

## 3. Yang harus kamu putuskan sendiri

1. **Definisi "konsisten".** Aturan apa yang kamu pakai untuk menilai (keseragaman verb, bentuk respons sukses, cakupan header, pola error)? Tulis sebelum memeriksa agar tidak menilai sambil menyesuaikan standar.
2. **Sifat temuan.** Mana yang bug, mana keputusan desain, mana dokumentasi kurang? Siapa yang berwenang memutuskan tiap kategori?
3. **Tempat perbaikan.** Diperbaiki aditif di v1, atau ditunda ke v2? Apa kriteria yang membuat sebuah perbaikan "terlalu mahal untuk v1"?
4. **DELETE.** Perlukah semua resource punya delete? Hard delete atau soft delete? Bagaimana jejak audit dan data historis dipertahankan?
5. **Strategi versi & deprecation.** URL (`/v2`), header, atau media type — mana yang paling murah untuk dua klien existing? Berapa lama v1 hidup, sinyal apa yang dikirim (header, changelog, email), dan syarat apa yang harus terpenuhi sebelum v1 dimatikan?
6. **207.** Apakah partial success layak menjadi perilaku default atau tetap opt-in? Siapa yang menanggung kompleksitasnya?

## 4. Peta kapabilitas API — pilih sendiri

| Kebutuhan | Kandidat probe (termasuk decoy) | Kenapa perlu dicek |
|---|---|---|
| Inventaris kontrak | `GET /openapi.json`, `GET /docs` | Sumber klaim awal; bandingkan `paths` dengan perilaku nyata |
| Operasi yang tidak ada | `curl -i -X DELETE ...` pada tiap resource | 405 membuktikan method tidak didukung; catat apakah header `Allow` ikut dikirim |
| Bentuk respons sukses | `POST`, `PUT`, `PATCH`, `DELETE` | 200 vs 201 vs 204 vs 207; konsisten atau tidak antar-resource |
| Cakupan koleksi | `GET /api/v1/stock` vs `GET /api/v1/suppliers/{id}/stock` | Filter, `meta`, default `limit`, dan urutan hasil bisa berbeda |
| Semantik bulk | `POST` vs `PUT` vs `PATCH .../bulk` | Upsert vs replace vs patch; mana yang boleh membuat record baru |
| Partial success | Bulk tanpa dan dengan `?mode=partial` | 400 vs 207; apakah `details[].index` selalu ada |
| Negosiasi konten | `Accept: text/csv`, `Accept: application/xml` | Dukungan CSV dan 406; apakah hanya di satu koleksi |
| Cache | `ETag` lalu `If-None-Match` | 304 dan cakupan ETag per endpoint |
| Auth | `/health`, `/auth/token`, `/api/v1/*` | Publik vs API key vs bearer; konsisten di semua operasi tulis |
| Error | `GET /api/v1/_simulate/{400..500}` | Skema `error.code/message/details` dan pemetaan status |
| Idempotensi | `Idempotency-Key` pada POST/PUT | Replay vs 409; endpoint mana yang mendukung |

## 5. Alur kerja yang diharapkan

**Fase 0 — Tetapkan kriteria (10 menit).** Tulis 6–8 aturan konsistensi yang dapat diuji, misalnya "setiap resource punya list dan get", "status sukses mengikuti pola yang sama untuk operasi yang sama", "setiap koleksi punya `meta` dengan field yang sama". Simpan sebagai bagian awal `audit.md`. Aturan boleh direvisi, tetapi revisinya harus terlihat.

**Fase 1 — Inventaris (15 menit).** Ekstrak seluruh pasangan path × method dari `/openapi.json`. Bandingkan dengan hasil probe. Catat perbedaan dokumentasi vs runtime sebagai kandidat temuan (bukan langsung temuan). Evidence: tabel inventaris + perintah yang dipakai.

**Fase 2 — Matriks resource × operation (20 menit).** Isi 21 sel di bawah. Gunakan legenda: `✅` ada dan konsisten, `⚠️` ada tetapi berbeda dari resource lain, `❌` tidak ada, `?` belum diuji. Setiap sel wajib menunjuk ID bukti.

| Resource | list | get | create | replace (PUT) | patch | delete | bulk |
|---|---|---|---|---|---|---|---|
| suppliers |  |  |  |  |  |  |  |
| stock |  |  |  |  |  |  |  |
| production plans |  |  |  |  |  |  |  |

**Fase 3 — Probe asimetri (20 menit).** Kejar minimal **6 temuan** yang benar-benar berbeda (bukan enam variasi dari satu masalah). Arah yang boleh dieksplorasi — bukan jawaban:

- operasi yang ada di satu resource tetapi tidak di resource lain;
- method yang sama tetapi artinya berbeda antar-resource;
- perbedaan bentuk respons sukses untuk operasi setara;
- perbedaan cakupan koleksi (nested vs global) pada filter/`meta`/default;
- perilaku bulk yang tidak seragam (create vs no-create, 400 vs 207);
- header lintas-cutting (ETag, `Content-Type`, `Allow`, rate limit) yang hanya muncul di sebagian endpoint;
- selisih antara yang tertulis di `/openapi.json` dan yang benar-benar dijawab server.

**Fase 4 — Klasifikasi dampak (10 menit).** Untuk tiap temuan: siapa yang terdampak (dashboard, ERP, Postman), apakah perubahan perbaikannya breaking, dan severity menurut skala yang kamu tetapkan di Fase 0. Bedakan "breaking untuk klien baru" dari "breaking untuk klien yang sudah berjalan".

**Fase 5 — Proposal v2 (10 menit).** Ubah temuan prioritas menjadi usulan konkret: before → after, alasan, dampak kompatibilitas, langkah migrasi klien, dan sinyal deprecation. Temuan yang tidak layak v2 harus tetap dicatat dengan alasan.

**Fase 6 — Review (5 menit).** Periksa ulang: setiap klaim punya file bukti; tidak ada temuan yang hanya berdasarkan bacaan spec; tidak ada dua temuan yang sebenarnya sama; severity tidak menggelembung.

## 6. Deliverable

| File | Isi | Format |
|---|---|---|
| `audit.md` | Kriteria konsistensi, inventaris path × method, matriks 3×7 terisi, minimal 6 temuan dengan bukti, severity, dan klasifikasi breaking/non-breaking. | Markdown, tabel + ringkasan eksekutif 1 paragraf |
| `v2-proposal.md` | Perubahan bergaya diff (before → after) per endpoint, matriks kompatibilitas per klien, langkah migrasi, timeline deprecation, risiko dan mitigasi. | Markdown |
| `evidence/` | 8–12 pasang request/response untuk temuan prioritas. `evidence/README.md` memetakan ID temuan → file. | Folder berisi `01-*.http`, `02-*.http`, dst. + README |

Format tabel temuan (wajib, satu baris per temuan):

| ID | Asimetri / inkonsistensi | Cara membuktikan (perintah) | Bukti | Dampak ke klien | Severity | Breaking? | Rekomendasi |
|---|---|---|---|---|---|---|---|
| F-01 | `<ringkasan satu kalimat>` | `curl -i ...` | `evidence/01-*.http` | `<klien + gejala>` | `<S1/S2/S3>` | `<ya/tidak>` | `<v1 aditif / v2 / dokumentasi>` |

Timeline deprecation di `v2-proposal.md` harus berupa tabel: fase, rentang waktu relatif (bukan tanggal karangan), aksi di sisi server, sinyal ke klien, dan kriteria keluar.

Kumpulkan `audit.md`, `v2-proposal.md`, dan folder `evidence/` di `submission/T6/` (lihat `tasks/README.md` §6).

## 7. Kriteria penilaian

| Komponen | Bobot | Yang dinilai |
|---|---|---|
| Kelengkapan bukti | 30 | Setiap temuan punya request/response yang dapat diulang; matriks sel terisi dengan ID bukti; tidak ada klaim dari bacaan spec saja |
| Kualitas temuan | 30 | Minimal 6 temuan berbeda dan bermakna; bukan variasi trivial; selisih dokumentasi vs runtime ditemukan; dampak dijelaskan |
| Penalaran breaking-change | 25 | Definisi breaking dari sudut klien; dampak per klien dibedakan; severity konsisten dengan kriteria sendiri |
| Kejelasan rekomendasi | 15 | Usulan v2 konkret dan dapat dieksekusi; migrasi + deprecation realistis; temuan yang ditolak tetap beralasan |
| **Total** | **100** | |

## 8. Jebakan & kesalahan umum

- **Mengaudit dari `/openapi.json` saja.** Spec bisa tertinggal dari implementasi; temuan yang tidak diprobe adalah dugaan.
- **Menyamakan 405 dengan 404.** 404 berarti path tidak dikenal; 405 berarti path ada tetapi method tidak didukung. Keduanya menuntut rekomendasi berbeda.
- **Menulis "tidak konsisten" tanpa dua respons.** Konsistensi adalah perbandingan; tunjukkan pasangan endpoint dan perbedaan konkretnya.
- **Menilai breaking dari sudut server.** Menambah field bisa memecahkan klien dengan skema ketat; menghapus field hampir selalu breaking.
- **Severity inflasi.** Melaporkan 20 temuan gaya penulisan membuat temuan penting tenggelam. Pilih yang berdampak pada klien.
- **v2 tanpa jalur data.** Mengganti nama field tanpa rencana migrasi nilai dan periode dual-run akan memutus sync ERP.
- **Melupakan klien non-browser.** Koleksi Postman, skrip bash, dan job ERP juga konsumen kontrak; jangan hanya memikirkan dashboard.
- **Merusak seed saat probing.** `DELETE` pada data seed menghilangkan bukti untuk peserta lain. Pakai supplier scratch dan restart server setelahnya.
- **Menganggap 207 sebagai 200.** 207 adalah hasil campuran; klien yang tidak memeriksa `errors[]` akan mengira semuanya berhasil.
- **Tidak mencatat header.** `Allow`, `ETag`, `Content-Type`, dan `Retry-After` sering menjadi bukti utama sebuah asimetri, tetapi mudah terlewat bila hanya melihat body.

## 9. Verifikasi mandiri

```bash
BASE=http://localhost:4010
KEY='X-API-Key: sup_demo_key_2026'
TOKEN=$(curl -s -X POST "$BASE/auth/token" -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))')

# 1. Inventaris: path + method yang diklaim kontrak
curl -s "$BASE/openapi.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).paths;for(const [k,v] of Object.entries(p))console.log(k,Object.keys(v).join(","))})'

# 2. Operasi yang tidak tersedia: 405 (bukan 404); catat apakah `Allow` dikirim
curl -s -i -X DELETE -H "$KEY" "$BASE/api/v1/suppliers/SUP-001" | grep -iE 'HTTP/|^allow'
curl -s -i -X DELETE -H "$KEY" "$BASE/api/v1/production-plans/PLAN-001" | grep -iE 'HTTP/|^allow'

# 3. Bandingkan dengan path yang memang tidak ada
curl -s -o /dev/null -w 'path-asing=%{http_code}\n' -X DELETE -H "$KEY" "$BASE/api/v1/suppliers/SUP-001/unknown"

# 3b. Supplier scratch untuk probe tulis (409 bila sudah ada — itu juga temuan)
curl -s -o /dev/null -w 'scratch=%{http_code}\n' -X POST "$BASE/api/v1/suppliers" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"supplier_id":"SUP-AUDIT-01","supplier_name":"Audit Scratch","api_status":"active"}'

# 4. Bulk: strict vs partial pada supplier scratch (jangan pakai data seed)
#    batch-audit.json = items yang sama (AUD-2 tetap invalid) → strict 400, partial 207
curl -s -o /dev/null -w 'strict=%{http_code}\n' -X POST "$BASE/api/v1/suppliers/SUP-AUDIT-01/stock/bulk" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"items":[{"part_number":"AUD-1","part_name":"Part 1","stock_quantity":5,"uom":"PCS","stock_location":"WH-A","stock_status":"low"},{"part_number":"AUD-2","part_name":"Part 2","stock_quantity":3,"uom":"UNIT","stock_location":"WH-A","stock_status":"low"}]}'
curl -s -o /dev/null -w 'partial=%{http_code}\n' -X POST "$BASE/api/v1/suppliers/SUP-AUDIT-01/stock/bulk?mode=partial" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d @batch-audit.json

# 5. Upsert vs replace: apakah PUT/PATCH bulk bisa membuat baris baru?
#    Bandingkan status PUT dengan status GET sesudahnya — jangan berasumsi.
curl -s -o /dev/null -w 'put-bulk=%{http_code}\n' -X PUT "$BASE/api/v1/suppliers/SUP-AUDIT-01/stock/bulk" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"items":[{"part_number":"AUD-BARU","part_name":"Part Baru","stock_quantity":1,"uom":"PCS","stock_location":"WH-A","stock_status":"low"}]}'
curl -s -o /dev/null -w 'get-baru=%{http_code}\n' -H "$KEY" "$BASE/api/v1/suppliers/SUP-AUDIT-01/stock/AUD-BARU"

# 6. Negosiasi konten pada koleksi stok
curl -s -o /dev/null -w 'csv=%{http_code} %{content_type}\n' -H "$KEY" -H 'Accept: text/csv' "$BASE/api/v1/stock"
curl -s -o /dev/null -w 'xml=%{http_code}\n' -H "$KEY" -H 'Accept: application/xml' "$BASE/api/v1/stock"

# 7. ETag: 200 pertama, lalu 304 dengan If-None-Match
ET=$(curl -s -D - -o /dev/null -H "$KEY" "$BASE/api/v1/suppliers" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -o /dev/null -w 'etag=%{http_code}\n' -H "$KEY" -H "If-None-Match: $ET" "$BASE/api/v1/suppliers"

# 8. Pagination: default limit dan batas atas (jangan menyimpulkan dari data.length)
curl -s -H "$KEY" "$BASE/api/v1/stock?limit=999" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.meta.limit,j.meta.total,j.meta.total_pages)})'
```

> **Peringatan.** `bash scripts/smoke-test.sh` **mengubah data** (`SUP-SMOKE-*`, stok `SMOKE-*`, production plan). Probe `DELETE` di atas hanya aman untuk supplier scratch `SUP-AUDIT-01`. Restart server (atau reset volume) setelah audit sebelum demo bersih.

## 10. Ekstensi opsional

- **Contract test ringan.** Tulis `contract-check.js` (Node stdlib) yang membaca `/openapi.json`, memanggil 10 endpoint, dan melaporkan selisih antara status/`Content-Type` yang dijanjikan dan yang diterima. Jalankan sebelum dan sesudah perubahan kontrak.
- **Survei konsumen.** Susun 6 pertanyaan untuk pemilik dashboard dan ERP: field mana yang wajib, error mana yang mereka tangani, dan seberapa cepat mereka bisa berubah. Gunakan hasilnya untuk membenarkan klasifikasi breaking.
- **Checklist governance.** Usulkan daftar periksa untuk endpoint baru (verb, status, header, contoh error, bulk semantics, dokumentasi) agar asimetri berikutnya tidak lahir lagi.
