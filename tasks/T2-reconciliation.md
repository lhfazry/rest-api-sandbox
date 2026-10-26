# T2 — Rekonsiliasi Stok vs Rencana Produksi

**Level:** Medium–Hard · **Estimasi:** 120 menit · **Peran:** Production Planner · **Prasyarat:** GET + pagination, join dua tabel, parsing tanggal ISO, dan penulisan CSV yang rapi.

## 1. Konteks bisnis

Setiap minggu supplier mengirim production plan: part apa, berapa banyak, kapan diproduksi, dan kapan dikirim. Sales sudah menjanjikan sebagian tanggal itu ke customer besar. Sebelum tanggal dikunci, operations harus tahu satu hal yang tidak pernah tertulis di plan mana pun: **plan mana yang tidak bisa dipenuhi dengan stok yang ada sekarang**.

Bulan lalu sebuah tanggal kirim dikonfirmasi berdasarkan plan yang terlihat normal. Saat produksi berjalan, part-nya tidak ada di stok supplier. Yang muncul kemudian bukan hanya keterlambatan, tetapi penalti kontrak dan pertanyaan mengapa tidak ada yang mencocokkan dua sumber data yang sebenarnya sama-sama tersedia.

Plan dan stock adalah dua resource terpisah. API tidak punya field `fulfillable`, jadi penilaianmu adalah lapisan analisis yang harus bisa dijelaskan. Output-mu akan dipakai tiga pihak: planner yang menyusun ulang jadwal, procurement yang menelepon supplier, dan manajer yang memutuskan tanggal mana yang ditahan.

Karena itu hasilnya bukan sekadar daftar "stok kurang". Setiap plan harus punya verdict, alasan, dan tindakan yang disarankan — termasuk saat datanya tidak cukup untuk menjawab.

Cakupan latihan ini adalah plan yang masih relevan untuk komitmen minggu ini. Plan yang sudah selesai tetap boleh muncul, tetapi keputusanmu tentang status itulah yang menentukan apakah ia masuk perhitungan atau hanya menjadi konteks.

## 2. Tujuan pembelajaran

- Menentukan kunci join yang stabil antara production plan dan stock, serta membuktikan bahwa kunci itu tidak menghasilkan duplikasi.
- Menarik dua populasi data secara lengkap dan mendamaikan jumlah baris dengan metadata pagination.
- Mengklasifikasikan plan yang tidak dapat dipenuhi memakai reason code yang konsisten dan dapat diuji ulang.
- Mengalokasikan stok yang terbatas ke beberapa plan tanpa menghitung stok yang sama dua kali.
- Menetapkan perlakuan eksplisit untuk status plan, plan tanpa data stok, dan supplier nonaktif.
- Menyusun temuan yang diprioritaskan beserta jalur eskalasi dan bukti pendukungnya.

## 3. Yang harus kamu putuskan sendiri

Tidak ada satu jawaban benar untuk semua pertanyaan di bawah. Yang dinilai adalah apakah keputusanmu konsisten, dapat diuji, dan mempertimbangkan dampaknya ke janji kirim.

1. **Apa kunci join-nya, dan apakah kunci itu unik?** Bagaimana kamu menangani satu `part_number` yang muncul di lebih dari satu supplier, atau beberapa plan yang menunjuk part yang sama?
2. **Bagaimana stok dialokasikan ketika beberapa plan membutuhkan part yang sama?** Urutkan berdasarkan tanggal produksi, tanggal kirim, atau `plan_id`? Keputusan ini menentukan apakah total gap bisa dijumlahkan tanpa double counting.
3. **Status plan mana yang masih dianggap komitmen?** Apakah `completed` keluar dari perhitungan, tetap direkonsiliasi sebagai histori, atau diperlakukan khusus? Bagaimana dengan `delayed`?
4. **Apa toleransi shortfall?** Gap absolut, persentase, atau menyisakan safety stock? Bagaimana pembulatan dilakukan, dan hanya boleh dilakukan setelah UOM dipastikan sebanding.
5. **Plan yang part-nya tidak ada di stok: nol atau tidak diketahui?** Keduanya berujung pada keputusan berbeda. Pilih satu dan jelaskan dampaknya ke janji kirim.
6. **Kapan kamu menahan komitmen tanggal?** Plan dengan jadwal yang tidak masuk akal dan supplier nonaktif perlu verdict serta jalur eskalasi yang berbeda; tentukan siapa pemilik tindak lanjutnya.

