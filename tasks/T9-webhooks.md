# T9 — Webhook Perubahan Stok

**Level:** Hard · **Estimasi:** ~150 menit · **Peran:** Integration Analyst · **Prasyarat:** T1–T6 (auth, error contract, filter/pagination, bulk write, idempotency); T7–T8 disarankan

## 1. Konteks bisnis

Tim perencanaan memakai sistem internal yang menarik data supplier setiap 5 menit:

```
GET /api/v1/stock?updated_since=<timestamp terakhir>
```

Cara ini punya tiga masalah yang sudah terasa di operasional. Perubahan stok yang naik lalu turun lagi dalam window 5 menit tidak pernah terlihat. Setiap polling tetap membebani API walaupun tidak ada perubahan. Dan ketika jadwal polling bertabrakan dengan nightly sync, tim melihat 429 yang tidak jelas asalnya.

Supplier setuju memakai **webhook**: sistem mereka mengirim HTTP POST ke URL milik kita saat stok atau production plan berubah. Pengiriman bersifat asynchronous dan at-least-once: satu event bisa tiba lebih dari sekali, dan urutan kedatangan bukan jaminan. Kamu adalah integration analyst yang diminta membuktikan bahwa mekanisme ini layak dipakai, sekaligus merancang sisi penerima yang aman dan tidak menghasilkan data ganda.

Yang harus disadari sejak awal: webhook adalah **notifikasi**, bukan database. Isi event bisa terlambat, hilang saat receiver mati, atau datang tidak berurutan. Keputusan tentang data apa yang tetap harus direkonsiliasi adalah bagian terpenting dari tugas ini.

Ukuran keberhasilan yang diminta manajer bukan "webhook menyala", melainkan: tidak ada perubahan stok yang terlewat dalam 24 jam pengamatan, tidak ada stok ganda akibat retry, dan tim operasi punya langkah jelas ketika receiver mati. Rancang bukti untuk ketiga hal itu sejak awal.

## 2. Tujuan pembelajaran

Setelah tugas ini, kamu mampu:

- Menjelaskan kapan polling lebih tepat dan kapan webhook lebih tepat, dengan angka latency, load, dan risiko missed update.
- Memilih event set dan cakupan subscriber berdasarkan kebutuhan bisnis, bukan berdasarkan daftar event yang tersedia.
- Memverifikasi signature HMAC-SHA256 atas raw body dan menolak delivery yang tidak sah.
- Membuat receiver yang idempoten terhadap retry dan tahan terhadap event yang datang tidak berurutan.
- Menunjukkan bukti retry dan failure logging tanpa mengubah data bisnis menjadi ganda.
- Menjelaskan trade-off latency, beban, dan kompleksitas operasional kepada audiens non-teknis dengan angka, bukan slogan.
- Menuliskan runbook rekonsiliasi dan prosedur operasi yang bisa dijalankan orang lain.

## 3. Yang harus kamu putuskan sendiri

