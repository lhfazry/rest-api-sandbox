# T5 — Playbook Kegagalan & Retry

**Level:** Medium-Hard · **Estimasi:** 90 menit · **Peran:** Integration Analyst (operasi integrasi) · **Prasyarat:** T1–T3; bisa membaca header HTTP, mengukur waktu respons, dan membedakan error body dari sukses

## 1. Konteks bisnis

Sync stok malam berjalan setiap hari pukul 01.00 terhadap Supplier API. Tiga minggu terakhir sync gagal intermiten: kadang selesai, kadang berhenti di tengah, kadang "sukses" tetapi data di gudang tidak berubah. Tim jaga malam tidak bisa membedakan tiga hal yang berbeda:

1. kegagalan sementara yang akan hilang bila dicoba lagi,
2. kegagalan permanen yang akan gagal selamanya walau diulang,
3. kegagalan yang tidak terlihat (respons 200, tetapi isinya bukan JSON yang valid).

Dua insiden jadi pelajaran. Pertama, sebuah loop retry menjalankan 12 percobaan dalam 40 detik dan justru memicu pembatasan kuota. Kedua, seorang analis mengulang request `400` selama satu jam karena mengira "server sedang sibuk". Manajer operasi meminta **playbook satu halaman** yang bisa diikuti orang non-teknis pada pukul 02.00 tanpa bertanya ke pembuatnya.

Alat yang tersedia: endpoint chaos pada sandbox (`?simulate=...` dan `GET /api/v1/_simulate/{code}`), header kuota, dan `Idempotency-Key` untuk operasi tulis. Tidak ada dependencies tambahan; semua pengukuran dilakukan dengan curl/Postman dan dicatat.

**Catatan (sifat simulator).** `?simulate=timeout&ms=8000` tidak membatalkan pekerjaan server — server tetap menunggu lalu menjawab. Jika klien menyerah lebih dulu (mis. `curl --max-time 3`), request bisa **sudah** diproses di sisi server. Ini bukandetail teknis kecil; inilah alasan retry pada operasi tulis harus punya kunci idempotensi.

**Catatan (environment).** Setiap respons `/api/v1` membawa header `X-RateLimit-*`, dan `GET /api/v1/_ratelimit` memberi state window untuk key pemanggil. Gunakan keduanya sebagai sumber angka; jangan menyimpulkan kuota dari perasaan atau dari satu request saja.

## 2. Tujuan pembelajaran

- Menjalankan eksperimen kegagalan terkontrol dan mencatat bukti yang dapat diperiksa ulang (status, latency, body, header).
- Mengklasifikasikan kegagalan menjadi retryable vs fatal berdasarkan gejala yang teramati, bukan dugaan.
- Merancang kebijakan retry berbatas: jumlah percobaan, backoff + jitter, timeout per percobaan, dan total budget.
- Menentukan operasi mana yang aman diulang, dan kapan `Idempotency-Key` wajib dipakai.
- Menulis runbook yang dapat dieksekusi tanpa penulisnya, termasuk kriteria eskalasi.
- Menghitung worst case waktu tunggu agar retry tidak melewati jendela sync.

## 3. Yang harus kamu putuskan sendiri

1. **Ambang timeout.** Berapa detik klien menunggu sebelum menyerah? Apakah angka itu berasal dari SLA, ukuran payload, atau pengukuran baseline?
2. **429.** Selalu retry? Bagaimana menghormati `Retry-After` dibanding backoff buatan sendiri — mana yang menang bila keduanya berbeda?
3. **Malformed 200.** Retry, abort, atau eskalasi? Berapa percobaan sebelum dianggap pelanggaran kontrak?
4. **401 vs 403.** Apakah 401 layak satu kali refresh token, atau langsung fatal? Mengapa 403 tidak boleh di-retry?
5. **Aturan berhenti.** `max_attempts` atau `total_budget_ms` yang mengikat bila keduanya bertabrakan? Circuit breaker per endpoint, per supplier, atau per run — dan kapan boleh half-open?
6. **Operasi tulis.** Mana yang aman diulang tanpa kunci (PUT/PATCH/DELETE), dan mana yang tidak (POST tanpa kunci)? Risiko apa yang kamu terima?

