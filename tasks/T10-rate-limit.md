# T10 — Rate Limit Governance

**Level:** Hard · **Estimasi:** ~120 menit · **Peran:** Integration Analyst / Platform Owner · **Prasyarat:** T1–T6 (auth, error contract, pagination, bulk write, idempotency); T7–T9 disarankan

## 1. Konteks bisnis

Setiap malam pukul 01.00, job sinkronisasi menarik seluruh stok dan plan dari Supplier API, lalu mengirim koreksi harga dan status dalam beberapa batch. Sejak volume part bertambah, job ini mulai menerima 429. Tim merespons dengan "coba lagi sampai berhasil": jeda tetap 5 detik, tanpa batas percobaan, dan tanpa memperhatikan header.

Akibatnya muncul dua masalah sekaligus. Retry yang menumpuk memperpanjang periode 429, sehingga job pagi juga ikut gagal. Dan karena sebagian write diulang tanpa kunci idempotensi, beberapa stok tercatat dua kali atau quantity terkirim ganda. Insiden terakhir baru ketahuan ketika tim gudang membandingkan angka dengan dashboard.

Kamu diminta mengambil alih masalah ini sebagai **platform owner**: ukur kuota yang benar-benar tersedia, rancang client yang sadar anggaran, buktikan perilaku saat 429, dan usulkan kebijakan kuota internal untuk tiga jenis pemakai — dashboard, nightly sync, dan analis ad-hoc — yang semuanya memakai kunci API yang sama.

"Governance" di sini bukan menaikkan limit. Ini tentang membagi kuota yang terbatas, membuat kegagalan dapat diprediksi, dan memastikan retry tidak pernah mengubah data dua kali. Solusi yang hanya menambah `sleep` tidak akan dinilai sebagai solusi.

## 2. Tujuan pembelajaran

Setelah tugas ini, kamu mampu:

- Membaca `X-RateLimit-Limit`, `X-RateLimit-Remaining`, dan `X-RateLimit-Reset` serta menafsirkannya tanpa menebak.
- Membedakan error yang boleh diulang dari error yang fatal, termasuk membedakan 429, 409, dan 401/403.
- Merancang anggaran request per job yang mempertimbangkan pagination, bulk, dan biaya operasi lain.
- Menerapkan `Retry-After` dengan exponential backoff dan jitter tanpa menimbulkan retry storm.
- Memakai `Idempotency-Key` sehingga retry tidak menghasilkan write ganda.
- Menyusun kebijakan kuota, ambang alert, dan kepemilikan yang dapat dijalankan tim operasi.
- Menjelaskan kepada pemilik produk mengapa penambahan worker justru dapat memperburuk outage.
- Menyeimbangkan kebutuhan dashboard interaktif dengan job batch yang panjang dalam satu kuota bersama.

## 3. Yang harus kamu putuskan sendiri