1. **Event set.** Apakah kamu berlangganan kelima event, hanya `stock.*`, atau menambah `plan.created`/`plan.updated`? Jelaskan kebutuhan bisnis yang dilayani tiap event dan event mana yang sengaja tidak dipakai.
2. **Cakupan subscriber.** Satu subscription untuk semua event, atau beberapa subscription dengan URL dan tujuan berbeda? Ingat tidak ada filter per supplier atau per part pada subscription.
3. **Bentuk URL receiver.** Loopback, host internal, atau tunnel? Siapa yang boleh menjangkau URL itu, dan bagaimana URL itu diamankan (path acak, allowlist, TLS)?
4. **Kebijakan verifikasi.** Header berformat `t=<unix>,v1=<hex>`, dan yang ditandatangani adalah `<t>.<rawBody>`. Berapa toleransi timestamp terhadap replay? Bagaimana kamu membandingkan signature tanpa membocorkan waktu? Apa yang dilakukan jika header signature tidak ada atau formatnya salah?
5. **Semantik duplikat.** Apa kunci idempotensi di sisi receiver: `delivery_id`, pasangan event+entity, atau hash body? Berapa lama disimpan, dan apa yang terjadi setelah proses restart?
6. **Semantik urutan.** Untuk entity apa `occurred_at` dijadikan pembanding? Apakah event yang lebih tua boleh menimpa state yang lebih baru? Bagaimana menangani dua event dengan timestamp sama?
7. **Perilaku saat gagal.** Apakah receiver memproses synchronous lalu membalas 2xx, atau menerima lalu memasukkan ke antrean lokal? Apa yang terjadi jika proses gagal setelah 2xx terkirim?
8. **Rekonsiliasi.** Data apa yang tidak bisa dipercaya dari event (misalnya quantity, price, status, penghapusan, perubahan supplier) dan seberapa sering pull rekonsiliasi dilakukan?
9. **Retensi.** Berapa lama `delivery-log.md` dan log receiver disimpan, dan data pribadi apa yang tidak boleh masuk log?
10. **Rotasi secret.** Karena tidak ada endpoint rotasi, bagaimana prosedur penggantian secret tanpa kehilangan event?
11. **Ambang fallback.** Pada kondisi apa kamu berhenti mengandalkan webhook dan kembali ke polling? Nyatakan pemicunya (misalnya delivery gagal berturut-turut atau backlog melewati batas) dan siapa yang memutuskan.

## 4. Peta kapabilitas API — pilih sendiri

Tabel ini bukan daftar endpoint yang semuanya harus dipakai. Tandai pilihanmu, lalu jelaskan alasan menolak kandidat lain.

| Kapabilitas | Endpoint / mekanisme | Nilai untuk tugas ini | Status |
|---|---|---|---|
| Mendaftarkan subscriber | `POST /api/v1/webhooks/subscriptions` | Menyimpan URL, event, dan menghasilkan `secret` | Kandidat |
| Melihat subscription | `GET /api/v1/webhooks/subscriptions` | Audit cakupan dan mendeteksi subscription ganda | Kandidat |
| Menghapus subscription | `DELETE /api/v1/webhooks/subscriptions/:subscriptionId` | Mencegah pengiriman ke receiver yang sudah mati | Kandidat |
| Uji konektivitas | `POST /api/v1/webhooks/subscriptions/:subscriptionId/test` | Memastikan URL dapat dijangkau sebelum demo | Kandidat |
| Melacak pengiriman | `GET /api/v1/webhooks/deliveries` | Bukti attempt, status, dan error | Wajib |
| Rekonsiliasi inkremental | `GET /api/v1/stock?updated_since=` | Menutup gap setelah receiver mati | Wajib |
| Rekonsiliasi per supplier | `GET /api/v1/suppliers/:id/stock` | Membatasi volume saat backfill | Kandidat |
| Rekonsiliasi plan | `GET /api/v1/production-plans?updated_since=` | Backfill event plan yang terlewat | Kandidat |
| Memicu event untuk latihan | `POST/PATCH/DELETE` pada stock dan plan | Menghasilkan event nyata, bukan event palsu | Kandidat |
| Mengurangi jumlah request baca | `ETag` + `If-None-Match` | Hemat bandwidth, tetapi **tidak** menutup missed update | Decoy |
| Filter status stok | `GET /api/v1/stock?status=out` | Hanya melihat kondisi sekarang, bukan perubahan | Decoy |
| Menghasilkan 429 buatan | `?simulate=ratelimit` | Satu kali 429, tidak menguji alur webhook | Decoy |
| Cek kesehatan | `GET /health` | Liveness server, tidak memberi info event | Decoy |
| Melihat kuota | `GET /api/v1/_ratelimit` | Relevan untuk T10, bukan untuk verifikasi event | Decoy |
| Dokumentasi | `GET /docs`, `GET /openapi.json` | Referensi kontrak, bukan sumber kebenaran data | Referensi |

