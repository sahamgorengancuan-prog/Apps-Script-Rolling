# Rolling Sales Center — Integrated Engine V29

Satu file Apps Script (`RollingSalesCenter.gs`) yang menggantikan seluruh varian
V28.3 / PERF10–PERF25 (49.319 baris → 6.168 baris).

**Nama parameter, nama function publik, dan susunan menu dipertahankan persis**
seperti versi sebelumnya, supaya user lama tidak perlu belajar ulang. Yang
diganti adalah isi logic-nya.

---

## 1. Cara pakai

1. Buka spreadsheet induk → **Extensions → Apps Script**.
2. Hapus isi lama, tempel seluruh `RollingSalesCenter.gs`, simpan.
3. Muat ulang spreadsheet → menu **🚀 Rolling Sales Center** muncul seperti biasa.
4. **🧪 Audit & Performance → 🧪 Run SELF-TEST Menyeluruh** (harus LULUS).
5. **🚀 2. Validate ALL Links Kolom E — Manifest**.

### Semua setup lewat parameter di file .gs, bukan menu

Tidak ada lagi prompt "masukkan ID database". Semua di blok parameter paling atas:

| Blok | Isi | Ganti kapan |
|------|-----|-------------|
| `RSC_DB_PARAMETERS.spreadsheetId` | `1psDMLLr98Fu…` (file **Database**) | DB pindah |
| `RSC_DB_PARAMETERS.extraSpreadsheetIds` | `['1JGo50yPN-…']` (file **Database m_bp_relation**) | ada DB terpisah |
| `RSC_DB_PARAMETERS.tables` | alias nama tab per tabel | tab DB diganti nama |
| `VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew` | `2026-09-01` | **tiap periode rolling** |
| `VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose` | `2026-08-31` | **tiap periode rolling** |
| `RSC_STANDARD_VALIDATION_V27_20260814` | worker, lease, attempts, defer | tuning |

---

## 2. Masalah yang diperbaiki

| # | Keluhan | Akar masalah | Perbaikan |
|---|---------|--------------|-----------|
| 1 | **Global heavy DB lease terlalu coarse** | Satu lock "heavy DB reader" dipegang selama seluruh pembacaan master → 4 lane saling blok (`waitMs=45000`), bundle dikembalikan | Lease **per-resource** (per tabel). `LockService` global hanya dipakai ~milidetik untuk compare-and-set. Setelah index jadi, semua execution baca snapshot **tanpa lock** |
| 2 | **DB_BUSY dihitung sebagai attempt validation** | `[PERF19 DB BUSY]` masuk jalur yang sama dengan kegagalan data → `Task gagal pada attempt 3` → `HARD_ERROR` | `rscClassify_()` memisah `INFRA`/`ACCESS`/`DATA`/`FATAL`. INFRA → `DEFERRED`, kolom **Defers++**, **Attempts tetap**. Infra **tidak pernah** jadi `HARD_ERROR` |
| 3 | **2500 IDs memicu full-scan fallback** | Ada ambang `MAX_TARGETED_IDS`; di atasnya jatuh ke full scan per task | Ambang dihapus. Master dibaca sekali per versi jadi hash-index, lookup O(1) berapa pun jumlah ID |

### Perbaikan turunan dari log produksi

| Gejala di log | Perbaikan |
|---------------|-----------|
| *STA Bogor* diproses 4 lane sekaligus | Claim atomik + `claimToken` compare-and-swap saat commit |
| `WATCHDOG BLOCKED Authorization binding mismatch` tiap 2 menit | Auth diperiksa **sekali**; mismatch → BLOCKED sekali, trigger dilepas |
| `[PERF19 LOOKUP REQUIRED]` → HARD_ERROR massal | Master DB opsional; rule yang bergantung padanya dicatat *skipped* |
| `STOPPED Stale run aborted` bertubi-tubi | Lane berhenti di 230 detik dan **melepas** sisa task tanpa penalti |
| Lane bangun tiap beberapa detik lalu IDLE | Lane menjadwalkan diri tepat pada `nextEligibleAt` |
| Ribuan baris `Prefetch shared master` | Dashboard di-throttle: tulis hanya saat state berubah |
| Worker kehabisan kuota memindai `m_bp_relation` | Index dibangun di execution tersendiri (prewarm) sebelum lane menyala |

---

## 3. Database master

Dua spreadsheet, sesuai kondisi nyata:

| Tab | Bentuk | Penanganan |
|-----|--------|------------|
| `m_bp_relation` | **COMPACT_JSON** — satu sel berisi `["110625404","ZWS014","S091110370","2026-03-01","2026-04-30"]`, tanpa header, baris pertama berupa URL | Deteksi layout otomatis; juga menerima 5 kolom legacy `bp_id_rlt1/relationship_cat_id/bp_id_rlt2/valid_from/valid_to`, dengan atau tanpa header |
| `m_sales_info` | Header CSV `id, sls_org, sls_office, salesman_id, …`; tanggal **epoch milidetik** (`253402214400000` = 9999-12-31) | Mode header; epoch, serial spreadsheet, `Date`, dan teks semuanya dinormalisasi |
| `m_bp_general_view` | `bp_id`, `bp_type_id`, `sls_office` | Mode header |
| `m_visit_schedule` | `cust_id`, `salesman_id`, `visit_schedule`, … | Mode header |

Pencocokan nama tab **ketat** (persis, atau prefix hanya bila nama tab mentok 31
karakter). Tanpa itu alias pendek seperti `m_bp` akan menyambar `m_bp_relation`.

### Index tabel besar

