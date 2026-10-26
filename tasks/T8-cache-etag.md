# T8 — Cache & Conditional GET

**Level:** Menengah–Sulit · **Estimasi:** 90 menit · **Peran:** Integration Analyst · **Prasyarat:** T1–T6; sudah bisa mengambil token Bearer dan membaca `meta` respons; paham header HTTP dasar.

## 1. Konteks bisnis

Dashboard memanggil empat endpoint setiap 30 detik: daftar supplier, stok `SUP-001`, daftar production plan, dan satu detail stok. Itu 2.880 request per endpoint per hari, lebih dari 11.000 request untuk empat endpoint, padahal data berubah hanya beberapa kali. Biaya kuota dan bandwidth naik, log penuh, dan dashboard tetap menampilkan angka yang sama.

Manajer integrasi meminta bukti sebelum menyetujui perubahan arsitektur: berapa byte yang benar-benar dihemat, apakah data bisa basi, dan apa yang terjadi ketika ada penulisan. Tugasmu bukan sekadar "memakai ETag", melainkan menunjukkan kapan mekanisme itu bekerja, kapan gagal, dan bagaimana merancang polling yang aman.

## 2. Tujuan pembelajaran

- Menjelaskan siklus `ETag` → `If-None-Match` → `304` dan membuktikan bahwa body 304 benar-benar kosong.
- Membedakan makna `200`, `304`, dan `404` dalam konteks cache, termasuk apa yang boleh dan tidak boleh dilakukan klien.
- Menjelaskan `Cache-Control: no-cache` sebagai kewajiban revalidasi, bukan larangan menyimpan.
- Merancang penyimpanan ETag per resource dan algoritme polling yang tahan terhadap perubahan query, penulisan, dan `429`.
- Mengukur penghematan payload secara jujur dan memproyeksikannya ke biaya harian.
- Menilai risiko stale setelah mutasi tunggal, bulk, replay idempotensi, dan restart server.

## 3. Yang harus kamu putuskan sendiri

1. **Resource yang dipantau.** Empat endpoint sudah disebut; apakah cukup, dan bagaimana kunci cache dibentuk (method + URL lengkap termasuk query)?
2. **Perlakuan query.** Apakah `?page=2`, `?status=low`, dan `?limit=5` berbagi entri cache atau terpisah? Apa akibatnya pada jumlah request?
3. **Aksi per status.** Apa yang dilakukan saat `200`, `304`, `404`, `429`, dan `5xx`? Kapan entri cache dihapus, kapan dipertahankan?
4. **Cara mengukur.** Byte body saja, atau body + header? Nyatakan asumsi dan konsisten.
5. **Skenario invalidasi.** Mutasi apa yang membuktikan ETag berubah, dan apakah perubahan itu berlaku global atau per resource?
6. **Replay idempotensi.** Apakah request dengan `Idempotency-Key` yang sama dan `Idempotency-Replayed: true` boleh mengubah ETag? Buktikan, jangan asumsikan.
7. **Batas pengujian.** Interval asli 30 detik terlalu lama untuk kelas; pilih interval yang dipercepat dan jelaskan bahwa hasilnya hanya bukti mekanisme, bukan bukti beban produksi.

## 4. Peta kapabilitas API — pilih sendiri

| Kapabilitas | Endpoint / header | Yang kamu dapat | Catatan biaya atau risiko |
|---|---|---|---|
| ETag daftar | `GET /api/v1/suppliers`, `/stock`, `/production-plans` | `ETag`, `Cache-Control: no-cache` | Nilai berubah setiap mutasi; jangan menganggapnya stabil atau bisa ditebak |
| ETag detail | `GET /api/v1/suppliers/:supplierId/stock/:partNumber`, `/production-plans/:planId` | ETag untuk satu resource | Berguna untuk polling sempit, bukan pengganti daftar |
| Revalidasi | `If-None-Match: <etag>` | `304`, body kosong, ETag sama | Tetap satu request; hemat byte, bukan kuota request |
| Penulisan | `PATCH /api/v1/suppliers/:id/stock/:partNumber` | Perubahan state dan ETag baru | Butuh Bearer; siapkan nilai pemulihan |
| Idempotensi | `Idempotency-Key` pada request tulis | Replay tanpa mutasi kedua, `Idempotency-Replayed: true` | TTL dan perilaku ETag tidak dijelaskan; uji |
| Bulk | `PATCH .../stock/bulk` dan `?mode=partial` | Satu mutasi untuk banyak baris | Atomic gagal total vs `207` sebagian; pengaruhnya ke ETag berbeda |
| Batas laju | `X-RateLimit-*`, `429`, `Retry-After` | Sinyal untuk backoff | 304 mungkin tetap dihitung sebagai request; ukur |
| `Last-Modified` | `If-Modified-Since` | Belum dijanjikan kontrak | Decoy: jangan andalkan tanpa bukti |
| `HEAD` | `HEAD /api/v1/stock` | Mungkin ETag tanpa body | Decoy: tidak dijelaskan; jangan jadikan fondasi desain |
| Simulasi | `?simulate=latency`, `?simulate=ratelimit` | Uji ketahanan poller | Decoy untuk produksi; jangan kirim ke dashboard nyata |