## 4. Peta kapabilitas API — pilih sendiri

| Kebutuhan | Kandidat endpoint / alat (termasuk decoy) | Kenapa perlu dicek |
|---|---|---|
| Baseline sehat | `GET /health`, `GET /api/v1/suppliers` | Pembanding latency dan bentuk respons normal |
| Lambat tetapi sukses | `GET /api/v1/suppliers?simulate=latency&ms=1500` | Membedakan "lambat" dari "gagal"; apakah timeout klien memotong respons |
| Klien menyerah | `...?simulate=timeout&ms=8000` + `curl --max-time 3` | Exit code klien vs status server; apakah pekerjaan tetap selesai |
| Error server | `?simulate=error500` | 5xx: retryable, tetapi berapa kali? |
| Kuota | `?simulate=ratelimit` | 429 + `Retry-After`; apakah body tetap memakai skema error standar |
| Status individual | `GET /api/v1/_simulate/400\|401\|403\|404\|429\|500` | Membandingkan `error.code` dan `details` antar status |
| Body rusak | `?simulate=malformed` | 200 dengan JSON tidak valid; hanya terdeteksi jika body di-parse |
| Kuota nyata | `GET /api/v1/_ratelimit` | `X-RateLimit-Limit/Remaining/Reset` untuk key pemanggil |
| Auth | Tanpa `X-API-Key`, `readonly-token` | 401 vs 403; kapan berhenti, kapan refresh |
| Retry berbahaya | `POST .../stock/bulk` dengan vs tanpa `Idempotency-Key` | Eksekusi ganda vs replay respons |
| Retry aman | `PUT/PATCH .../stock/{partNumber}`, `GET` | Apakah hasilnya sama bila diulang — termasuk `last_updated` dan efek samping lain |
| Konflik | `Idempotency-Key` sama + body berbeda | 409 `IDEMPOTENCY_KEY_REUSED`: fatal, bukan retryable |

## 5. Alur kerja yang diharapkan

**Fase 0 — Harness (10 menit).** Buat `probe.sh` (atau koleksi Postman) yang selalu mencetak: timestamp, metode, URL, status, `time_total`, ukuran body, dan header terpilih. Simpan output mentah per skenario di `raw/E01.txt` dst. Tanpa ini, evidence.csv hanya jadi cerita.

**Fase 1 — Baseline (10 menit).** Ukur minimal 5 request sehat berturut-turut. Catat median dan nilai terburuk. Angka inilah pembanding untuk semua klaim "lambat". Evidence: tabel baseline + file mentah.

**Fase 2 — Matriks status (20 menit).** Jalankan keenam kode `_simulate` dan tiga `?simulate=` utama (error500, ratelimit, latency). Catat status, `error.code`, apakah `details` array, dan header khusus. Evidence: 9 baris pertama evidence.csv.

**Fase 3 — Timeout & body rusak (15 menit).** (a) Ukur `simulate=latency` yang mendekati/melewati timeout klien. (b) Paksa timeout dengan `--max-time` dan catat exit code, bukan hanya status. (c) Parse body `malformed` dengan `JSON.parse` dan tunjukkan error-nya. Evidence: 3 skenario + potongan output parser.

**Fase 4 — Kuota & auth (10 menit).** Panggil `_ratelimit` sebelum dan sesudah beberapa request; catat perubahan `Remaining`/`Reset`. Uji 401 (tanpa key), 401 (tanpa bearer), dan 403 (`readonly-token`). Evidence: header mentah.

**Fase 5 — Klasifikasi & kebijakan (15 menit).** Isi tabel klasifikasi (gejala → keputusan → alasan). Baru setelah itu tulis `retry-policy.json`; setiap angka harus merujuk bukti atau SLA, bukan selera. Evidence: tabel + JSON.

**Fase 6 — Uji kebijakan (10 menit).** Simulasikan kegagalan berurutan (mis. 500 → 500 → 200) dan tunjukkan policy berhenti atau lanjut sesuai aturan. Hitung worst case: `max_attempts × attempt_timeout + total backoff`; bandingkan dengan jendela sync. Evidence: log percobaan dengan timestamp.