1. **Anggaran per job.** Berapa request per menit untuk nightly sync, dashboard, dan analis? Tunjukkan aritmetika terhadap batas 600/menit dan sisakan headroom untuk interaksi manusia.
2. **Satuan kerja.** Apakah kamu mengirim satu request per record, per halaman, atau per bulk? Berapa ukuran halaman dan berapa item per bulk? Masukkan juga biaya operasi lain seperti registrasi webhook, test delivery, dan rekonsiliasi ke dalam anggaran.
3. **Kepemilikan kunci.** Kontrak hanya menyediakan satu kunci demo. Bagaimana kamu menegakkan kuota virtual per job tanpa kunci terpisah, dan apa risikonya jika disiplin itu gagal?
4. **Model pacing.** Fixed interval, token bucket, atau concurrency cap? Jelaskan mengapa pilihanmu tetap aman ketika latensi server berubah.
5. **Klasifikasi error.** Buat matriks status → tindakan: retry, retry dengan kunci sama, berhenti, atau eskalasi. Tempatkan 400, 401, 403, 404, 409, dan 5xx secara eksplisit.
6. **Kebijakan backoff.** Berapa base delay, faktor, cap, dan jumlah attempt? Kapan `Retry-After` mengalahkan rumus backoff, dan apa yang terjadi jika nilainya lebih besar dari sisa waktu job?
7. **Idempotensi.** Dari apa kunci diturunkan (job, entity, versi, hash body)? Berapa lama berlaku, dan bagaimana mencegah kunci sama dipakai untuk body berbeda?
8. **Perilaku saat kuota habis.** Apakah job menunggu, menurunkan prioritas, atau berhenti dan dilanjutkan besok? Siapa yang diberi tahu?
9. **Ambang alert.** Pada `Remaining` berapa alert dikirim, dan apakah `Reset` dipakai untuk menghitung waktu tunggu? Bagaimana mengatasi clock skew antar mesin?
10. **Eksperimen burst.** Kapan dan berapa lama burst dilakukan agar tidak merusak demo tim lain? Berapa request yang cukup untuk membuktikan 429 secara sah?
11. **Anggaran waktu job.** Jika job harus selesai sebelum pukul 05.00, pada titik mana kamu berhenti retry dan menyatakan partial success? Bagaimana hasil parsial dilaporkan?
12. **Bukti.** Format timeline seperti apa yang membuat orang lain bisa memverifikasi klaimmu tanpa menjalankan ulang semuanya?

## 4. Peta kapabilitas API — pilih sendiri

| Kapabilitas | Endpoint / mekanisme | Nilai untuk tugas ini | Status |
|---|---|---|---|
| Melihat kuota berjalan | `GET /api/v1/_ratelimit` | State window untuk kunci yang dipakai | Wajib |
| Membaca sisa kuota | Header `X-RateLimit-*` pada setiap response `/api/v1` | Umpan balik per request, bukan tebakan | Wajib |
| Menunggu setelah 429 | Header `Retry-After` | Lama tunggu yang ditentukan server | Wajib |
| Write aman diulang | `Idempotency-Key` + `Idempotency-Replayed` | Mencegah duplikat saat retry | Wajib |
| Mengurangi jumlah write | Endpoint bulk (`?mode=partial` → 207) | Satu request untuk banyak item | Kandidat |
| Mengurangi jumlah read | `limit=50` dan pagination | Sedikit request per halaman | Kandidat |
| Sinkronisasi inkremental | `updated_since` pada stock dan plan | Menghindari tarik ulang seluruh dataset | Kandidat |
| Laporan sekali jalan | `Accept: text/csv` pada global stock | Satu request untuk ekspor, bukan untuk sync | Situasional |
| 429 terkendali | `?simulate=ratelimit` | Latihan penanganan; 429 + `Retry-After: 5`, **tidak** menguras kuota nyata | Latihan |
| Riwayat pengiriman | `GET /api/v1/webhooks/deliveries` | Melihat status pengiriman event, bukan sisa kuota | Decoy |
| Cek liveness | `GET /health` | Bebas kuota, tetapi tidak menunjukkan sisa | Decoy |
| Ambil token | `POST /auth/token` | Bebas kuota; tidak mereset limit | Decoy |
| Cache response | `ETag` + `If-None-Match` → 304 | Menghemat bandwidth; status 304 tetap request | Decoy jika dianggap gratis |
| Memantau lewat dashboard | UI `/` | Memakai kunci dan kuota yang sama | Decoy sebagai alat ukur |
| Filter status stok | `GET /api/v1/stock?status=low` | Filter bisnis, tidak mengurangi biaya request | Decoy |

Tidak ada endpoint untuk menaikkan limit, membuat kunci baru, atau melihat pemakaian historis. Semua angka harus kamu kumpulkan sendiri dari header dan `_ratelimit`.

## 5. Alur kerja yang diharapkan

