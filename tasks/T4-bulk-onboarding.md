# T4 — Onboarding Supplier Baru: 24 SKU, 3 Data Rusak

**Level:** Hard · **Estimasi:** 120 menit · **Peran:** Integration Analyst (tim integrasi procurement) · **Prasyarat:** T1–T3 (auth, status code, filter/pagination) atau setara; nyaman mengirim request dengan curl/Postman dan membaca JSON

## 1. Konteks bisnis

PT Sinar Presisi (Bandung) resmi menjadi supplier komponen presisi. Kontrak pengadaan menyebut **24 SKU aktif** dan gudang harus sudah bisa melihat stok mereka di dashboard internal **Senin 08.00**; cutover ERP menyusul hari Selasa. Vendor tidak punya API — tim mereka mengekspor data dari sistem lama ke spreadsheet, dan file itu satu-satunya sumber yang tersedia.

Email vendor berbunyi: *"Terlampir export 24 baris. Kami sudah cek, hanya 3 baris yang bermasalah. Sisanya bersih."* Tim procurement baru mengirimkan **15 baris pertama** (Lampiran A). Sembilan baris sisanya masih menunggu konfirmasi gudang dan belum bisa diproses minggu ini.

Kenyataan operasional yang membentuk keputusanmu:

- Dashboard dan sync ERP membaca API yang sama. Baris ganda akan muncul dua kali di laporan stok gudang.
- Sync dijalankan ulang setiap vendor mengirim file (mingguan) — ini bukan operasi sekali pakai.
- Tim support terbiasa "kalau gagal, jalankan ulang" tanpa membaca status. Insiden terakhir: satu batch dijalankan tiga kali, `last_updated` seluruh baris berubah, dan laporan "stok terbaru" jadi menyesatkan.
- Vendor akan mengirim file yang sama persis minggu depan, termasuk baris yang hari ini rusak.
- API key demo ada di dokumen; token ditukar lewat `POST /auth/token`. Tidak ada dependencies tambahan — semua bukti dikumpulkan dengan curl/Postman.

**Catatan (batas latihan).** Judul menyebut 24 SKU karena itu isi kontrak; lampiran hanya memuat 15 baris. Selisih 9 baris bukan tugas yang boleh diabaikan diam-diam: nyatakan sebagai *coverage gap* di deliverable, jangan mengarang data. Nilai di Lampiran A disalin apa adanya dari file vendor, termasuk tipe sel dan sel kosong.

### Lampiran A — cuplikan export vendor (15 baris)

| No | part_number | part_name | qty | uom | location | status | unit_price | currency |
|---|---|---|---|---|---|---|---|---|
| 1 | SPR-BRG-6204 | Bearing 6204 ZZ | 240 | PCS | WH-BDG-01 | available | 38500 | IDR |
| 2 | SPR-BRG-6205 | Bearing 6205 ZZ | 180 | PCS | WH-BDG-01 | available | 42000 | IDR |
| 3 | SPR-SEA-2535 | Oil Seal 25x35x7 | 96 | PCS | WH-BDG-02 | available | 15000 | IDR |
| 4 | SPR-BLT-A42 | V-Belt A-42 | 40 | PCS | WH-BDG-02 | low | 54000 | IDR |
| 5 | SPR-CHN-06B | Roller Chain 06B-1 | 25 | PCS | WH-BDG-03 | low | 176000 | IDR |
| 6 | SPR-GSK-KIT | Gasket Set Pompa | 60 | UNIT | WH-BDG-03 | available | 98000 | IDR |
| 7 | SPR-FLT-OIL | Filter Oli Hidrolik | 12 | BOX | WH-BDG-03 | low | 132000 | IDR |
| 8 | SPR-NUT-M12 | Hex Nut M12 | 800 | PCS | WH-BDG-04 | available | 2500 | IDR |
| 9 | SPR-WSH-M12 | Washer M12 | 750 | PCS | WH-BDG-04 | available | 1200 | IDR |
| 10 | SPR-PIN-08 | Pin Dowel 8mm | 0 | PCS | WH-BDG-04 | out | 4500 | IDR |
| 11 |  | Bushing Bronze 20mm | 34 | PCS | WH-BDG-05 | available | 67000 | IDR |
| 12 | SPR-SPR-C25 | Compression Spring 25mm | 150 | PCS | WH-BDG-05 | available | 8900 | IDR |
| 13 | SPR-CPL-10 | Coupling 10mm | 18 | SET | WH-BDG-06 | low | 210000 | IDR |
| 14 | SPR-HSE-32 | Hose Hydraulic 3/8" | "120" | METER | WH-BDG-06 | available | 41000 | IDR |
| 15 | SPR-VLV-12 | Ball Valve 1/2" | 22 | PCS | WH-BDG-06 | available | 156000 | IDR |

