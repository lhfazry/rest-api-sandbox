# T1 — Laporan Kekurangan Stok Mingguan

**Level:** Medium · **Estimasi:** 90 menit · **Peran:** Supply Chain Analyst · **Prasyarat:** bisa mengirim GET dengan header API key, membaca JSON, dan mengolah tabel di spreadsheet, `jq`, atau Python.

## 1. Konteks bisnis

Senin, 08.00. Rapat expedite mingguan dimulai dan semua mata tertuju ke layar. Tugas timmu terdengar sederhana: tentukan part mana yang harus di-expedite minggu ini, dari supplier mana, dan mana yang bisa menunggu.

Bulan lalu keputusan ini diambil dari dashboard yang menampilkan sebuah part sebagai `available`. Kenyataannya jumlahnya nol. Lini produksi berhenti hampir satu shift, biaya kirim darurat keluar, dan pertanyaan yang muncul di rapat berikutnya bukan "kenapa datanya salah" melainkan "kenapa tidak ada yang memeriksa".

Direktur operasi tidak minta dashboard baru. Ia minta satu laporan mingguan yang: (a) tidak mempercayai satu field status saja, (b) menyebutkan alasan untuk setiap baris, dan (c) bisa direproduksi oleh orang lain dari respons API mentah.

Risikonya dua arah. Memasukkan part yang sebenarnya aman ke daftar expedite membuang biaya pengiriman. Mengeluarkan part yang sebenarnya kritis menghentikan lini. Karena itu setiap baris di laporanmu harus bisa ditelusuri ke request dan respons tertentu.

Data supplier di sandbox ini sengaja tidak rapi. Itu bukan alasan untuk menunda laporan; itu bagian dari pekerjaan. Anggap dirimu sedang menulis untuk dua pembaca sekaligus: manajer yang butuh keputusan dalam satu halaman, dan auditor yang akan menanyakan dari mana angka itu datang.

## 2. Tujuan pembelajaran

- Memilih resource yang tepat (stok global, stok per supplier, atau stok per part) dan menjelaskan konsekuensi pilihan tersebut.
- Menarik seluruh populasi data dengan pagination yang benar, termasuk saat `limit` mencapai batas maksimum.
- Mencocokkan permintaan dari production plan dengan ketersediaan di stock memakai kunci yang stabil.
- Mengubah kontradiksi data menjadi temuan yang bisa dieksekusi, bukan sekadar daftar "data aneh".
- Merumuskan dan mempertahankan keputusan eksplisit untuk supplier nonaktif serta baris yang datanya tidak lengkap.
- Menyusun bukti request/response sehingga angka di laporan dapat direproduksi pihak lain.

## 3. Yang harus kamu putuskan sendiri

1. **Apa sumber kebenaran kuantitas?** `stock_quantity`, `stock_status`, atau justru perbandingan dengan `planned_quantity`? Ketiganya bisa berbeda; tulis mana yang kamu pakai untuk memutuskan dan mengapa.
2. **Apakah supplier berstatus `inactive` masuk laporan?** Kalau masuk, dengan label apa? Kalau dikeluarkan, siapa yang menanggung risiko part yang tetap dibutuhkan? Keputusan ini harus tertulis, bukan tersirat.
3. **Bagaimana memperlakukan UOM yang berbeda untuk `part_number` yang sama?** Boleh dijumlahkan, dibandingkan per supplier, atau hanya dilaporkan terpisah? Jelaskan dampaknya ke angka gap.
4. **Apa definisi "berisiko"?** Stok nol, stok di bawah demand, status `out`, atau kombinasi? Berapa toleransi pembulatan yang kamu terima?
5. **Periode apa yang masuk cakupan?** Semua plan, hanya plan yang belum selesai, atau plan dengan tanggal tertentu? Tetapkan cut-off sebelum menarik data.
6. **Apa yang kamu lakukan pada baris yang tidak bisa dihitung** (nilai bukan angka, field kosong)? Dibuang, dianggap nol, atau dilaporkan sebagai "tidak dapat dinilai"? Masing-masing punya konsekuensi berbeda.

## 4. Peta kapabilitas API — pilih sendiri