`m_bp_relation` puluhan MB, snapshot-nya tidak muat di CacheService. Penyimpanan
bertingkat: **memori → CacheService (< 5 MB) → spreadsheet `_RSC_INDEX_CACHE`**
(sheet `IDX_<TABEL>`, 2 kolom + penanda versi). Tanpa tier ketiga, penulisan
cache gagal diam-diam dan setiap execution membangun ulang index dari sumber.

Baris yang masa berlakunya lewat (grace 60 hari) tidak diindeks.

---

## 4. Katalog rule

Layout diperiksa **A:P**. Pesan mempertahankan format lama:
`Layout A:P tidak sesuai template FSD. $D: expected "Relationship", got ""`.

| Kode | Aturan | Butuh DB |
|------|--------|----------|
| R1 | Kolom wajib. `Relationship` boleh kosong **hanya** untuk Change Schedule Only | tidak |
| R2 | `Relationship` ∈ ZWS003…ZWS022 | tidak |
| R3 | `Sales Office` ada di master `em`; `Delivering Plant` = `Sales Office` | tidak |
| R4 | Format `YYYY-MM-DD`; urutan tanggal; **Reason=Rolling ⇒ Valid From & Visit Valid From = `dateNew`**; **Toko Bangkrut ⇒ Valid To & Visit Valid To = `dateClose`** | tidak |
| R5 | `Visit Category` ∈ {F1,F2,F4,F8}; `Visit Type` 01–12; `Reason` ∈ {Rolling, Toko Bangkrut} | tidak |
| R6 | Jumlah token `Schedule Visit` = F*n*; token `W{1-4}{M,T,W,TH,F,S,SU}`; satu hari sama; F2 pola {1,3} atau {2,4}; F4 minggu 1–4; F8 dua hari × empat minggu | tidak |
| R7 | `Customer ID` + `Salesman ID` sama ⇒ `Schedule Visit` identik | tidak |
| R8a | Duplikat `Customer ID + Relationship + Salesman ID + Valid To`. Baris Change Schedule Only dikecualikan | tidak |
| R8b | Bentrok dengan relasi aktif di `m_bp_relation` | ya |
| R9 | Format `Salesman ID` / `Salesman BP Type`; ada di `m_sales_info` | sebagian |
| R10 | `Customer ID` 6–12 digit; ada di `m_bp_general_view`; Sales Office & BP Type cocok | sebagian |
| TB | `Toko Bangkrut`: `Valid To` bukan `9999-12-31`; key ada di `m_visit_schedule` | sebagian |

**Change Schedule Only** (dipertahankan dari PERF6/PERF7):
CASE 1 `EXACT_REL_VALID_TO` — Customer+Relationship+Salesman+Valid To sudah ada di
`m_bp_relation`. CASE 2 `PAIR_NO_RELATION` — Relationship kosong, pasangan
Customer+Salesman ada. Keduanya dikecualikan dari duplicate check R8, dan pada
revamp ditulis sebagai visit-only.

---

## 5. Status task

| Status | Arti | Menambah Attempts? |
|--------|------|--------------------|
| `QUEUED` / `ACTIVE` | menunggu / diproses | – |
| `DEFERRED` | ditunda karena infrastruktur | **tidak** (Defers++) |
| `RETRY` | gagal data, dicoba lagi | ya |
| `COMPLETE_OK` / `COMPLETE_WITH_ERRORS` | selesai | – |
| `HARD_ERROR` | gagal data final | – |
| `BLOCKED_INFRA` | ditunda terlalu sering; **bukan** kegagalan data | tidak |
| `SKIPPED_INVALID` | link bukan URL/ID Sheets | – |

---

## 6. Pengujian

Harness Node menjalankan `RollingSalesCenter.gs` **apa adanya** di dalam `vm`
dengan stub layanan Apps Script; dunia uji dibangun dari data asli workbook induk
(62 file anak — sama dengan `valid=62` di log produksi).

```bash
npm test
# e2e      73 assertion — kontrak publik + pipeline penuh
# scale    24 assertion — 50.000 baris, konflik masif, kasus tepi
# db       71 assertion — bentuk nyata m_bp_relation & m_sales_info
# features 71 assertion — job tanggal, setup, summary, revamp, copy, compile, onEdit, pipeline
```

**239 assertion lulus.** `RSC_RUN_SELF_TEST_20260819()` (73 assertion) juga bisa
dijalankan langsung dari menu.

---

## 7. Yang perlu dikonfirmasi sebelum dipakai penuh

Tiga subsistem diimplementasi ulang berdasarkan spesifikasi yang bisa saya baca,
tetapi **layout keluarannya belum saya bandingkan dengan hasil versi lama**:

1. **Compile Upload Ready** (`RSC_UR_START_20260721`, `RSC_UR_START_ST_RL_20260727`) —
   sekarang menghasilkan penggabungan baris non-ERROR dengan header template yang
   sama, ditambah dua kolom penelusuran di depan (`Sales Office Source`,
   `Source File`). **Bandingkan dulu dengan file compile versi lama** sebelum
   dipakai untuk upload SAP.
2. **Copy Template FINAL** (`RSC_START_COPY_ROLLING_TEMPLATE_FILES_20260611`) —
   menyalin sumber kolom D ke file baru dan menulis link ke kolom E. Fase
   *finalize* versi lama (dedupe, sync missing row, hapus protection) belum ikut.
3. **Mark Exact Data With Current** (`RSC_MARK_EXACT_DATA_WITH_CURRENT_20260611`) —
   butuh Advanced Service **BigQuery** diaktifkan; query memakai kolom
   `bp_id, relationship_cat_id, bp_id_rlt2`.

Sumber versi lama disimpan di `legacy/` sebagai rujukan bila ketiganya perlu
disesuaikan lebih lanjut.