**Fase 7 — Runbook (10 menit).** Susun langkah T+0 sampai eskalasi, termasuk apa yang dikirim ke vendor dan apa yang **tidak** boleh dilakukan operator. Uji runbook dengan skenario "orang lain membacanya" — minta rekan mengikuti tanpa penjelasanmu.

## 6. Deliverable

| File | Isi | Format |
|---|---|---|
| `playbook.md` | Ringkasan keputusan, tabel klasifikasi, ringkasan policy, runbook bertahap (deteksi → klasifikasi → aksi → eskalasi), template komunikasi, dan asumsi/risiko. Maksimal 2 halaman efektif. | Markdown |
| `evidence.csv` | Satu baris per percobaan, termasuk baseline dan kegagalan yang disengaja. Harus konsisten dengan file mentah di `raw/`. | CSV, header persis: `scenario_id,endpoint,method,simulate,client_max_time_s,http_status,latency_ms,retry_after,parse_ok,body_signature,classification,action,raw_file` |
| `retry-policy.json` | Policy yang dapat dibaca mesin: attempts, timeout, budget, backoff + jitter, daftar status retry/no-retry, aturan `Retry-After`, kebutuhan idempotency, circuit breaker, observability. | JSON valid |
| `decision-tree.md` | Pohon keputusan `mermaid` (`flowchart TD`), minimal 8 node keputusan. Setiap edge diberi label gejala yang teramati (status/exit code/jenis parse error); setiap terminal diberi label `RETRY`, `STOP-FATAL`, atau `ESCALATE`. | Markdown + blok mermaid |

Kumpulkan keempat deliverable di `submission/T5/` (lihat `tasks/README.md` §6).

Kerangka `retry-policy.json` (isi nilainya sendiri; angka 0 berarti "belum diputuskan"):

```json
{
  "policy_version": "1.0",
  "applies_to": ["<endpoint atau pola>"],
  "max_attempts": 0,
  "attempt_timeout_ms": 0,
  "total_budget_ms": 0,
  "backoff": { "strategy": "exponential", "base_ms": 0, "multiplier": 0, "jitter": "<none|full|equal>", "max_delay_ms": 0 },
  "retry_on": ["<status atau gejala>"],
  "no_retry_on": ["<status atau gejala>"],
  "honor_retry_after": true,
  "idempotency": { "required_for": ["<method + path>"], "header": "Idempotency-Key" },
  "circuit_breaker": { "scope": "<endpoint|supplier|run>", "failure_threshold": 0, "open_ms": 0, "half_open_probes": 0 },
  "observability": { "log_fields": ["<field>"], "alert_after": "<kondisi>" }
}
```

## 7. Kriteria penilaian

| Komponen | Bobot | Yang dinilai |
|---|---|---|
| Klasifikasi kegagalan | 25 | Setiap status/gejala punya keputusan dan alasan; 401/403/400/404/409 tidak disamakan dengan 5xx; malformed dan timeout ditangani eksplisit |
| Kualitas kebijakan retry | 30 | Backoff + jitter masuk akal; timeout per attempt dan total budget konsisten; `Retry-After` dihormati; circuit breaker punya ambang dan pemulihan; worst case dihitung |
| Bukti eksperimen | 25 | Skenario cukup beragam; latency terukur, bukan dikira; body/header tersimpan; CSV konsisten dengan raw; kesimpulan dapat dilacak ke bukti |
| Kejelasan runbook | 20 | Langkah dapat dieksekusi orang lain; kriteria eskalasi dan komunikasi jelas; batasan "jangan lakukan" eksplisit; keputusan tulis vs baca dibedakan |
| **Total** | **100** | |

## 8. Jebakan & kesalahan umum