## 5. Alur kerja yang diharapkan

1. Ambil satu daftar dan satu detail, simpan `ETag`, `Cache-Control`, status, dan ukuran body ke tabel timeline.
2. Kirim ulang request yang sama dengan `If-None-Match`. Simpan header respons dan ukuran body; buktikan body 0 byte.
3. Ubah satu baris stok lewat `PATCH` dengan `Idempotency-Key`, lalu ulangi request kondisional. Bandingkan ETag sebelum dan sesudah.
4. Ulangi `PATCH` yang sama dengan key identik; catat `Idempotency-Replayed` dan apakah ETag bergerak.
5. Uji variasi query (`page`, `status`, `limit`, urutan parameter) dan catat ETag mana yang sama atau berbeda.
6. Uji `404` untuk plan yang tidak ada dan `429` lewat simulasi; tentukan aksi poller pada masing-masing.
7. Jalankan `poll.js` beberapa siklus dengan interval dipercepat; hasilkan log terstruktur berisi status, ETag, byte, dan aksi.
8. Hitung penghematan, proyeksikan ke 2.880 request per endpoint per hari, lalu tulis rekomendasi produksi beserta mode kegagalan.

## 6. Deliverable

| File | Isi minimum | Bukti yang harus terlihat |
|---|---|---|
| `cache-probe.md` | Tabel timeline: waktu, request, ETag, status, byte body, byte header, aksi | Baris 200 pertama, baris 304, dan baris setelah mutasi |
| `poll.js` | Node stdlib tanpa dependensi; simpan ETag per URL; interval dan jumlah siklus dari env; berhenti setelah N siklus | Log JSON per siklus; 304 tidak menimpa body tersimpan; `429` menghormati `Retry-After` |
| `invalidation.md` | Bukti ETag berubah setelah `PATCH`; replay dengan `Idempotency-Key`; perilaku bulk/`207`; nilai dipulihkan | Potongan header sebelum/sesudah dan status replay |
| `design-notes.md` | Rekomendasi polling produksi; perkiraan penghematan; risiko stale; kegagalan multi-klien, CDN, restart | Keputusan eksplisit dan kondisi kapan desain harus diubah |

## 7. Kriteria penilaian (sum 100)

| Aspek | Bobot | Yang dinilai |
|---|---|---|
| Bukti 304 | 30 | 304 nyata, body kosong, ETag sama, makna status dijelaskan; bukan sekadar klaim |
| Logika invalidasi | 25 | ETag berubah setelah mutasi; replay idempotensi dan bulk diuji; cakupan global/per-resource dipahami |
| Efisiensi terukur | 20 | Pengukuran konsisten, persentase dan proyeksi harian benar, asumsi byte dinyatakan |
| Analisis produksi | 25 | Stale risk, multi-instance, CDN, restart, `429`, dan rekomendasi operasional dibahas |

## 8. Jebakan & kesalahan umum

- Menganggap `no-cache` berarti "jangan simpan", lalu membuang body dan tetap meminta data penuh.
- Menyimpan ETag tanpa menyimpan body, sehingga `304` tidak bisa digunakan.
- Menghitung `304` sebagai error atau sebagai data baru.
- Menganggap ETag berlaku per resource, padahal revisi bisa global: satu `PATCH` mengubah ETag daftar lain.
- Membandingkan ETag dari URL berbeda, misalnya ETag `?page=1` dikirim ke `?page=2`.
- Lupa memasukkan query string ke kunci cache, sehingga filter berbeda saling menimpa.
- Mengukur hanya `size_download` lalu menyimpulkan total byte tanpa header.
- Menyimpulkan penghematan kuota, padahal 304 tetap memakan satu request dan mungkin terkena rate limit.
- Menguji invalidasi dengan `PATCH` lalu lupa memulihkan nilai, sehingga baseline kelas berubah.
- Memakai token `readonly-token` untuk `PATCH`, mendapat `403`, lalu menyalahkan cache.
- Menganggap replay `Idempotency-Key` selalu netral terhadap ETag tanpa membuktikannya.
- Menganggap CDN bersama otomatis aman: ETag tidak mengoordinasikan klien, dan cache bersama yang menyimpan respons ber-API key berisiko menyajikan data ke pihak lain.
- Menyimpulkan bulk `207` hanya mengubah baris yang sukses; revisi dapat menggeser ETag seluruh koleksi, jadi daftar tetap perlu divalidasi ulang.
- Menjalankan smoke test di tengah pengukuran; data berubah dan ETag bergerak tanpa penjelasan.

## 9. Verifikasi mandiri

