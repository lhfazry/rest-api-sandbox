# T7 — Export Stok untuk Procurement (CSV)

**Level:** Menengah · **Estimasi:** 75 menit · **Peran:** Procurement Analyst · **Prasyarat:** T1–T6 selesai; server berjalan di `http://localhost:4010`; sudah bisa memakai `X-API-Key` dan mengambil token Bearer.

## 1. Konteks bisnis

Setiap pagi pukul 07.00 tim Finance meminta file spreadsheet stok terbaru. Dashboard internal hanya bisa dibaca, tidak punya tombol export, dan menyalin JSON mentah ke Excel menghasilkan satu kolom panjang yang tidak bisa dipivot. Procurement juga perlu daftar item `low` dan `out` untuk ditindaklanjuti hari itu, bukan seluruh 24 baris.

Kontrak dengan Finance sederhana: satu baris header yang stabil, UTF-8, pemisah koma, akhir baris CRLF, dan nama file yang memuat tanggal. Data sandbox memang kotor. Tugasmu bukan membersihkannya diam-diam, melainkan mengekspor apa adanya sambil mendokumentasikan anomali yang ikut terbawa. Keputusan teknis dan alasannya adalah inti latihan ini.

## 2. Tujuan pembelajaran

- Membandingkan **content negotiation** (`Accept: text/csv`) dengan **paging JSON manual** berdasarkan bukti, bukan preferensi.
- Membaca parameter filter dan pagination dari dokumentasi lalu memverifikasi perilakunya, termasuk yang tidak dijanjikan.
- Menghasilkan CSV yang valid menurut RFC 4180: quoting, escaped quote, CRLF, dan header yang tepat.
- Menjaga konsistensi jumlah baris antara file, `X-Total-Count`, dan `meta.total`.
- Membuat rekomendasi yang memisahkan masalah teknis (enkoding, locale) dari masalah data (nilai kotor).

## 3. Yang harus kamu putuskan sendiri

1. **Mekanisme export.** Satu request CSV global, atau JSON berpaginasi yang dirakit sendiri? Tuliskan alasan dan biaya masing-masing.
2. **Cakupan data.** Hanya `low` + `out`, atau semua status? Apakah supplier `inactive` (`SUP-003`) ikut diekspor? Siapa pemilik keputusan ini di dunia nyata?
3. **Cara menggabungkan dua status.** Filter `status` hanya menerima satu nilai. Dua request lalu digabung, atau dua file terpisah? Bagaimana mencegah baris ganda?
4. **Kelengkapan baris.** `limit` default 10 dan maksimum 50. Apakah CSV mengikuti pagination yang sama? Jika ya, bagaimana memastikan file memuat seluruh hasil filter, bukan hanya halaman pertama?
5. **Filter supplier.** Satu file per supplier, atau satu file gabungan dengan kolom `supplier_id`? Ingat ada `part_number` yang sama di dua supplier dengan UOM berbeda.
6. **Perlakuan data kotor.** Apakah `stock_quantity` string `"480"` dikonversi, `unit_price` null diisi 0, dan `uom` `"pcs"` diubah menjadi huruf besar? Jika ya, bagaimana Finance tahu ada perubahan? Jika tidak, bagaimana kamu menandainya?
7. **Locale Excel.** Apakah file harus tetap koma (standar) atau mengikuti Excel `id-ID` yang memakai titik koma dan koma desimal? Jika memilih kompromi, nyatakan siapa yang dirugikan.

## 4. Peta kapabilitas API — pilih sendiri

| Kapabilitas | Endpoint / header | Yang kamu dapat | Catatan biaya atau risiko |
|---|---|---|---|
| CSV global | `GET /api/v1/stock?supplier_id=&status=` + `Accept: text/csv` | Satu respons CSV, header `X-Total-Count`, `Content-Disposition` | Memakai filter dan pagination yang sama; `limit` default 10 bisa memotong hasil |
| JSON global berpaginasi | `GET /api/v1/stock?page=&limit=` (maks 50) | Kontrol penuh atas filter, sort, dan jumlah baris | Harus loop; 24 baris hari ini, tetapi kode wajib tetap benar jika data tumbuh |
| JSON per supplier | `GET /api/v1/suppliers/:id/stock` | Stok satu supplier | Enam kombinasi supplier×status; lebih banyak request, mudah ada yang terlewat |
| Nested + CSV | `GET /api/v1/suppliers/SUP-001/stock` + `Accept: text/csv` | Belum tentu CSV | Kontrak hanya menjanjikan CSV di koleksi global; jangan berasumsi |
| Kontrak | `/openapi.json`, `/docs` | Daftar parameter dan contoh | Dokumentasi bisa belum menyebut detail CSV; verifikasi tetap perlu |
| Negosiasi gagal | `Accept: application/xml` | `406 NOT_ACCEPTABLE` | Bukti bahwa server benar-benar menegosiasikan format |
| Kesiapan | `GET /health` | Status server sebelum export | Jangan menjadwalkan export ke server yang belum siap |
| Dashboard | `GET /` | Tampilan read-only | Decoy: tidak ada endpoint export; jangan scrape HTML |