**Catatan (kontrak vs implementasi).** Kontrak menyebut `stock_quantity` bilangan bulat. Sebagian validator menerima string numerik lalu mengubahnya sendiri. Jangan menyimpulkan "pasti ditolak" atau "pasti diterima": kirim, baca respons, catat. Yang dinilai adalah keputusanmu berdasarkan bukti, bukan tebakan.

## 2. Tujuan pembelajaran

- Memilih endpoint tulis berdasarkan semantik (create vs upsert vs replace vs patch), bukan kebiasaan.
- Menjalankan bulk dengan `?mode=partial`, lalu memetakan `errors[].index` ke baris sumber secara akurat.
- Membedakan "data rusak di sumber" dari "payload tidak sesuai kontrak", dan memutuskan siapa yang memperbaiki.
- Merancang retry yang aman dengan `Idempotency-Key` dan membuktikan tidak ada eksekusi ganda.
- Menutup onboarding dengan verifikasi berbasis hitungan sebelum/sesudah, bukan asumsi "sudah 201 berarti beres".
- Mendokumentasikan keputusan sehingga orang lain bisa mengulang proses yang sama tanpa bertanya.

## 3. Yang harus kamu putuskan sendiri

1. **Identitas supplier.** `supplier_id` dibuat sendiri atau mengikuti konvensi procurement? Format apa yang dipakai, dan bagaimana kamu mencegah tabrakan dengan supplier lain?
2. **Strategi tulis.** Satu batch 15 item, 15 request satuan, atau beberapa batch kecil? Apa yang terjadi pada tiap pilihan jika dijalankan dua kali?
3. **Mode percobaan pertama.** `?mode=partial` atau strict (default)? Mana yang menghasilkan bukti lebih baik, dan apa risiko partial jika ternyata separuh data masuk?
4. **Tiga baris bermasalah.** Diperbaiki di file sumber, di payload, atau dikembalikan ke vendor? Siapa pemilik kebenaran data, dan apakah baris yang lolos validasi otomatis dianggap benar?
5. **Lokasi `Idempotency-Key`.** Per batch atau per baris? Berapa lama kunci berlaku? Apa yang kamu lakukan bila body berubah tetapi kunci sama?
6. **Coverage 15/24 dan kriteria selesai.** Tunda go-live, onboarding sebagian, atau blokir? Metrik apa yang membuktikan onboarding selesai — jumlah baris, `meta.total`, atau spot check per part? Mengapa?

## 4. Peta kapabilitas API — pilih sendiri

| Kebutuhan | Kandidat endpoint (termasuk decoy) | Kenapa perlu dicek |
|---|---|---|
| Daftarkan supplier | `POST /api/v1/suppliers` · `PUT /api/v1/suppliers/bulk` (decoy) | Status sukses, konflik bila dijalankan ulang, apakah bulk dapat membuat supplier baru |
| Cek supplier sudah ada | `GET /api/v1/suppliers?q=` · `GET /api/v1/suppliers/{id}` | Filter `q` mencari nama/ID? 404 vs 200 membedakan "belum ada" dari "salah ketik" |
| Cek isi stok saat ini | `GET /api/v1/suppliers/{id}/stock?limit=50` · `GET /api/v1/stock?supplier_id=` | Default `limit=10` menipu; `meta.total` vs `data.length` |
| Kirim 15 baris sekaligus | `POST /api/v1/suppliers/{id}/stock/bulk` · `PUT`/`PATCH .../stock/bulk` (decoy) | Hanya POST yang upsert; PUT/PATCH tidak pernah membuat baris baru |
| Kirim satu per satu | `POST /api/v1/suppliers/{id}/stock` (decoy) | 409 bila part sudah ada; tidak atomik, mahal untuk 15 baris |
| Ambil baris yang gagal | `GET /api/v1/suppliers/{id}/stock/{partNumber}` | 404 untuk baris yang tidak masuk; bukti partial failure |
| Ulangi dengan aman | `POST .../stock/bulk` + header `Idempotency-Key` | Replay vs 409 `IDEMPOTENCY_KEY_REUSED` |
| Ambil token | `POST /auth/token` | 401 (tanpa key/token) vs 403 (readonly) sebelum menyalahkan endpoint |

## 5. Alur kerja yang diharapkan

**Fase 0 — Recon (10 menit).** Buka `/docs` dan `/openapi.json`. Baca Lampiran A. Buat *row map*: nomor baris sumber → indeks item (ingat: array JSON mulai dari 0). Evidence: potongan `meta.total` supplier sebelum onboarding + row map di onboarding-log.

**Fase 1 — Pastikan belum ada (5 menit).** Cek supplier dengan `GET` (filter atau by ID). Putuskan: create, atau sudah ada dan harus di-`PATCH`. Evidence: status code + body singkat.