Catatan pemakaian: `webhook.test` hanya event uji dan tidak termasuk daftar event yang boleh didaftarkan. Tidak ada event `plan.deleted`, `supplier.updated`, atau `stock.low`. Jangan mengarang event dan jangan menganggap `data` memiliki field yang tidak dijamin kontrak.

## 5. Alur kerja yang diharapkan

1. **Ukur baseline.** Catat satu siklus polling 5 menit: berapa request, berapa baris berubah, dan perubahan apa yang terlewat jika dua perubahan terjadi di antara dua poll. Simpan angka ini untuk bagian diskusi.
2. **Rancang kontrak penerimaan.** Tentukan event set, arti setiap event bagi sistem internal, dan aksi yang dijalankan. Tulis pemetaan event → aksi sebelum menulis kode.
3. **Daftarkan subscription.** Simpan payload dan response persis apa adanya ke `subscription.json`; jangan menyalin secret ke dokumen yang dibagikan.
4. **Bangun receiver.** Server HTTP Node stdlib yang membaca **raw body**, memverifikasi signature, menolak yang salah, mencatat `delivery_id`, dan membalas 2xx dengan cepat.
5. **Uji jalur normal.** Kirim event test, lalu picu `stock.created`, `stock.updated`, dan `stock.deleted` melalui API. Tunjukkan event test tidak dianggap perubahan bisnis.
6. **Uji negatif.** Kirim body dengan signature salah, timestamp kedaluwarsa, dan header hilang. Receiver harus menolak dan tidak mengubah state.
7. **Uji duplikat dan urutan.** Kirim dua kali event dengan `delivery_id` sama; lalu kirim event lama setelah event baru untuk entity yang sama. Tunjukkan state akhir benar, bukan sekadar "request diterima".
8. **Uji kegagalan.** Buat receiver membalas 503 pada attempt pertama. Pengiriman dicoba maksimal 3 kali dengan jeda 1 detik lalu 2 detik; amati `attempts`, `response_status`, dan status akhir di `/webhooks/deliveries`.
9. **Rekonsiliasi.** Matikan receiver, lakukan beberapa perubahan, hidupkan lagi, lalu tutup gap dengan `updated_since`. Tunjukkan hasilnya sama dengan kondisi API.
10. **Tulis operasi.** Isi runbook dengan langkah nyata, bukan niat: siapa melakukan apa, command apa, dan bagaimana memverifikasi pemulihan.

## 6. Deliverable

| File | Isi wajib | Bukti minimum |
|---|---|---|
| `receiver.js` | Server stdlib; verifikasi HMAC raw body; tolak signature salah; dedupe berbasis `delivery_id`; urutan berbasis `occurred_at`; log JSON terstruktur; balas 2xx cepat | Bisa dijalankan dengan `node receiver.js`; tiga skenario negatif menghasilkan penolakan yang tercatat |
| `subscription.json` | Payload registrasi, response 201, dan daftar event yang dipilih beserta alasannya. Secret disamarkan | `subscription_id` dan `events` cocok dengan `GET /webhooks/subscriptions` |
| `delivery-log.md` | Timeline: waktu, event, `delivery_id`, attempt, status, response code, aksi receiver, keputusan; ringkasan baseline polling vs webhook | Minimal satu event sukses, satu retry, satu duplikat, satu event out-of-order |
| `security-notes.md` | Algoritma signature, konstruksi string yang ditandatangani, replay window, perbandingan constant-time, penyimpanan secret, rotasi, data yang tidak boleh masuk log | Alasan eksplisit untuk setiap pilihan, termasuk yang ditolak |
| `runbook.md` | Prosedur replay/backfill, verifikasi setelah insiden, eskalasi saat 429/5xx, cara menonaktifkan subscription yang bocor | Dapat diikuti orang lain tanpa bertanya; memuat command dan kriteria sukses |

## 7. Kriteria penilaian