1. **Ukur baseline.** Kirim beberapa request baca dan catat status, `Remaining`, `Reset`, dan waktu lokal. Bandingkan dengan response `_ratelimit`. Jangan mengandalkan satu sampel.
2. **Inventarisasi pemakai.** Daftar job yang memakai kunci yang sama: dashboard, nightly sync, analis, dan mungkin webhook registration. Perkirakan request per menit masing-masing pada kondisi normal dan puncak.
3. **Hitung anggaran.** Tentukan porsi untuk tiap job, headroom, dan ukuran batch. Tunjukkan skenario terburuk ketika semua job berjalan bersamaan.
4. **Rancang client.** Definisikan antrean, pacing, batas concurrency, klasifikasi error, dan strategi kunci idempotensi sebelum menulis kode.
5. **Uji matriks kegagalan.** Paksa 401, 403, 404, 409, 429, 500, dan timeout. Tunjukkan mana yang diulang, mana yang langsung dihentikan, dan apa yang dicatat.
6. **Uji idempotensi.** Kirim write yang sama dua kali dengan kunci sama; lalu kirim kunci sama dengan body berbeda. Tunjukkan replay dan 409 `IDEMPOTENCY_KEY_REUSED` ditangani berbeda.
7. **Lakukan burst yang sah.** Baca `Remaining` dan `Reset`, lalu kirim request secukupnya hingga melewati batas sebelum window berakhir. Amati `Remaining` menurun, 429 pertama, nilai `Retry-After`, lalu pemulihan setelah menunggu. Jika window keburu reset, ulangi perhitungan; jangan menyimpulkan 429 dari burst yang terpotong window.
8. **Buktikan tidak ada duplikat.** Setelah retry sukses, bandingkan jumlah record atau quantity dengan sebelum job. Tunjukkan angka yang sama, bukan sekadar status 200.
9. **Evaluasi anggaran.** Bandingkan waktu yang direncanakan dengan waktu aktual, jumlah request per job, dan sisa headroom. Jika burst membuat `Remaining` mendekati nol, jelaskan langkah mitigasinya.
10. **Susun kebijakan.** Tetapkan kuota per job, ambang alert, jalur eskalasi, dan aturan siapa boleh melakukan burst.
11. **Tulis laporan.** Sertakan timeline yang bisa diaudit, keputusan yang diambil, dan hal yang sengaja tidak dilakukan.

## 6. Deliverable

| File | Isi wajib | Bukti minimum |
|---|---|---|
| `rate-limit-report.md` | Tabel timeline: nomor request, waktu, endpoint, status, `Remaining`, `Reset`, `Retry-After`, tindakan client; grafik atau ringkasan penurunan kuota; analisis window | Memuat 429 nyata dan pemulihan; angka konsisten dengan header |
| `client.js` | Node stdlib; anggaran per job; pacing; backoff + jitter; menghormati `Retry-After`; `Idempotency-Key` stabil; klasifikasi error; log terstruktur | Dapat dijalankan dengan mode `--dry-run` dan mode burst; tidak menulis saat dry-run |
| `quota-policy.md` | Kuota dashboard/sync/analis, headroom, prioritas, ambang alert, pemilik, prosedur saat kuota habis, aturan burst | Angka dapat diturunkan dari 600/menit; ada penanggung jawab dan jalur eskalasi |
| `evidence-429.md` | Trace 429 pertama, `Retry-After`, waktu tunggu aktual, request setelah pulih, dan bukti tidak ada duplikat | Bisa dicocokkan dengan `rate-limit-report.md` dan data API |

Bukti dinilai dari konsistensi antar-file. Nomor request di laporan harus sama dengan trace, keputusan di `quota-policy.md` harus tercermin di `client.js`, dan klaim "tidak ada duplikat" harus disertai cara menghitungnya. Screenshot tanpa angka tidak cukup.

## 7. Kriteria penilaian

| Komponen | Bobot | Yang dinilai |
|---|---:|---|
| Pengukuran dan bukti | 25 | Ketepatan membaca header, `_ratelimit`, timeline, dan pembuktian 429 nyata |
| Kebijakan backoff | 25 | Klasifikasi error, `Retry-After`, exponential + jitter, batas attempt, perilaku saat waktu job habis |
| Keamanan retry dan idempotency | 25 | Kunci stabil, replay dipahami, 409 tidak diulang, tidak ada write ganda |
| Kebijakan kuota | 25 | Anggaran per job realistis, headroom, alert, kepemilikan, prioritas, aturan burst |
| **Total** | **100** | |