**Fase 2 — Create supplier (10 menit).** Kirim `POST /api/v1/suppliers` dengan field wajib yang kamu pilih. Bila 409, jangan langsung ganti ID — tentukan apakah itu re-run atau tabrakan nyata. Evidence: status, `Location`, dan keputusan.

**Fase 3 — Susun `batch.json` (20 menit).** 15 item sesuai kontrak stok. Mapping kolom spreadsheet → field API, normalisasi yang kamu anggap perlu, dan catat setiap perubahan beserta alasannya. Evidence: file JSON valid + tabel mapping (kolom → field → transformasi).

**Fase 4 — Kirim partial (15 menit).** Kirim dengan `?mode=partial` dan `Idempotency-Key` pertama. Simpan respons mentah. Bila 207, baca `summary` dan `errors[]`, bukan hanya `message`. Evidence: respons utuh, daftar indeks gagal.

**Fase 5 — Perbaiki & kirim ulang (20 menit).** Untuk setiap indeks gagal: perbaiki di payload, lalu kirim ulang **hanya** yang gagal (atau seluruh batch — keputusanmu, dengan konsekuensi yang kamu jelaskan). Evidence: respons kedua + daftar baris yang berubah.

**Fase 6 — Verifikasi (15 menit).** Hitung total, bandingkan dengan 15 baris lampiran dan 24 SKU kontrak. Spot check minimal 3 part (termasuk yang diperbaiki). Evidence: tabel before/after + status per part.

**Fase 7 — Eksperimen idempotency (15 menit).** (a) Kirim ulang body identik dengan kunci yang sama → catat status dan header replay. (b) Kirim body berbeda dengan kunci yang sama → catat status. (c) Ulangi skenario gagal (mis. `?simulate=ratelimit` atau timeout klien) lalu retry dengan kunci yang sama; buktikan jumlah baris tidak bertambah. Evidence: dua request + dua respons, plus hitungan sebelum/sesudah.

**Fase 8 — Dokumentasi (10 menit).** Rangkum timeline, keputusan, dan risiko sisa (termasuk 9 baris belum diproses) dalam bahasa yang bisa dibaca manajer non-teknis.

## 6. Deliverable

| File | Isi | Format |
|---|---|---|
| `onboarding-log.md` | Timeline kronologis: waktu, aksi, endpoint, status code, keputusan + alasan. Sertakan row map sumber→indeks, pilihan strategi tulis, dan penanganan 409. | Markdown, tabel + paragraf singkat |
| `batch.json` | Payload final yang benar-benar dikirim (`items[]`, 15 item) beserta field yang sudah dinormalisasi. Tidak boleh berisi komentar atau kunci bantu yang tidak dikenal API. | JSON valid |
| `verification.md` | Tabel before/after: total baris, sebaran `stock_status`/`uom`, 15 baris lampiran vs tersimpan, 24 SKU kontrak vs coverage, dan hasil spot check per part. | Markdown, minimal 2 tabel |
| `idempotency-evidence.md` | Pasangan request/response: (1) dua request identik + header replay, (2) body berbeda + status konflik, (3) retry setelah kegagalan + hitungan baris sebelum/sesudah. | Markdown dengan blok `http` |

Kumpulkan keempat file di `submission/T4/` (lihat `tasks/README.md` §6).

## 7. Kriteria penilaian

| Komponen | Bobot | Yang dinilai |
|---|---|---|
| Penanganan partial failure | 30 | Memilih mode dengan alasan; membaca `summary`/`errors[].index`; memetakan indeks ke baris sumber dengan benar; tidak mengklaim sukses saat ada item gagal |
| Idempotency & retry safety | 25 | Kunci dipakai konsisten; replay dibuktikan dengan header; konflik body berbeda dikenali; tidak ada eksekusi ganda; keputusan retry dijelaskan |
| Perbaikan data | 25 | Tiga baris bermasalah ditangani tepat; normalisasi tidak mengarang nilai; keputusan "perbaiki di mana" dijustifikasi; tipe data akhir sesuai kontrak |
| Dokumentasi | 20 | Timeline dapat diulang orang lain; bukti (status, body, header) terlampir; gap 9 baris dan risiko sisa dinyatakan; bahasa jelas untuk non-teknis |
| **Total** | **100** | |

## 8. Jebakan & kesalahan umum