```bash
BASE=http://localhost:4010
KEY='X-API-Key: sup_demo_key_2026'
URL="$BASE/api/v1/suppliers/SUP-001/stock?limit=5"

TOKEN=$(curl -s -X POST "$BASE/auth/token" -H 'Content-Type: application/json' \
  -d '{"client_id":"company-dashboard","client_secret":"s3cr3t-demo"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).access_token))")

# 1) Simpan ETag dan ukuran body
curl -sD /tmp/t8-h1.txt -o /tmp/t8-b1.json -w 'status=%{http_code} bytes=%{size_download}\n' \
  -H "$KEY" "$URL"
ETAG=$(tr -d '\r' < /tmp/t8-h1.txt | awk -F': ' 'tolower($1)=="etag"{print $2}')
grep -i 'cache-control' /tmp/t8-h1.txt

# 2) Revalidasi: harapan 304 dan body 0 byte
curl -sD /tmp/t8-h2.txt -o /tmp/t8-b2.json -w 'status=%{http_code} bytes=%{size_download}\n' \
  -H "$KEY" -H "If-None-Match: $ETAG" "$URL"
test -s /tmp/t8-b2.json && echo 'BODY TIDAK KOSONG' || echo 'body kosong (0 byte)'

# 3) Mutasi dengan idempotency key, lalu cek ETag baru
curl -s -X PATCH "$BASE/api/v1/suppliers/SUP-001/stock/MJK-BRG-6205" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: t8-invalidate-001' -d '{"stock_quantity":481}' -o /dev/null -w '%{http_code}\n'
curl -sD - -o /dev/null -H "$KEY" "$URL" | grep -i '^etag'

# 4) Replay key yang sama: catat Idempotency-Replayed dan ETag
curl -sD - -o /dev/null -X PATCH "$BASE/api/v1/suppliers/SUP-001/stock/MJK-BRG-6205" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: t8-invalidate-001' -d '{"stock_quantity":481}' | grep -iE 'idempotency|etag|^HTTP'

# 5) Pulihkan nilai awal
curl -s -X PATCH "$BASE/api/v1/suppliers/SUP-001/stock/MJK-BRG-6205" \
  -H "$KEY" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"stock_quantity":480}' -o /dev/null -w '%{http_code}\n'

# 6) 404 bukan 304: plan yang tidak ada tidak boleh dianggap cache valid
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "$KEY" "$BASE/api/v1/production-plans/PLAN-999"

# 7) 429 dan Retry-After (simulasi)
curl -sD - -o /dev/null -H "$KEY" "$BASE/api/v1/stock?simulate=ratelimit" \
  | grep -iE '^HTTP|retry-after|x-ratelimit'
```

Untuk mengukur perbedaan query, ulangi langkah 1 pada `?page=2`, `?status=low`, dan `?limit=5&page=1`, lalu bandingkan ETag. Ingat **smoke test memutasi data**; jangan jalankan selama pengukuran. Restart server mengembalikan seed dan **mereset** revisi ETag (revisi disimpan di memori), sehingga klien yang masih memegang ETag lama harus menganggap cache-nya tidak valid.

## 10. Ekstensi opsional

- Tambahkan store ETag persisten (file JSON) dan uji perilakunya setelah server restart.
- Bandingkan ETag dengan hash body (`sha256`) untuk mendeteksi ETag yang berubah tanpa perubahan isi.
- Terapkan backoff eksponensial dengan jitter saat `429`, dan tunjukkan header yang dipakai.
- Ukur biaya header per siklus dan hitung titik impas antara polling 30 detik dan 5 menit.
- Rancang negosiasi CDN: header apa yang harus diteruskan, dan mengapa API key di URL berbahaya.
- Simulasikan dua klien dengan ETag berbeda untuk menunjukkan tidak ada koordinasi antar-klien.

## Catatan ambiguitas

- Kekuatan ETag adalah strong dan dibentuk dari revisi data + method + path + query terurut, jadi `?limit=5&page=1` dan `?page=1&limit=5` seharusnya menghasilkan ETag sama. Anggap string ini buram; jangan mem-parse.
- Revisi disebut global: setiap mutasi sukses mengubah ETag semua URL JSON. Buktikan cakupannya, terutama untuk daftar supplier dan production plan yang tidak kamu ubah.
- `304` tetap mengirim `ETag` dan `Cache-Control: no-cache`; rekam header itu untuk membuktikan body kosong bukan karena koneksi putus.
- ETag hanya dipasang pada respons JSON `200`. Respons `404` (dan error lain) tidak membawa ETag, sehingga tidak bisa dijawab `304`. Uji ini secara eksplisit; jangan memperlakukan ETag sebagai bukti bahwa resource ada.
- `If-None-Match` menerima satu ETag, daftar dipisah koma, atau `*`; uji minimal satu varian selain ETag tunggal.
- Perilaku replay `Idempotency-Key` terhadap ETag dan masa berlakunya tidak dijelaskan; jadikan hipotesis yang diuji, bukan asumsi.
- ETag hanya dijanjikan untuk respons JSON; CSV di koleksi stok tidak memakai ETag karena validasinya tidak mewakili representasi CSV.
- Apakah `304` dihitung dalam kuota `X-RateLimit-*` tidak dijelaskan; bandingkan header sebelum dan sesudah.
- Perilaku multi-instance dan restart (revisi in-memory) tidak dijamin; bahas sebagai risiko, bukan fakta.