## 4. Peta kapabilitas API — pilih sendiri

| Kebutuhan | Kandidat endpoint (2–4) | Kenapa perlu dicek |
|---|---|---|
| Enumerasi seluruh plan lintas supplier | `GET /api/v1/production-plans` · loop `GET /api/v1/suppliers/:supplierId/production-plans` · `GET /api/v1/production-plans/:planId` | Endpoint per plan hanya untuk verifikasi; tidak bisa dipakai menemukan populasi. |
| Plan untuk satu supplier | `GET /api/v1/production-plans?supplier_id=` · `GET /api/v1/suppliers/:supplierId/production-plans` | Dua jalur sah; pilih yang paling mudah diaudit dan konsisten dengan cara kamu menarik stok. |
| Stok pembanding | `GET /api/v1/stock?supplier_id=` · `GET /api/v1/suppliers/:supplierId/stock` · `GET .../stock/:partNumber` | Per-part lookup untuk N plan akan menjadi N+1 request; bukan cara enumerasi. |
| Memeriksa part yang sama di supplier lain | `GET /api/v1/stock?part_number=` · loop per supplier · `?q=` | Part number bisa muncul di beberapa supplier. `q` adalah pencarian teks, bukan kunci. |
| Filter status plan | `?status=` pada list plan · tarik semua lalu filter lokal | Parameter query bernama `status`, sedangkan field respons bernama `production_status`. Pastikan filter benar-benar bekerja. |
| Menentukan supplier yang boleh dikomitmenkan | `GET /api/v1/suppliers?api_status=active` · `GET /api/v1/suppliers/:id` | Status integrasi bukan status kualitas, tetapi tetap perlu keputusan eksplisit. |
| Verifikasi satu plan | `GET /api/v1/production-plans/:planId` · baris di hasil list | Berguna untuk spot-check, bukan untuk membangun dataset. |
| Validasi urutan tanggal | Tidak ada endpoint khusus · hitung di klien | API menyimpan tanggal apa adanya; kewajaran jadwal adalah aturan bisnismu. |
| Ekspor untuk review manual | `GET /api/v1/stock` + `Accept: text/csv` · JSON | CSV hanya tersedia untuk stock; plan tetap JSON. Format transfer tidak boleh mengubah logika. |

> Catatan kontrak: `GET /api/v1/production-plans` dan `GET /api/v1/stock` (global) tersedia dan menjadi jalur enumerasi utama; loop per supplier sah sebagai pembanding. Selain itu, `?status=` memfilter field `production_status` — jangan mengarang field `status` di output.

## 5. Alur kerja yang diharapkan

0. **Siapkan baseline.** Jalankan server dari root repo, pastikan `/health` hijau, dan catat waktu pengambilan. Kalau data pernah dimutasi latihan lain, restart agar seed bersih.
   *Checkpoint:* URL base, waktu, dan status `/health`.
1. **Tulis aturan sebelum melihat hasil.** `decision-rules.md` dibuat lebih dulu: kunci join, status mapping, urutan alokasi, toleransi, kamus verdict dan reason code.
   *Checkpoint:* aturan cukup spesifik sehingga orang lain bisa menerapkannya ke plan baru tanpa bertanya.
2. **Enumerasi plan.** Tarik semua halaman. Hitung plan per status, lalu tandai mana yang masuk cakupan dan mana yang dikecualikan.
   *Checkpoint:* jumlah plan mentah, jumlah per status, jumlah dalam cakupan; selisihnya dijelaskan.
3. **Enumerasi stok.** Tarik semua halaman stok, termasuk supplier yang tidak muncul di plan. Simpan `meta` tiap halaman.
   *Checkpoint:* total baris = `meta.total`; tidak ada halaman yang terlewat.
4. **Uji kualitas kunci.** Cari duplikasi `(supplier_id, part_number)`, part lintas supplier, ketidaksesuaian nama, dan UOM yang tidak sebanding.
   *Checkpoint:* tabel hasil uji kunci; daftar pasangan yang tidak aman untuk di-join.