- **Offset indeks.** `errors[].index` berbasis 0, sedangkan nomor baris spreadsheet berbasis 1. Salah offset membuat kamu "memperbaiki" baris yang sebenarnya sudah masuk.
- **Menganggap 207 = sukses.** 207 berarti sebagian gagal; tanpa membaca `summary.failed` dan `errors[]`, onboarding dianggap selesai padahal belum.
- **Memakai PUT/PATCH bulk untuk membuat baris baru.** Keduanya tidak pernah membuat record; hasilnya 404/207 "missing", bukan data masuk.
- **Mengirim ulang tanpa kunci setelah timeout.** Klien menyerah, server bisa tetap memproses. Tanpa `Idempotency-Key`, batch dieksekusi ulang dan `last_updated` semua baris berubah.
- **Mengasumsikan simulasi 429 terjadi setelah data ditulis.** Simulator dapat memotong request sebelum handler. Buktikan dengan GET sebelum/sesudah, jangan menyimpulkan dari status saja.
- **Menghitung total dari `data.length`.** Default `limit` adalah 10 dan maksimum 50; pakai `meta.total` dan paging bila perlu.
- **Lupa `Authorization: Bearer`.** API key benar tetapi tulis tetap 401; memakai `readonly-token` menghasilkan 403. Keduanya bukan bug server.
- **Mempercayai klaim vendor.** "Hanya 3 baris bermasalah" adalah klaim, bukan hasil verifikasi; jumlah yang ditolak server bisa berbeda dari jumlah yang kamu perbaiki. Rekonsiliasi selisihnya, jangan diamkan.
- **Menormalkan data diam-diam.** Mengubah `uom` atau mengisi `part_number` karangan tanpa mencatatnya menghilangkan jejak audit dan bisa menimpa part yang berbeda.
- **Melewatkan 9 baris kontrak.** Menyatakan "onboarding selesai 15 baris" tanpa menyebut sisa 9 adalah laporan yang menyesatkan.

## 9. Verifikasi mandiri

Jalankan server lebih dulu: `node server/server.js` (port 4010). Ganti `SUP-9XX` dengan ID supplier yang kamu buat.

```bash
BASE=http://localhost:4010
KEY='X-API-Key: sup_demo_key_2026'
TOKEN=$(curl -s -X POST "$BASE/auth/token" -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))')

# 1. Supplier benar-benar ada
curl -s -o /dev/null -w '%{http_code}\n' -H "$KEY" "$BASE/api/v1/suppliers/SUP-9XX"

# 2. Jumlah baris stok (pakai meta.total, bukan panjang array)
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-9XX/stock?limit=50" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.meta.total,j.data.length)})'

# 3. Spot check part yang diperbaiki (tipe field ikut diperiksa)
curl -s -H "$KEY" "$BASE/api/v1/suppliers/SUP-9XX/stock/SPR-GSK-KIT"

# 4. Kirim ulang batch identik dengan kunci yang sama: jumlah tidak boleh bertambah
curl -s -D - -o /dev/null -X POST "$BASE/api/v1/suppliers/SUP-9XX/stock/bulk?mode=partial" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: onboard-sinar-2026-01' --data @batch.json | grep -iE 'idempotency|HTTP/'

# 5. Kunci sama, body berbeda: harus konflik, bukan menimpa diam-diam
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/v1/suppliers/SUP-9XX/stock/bulk" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: onboard-sinar-2026-01' \
  -d '{"items":[{"part_number":"SPR-BRG-6204","part_name":"Bearing 6204 ZZ","stock_quantity":1,"uom":"PCS","stock_location":"WH-BDG-01","stock_status":"low"}]}'

# 6. Tanpa bearer / readonly: pastikan kamu bisa membedakan 401 dan 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/v1/suppliers/SUP-9XX/stock/bulk" \
  -H "$KEY" -H 'Content-Type: application/json' --data @batch.json
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/v1/suppliers/SUP-9XX/stock/bulk" \
  -H "$KEY" -H 'Authorization: Bearer readonly-token' -H 'Content-Type: application/json' --data @batch.json

# 7. Token masih berlaku untuk operasi tulis
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$BASE/api/v1/suppliers/SUP-9XX" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"api_status":"active"}'
```

> **Peringatan.** `bash scripts/smoke-test.sh` **mengubah data** (membuat `SUP-SMOKE-*`, stok `SMOKE-*`, dan satu production plan). Jangan menjalankannya di tengah latihan; restart server atau reset volume sebelum demo bersih. Tanpa `PERSIST_DATA=1`, restart mengembalikan data ke seed.

## 10. Ekstensi opsional

- **Harness Node stdlib.** Tulis `onboard.js` tanpa dependencies: baca CSV → validasi → chunk 5 item → kirim dengan retry/backoff dan `Idempotency-Key`, lalu tulis log JSON per attempt. Buktikan hasilnya sama dengan kerja manual.
- **Deteksi drift mingguan.** Bandingkan file vendor minggu depan dengan stok saat ini; hasilkan laporan "baru / berubah / hilang" tanpa menulis apa pun ke API.
- **Gerbang kualitas.** Usulkan checklist pra-kirim (tipe, enum, field wajib) dan pemilik tanda tangan sebelum batch dijalankan, lalu jelaskan bagaimana checklist itu mencegah insiden "sync tiga kali".