| Kebutuhan | Kandidat endpoint (2–4) | Kenapa perlu dicek |
|---|---|---|
| Melihat semua supplier dan status integrasinya | `GET /api/v1/suppliers` · `GET /api/v1/suppliers/:supplierId` · dashboard `/` | Daftar induk menentukan cakupan. Detail satu supplier tidak memberi populasi, dan filter status hanya ada di list. |
| Mengambil stok seluruh supplier | `GET /api/v1/stock` · loop `GET /api/v1/suppliers/:supplierId/stock` · `GET .../stock/:partNumber` | Global sekali jalan vs N request. Endpoint per part tidak bisa dipakai untuk enumerasi. |
| Memastikan stok satu part tertentu | `GET .../stock/:partNumber` · `GET /api/v1/stock?part_number=` · filter lokal dari hasil list | Exact lookup vs filter. Filter lokal rawan salah kalau halaman belum lengkap. |
| Mengambil demand dari production plan | `GET /api/v1/production-plans` · `GET /api/v1/suppliers/:supplierId/production-plans` · `GET /api/v1/production-plans/:planId` | Plan adalah resource terpisah dari stock. Endpoint per plan tidak bisa dipakai untuk enumerasi. |
| Mencari baris yang status dan qty-nya bertentangan | `GET .../stock?status=available` · tarik semua lalu hitung sendiri · `?q=` | Filter status memercayai field yang justru sedang dicurigai. Hanya pull-all + perhitungan sendiri yang bisa membuktikan kontradiksi. |
| Memeriksa supplier nonaktif | `GET /api/v1/suppliers?api_status=inactive` · cek satu per satu `GET /api/v1/suppliers/:id` | Filter list adalah cara termurah, tetapi keputusan memakai datanya tetap milikmu. |
| Membuktikan tidak ada halaman terlewat | `meta.total`, `meta.total_pages`, `limit=50`, `page=n` | `data.length` di halaman terakhir bukan total populasi. |
| Mengukur dampak finansial shortage | `stock_quantity` + `planned_quantity` · `unit_price` + `currency` | Nilai rupiah hanya boleh dihitung jika field tersedia; jangan mengarang default. |

> Catatan kontrak: `GET /api/v1/stock` dan `GET /api/v1/production-plans` (global) tersedia dan menjadi jalur utama untuk enumerasi. Loop per supplier tetap sah sebagai pembanding, tetapi biayanya N request dan lebih mudah melewatkan supplier yang tidak kamu daftar lebih dulu.

## 5. Alur kerja yang diharapkan

0. **Siapkan lingkungan.** Jalankan server dari root repo (`node server/server.js`), pastikan `/health` menjawab, dan catat waktu mulai. Jika data pernah diubah latihan lain, restart server agar kembali ke seed.
   *Checkpoint:* URL base, waktu, dan status `/health`.
1. **Bekukan definisi (15 menit pertama).** Tulis di `report.md`: definisi berisiko, cut-off tanggal, perlakuan supplier nonaktif, dan toleransi. Cantumkan `rules_version` dan waktu. Jangan mengubah definisi setelah melihat hasil; kalau terpaksa, buat versi baru dan jelaskan.
   *Checkpoint:* satu paragraf definisi yang bisa dibaca orang lain tanpa bertanya.
2. **Inventaris supplier.** Simpan respons mentah. Catat jumlah supplier, sebaran `api_status`, dan endpoint yang kamu pakai.
   *Checkpoint:* daftar supplier + status, dengan URL persisnya.
3. **Tarik stok sampai habis.** Pilih global atau loop per supplier, lalu iterasi halaman sampai `page > total_pages`. Jumlahkan `data.length` dan bandingkan dengan `meta.total`.
   *Checkpoint:* tabel `page`, `limit`, jumlah baris, `meta.total`, `total_pages`.
4. **Tarik plan sesuai cakupan.** Tentukan status plan yang masuk hitungan dan hitung yang sengaja dikecualikan beserta alasannya.
   *Checkpoint:* jumlah plan per status sebelum dan sesudah filter; daftar plan yang dikecualikan.