5. **Klasifikasikan setiap plan.** Bedakan minimal: tidak ada stok, stok tidak cukup, UOM tidak sebanding, kuantitas tidak dapat dibaca, jadwal mustahil, dan aman.
   *Checkpoint:* setiap plan punya satu verdict dan satu reason code; tidak ada plan tanpa keputusan.
6. **Alokasikan stok.** Urutkan plan sesuai aturan yang kamu tulis, kurangi stok yang tersedia per part, dan catat sisa setelah tiap alokasi.
   *Checkpoint:* total alokasi per part tidak melebihi stok yang tersedia.
7. **Susun CSV.** Satu baris per plan dalam cakupan, termasuk plan yang aman. Kolom alasan tidak boleh kosong.
   *Checkpoint:* jumlah baris CSV = jumlah plan dalam cakupan.
8. **Prioritaskan dan eskalasi.** Pisahkan temuan yang memblokir janji kirim dari yang perlu konfirmasi dan yang cukup dipantau. Sertakan bukti dan pemilik tindakan.
   *Checkpoint:* tiga temuan teratas punya dampak bisnis dan langkah berikutnya yang jelas.

## 6. Deliverable

| File | Isi | Format |
|---|---|---|
| `reconciliation.csv` | Satu baris per plan dalam cakupan: `plan_id`, `supplier_id`, `part_number`, `part_name_plan`, `part_name_stock`, `uom_stock`, `planned_quantity`, `stock_available`, `gap_qty`, `production_date`, `delivery_schedule`, `production_status`, `supplier_api_status`, `verdict`, `reason_code`, `recommended_action`. Catatan: production plan tidak memiliki field UOM; nyatakan asumsimu di `decision-rules.md` alih-alih mengarang `uom_plan`. | CSV, header tepat satu baris |
| `findings.md` | Temuan berprioritas (memblokir / perlu konfirmasi / pantau), bukti, dampak bisnis, rekomendasi eskalasi, dan pemilik tindakan. | Markdown |
| `decision-rules.md` | Kunci join, status mapping, urutan alokasi, toleransi, kamus verdict/reason code, asumsi, dan versi aturan. | Markdown |

Simpan dalam `submission/T2/`. `reconciliation.csv` harus bisa dibuka di spreadsheet tanpa perbaikan manual dan angkanya konsisten dengan `findings.md`.

## 7. Kriteria penilaian

| Komponen | Bobot | Yang dinilai |
|---|---|---|
| Logika join | 30 | Kunci benar; duplikasi dan part lintas supplier ditangani; tidak ada plan yang hilang atau dobel; alokasi tidak menghitung stok dua kali. |
| Kelengkapan temuan | 25 | Semua jenis ketidaksesuaian yang relevan terdeteksi; plan aman tetap tercatat; tidak ada kategori yang tertukar. |
| Kualitas keputusan | 25 | Verdict dapat dipertahankan; toleransi dan status mapping masuk akal; eskalasi tepat sasaran. |
| Deliverable hygiene | 20 | CSV valid dan konsisten; reason code seragam; `decision-rules.md` cukup untuk mereproduksi hasil; bukti memadai. |
| **Total** | **100** | |

## 8. Jebakan data & kesalahan umum