- **"Timeout berarti tidak terjadi apa-apa."** Klien menyerah, server bisa tetap memproses. Retry tanpa kunci dapat menggandakan efek tulis.
- **Retry 429 seketika.** Mengabaikan `Retry-After` memperpanjang pembatasan dan membuat `Remaining` makin kecil.
- **Mengulang 400/404.** Keduanya deterministik; retry hanya menambah log dan menunda perbaikan data.
- **Backoff tanpa jitter.** Semua worker bangun bersamaan dan menabrak endpoint di detik yang sama.
- **Mengukur latency dari perasaan.** Tanpa `time_total` dan baseline, klaim "lambat" tidak bisa dibandingkan.
- **Mencatat 200 malformed sebagai sukses.** Jika body tidak di-parse, kegagalan kontrak lolos ke proses berikutnya.
- **Menganggap 401 dan 403 sama.** 401 bisa diperbaiki dengan token baru; 403 tidak akan berubah dengan retry.
- **Circuit breaker global.** Satu endpoint bermasalah memutus semua sync, termasuk yang masih sehat.
- **Budget tidak dihitung.** `max_attempts × attempt_timeout + total backoff` bisa melewati jendela sync dan bertabrakan dengan run berikutnya. Hitung worst case, jangan tebak.
- **Policy tanpa observability.** Tanpa field log yang konsisten, kegagalan berikutnya tidak bisa dibandingkan dengan evidence hari ini.

## 9. Verifikasi mandiri

```bash
BASE=http://localhost:4010
KEY='X-API-Key: sup_demo_key_2026'
W='status=%{http_code} time=%{time_total}s size=%{size_download}\n'

# 1. Baseline (ulangi 5x, catat sebarannya)
curl -s -o /dev/null -w "$W" -H "$KEY" "$BASE/api/v1/suppliers"

# 2. Lambat tetapi sukses
curl -s -o /dev/null -w "$W" -H "$KEY" "$BASE/api/v1/suppliers?simulate=latency&ms=1500"

# 3. Timeout sisi klien: catat exit code (28 = curl kehabisan waktu), bukan hanya status
curl -s -o /dev/null -w "$W" --max-time 3 -H "$KEY" "$BASE/api/v1/suppliers?simulate=timeout&ms=8000"; echo "exit=$?"

# 4. 500 dan 429: lihat body + header, bukan hanya angka
curl -s -i -H "$KEY" "$BASE/api/v1/suppliers?simulate=error500" | head -20
curl -s -i -H "$KEY" "$BASE/api/v1/_simulate/429" | grep -iE 'HTTP/|retry-after|x-ratelimit'

# 5. Malformed: buktikan parse gagal
curl -s -H "$KEY" "$BASE/api/v1/suppliers?simulate=malformed" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s);console.log("parse OK")}catch(e){console.log("parse GAGAL:",e.message)}})'

# 6. Kuota untuk key kita
curl -s -i -H "$KEY" "$BASE/api/v1/_ratelimit" | grep -iE 'HTTP/|x-ratelimit|retry-after'

# 7. 401 vs 403 (jangan menyalahkan endpoint)
curl -s -o /dev/null -w 'tanpa-key=%{http_code}\n' "$BASE/api/v1/suppliers"
curl -s -o /dev/null -w 'tanpa-bearer=%{http_code}\n' -X POST "$BASE/api/v1/suppliers/SUP-001/stock/bulk" \
  -H "$KEY" -H 'Content-Type: application/json' -d '{"items":[]}'
curl -s -o /dev/null -w 'readonly=%{http_code}\n' -X POST "$BASE/api/v1/suppliers/SUP-001/stock/bulk" \
  -H "$KEY" -H 'Authorization: Bearer readonly-token' -H 'Content-Type: application/json' -d '{"items":[]}'
```

> **Peringatan.** `bash scripts/smoke-test.sh` **mengubah data** (membuat `SUP-SMOKE-*`, stok `SMOKE-*`, dan production plan). Jangan jalankan saat mengumpulkan evidence; restart server sebelum demo bersih.

## 10. Ekstensi opsional

- **Harness yang patuh policy.** Implementasikan `probe.js` (Node stdlib) yang membaca `retry-policy.json`, menjalankan retry dengan jitter, dan menulis satu baris log per percobaan. Bandingkan hasilnya dengan runbook manual.
- **Verifikasi jitter.** Jalankan 20 simulasi kegagalan dan plot sebaran delay antar percobaan; tunjukkan bahwa retry tidak menumpuk di waktu yang sama.
- **Synthetic canary.** Jadwalkan probe sehat setiap 5 menit, hitung error rate per jam, dan usulkan ambang alert yang menghasilkan satu halaman on-call, bukan ratusan notifikasi.
