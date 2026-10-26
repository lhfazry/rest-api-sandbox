# ANOMALY CATALOG — Dataset Sandbox (TRAINER ONLY)

> ⚠️ **Jangan dibagikan ke peserta.** File ini memuat kunci jawaban latihan.
> Dataset default (`data/*.json`) **sengaja** mengandung anomali. Semua ini bukan bug.
> Jika kamu mengubah data, **perbarui file ini** dan jalankan ulang `bash scripts/smoke-test.sh`.

Terakhir diverifikasi: 2026-10-26 · smoke test: **67/67 PASS**

---

## 1. Peta anomali

| # | Anomali | Lokasi | Nilai yang terlihat | Kenapa penting | Modul pemakaian |
|---|---|---|---|---|---|
| A1 | Stok 0 tetapi status `available` | `SUP-001` / `MJK-LUB-EP2` | `stock_quantity: 0`, `stock_status: "available"` | Kontradiksi data paling dasar; melatih eskalasi berbasis bukti | M01 (penemuan), M10 (konteks) |
| A2 | `part_number` sama di dua supplier, UOM berbeda | `SUP-001` `MJK-GSK-KIT` = **SET** vs `SUP-002` `MJK-GSK-KIT` = **PCS** | Dua baris berbeda untuk part yang sama | Kunci join ambigu; salah pilih supplier = salah stok | M10 |
| A3 | Stok > 0 tetapi status `out` (kebalikan A1) | `SUP-003` / `NEK-TRM-25` | `stock_quantity: 14`, `stock_status: "out"` | Membuktikan aturan "qty 0 ⇒ out" bukan satu-satunya pola; arah salah bisa terjadi | M05 |
| A4 | `stock_quantity` bertipe **string** + `stock_location` null | `SUP-003` / `NEK-CBL-4C16` | `"480"`, `null` | Tipe data salah & field kosong; penjumlahan/sort bisa kacau | M05, M09 |
| A5 | `uom` huruf kecil | `SUP-003` / `NEK-SEN-PR` | `"pcs"` (bukan `PCS`) | Filter/agregasi berbasis UOM gagal diam-diam | M05, M08 |
| A6 | `last_updated` basi + timezone UTC | `SUP-002` / `SNP-BLT-M12` | `2025-12-01T00:00:00+00:00` | Data 7+ minggu lebih tua; offset beda dari `+07:00` | M05, M07, M09 |
| A7 | Field opsional hilang | `SUP-002` / `SNP-SEA-2035` | `unit_price: null`, `currency` tidak ada | Wajib vs opsional; mapping tidak boleh mengarang default | M08 |
| A8 | Supplier `inactive` tetapi data tetap mengalir | `SUP-003` (`api_status: "inactive"`) | 9 baris stok + 5 plan tetap tersedia | Apakah data supplier nonaktif boleh dipakai? Siapa yang memutuskan? | M02, M06, M10 |
| A9 | Production plan tanpa stock (orphan) | `SUP-003` / `PLAN-013` (`NEK-SRV-DRV`) | Plan ada, part tidak ada di stock | Join stock↔plan tidak lengkap; rencana produksi tidak bisa divalidasi | M10 |
| A10 | `delivery_schedule` lebih awal dari `production_date` | `SUP-002` / `PLAN-014` (`SNP-TRM-R38`) | produksi 2026-02-20, kirim 2026-02-15 | Logika tanggal mustahil; dampak ke janji ke customer | M10 |
| A11 | `part_name` berbeda untuk part yang sama | `SUP-002` `PLAN-015` = "Hex Nut M10" vs stock `SNP-NUT-M10` = "Nut Hex M10" | Nama tidak identik | Join berbasis nama akan gagal; kunci harus `part_number` | M08, M10 |

## 2. Baseline yang **tidak** boleh berubah (diklaim materi)

| Klaim | Nilai | Dikunci di |
|---|---|---|
| `GET /api/v1/suppliers` total | `3` (SUP-001, SUP-002, SUP-003) | M01, M02, M10 |
| Stok SUP-001 | `6` item, default `limit=10` → `total_pages=1` | M01, M05, M09, M10 |
| Plan SUP-001 | `4` plan (`PLAN-001`..`PLAN-004`) | M05, M10 |
| Stok SUP-002 `limit=3` | 3 item pertama: `SNP-BOL-M10`, `SNP-NUT-M10`, `SNP-WSH-M10` (total 9, `total_pages=3`) | M01 |
| `PLAN-004` | `production_status: "completed"` | M10 |

Jika salah satu angka di atas berubah, **update materi + katalog ini + smoke test** dalam satu commit.

## 3. Keterbatasan yang tersisa (bahan task lanjutan)

- Pagination drift: data berubah saat paging; belum ada snapshot/cursor stabil.
- Soft delete / audit trail: `DELETE` stock menghapus permanen; supplier dan plan tidak punya DELETE.
- Breaking change versi: belum ada `/v2`, header versi, atau kebijakan deprecation.
- Cache/CDN stale di dashboard: dashboard masih membaca langsung tanpa ETag.
- Clock skew: belum ada validasi timestamp masa depan pada payload.
- Webhook dan idempotency in-memory: restart menghapus subscription, delivery, dan cache idempotency.
- Kuota per job: hanya satu API key demo; belum ada provisioning kunci atau kuota terpisah.
- Observability: belum ada metrics/access log terstruktur selain log konsol.