5. **Normalisasi di lapisan analisis, bukan di API.** Parse angka secara eksplisit, samakan penulisan UOM, tandai `null`/field hilang. Nilai asli tetap disimpan di `evidence.md`.
   *Checkpoint:* daftar baris yang memerlukan normalisasi + nilai aslinya.
6. **Join berdasarkan `(supplier_id, part_number)`.** Sebelum join, periksa duplikasi kunci dan part number yang muncul di lebih dari satu supplier. Jangan memakai `part_name` sebagai kunci.
   *Checkpoint:* jumlah kunci unik vs jumlah baris; daftar kunci duplikat (kalau ada).
7. **Hitung gap dan klasifikasikan.** `gap = demand - stock` hanya jika UOM sebanding. Setiap baris wajib punya `reason_code` dan rekomendasi.
   *Checkpoint:* distribusi reason code; tidak ada baris tanpa alasan.
8. **Tulis, lalu uji ulang.** Bandingkan jumlah baris laporan dengan populasi, jalankan verifikasi §9, dan simpan bukti. Jangan memakai smoke test sebagai verifikasi karena skrip itu mengubah data.
   *Checkpoint:* jumlah baris laporan = jumlah baris dalam cakupan; semua perintah §9 memberi hasil yang diharapkan.

## 6. Deliverable

| File | Isi | Format |
|---|---|---|
| `report.md` | Ringkasan eksekutif maksimal 250 kata; tabel part berisiko (supplier, part, UOM, stok, demand, gap, status dilaporkan, status hasil analisis, rekomendasi); keputusan dan asumsi; `rules_version`. | Markdown |
| `shortage-report.json` | `generated_at`, `rules_version`, `sources[]`, `assumptions[]`, `summary`, dan `items[]`. Setiap item punya `reason_code` dan `evidence_ref`. Harus valid dan bisa dibaca `jq`. | JSON |
| `evidence.md` | URL + status + header relevan + potongan body, ringkasan pagination per halaman, timestamp pengambilan, dan daftar kontradiksi beserta buktinya. | Markdown dengan code block |

Simpan ketiga file dalam satu folder `submission/T1/`. Angka yang muncul di `report.md` wajib sama dengan yang ada di `shortage-report.json`; kalau berbeda, jelaskan mana yang benar.

## 7. Kriteria penilaian

| Komponen | Bobot | Yang dinilai |
|---|---|---|
| Akurasi data | 35 | Semua baris dalam cakupan ikut dihitung; total cocok dengan `meta.total`; tidak ada part hilang atau dobel; gap benar; UOM tidak dicampur. |
| Penalaran keputusan | 25 | Definisi eksplisit dan konsisten; supplier nonaktif diperlakukan dengan alasan; prioritas bisa dipertahankan di rapat. |
| Penanganan anomali | 20 | Kontradiksi terdeteksi dan diklasifikasikan; data sumber tidak "diperbaiki" diam-diam; setiap anomali punya reason code. |
| Bukti & dokumentasi | 20 | Request bisa diulang orang lain; kutipan respons memadai; struktur JSON rapi; laporan mudah dibaca. |
| **Total** | **100** | |

Rubrik membaca hasil, bukan proses. Laporan yang "rapi" tetapi tidak bisa direproduksi tetap kehilangan poin di dua komponen terakhir.

## 8. Jebakan data & kesalahan umum