- **Join berdasarkan nama akan kehilangan baris.** `part_name` di plan dan di stock bisa berbeda untuk part yang sama; kunci harus `part_number` bersama `supplier_id`.
- **`part_number` yang sama bisa ada di dua supplier.** Tanpa `supplier_id`, join menghasilkan kombinasi palsu dan stok yang salah.
- **Stok dipakai bersama oleh beberapa plan.** Menghitung gap per plan terhadap stok penuh akan menggandakan kekurangan; alokasikan dan catat sisanya.
- **Plan `completed` masih ada di dataset.** Kalau tidak dikecualikan, stok yang sudah terpakai akan tampak tersedia untuk plan baru.
- **Plan bisa menunjuk part yang tidak ada di stok.** Memperlakukannya sebagai "stok 0" menyamarkan masalah data menjadi masalah kuantitas.
- **Tanggal harus dibandingkan sebagai tanggal, bukan teks acak.** `delivery_schedule` sebelum `production_date` adalah kontradiksi, bukan keterlambatan biasa.
- **UOM tidak selalu sebanding, dan plan tidak punya field UOM.** Satuan hanya tersedia di stock. Jangan mengarang `uom_plan`; nyatakan bahwa perbandingan mengasumsikan satuan stock berlaku, atau tandai baris sebagai tidak dapat dibandingkan.
- **UOM tidak selalu sebanding.** Jangan mengurangi `planned_quantity` dengan `stock_quantity` sebelum memastikan satuannya sama.
- **Kuantitas bisa berupa string.** Pengurangan di JavaScript bisa menghasilkan `NaN` atau penggabungan teks; parse dulu dan tandai baris yang gagal.
- **`limit` default 10.** Jumlah plan melebihi satu halaman; membaca halaman pertama saja membuat rekonsiliasi tampak lengkap padahal tidak.
- **Supplier nonaktif masih mengirim plan dan punya stok.** Mengabaikannya tanpa catatan adalah keputusan bisnis yang tidak terdokumentasi.
- **`status` di query bukan nama field di respons.** Respons memakai `production_status`; jangan menyimpulkan filter gagal hanya karena field `status` tidak ada.
- **Satu `plan_id` bisa tidak muncul di stok mana pun.** Jangan memakai `plan_id` sebagai kunci join ke stock; stock tidak mengenal plan.
- **Dua plan bisa menunjuk part yang sama dengan tanggal berbeda.** Menggabungkan keduanya menjadi satu baris akan menyembunyikan plan yang paling mendesak.

## 9. Verifikasi mandiri

```bash
BASE=http://localhost:4010
KEY='X-API-Key: sup_demo_key_2026'

# 1. Populasi plan satu supplier
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-001/production-plans?limit=50" | jq '.meta'

# 2. Filter status benar-benar bekerja
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-001/production-plans?status=completed" \
  | jq '[.data[].production_status] | unique'
# harus ["completed"] atau [] jika tidak ada; tidak boleh berisi status lain

# 3. Plan tidak ada: envelope error
curl -s -H "$KEY" "$BASE/api/v1/production-plans/PLAN-999" | jq '.error.code'    # "NOT_FOUND"

# 4. Filter supplier nonaktif
curl -s -H "$KEY" "$BASE/api/v1/suppliers?api_status=inactive" | jq '[.data[].api_status] | unique'

# 5. Pagination tidak tumpang tindih
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-002/stock?limit=3&page=1" | jq '[.data[].part_number]'
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-002/stock?limit=3&page=2" | jq '[.data[].part_number]'
# tidak boleh ada part_number yang muncul di kedua halaman

# 6. Cakupan global
curl -s -H "$KEY" "$BASE/api/v1/production-plans?limit=1" | jq '.meta'                       # 200, meta.total 15

# 7. Simulasi kegagalan server
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-001/production-plans?simulate=error500" | jq '.error.code'
# "INTERNAL_SERVER_ERROR"

# 8. Write tanpa bearer token ditolak sebelum mengubah data
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H "$KEY" -H 'Content-Type: application/json' \
  -d '{}' "$BASE/api/v1/production-plans/PLAN-001"                              # 401

# 9. Method yang tidak tersedia
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "$KEY" "$BASE/api/v1/production-plans/PLAN-001"  # 405
```

Jika ada hasil yang tidak sesuai kontrak, catat sebagai temuan lingkungan, bukan alasan mengubah data. Jangan menjalankan `scripts/smoke-test.sh` sebagai verifikasi karena skrip itu menambah supplier, stok, dan plan. Jika sudah terlanjur menulis, restart server.

## 10. Ekstensi opsional

- Tambahkan simulasi "what-if": jika satu plan digeser satu minggu, plan mana yang berubah verdict? Tulis dampaknya dalam satu paragraf.
- Buat ringkasan per supplier (jumlah plan, total gap, plan paling berisiko) dan bandingkan supplier aktif vs nonaktif.
- Tambahkan kolom tingkat keyakinan (`high`/`medium`/`low`) berdasarkan kelengkapan data, lalu jelaskan aturan penetapannya.