## 8. Jebakan & kesalahan umum

- **Retry semua error.** 401, 403, 404, dan 409 tidak akan berubah karena diulang; yang terjadi hanyalah memperpanjang outage dan menyembunyikan masalah.
- **Mengabaikan `Retry-After`.** Jeda tetap 5 detik bisa lebih cepat dari yang diminta server, sehingga 429 berlanjut dan job kehabisan waktu.
- **Backoff tanpa jitter.** Semua worker bangun pada saat yang sama dan menciptakan gelombang 429 baru.
- **Kunci idempotensi baru di setiap attempt.** Retry dianggap write baru; inilah akar duplikasi stok.
- **Kunci sama untuk body berbeda.** Server membalas 409 `IDEMPOTENCY_KEY_REUSED`. Jangan menganggapnya 429 atau mengulang; perbaiki kunci.
- **Menghitung kuota secara lokal.** Angka `Remaining` adalah sumber kebenaran, bukan counter internal yang tidak tahu request dari dashboard.
- **Setiap worker merasa punya 600.** Limit berlaku per kunci, bukan per proses. Sepuluh worker dengan 60 request masing-masing tetap bisa melewati batas jika tidak dikoordinasikan.
- **Menganggap 304 dan `/health` gratis.** Anggap 304 tetap request sampai terbukti sebaliknya; `/health` memang exempt, tetapi tidak membantu job menulis.
- **Mengulang seluruh bulk setelah 207.** 207 berarti sebagian berhasil; mengulang semua item berisiko menduplikasi yang sudah sukses. Gunakan `details[].index`.
- **Menggunakan `?simulate=ratelimit` sebagai bukti kuota.** Itu 429 satu kali, bukan cerminan pemakaian window.
- **Burst tanpa koordinasi.** Kuota dipakai bersama tim dan dashboard; burst yang tidak dijadwalkan bisa merusak demo orang lain.
- **Menganggap restart server sebagai strategi pemulihan.** Pada sandbox limiter berjalan di memori; restart mereset kuota, tetapi juga menghapus state lain dan tidak bisa diandalkan di produksi.
- **Tidak punya batas waktu.** Backoff tanpa deadline membuat job menggantung sampai pagi dan menutupi kegagalan yang seharusnya dilaporkan.

## 9. Verifikasi mandiri

Jalankan server, lalu siapkan token. **Peringatan:** `bash scripts/smoke-test.sh` mengubah data dan ikut memakai kuota. Jangan jalankan saat demo berlangsung. Burst juga memakai kuota bersama; jadwalkan dengan trainer.

```bash
node server/server.js
export BASE=http://localhost:4010
export KEY=sup_demo_key_2026
export TOKEN=$(curl -s -X POST "$BASE/auth/token" \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).access_token')
```

1. **Header.** `curl -i -H "X-API-Key: $KEY" "$BASE/api/v1/suppliers?limit=1"` harus memuat ketiga header `X-RateLimit-*`. Catat nilai `Reset` dan bandingkan dengan jam mesin.
2. **State kuota.** Panggil `GET /api/v1/_ratelimit`, lalu bandingkan dengan header request berikutnya. Jelaskan field yang kamu pakai; jangan mengandalkan nama field yang tidak ada di kontrak.
3. **429 terkendali.** Panggil `?simulate=ratelimit`, catat `Retry-After`, dan tunjukkan client menunggu sesuai nilai itu, bukan nilai hardcoded.
4. **Idempotensi.** Kirim write yang sama dua kali dengan kunci sama; response kedua harus memuat `Idempotency-Replayed: true`. Lalu ubah body dengan kunci yang sama dan pastikan 409, bukan retry.
5. **Matriks error.** Uji 401 (tanpa token), 403 (`readonly-token`), 404 (id tidak ada), dan 500 (`?simulate=error500`). Tunjukkan mana yang fatal.
6. **Burst nyata.** Baca `Remaining`, kirim request hingga melewati batas dengan jeda kecil, dan rekam 429 pertama. Tunggu sesuai `Retry-After`, lalu tunjukkan request berikutnya sukses dan `Remaining` pulih.
7. **Tanpa duplikat.** Sebelum dan sesudah job retry, hitung record atau quantity untuk entity yang diuji. Angka harus sama; lampirkan command penghitungnya.
8. **Dry-run.** Jalankan `node client.js --dry-run` dan tunjukkan tidak ada request tulis yang dikirim, tetapi anggaran dan rencana retry tercetak.