| Komponen | Bobot | Yang dinilai |
|---|---:|---|
| Verifikasi signature | 25 | Raw body, HMAC benar, perbandingan aman, replay window, penolakan yang konsisten |
| Penanganan duplikat dan urutan | 20 | Idempotensi `delivery_id`, aturan `occurred_at`, bukti state akhir benar |
| Desain event dan rekonsiliasi | 25 | Event set beralasan, batas webhook dipahami, strategi pull dan backfill konkret |
| Bukti pengiriman dan retry | 15 | Timeline attempt, status, failure logging, pemulihan |
| Dokumentasi | 15 | Security notes dan runbook operasional, jelas, dapat dijalankan |
| **Total** | **100** | |

Penilaian bukan pada panjang kode. Receiver 120 baris yang menolak signature salah dan idempoten lebih bernilai daripada 400 baris yang selalu membalas 200.

## 8. Jebakan & kesalahan umum

- **Menandatangani ulang body.** `JSON.stringify(req.body)` setelah parsing menghasilkan byte berbeda dari raw body. Signature hanya valid atas byte asli.
- **Membandingkan signature dengan `===`.** Gunakan perbandingan constant-time dan tolak lebih awal jika header tidak lengkap.
- **Menerima semua event karena "ini sandbox".** Receiver yang tidak memverifikasi tidak membuktikan apa pun dan tidak layak dipakai di produksi.
- **Menganggap retry sebagai event baru.** Tanpa dedupe `delivery_id`, satu gangguan jaringan menjadi dua perubahan stok.
- **Mengurutkan berdasarkan waktu terima.** Event lama bisa tiba belakangan; tanpa pembanding `occurred_at` per entity, state bisa mundur.
- **Mempercayai isi event sebagai sumber kebenaran.** Event tidak memuat semua field dan bisa terlewat. Rekonsiliasi tetap wajib.
- **Kerja berat di handler.** Timeout pengiriman 3 detik; jika receiver baru membalas setelah proses selesai, sender menganggap gagal dan retry memperparah beban.
- **URL receiver tidak dapat dijangkau.** `localhost` di mesin mahasiswa tidak sama dengan `localhost` di dalam container. Uji dengan endpoint `/test` sebelum demo.
- **Membocorkan secret ke log atau screenshot.** Secret hanya untuk verifikasi; jangan menulis header signature lengkap atau body mentah ke tempat yang dibagikan.
- **Menganggap delivery log abadi.** Delivery disimpan di memori dan hilang saat restart; jangan menjadikannya satu-satunya audit trail.

## 9. Verifikasi mandiri

Jalankan server dari root repo, lalu siapkan token. **Peringatan:** `bash scripts/smoke-test.sh` mengubah data (membuat `SUP-SMOKE-*`, stock `SMOKE-*`, dan plan). Jangan jalankan di tengah demo tanpa restart server sesudahnya.

```bash
node server/server.js
export BASE=http://localhost:4010
export KEY=sup_demo_key_2026
export TOKEN=$(curl -s -X POST "$BASE/auth/token" \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).access_token')
```

**Receiver aman.** Jalankan receiver di loopback, port tidak umum, dan path acak. Jangan bind ke `0.0.0.0` di jaringan kampus. Contoh URL: `http://127.0.0.1:8787/hooks/9f3c-stock`. Jika server berjalan di container, gunakan alamat host yang memang dapat dijangkau dari container, bukan `127.0.0.1`.

Untuk uji negatif, duplikat, dan urutan, buat pengirim tiruan lokal yang menandatangani body dengan secret subscription. Jangan menambahkan endpoint injeksi ke server sandbox; yang diuji adalah receiver, bukan kemampuan menyuntik event.

