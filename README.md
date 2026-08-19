# Rolling Sales Center — Integrated Validation Engine

Satu file Apps Script (`RollingSalesCenter.gs`) yang menggantikan seluruh varian
`RSC_STANDARD_VALIDATION_V28_3_PERF17` … `PERF25`. Dipasang pada spreadsheet induk
**USE THIS Template Rolling Sales**, memvalidasi seluruh link pada kolom E sheet
`Rekap Approved`, menulis `Validation Status` + `Error Detail` ke tiap file anak,
dan melaporkan progres ke sheet `Job Logging Details`.

---

## 1. Masalah yang diperbaiki

| # | Keluhan | Akar masalah pada arsitektur lama | Perbaikan |
|---|---------|-----------------------------------|-----------|
| 1 | **Global heavy DB lease terlalu coarse** | Satu lock "heavy DB reader" dipegang selama seluruh pembacaan master, sehingga 4 lane saling blok (`waitMs=45000`) dan seluruh bundle di-`WAITING`. | Lease **per-resource** (`IDX:<tabel>:<versi>`). `LockService` global hanya dipakai <2 detik untuk compare-and-set. Setelah index terbentuk, semua execution membaca snapshot cache **tanpa lock sama sekali**. Tabel berbeda dibangun paralel penuh. |
| 2 | **DB_BUSY salah dihitung sebagai attempt validation** | `[PERF19 DB BUSY]` masuk jalur yang sama dengan kegagalan data → `Task gagal pada attempt 3` → `HARD_ERROR`. | `rscClassify_()` memisahkan `INFRA` / `ACCESS` / `DATA` / `FATAL`. `INFRA` → status `DEFERRED`, kolom **Defers++**, **Attempts tidak berubah**, dijadwalkan ulang dengan exponential backoff + jitter. Infra **tidak pernah** menjadi `HARD_ERROR`; batasnya `BLOCKED_INFRA` yang masih bisa dilanjutkan. |
| 3 | **2500 IDs masih memicu full-scan fallback** | Ada ambang `MAX_TARGETED_IDS`; di atasnya kode jatuh ke full scan master per task. | Ambang dihapus total. Master dibaca **sekali per versi** menjadi hash-index; lookup O(1) berapa pun jumlah ID. Terbukti pada uji: 5.000 lookup = **0** pembacaan sheet tambahan. |

### Perbaikan turunan yang ikut selesai

| Gejala pada log | Perbaikan |
|-----------------|-----------|
| File yang sama (mis. *STA Bogor*) diproses 4 lane sekaligus | Claim atomik + `claimToken` compare-and-swap saat commit. Token tidak cocok → hasil dibuang, bukan menimpa. |
| `WATCHDOG BLOCKED Authorization binding mismatch` berulang tiap 2 menit | Otorisasi diperiksa **sekali**; mismatch → `BLOCKED` sekali, trigger watchdog dilepas, alasan disimpan. Pulih lewat menu **Admin → Bind Ulang Otorisasi**. |
| `[PERF19 LOOKUP REQUIRED] _rsc_bp_general_lookup belum tersedia` → `HARD_ERROR` massal | Master DB bersifat **opsional**. Bila tabel tidak ada, rule yang bergantung padanya dicatat sebagai *skipped*, bukan menggagalkan file. |
| `STOPPED Stale run aborted` bertubi-tubi | Lane berhenti di `SOFT_DEADLINE_MS` (4 menit dari kuota 6 menit) dan **melepas** task yang belum dikerjakan tanpa penalti. Tidak ada lagi lease yatim. |
| Lane bangun tiap beberapa detik lalu `IDLE` | Lane menjadwalkan diri tepat pada `nextEligibleAt` task paling awal. |
| Ribuan baris log `Prefetch shared master` | Dashboard di-throttle: menulis hanya saat state berubah atau melewati interval minimum; histori dibatasi 400 baris. |

---

## 2. Pemasangan

1. Buka spreadsheet induk → **Extensions → Apps Script**.
2. Hapus isi `Code.gs`, tempel seluruh isi `RollingSalesCenter.gs`, simpan.
3. Muat ulang spreadsheet → muncul menu **Rolling Sales Center**.
4. Jalankan **Admin / Recovery → Jalankan Self-Test** (harus `LULUS`).
5. *(Opsional)* **Admin / Recovery → Set ID Spreadsheet DB Master** bila punya
   database MDM eksternal. Tanpa ini pipeline tetap berjalan penuh; hanya rule
   berbasis master DB yang dilewati.
6. **▶ Jalankan Validasi Semua Link E**.

### Script Properties