- **Status dan qty bisa bertentangan ke dua arah.** Jangan menurunkan satu field dari field lain tanpa menandai konflik yang kamu temukan.
- **Angka bisa datang sebagai string.** Di JavaScript, `"12" + 0` menghasilkan `"120"`, dan pengurutan menjadi leksikografis. Parse eksplisit dan catat baris yang perlu dikoreksi.
- **Penulisan UOM tidak seragam.** Filter `uom=PCS` akan diam-diam membuang baris yang ditulis `pcs`. Normalisasi di analisis, bukan dengan mengubah sumber.
- **`part_number` yang sama bisa muncul di supplier berbeda dengan UOM berbeda.** Jangan menjumlahkan lintas supplier sebelum memeriksa satuan.
- **Nama part tidak stabil antar resource.** Join berbasis nama akan kehilangan baris; kunci harus `(supplier_id, part_number)`.
- **Timestamp memakai offset yang berbeda.** Bandingkan sebagai instant hasil parse, bukan sebagai string. Dua timestamp bisa menunjuk waktu yang sama meskipun offset dan panjang tulisannya berbeda.
- **Ada plan yang menunjuk part yang tidak ada di stok.** "Tidak ada data" bukan "stok nol"; beri verdict terpisah.
- **Supplier nonaktif tetap mengembalikan data.** Menyalin datanya tanpa catatan adalah keputusan yang tidak terdokumentasi.
- **Field opsional bisa `null` atau hilang sama sekali.** Jangan mengisi default yang tidak ada di sumber; tulis "tidak tersedia".
- **`limit` default 10.** Populasi bisa lebih besar dari satu halaman; laporan yang hanya membaca halaman pertama akan terlihat rapi tetapi salah.
- **`data.length` bukan total.** Selalu rekonsiliasi dengan `meta.total` dan `meta.total_pages` sebelum menyimpulkan.
- **`q` adalah pencarian teks, bukan kunci.** Mencari part lewat `?q=` bisa mengembalikan nol atau beberapa baris mirip; untuk kepastian, pakai filter field atau lookup per part.
- **Angka dashboard dan angka API bisa berbeda waktu.** Dashboard membaca snapshot saat halaman dibuka. Untuk laporan, sumbernya adalah respons API yang kamu simpan, bukan tangkapan layar.

## 9. Verifikasi mandiri

Jalankan dari terminal, dengan server aktif. Semua perintah di bawah read-only atau ditolak sebelum mengubah data.

```bash
BASE=http://localhost:4010
KEY='X-API-Key: sup_demo_key_2026'

# 1. Server hidup, tanpa API key
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/health"                        # 200

# 2. Tanpa API key harus ditolak
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/suppliers"              # 401

# 3. Populasi supplier + meta
curl -s -H "$KEY" "$BASE/api/v1/suppliers?limit=50" | jq '.meta'

# 4. Batas atas pagination
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-001/stock?limit=99" | jq '.meta'
# meta.limit harus 50, bukan 99

# 5. Part tidak ada: envelope error, bukan 200 kosong
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-001/stock/DOES-NOT-EXIST" | jq '.error.code'
# "NOT_FOUND"

# 6. Rate limit dan Retry-After
curl -s -D - -o /dev/null -H "$KEY" "$BASE/api/v1/suppliers?simulate=ratelimit" | grep -iE '^HTTP/|^Retry-After'
# 429 dan Retry-After: 5

# 7. Write dengan token readonly: 403, bukan 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "$KEY" -H 'Authorization: Bearer readonly-token' -H 'Content-Type: application/json' \
  -d '{}' "$BASE/api/v1/suppliers/SUP-001/stock"                               # 403

# 8. Method tidak diizinkan
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "$KEY" "$BASE/api/v1/suppliers/SUP-001"  # 405

# 9. Cakupan global
curl -s -H "$KEY" "$BASE/api/v1/stock?limit=1" | jq '.meta'                                  # 200, meta.total 24
# bandingkan hasilnya dengan loop per supplier pada ekstensi §10
```

Catat hasilnya di `evidence.md`. Jika ada yang tidak sesuai, itu temuan lingkungan: sebutkan versi/deployment dan jangan mengakalinya dengan mengubah data. **Jangan menjalankan `scripts/smoke-test.sh` sebagai verifikasi** — skrip itu membuat supplier, stok, dan plan baru. Kalau kamu terlanjur melakukan write, restart server agar seed kembali bersih.

## 10. Ekstensi opsional

- Tambahkan kolom dampak finansial untuk baris yang punya `unit_price` dan `currency`, dan tandai eksplisit baris yang tidak bisa dihitung.
- Buat mode `--as-of YYYY-MM-DD` pada skrip laporan sehingga hasil bisa direproduksi untuk minggu lain tanpa mengubah kode.
- Bandingkan hasil pendekatan global vs loop per supplier: jumlah request, waktu, dan kemungkinan baris terlewat. Tulis rekomendasi kapan masing-masing dipakai.