1. **Registrasi dan uji jangkauan.** Daftarkan subscription, simpan response, lalu panggil endpoint test. Di `GET /webhooks/deliveries?subscription_id=...` harus terlihat event `webhook.test` dengan status yang jelas.
2. **Event nyata.** Picu satu update stock memakai `Idempotency-Key` agar tidak menggandakan write. Periksa timeline receiver dan delivery log.
3. **Signature negatif.** Kirim request tiruan ke receiver dengan signature salah, timestamp lama, dan tanpa header. Ketiganya harus ditolak; tidak ada perubahan state.
4. **Duplikat.** Kirim dua request dengan `delivery_id` sama. Log boleh mencatat dua kedatangan, tetapi aksi bisnis hanya sekali.
5. **Urutan.** Kirim event `stock.updated` dengan `occurred_at` lebih baru, lalu event yang lebih lama. State akhir harus mengikuti yang lebih baru.
6. **Retry.** Setel receiver gagal sekali (misalnya variabel lingkungan `FAIL_ONCE=1` yang kamu buat sendiri), picu event, lalu tunjukkan `attempts` bertambah dan status akhir `delivered`.
7. **Rekonsiliasi.** Matikan receiver, ubah stok, nyalakan lagi, lalu tarik `GET /api/v1/stock?updated_since=<waktu mati>`. Bandingkan dengan state internal.
8. **Batas memori.** Restart server dan tunjukkan delivery log kosong. Jelaskan konsekuensinya untuk audit dan replay.
9. **Header pengiriman.** Catat `X-Sandbox-Event`, `X-Sandbox-Delivery`, dan `X-Sandbox-Signature` yang diterima. Tunjukkan nilainya konsisten dengan body dan timestamp, lalu jelaskan header mana yang boleh dipercaya sebelum verifikasi.

## 10. Ekstensi opsional

- Tambahkan dead-letter queue berbasis file untuk event yang gagal permanen, lengkap dengan prosedur replay.
- Buat alat replay yang membaca log dan mengirim ulang event dengan `delivery_id` baru, serta menjelaskan mengapa itu bukan duplikat.
- Tambahkan metrik sederhana (jumlah diterima, ditolak, duplikat, retry) dan satu alert ketika tingkat penolakan melewati ambang.
- Rancang rotasi secret dua fase: secret lama dan baru berlaku bersamaan dalam jendela terbatas.
- Bandingkan biaya polling 5 menit vs webhook untuk 24 jam, dengan asumsi jumlah part dan jam operasional yang eksplisit.
- Uji receiver di balik reverse proxy yang menambahkan header, dan pastikan signature tetap dihitung dari body asli.

## Catatan

- Body event berisi `event`, `delivery_id`, `occurred_at`, dan `data`. `data` adalah snapshot record saat event terjadi (field stock/plan yang sama seperti response API); untuk `stock.deleted`, `data` memuat snapshot terakhir sebelum dihapus. Jangan menganggap event memuat state yang lebih baru dari pull rekonsiliasi.
- Tidak ada event `plan.deleted`, `supplier.*`, atau event khusus stok rendah. Permintaan event di luar daftar yang diizinkan akan ditolak; catat kode errornya.
- Tidak ada endpoint rotasi secret. Rotasi berarti subscription baru dengan secret baru, lalu menonaktifkan yang lama setelah transisi. Ini keputusan desain yang harus kamu pertanggungjawabkan.
- Subscription dan delivery disimpan di memori: restart server menghapus keduanya. Ini membatasi audit dan replay; jangan menjadikannya satu-satunya sumber kebenaran, dan verifikasi ulang setelah restart.
- Registrasi subscription adalah operasi tulis: sertakan Bearer token. Dengan API key saja, endpoint menjawab 401.
- `webhook.test` tidak boleh didaftarkan sebagai event subscription; endpoint test mengirim event ini secara langsung.
- Jaminan urutan hanya dapat diasumsikan per entity, bukan global. Dua part berbeda bisa saling mendahului tanpa masalah.
- `updated_since` tidak mengembalikan record yang sudah dihapus. Penghapusan hanya boleh disimpulkan dari event `stock.deleted` atau dari perbandingan snapshot penuh; ini contoh data yang tidak bisa sepenuhnya diandalkan pada pull inkremental.
