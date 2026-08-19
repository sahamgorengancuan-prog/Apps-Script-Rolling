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
| `RSC_DB_SPREADSHEET_ID` | tidak | Spreadsheet DB master utama. |
| `RSC_DB_EXTRA_IDS` | tidak | Spreadsheet DB tambahan, dipisah koma. Diisi otomatis bila Anda menempel beberapa link sekaligus di menu. |
| `RSC_PERIOD_START` | tidak | Awal periode rolling `YYYY-MM-DD`. Default: tanggal 1 bulan berjalan. Dipakai rule **R4**. |
| `RSC_INDEX_STORE_ID` | otomatis | Spreadsheet `_RSC_INDEX_CACHE` yang dibuat sendiri oleh script untuk menyimpan index besar. Jangan dihapus. |

---

## 2b. Sumber DB master

Engine mendukung **lebih dari satu spreadsheet DB**, karena pada praktiknya
`m_bp_relation` memang berada di file terpisah. Tempel semua link sekaligus
(pisah baris atau koma) lewat **Admin / Recovery → Set Link Spreadsheet DB Master**.

Bentuk data yang sudah didukung dan diuji:

| Tab | Bentuk | Penanganan |
|-----|--------|------------|
| `m_bp_relation` | **tanpa baris header**; baris 1 berisi URL, kolom berurutan `customer_id, relationship, salesman_id, valid_from, valid_to` | mode **posisional**; baris non-numerik di kolom kunci dilewati otomatis |
| `m_sales_info` | header CSV `id, sls_org, sls_office, salesman_id, …`; tanggal dalam **epoch milidetik** (`253402214400000` = 9999-12-31) | mode **header**; epoch milidetik, serial spreadsheet, `Date`, dan teks `YYYY-MM-DD`/`DD/MM/YYYY` semuanya dinormalisasi |
| lainnya | header biasa | dicocokkan lewat alias nama kolom |

Jalankan **Admin / Recovery → Inventarisasi Tab DB (Discovery)** untuk melihat
sheet `_RSC_DB_DISCOVERY`: daftar seluruh tab di setiap DB, jumlah baris, mode
yang terdeteksi, tabel engine yang memakainya, dan tabel yang **belum** menemukan
tab-nya. Tab yang belum terpetakan cukup ditambahkan aliasnya di `RSC_CFG.DB_TABLES`.

Pencocokan nama tab sengaja **ketat** (persis, atau prefix hanya bila nama tab
mentok batas 31 karakter). Tanpa itu alias pendek seperti `m_bp` akan menyambar
tab `m_bp_relation` dan master terbaca dari tabel yang salah.

### Index tabel besar

`m_bp_relation` berukuran puluhan MB. Snapshot index-nya tidak muat di
CacheService, sehingga penyimpanan bertingkat:

1. **Memori execution** — paling cepat.
2. **CacheService** — untuk snapshot < 5 MB.
3. **Spreadsheet `_RSC_INDEX_CACHE`** — snapshot besar dimaterialisasi menjadi
   sheet `IDX_<TABEL>` berisi 2 kolom (key + nilai terpaket) dengan penanda versi.
   Tanpa tier ini, penulisan cache akan gagal diam-diam dan **setiap** execution
   membangun ulang index dari sumber — persis pola yang membuat versi lama macet.

Baris yang masa berlakunya sudah lewat (dengan grace 60 hari) tidak diindeks,
sehingga index tetap ramping tanpa mengorbankan pemeriksaan relasi aktif.

Pembangunan index berjalan di **eksekusi tersendiri** (`rscPrewarmIndexes`) yang
dijadwalkan sebelum lane menyala. Dengan begitu biaya pemindaian tabel besar
dibayar sekali per versi DB, bukan memakan kuota 6 menit milik worker.

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
npm test                  # menjalankan ketiganya
node test/e2e.test.js     # 82 assertion — pipeline penuh
node test/scale.test.js   # 24 assertion — skala & kasus tepi
node test/db.test.js      # 72 assertion — bentuk nyata kedua spreadsheet DB
```

Cakupan: pipeline 62 link end-to-end, prewarm index di eksekusi terpisah,
kebenaran hasil di file anak, anti-duplikat lane, DB busy tidak menambah Attempts
(7× berturut-turut tetap 0 `HARD_ERROR`), lease per-resource, 12.000 baris master
+ 5.000 lookup tanpa baca ulang, watchdog anti-loop, error akses/layout,
dashboard & write-back Rekap, jalan tanpa DB, idempotensi restart, file 50.000
baris (~28.500 baris/detik), konflik masif, sel `Date` asli, `=HYPERLINK`, batas
waktu eksekusi lane, dua sumber DB, `m_bp_relation` tanpa header, epoch
milidetik, materialisasi index ke sheet + pembacaan dingin tanpa menyentuh
sumber, invalidasi saat versi DB berubah, dan regresi pencocokan nama tab.

`rscSelfTest()` (47 assertion) juga dapat dijalankan langsung dari editor Apps
Script lewat menu **Admin / Recovery → Jalankan Self-Test**.