## 5. Alur kerja yang diharapkan

1. Baca `/docs` dan `/openapi.json`, catat parameter `supplier_id`, `status`, `page`, `limit`, `sort` yang relevan.
2. Probe CSV dengan `curl -D` dan simpan header ke file. Catat `Content-Type`, `Content-Disposition`, dan `X-Total-Count`. Uji juga `?limit=5` untuk melihat apakah CSV memotong baris mengikuti pagination.
3. Tentukan cakupan, lalu hitung baseline lewat JSON (`limit=50`) sebagai pembanding independen. Ingat `limit` default 10, jadi hasil tanpa `limit` bukan populasi penuh.
4. Tulis skrip yang mengambil data, menulis ke file sementara, memvalidasi, baru memindahkan ke nama final bertimestamp. Jika memilih JSON, kumpulkan halaman sampai `page` melewati `meta.total_pages`; hormati batas `limit` maksimum 50 dan buktikan loop dengan `limit=5`. Jika memilih CSV, pastikan jumlah baris sama dengan total hasil filter, bukan hanya satu halaman.
5. Validasi: jumlah baris, konsistensi total, urutan kolom, CRLF, dan tidak ada baris terpotong.
6. Buat satu baris uji sementara yang memuat koma dan tanda kutip, ekspor, periksa quoting, lalu hapus baris uji tersebut.
7. Periksa enkoding: tidak ada BOM tak diminta, tidak ada karakter pengganti (`�`), dan byte non-ASCII terbaca benar.
8. Tulis rekomendasi: kapan CSV lebih tepat, kapan JSON berpaginasi lebih tepat, dan risiko apa yang harus disepakati dengan Finance.

## 6. Deliverable

| File | Isi minimum | Bukti yang harus terlihat |
|---|---|---|
| `export.sh` **atau** `export.js` | Tanpa dependensi npm; filter dapat diubah lewat argumen/env; gagal dengan exit code non-zero; nama file bertimestamp | Satu kali dijalankan bersih, satu kali dijalankan saat server mati (gagal jelas, bukan file kosong) |
| `sample.csv` | Hasil export dari seed data, header persis 11 kolom kontrak, tanpa baris fixture uji | Bisa dibuka di Excel/LibreOffice tanpa pergeseran kolom |
| `validation.md` | Jumlah baris vs `X-Total-Count` vs `meta.total`; hasil uji 406; bukti quoting; cek enkoding | Tempel potongan header respons dan perintah yang dipakai |
| `recommendation.md` | Perbandingan CSV vs JSON+paging; risiko locale Excel; rekomendasi untuk Finance dan Procurement | Keputusan eksplisit, bukan daftar "tergantung" |

## 7. Kriteria penilaian (sum 100)

| Aspek | Bobot | Yang dinilai |
|---|---|---|
| Pemilihan mekanisme | 25 | Keputusan didukung bukti probe, bukan asumsi; trade-off request, ukuran, dan kompleksitas dijelaskan |
| Kualitas skrip | 25 | Filter benar, penanganan error, file sementara, exit code, tidak ada dependensi baru |
| Validasi data | 30 | Tiga angka total konsisten; quoting, CRLF, enkoding, dan anomali data dibuktikan |
| Rekomendasi | 20 | Relevan untuk Finance/Procurement, memisahkan masalah format dan kualitas data, menyebut risiko locale |

## 8. Jebakan & kesalahan umum

- Merakit CSV dengan `join(',')` tanpa quoting, lalu rusak saat `part_name` berisi koma.
- Menulis LF saja, atau menambahkan BOM tanpa kesepakatan sehingga header terbaca aneh.
- Menganggap CSV selalu mengembalikan seluruh baris, padahal `limit` default 10; file berisi 10 baris dan tidak ada yang menyadarinya sampai Finance bertanya.
- Loop paging berhenti di halaman pertama karena `total_pages` tidak dibaca.
- Menggabungkan hasil `low` dan `out` lalu menduplikasi baris yang statusnya berubah di antara dua request.
- Mengubah `"480"` menjadi angka dan `null` menjadi 0 tanpa catatan; Finance mengira harga benar-benar nol.
- Menghapus baris anomali agar file "bersih"; ini menghilangkan bukti dan melanggar kesepakatan.
- Menimpa `sample.csv` langsung sehingga kegagalan di tengah menghasilkan file separuh.
- Membandingkan `X-Total-Count` dengan jumlah baris halaman, bukan dengan total hasil filter.
- Menganggap `406` sebagai kerusakan server; itu justru bukti negosiasi format bekerja.
- Membuat fixture uji permanen yang mengubah baseline data seed.