## 10. Ekstensi opsional

- Buat simulator token bucket sederhana (spreadsheet atau skrip) dan bandingkan hasilnya dengan header nyata.
- Tambahkan adaptive concurrency: turunkan paralelisme ketika `Remaining` menipis, naikkan perlahan setelah pulih.
- Rancang antrean prioritas: dashboard manusia di atas nightly sync, dengan bukti bahwa antrean tidak kelaparan.
- Buat dashboard pemantauan kuota yang membaca header dan `_ratelimit`, bukan menebak dari log.
- Usulkan desain kunci API per job (tanpa mengubah kontrak saat ini) dan jelaskan migrasinya.
- Hitung biaya per job dalam request dan waktu, lalu usulkan jadwal yang menghindari tabrakan.
- Uji skenario 5xx berkepanjangan dan tunjukkan circuit breaker sederhana.
- Gabungkan dengan T9: pindahkan perubahan inkremental ke webhook, sisakan pull rekonsiliasi harian, lalu hitung penghematan kuotanya.
- Simulasikan kegagalan jam: ubah waktu sistem client dan tunjukkan kebijakan `Reset` tetap aman.

## Catatan

- Batas default 600 request/menit per kunci. Nilai aktual ada di header `X-RateLimit-Limit` dan `GET /api/v1/_ratelimit`; jangan hardcode 600 tanpa membandingkannya dengan header.
- `GET /api/v1/_ratelimit` mengembalikan `{ data: { limit, window_ms, window_started_at, used, remaining, reset_at } }`. Bandingkan `remaining` dengan header request berikutnya.
- Yang dihitung: setiap request yang mencapai route `/api/v1` dengan API key valid, termasuk 304, 404 resource, 406, 429, dan `/_ratelimit`. Empat jalur exempt: `/health`, `/auth/token`, `/openapi.json`, `/docs`. Request tanpa API key (401) dan request yang tidak cocok dengan route (404 path / 405) tidak dihitung — jangan memakai path palsu untuk mengukur kuota.
- Pada respons 429, `X-RateLimit-Remaining` bisa 0 atau negatif karena 429 tetap memakai kuota. Gunakan `Retry-After` dan `Reset` untuk pemulihan, bukan `Remaining` saja.
- Hanya tersedia satu kunci demo. Kuota per job harus ditegakkan secara internal; tidak ada endpoint provisioning kunci.
- `Retry-After` dalam detik dan `X-RateLimit-Reset` dalam epoch detik. Waspadai clock skew antara mesin client dan server.
- Jenis window (fixed atau sliding) tidak dirinci. Gunakan `Reset` sebagai panduan, waspadai pembulatan, dan jangan mengasumsikan kuota langsung penuh tepat setelah `Reset`.
- Idempotency disimpan di memori selama 24 jam. Restart server menghapusnya, jadi replay setelah restart tidak dijamin dan tidak boleh dijadikan strategi.
- 409 dengan kode `IDEMPOTENCY_KEY_REUSED` berbeda dari 429 `RATE_LIMITED`: yang pertama fatal dan menandakan kunci salah pakai, bukan kuota habis.
- Bulk `?mode=partial` membalas 207; satu request tetap satu unit kuota, tetapi kegagalan per item harus ditangani terpisah dari rate limit.
- Dashboard memakai kunci yang sama. Pemakaian dashboard, termasuk refresh otomatis, mengurangi kuota job dan harus masuk anggaran.