| Kunci | Wajib | Keterangan |
|-------|-------|------------|
| `RSC_DB_SPREADSHEET_ID` | tidak | Spreadsheet DB master (`m_bp_general`, `m_bp_relation`, `m_visit_schedule`, `m_salesman`, `m_relationship`). Nama sheet ditoleransi lewat alias & prefix. |
| `RSC_PERIOD_START` | tidak | Awal periode rolling `YYYY-MM-DD`. Default: tanggal 1 bulan berjalan. Dipakai rule **R4**. |

---

## 3. Katalog rule

Layout yang diperiksa: **A:P** pada sheet `Change Rolling & Change Schedule`.
Pesan layout mempertahankan format lama:
`Layout A:P tidak sesuai template FSD. $D: expected "Relationship", got ""`.

| Kode | Aturan | Butuh DB |
|------|--------|----------|
| R1 | Kolom wajib tidak boleh kosong | tidak |
| R2 | `Relationship` terdaftar pada master Relationship (ZWS003…ZWS022) | tidak (fallback bawaan) |
| R3 | `Sales Office` ada di master `em`; `Delivering Plant` = `Sales Office` | tidak |
| R4 | Format `YYYY-MM-DD`; `Valid From ≤ Valid To`; visit-range di dalam validity; tidak mendahului awal periode | tidak |
| R5 | `Visit Category` ∈ {F1,F2,F4,F8}; `Visit Type` 01–12 (2 digit); `Reason` ∈ {Rolling, Toko Bangkrut} | tidak |
| R6 | Jumlah token `Schedule Visit` = F*n*; token `W{1-4}{M,T,W,TH,F,S,SU}`; satu hari yang sama; F2 pola minggu {1,3} atau {2,4}; F4 minggu 1–4; F8 dua hari × empat minggu | tidak |
| R7 | `Customer ID` + `Salesman ID` sama wajib punya `Schedule Visit` identik | tidak |
| R8a | Duplikat `Customer ID + Relationship + Salesman ID + Valid To` di dalam template | tidak |
| R8b | Bentrok dengan relasi aktif di `m_bp_relation` | ya |
| R9 | `Salesman ID` = `S`+9 digit; `Salesman BP Type` format `ZD01`; ada di master salesman | sebagian |
| R10 | `Customer ID` 8–12 digit; ada di `m_bp_general`; Sales Office cocok | sebagian |
| TB | `Toko Bangkrut`: `Valid To` bukan `9999-12-31`; key ada di `m_visit_schedule` | sebagian |

Sheet `Change Salesman Type` dan `Change Sales Office` memakai **engine, normalisasi,
penulisan, dan pelaporan yang sama persis** — hanya daftar kolom dan rule yang berbeda
(lihat `RSC_SPECS`).

---

## 4. Status task

| Status | Arti | Menambah Attempts? |
|--------|------|--------------------|
| `QUEUED` / `ACTIVE` | menunggu / sedang diproses | – |
| `DEFERRED` | ditunda karena infrastruktur (DB busy, lock, kuota) | **tidak** (Defers++) |
| `RETRY` | gagal data, akan dicoba lagi | ya |
| `COMPLETE_OK` | selesai, 0 baris error | – |
| `COMPLETE_WITH_ERRORS` | selesai, ada baris error di file anak | – |
| `HARD_ERROR` | gagal data final (layout rusak, tanpa akses, dst.) | – |
| `BLOCKED_INFRA` | ditunda terlalu sering; **bukan** kegagalan data | tidak |
| `SKIPPED_INVALID` | kolom E bukan URL/ID Google Sheets | – |

---

## 5. Pengujian

Harness Node menjalankan `RollingSalesCenter.gs` **apa adanya** di dalam `vm`
dengan stub `SpreadsheetApp` / `PropertiesService` / `CacheService` / `LockService` /
`ScriptApp` / `DriveApp` / `Session`, dan dunia uji dibangun dari data asli
`USE THIS Template Rolling Sales 1 September 2026.xlsx`
(62 file anak — sama dengan `valid=62` pada log produksi).

```bash
node test/e2e.test.js     # 74 assertion — pipeline penuh
node test/scale.test.js   # 24 assertion — skala & kasus tepi
```

Cakupan: pipeline 62 link end-to-end, kebenaran hasil di file anak, anti-duplikat
lane, DB busy tidak menambah Attempts (7× berturut-turut tetap 0 `HARD_ERROR`),
lease per-resource, 12.000 baris master + 5.000 lookup tanpa baca ulang, watchdog
anti-loop, error akses/layout, dashboard & write-back Rekap, jalan tanpa DB,
idempotensi restart, file 50.000 baris (~28.500 baris/detik), konflik masif,
sel `Date` asli, `=HYPERLINK`, dan batas waktu eksekusi lane.

`rscSelfTest()` juga dapat dijalankan langsung dari editor Apps Script
(menu **Admin / Recovery → Jalankan Self-Test**).