## 9. Verifikasi mandiri

Jalankan server lebih dulu (`node server/server.js`). Ganti `BASE` bila memakai port lain.

```bash
BASE=http://localhost:4010
KEY='X-API-Key: sup_demo_key_2026'

curl -s "$BASE/health"

# Baseline JSON: total hasil filter, bukan jumlah baris halaman
curl -s -H "$KEY" "$BASE/api/v1/stock?limit=50" | grep -o '"part_number"' | wc -l
curl -s -H "$KEY" "$BASE/api/v1/stock?status=low&limit=50" | grep -o '"part_number"' | wc -l

# Header CSV: content-type, disposition, total; bandingkan baris dengan total
curl -sD /tmp/t7-headers.txt -o /tmp/t7.csv \
  -H "$KEY" -H 'Accept: text/csv' "$BASE/api/v1/stock?status=low&limit=50"
grep -iE 'content-type|content-disposition|x-total-count' /tmp/t7-headers.txt

# Bukti pagination CSV: 5 baris, tetapi total filter tetap 24
curl -sD /tmp/t7-limit.txt -o /tmp/t7-limit.csv \
  -H "$KEY" -H 'Accept: text/csv' "$BASE/api/v1/stock?limit=5"
grep -c '^SUP-' /tmp/t7-limit.csv; grep -i 'x-total-count' /tmp/t7-limit.txt

# 406 untuk format yang tidak didukung
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "$KEY" -H 'Accept: application/xml' "$BASE/api/v1/stock"
```

Uji quoting dengan fixture sementara (wajib dihapus setelah selesai):

```bash
TOKEN=$(curl -s -X POST "$BASE/auth/token" -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).access_token))")

curl -s -X POST "$BASE/api/v1/suppliers/SUP-001/stock" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"part_number":"T7-CSV-TEST","part_name":"Bracket, L-Type \"Heavy\"","stock_quantity":1,"uom":"PCS","stock_location":"WH-TEST","stock_status":"low"}'

curl -s -H "$KEY" -H 'Accept: text/csv' "$BASE/api/v1/stock?part_number=T7-CSV-TEST&limit=50" | grep 'T7-CSV-TEST'
# harapan: nama terbungkus kutip ganda dan kutip di dalamnya menjadi dua kutip

curl -s -X DELETE "$BASE/api/v1/suppliers/SUP-001/stock/T7-CSV-TEST" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN"
```

Pemeriksaan file: `file -I sample.csv` harus melaporkan UTF-8 atau ASCII (keduanya valid), bukan ISO-8859-1; uji fixture non-ASCII untuk memastikan byte UTF-8 tidak berubah. Hitung CRLF dan pastikan tidak ada `\r` tunggal. Ingat **smoke test memutasi data** (`SUP-SMOKE-*`, stok `SMOKE-*`, satu plan). Restart server untuk mengembalikan seed, dan jangan menjalankannya di tengah pengambilan sample.

## 10. Ekstensi opsional

- Jadwalkan export harian dan simpan checksum agar file yang tidak berubah bisa dilewati.
- Sediakan dua varian: koma/UTF-8 untuk sistem, titik koma untuk Excel `id-ID`, dengan penjelasan risikonya.
- Tambahkan deteksi formula injection (`=`, `+`, `-`, `@` di awal sel) tanpa mengubah data secara diam-diam.
- Tangani `429` dan `Retry-After` bila export diperbesar ke ribuan baris.
- Bandingkan hasil export hari ini dengan kemarin dan kirim ringkasan perubahan, bukan hanya file.

## Catatan ambiguitas

- Filter `status` hanya menerima satu nilai; tidak ada dukungan daftar dipisah koma. Menggabungkan `low` dan `out` berarti dua request.
- Perilaku `limit`/`page` pada respons CSV tidak dirinci di ringkasan kontrak. Implementasi memakai hasil filter dan pagination yang sama seperti JSON, jadi `limit` default 10 tetap berlaku. Uji dengan `?limit=5`: jumlah baris data harus 5, sementara `X-Total-Count` tetap total hasil filter. Jika tidak demikian, dokumentasikan perilaku sebenarnya.
- `X-Total-Count` adalah total setelah filter, bukan jumlah baris yang dikirim. Bandingkan dengan `meta.total` dari request JSON yang identik; jika berbeda, hentikan export.
- Data seed tidak memuat koma, tanda kutip, atau karakter non-ASCII pada nilai stok, sehingga fixture sementara diperlukan untuk membuktikan escaping dan UTF-8.
- Apakah `sort` memengaruhi isi CSV juga tidak dijelaskan; jika dipakai, dokumentasikan hasilnya.
