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
| `m_visit_schedule` | `cust_id`, `salesman_id`, `visit_category`, `visit_type`, `visit_valid_from`, … | Mode header. Dipakai Toko Bangkrut: key `Visit Category + Customer + Salesman + Visit Type`, effective date dipilih **terakhir yang ≤ `dateClose`**, atau paling awal bila semua > `dateClose` |
| `m_rel_salesman_type_rlt` | `rlt_id`, `rlt_desc` | Opsional. Bila ada, kode Relationship di luar ZWS001–ZWS022/BUR001 ikut diterima; bila tidak ada, dipakai daftar canonical di `RELATIONSHIP_OPTIONS` |

Pencocokan nama tab **ketat** (persis, atau prefix hanya bila nama tab mentok 31
karakter). Tanpa itu alias pendek seperti `m_bp` akan menyambar `m_bp_relation`.

Nama tab dan nama kolom dicari lewat alias di `RSC_DB_PARAMETERS.tables` dan
`*Headers`. Untuk memastikan tab mana yang benar-benar terpakai, jalankan menu
**Diagnose DB Access / Identity** (`RSC_PERF11_DIAGNOSE_DB_ACCESS_20260819`) — ia
mencetak daftar tab tiap spreadsheet DB **dan** hasil resolusi tiap tabel master
(tab yang terpakai, jumlah key, jumlah baris). Tabel yang tidak ditemukan membuat
rule terkait **dilewati**, bukan menjadi error.

### Index tabel besar

`m_bp_relation` puluhan MB, snapshot-nya tidak muat di CacheService. Penyimpanan
bertingkat: **memori → CacheService (< 5 MB) → spreadsheet `_RSC_INDEX_CACHE`**
(sheet `IDX_<TABEL>`, 2 kolom + penanda versi). Tanpa tier ketiga, penulisan
cache gagal diam-diam dan setiap execution membangun ulang index dari sumber.

Baris yang masa berlakunya lewat (grace 60 hari) tidak diindeks.

---

## 4. Katalog rule — Standard V28.3 / PERF26

Layout diperiksa **A:P**. Pesan mempertahankan format lama:
`Layout A:P tidak sesuai template FSD. $D: expected "Relationship", got ""`.

Pipeline Rolling berjalan lima fase, sama untuk Active Sheet maupun Bulk Link E:

```
RSC_STD_VALIDATE_ONE_SHEET_20260814_
  -> RSC_STD_VALIDATE_ROLLING_20260814_
       -> RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_20260814_
            1. RSC_V28_3_CREATE_ROLLING_SNAPSHOT_20260814_    baca A:N + canonicalize
            2. RSC_V28_3_LOAD_ROLLING_MASTERS_20260814_       subset master
            3. RSC_STD_LOAD_RELATION_CONTEXT_20260814_        konteks m_bp_relation
               RSC_STD_DETECT_CHANGE_SCHEDULE_ONLY_20260819_  CASE 1 / CASE 2
               RSC_MVS_getIndexSubset_20260819_               subset m_visit_schedule
            4. RSC_V28_3_APPLY_ROLLING_MUTATIONS_20260814_    auto-replace
            5. RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_RULES_...  S0/R1..R12/TB
               RSC_V28_3_WRITE_ROLLING_SNAPSHOT_20260814_     tulis A:N + O:P + warna
```

### Matriks rule

| Kode | Aturan | ERROR bila | Pengecualian | Butuh DB |
|------|--------|-----------|--------------|----------|
| S0 | Sales Office wajib dan ada di master `em`; Delivering Plant 4 karakter alphanumeric | kosong / tidak ada di `em` / plant bukan 4 alnum | Delivering Plant tidak wajib | `em` |
| R1 | Customer & Salesman wajib, format benar, ada di `m_bp_general_view.bp_id` | kosong / non-numerik / tidak ditemukan | Customer non-numerik dimaafkan pada pasangan S\*+S\* | ya |
| R1A | Salesman **normal** ada di `m_sales_info.salesman_id` | tidak ditemukan | **Dummy Salesman exempt** | ya |
| R2 | Relationship wajib, format `ZWSnnn`/`BUR001`, terdaftar di LOV/master | kosong / format salah / tidak terdaftar | kosong boleh pada `PAIR_NO_RELATION` | opsional |
| R3 | Salesman BP Type wajib, format `ZDnn`, sama dengan `bp_type_id` | kosong / format salah / `bp_type_id` tidak ada di master | nilai F **di-auto-replace** dari master bila tersedia | ya |
| R4 | Empat tanggal wajib dan valid `YYYY-MM-DD` | kosong / tidak terbaca | tanggal relasi dilewati pada `PAIR_NO_RELATION`; tanggal visit dilewati pada S\*+S\* | tidak |
| R5 | Visit Category ∈ {F1,F2,F4,F8} | kosong / di luar daftar | optional pada S\*+S\* | tidak |
| R6 | Schedule Visit sesuai matriks frekuensi | token salah/duplikat/kosong, jumlah token tidak sesuai kategori | optional pada S\*+S\* | tidak |
| R7 | Customer+Salesman sama ⇒ Schedule Visit identik | ada dua normalisasi berbeda | dilewati pada S\*+S\* | tidak |
| R8a | Duplikat `Customer + Relationship + Salesman + Valid To` dalam template | key muncul > 1 kali | Change Schedule Only dikecualikan | tidak |
| R8b | Key yang sama sudah ada di `m_bp_relation` | key sudah ada | Change Schedule Only exact dikecualikan | ya |
| R9 | `Valid To` > `Valid From` | `Valid To <= Valid From` | dilewati pada `PAIR_NO_RELATION` | tidak |
| R9A | Change Rolling normal wajib open-ended | `Valid To != 9999-12-31` | tidak berlaku untuk Toko Bangkrut / `PAIR_NO_RELATION` | tidak |
| R10 | `Visit Valid To` > `Visit Valid From` | `<=` | dilewati pada S\*+S\* | tidak |
| R11 | Periode visit di dalam periode relasi | visit From < Valid From, atau visit To > Valid To | dilewati pada S\*+S\* dan `PAIR_NO_RELATION` | tidak |
| R12 | Visit Type wajib, `01`–`12` dua digit | kosong / di luar 01–12 | `1` dinormalisasi jadi `01`; optional pada S\*+S\* | tidak |
| TB | Toko Bangkrut: `Valid To`/`Visit Valid To` = `dateClose`; key MVS lengkap dan ada; `Visit Valid From` = effective date DB | tidak sesuai | sisi visit dilewati pada S\*+S\*; sisi relasi dilewati pada `PAIR_NO_RELATION` | `m_visit_schedule` |

Validator tambahan: **Change Sales Office** (`SO1`–`SO7`) memeriksa hirarki
Sales Org → Distribution Channel → Division → Sales Office dari `em` plus
duplicate key; **Change Salesman Type** (`ST1`–`ST7`) memeriksa Sales Type
terhadap LOV *New code S4* (`SALES_TYPE_OPTIONS`, 114 kode) plus duplicate key.

### Salesman ID

| Jenis | Regex | Wajib di `m_bp_general_view` | Wajib di `m_sales_info` |
|-------|-------|------------------------------|-------------------------|
| Normal | `^S\d+$` (contoh `S091160257`) | ya | **ya** |
| Dummy | `^S0000[0TSM][A-Z0-9]{4}$` (contoh `S000002AA0`, `S0000T2AA0`, `S0000S5AW0`, `S0000M2AA0`) | ya | **tidak** |

### S\* Customer + S\* Salesman

Aktif bila **keduanya** cocok `^S[A-Z0-9]+$`. Efeknya **hanya** membuat seluruh
visit section optional (Visit Category, Visit Type, Schedule, Visit Valid
From/To, R5/R6/R10/R11, MVS Toko Bangkrut). Bukan bypass untuk BP, Salesman,
Relationship, maupun tanggal relasi.

### Change Schedule Only

CASE 1 `EXACT_REL_VALID_TO` — `Customer + Relationship + Salesman + Valid To`
cocok persis dengan record `m_bp_relation`. CASE 2 `PAIR_NO_RELATION` —
Relationship kosong dan pasangan Customer+Salesman ada di `m_bp_relation`.
Keduanya dikecualikan dari R8; pada revamp ditulis sebagai visit-only dengan
`Change Schedule Only = x`. **Toko Bangkrut sengaja tidak pernah diperlakukan
sebagai CASE 1.**

### Field yang di-auto-replace sebelum rule final

| Field | Kondisi | Perlakuan |
|-------|---------|-----------|
| Salesman BP Type | ada `bp_type_id` di BP master | **ditimpa** dari master |
| Valid From | Reason Rolling (normal / CASE 1) | **ditimpa** `dateNew` — histori DB tidak boleh menarik mundur |
| Visit Valid From | Reason Rolling (semua mode kecuali S\*+S\*) | **ditimpa** `dateNew` |
| Valid From | Toko Bangkrut | **ditimpa** dari `m_bp_relation` (open-ended diprioritaskan, lalu histori tertutup terbaru, lalu Valid From paling awal milik Customer) |
| Valid To / Visit Valid To | Toko Bangkrut | **diisi bila kosong** dengan `dateClose`; bila user mengisi nilai lain, nilai itu dibiarkan agar rule TB melaporkannya |
| Visit Valid From | Toko Bangkrut | **diisi bila kosong** dengan effective date `m_visit_schedule` (tanggal terakhir ≤ `dateClose`, atau paling awal bila semua > `dateClose`) |
| Relationship / Valid From / Valid To | `PAIR_NO_RELATION` | sengaja **tidak** di-backfill |
| Kode & tanggal | semua baris | dikanonikalkan, ditulis ulang sebagai `yyyy-mm-dd` |

Baris hasil mutasi ditulis kembali ke A:N, hanya baris yang benar-benar berubah,
dalam blok berurutan, sehingga formula pada baris lain tidak tersentuh. Jumlah
baris yang dibetulkan dilaporkan sebagai `Dibetulkan: n baris`.

---

## 4b. Kode warna status

Satu peta warna dipakai di seluruh permukaan (kolom O:P, manifest, dashboard Job
Logging, kolom Feedback rekap) lewat `RSC_UI_STATUS_COLOR_20260820_`.

| Warna | Hex | Status |
|-------|-----|--------|
| 🟩 Hijau | `#B7E1CD` | `OK`, `ALL OK`, `COMPLETE_OK`, `DONE`, `VALIDASI OK` |
| 🟥 Merah | `#F4C7C3` | `ERROR`, `HARD_ERROR`, `COMPLETE_WITH_ERRORS`, `GAGAL`, `PERLU REVISI` |
| 🟨 Kuning | `#FFF2A8` | `IN PROGRESS`, `ACTIVE`, `RUNNING`, `WORKER`, `VALIDATING`, `CLAIMED` |
| 🟧 Orange | `#FCD9A6` | `QUEUE`, `QUEUED`, `PENDING`, `MENUNGGU` |
| 🟫 Kuning tua | `#FFE0B2` | `RETRY`, `DEFERRED`, `TERTUNDA` |
| 🟦 Biru | `#D6E4F7` | `BLOCKED_INFRA` |
| ⬜ Abu | `#E5E7EB` | `SKIPPED_INVALID`, `DILEWATI`, `STOPPED`, `IDLE` |

Status ditulis tebal; kolom Error Detail dibungkus (wrap). Kalimat panjang pada
kolom Feedback ikut diwarnai lewat pencocokan kata kunci.

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
# logic    264 assertion — konformansi PERF26 pasal demi pasal + kode warna
# e2e       73 assertion — kontrak publik + pipeline penuh
# scale     24 assertion — 50.000 baris, konflik masif, kasus tepi
# db        78 assertion — bentuk nyata m_bp_relation & m_sales_info
# features  71 assertion — job tanggal, setup, summary, revamp, copy, compile, onEdit, pipeline
```

**510 assertion lulus.** `RSC_RUN_SELF_TEST_20260819()` juga bisa dijalankan
langsung dari menu.

`test/logic.test.js` memetakan dokumen PERF26 satu-satu:

| Bagian | Isi | Pasal PERF26 |
|--------|-----|--------------|
| L1 | Layout A:P | §2 |
| L2 | Canonicalization (kode, Visit Type, Schedule, 7 format tanggal) | §3 |
| L3 | Salesman normal vs Dummy | §6 |
| L4 | Pengecualian S\*+S\* | §7 |
| L5 | Change Schedule Only CASE 1 & CASE 2 | §8 |
| L6 | Kebijakan tanggal Rolling | §9 |
| L7 | Toko Bangkrut: Valid From, dateClose, effective date MVS | §10 |
| L8 | Matriks frekuensi F1/F2/F4/F8 | §11 |
| L9 | R7, R8a, R8b | §12 |
| L10 | Setiap rule §5 terbukti dapat menyala | §5 |
| L11 | Output O:P | §14 |
| L12–L13 | Warna hasil + penulisan kembali A:N | §13, §14 |
| L14 | Change Sales Office & Change Salesman Type | §17, §18 |
| L15 | Paritas Active vs Bulk + 13 fungsi inti | §15, §21 |
| L16 | Kegagalan teknis tidak mengubah OK/ERROR | §19 |
| L17 | Warna pada manifest, dashboard, dan rekap saat bulk run nyata | – |

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

### Keputusan yang saya ambil saat dokumen PERF26 bisa dibaca dua arah

Dokumen PERF26 §13 menyebut sejumlah field "authoritative auto-replace",
sementara §5 tetap mencantumkan rule ERROR untuk sebagian field yang sama.
Kalau semuanya ditimpa, rule-nya tidak akan pernah menyala. Yang saya terapkan:

| Field | Pilihan | Alasan |
|-------|---------|--------|
| Salesman BP Type | **ditimpa** | §20 catatan 4 menyatakan mismatch user memang dibetulkan, bukan dijadikan ERROR |
| Rolling Valid From & Visit Valid From | **ditimpa** | §9 tegas: histori DB tidak boleh menarik mundur; §5 R4 tidak punya rule "harus dateNew" |
| Toko Bangkrut Valid To / Visit Valid To / Visit Valid From | **diisi bila kosong**, selain itu ERROR | §5 TB punya rule ERROR eksplisit untuk ketiganya; menimpa diam-diam akan menyembunyikan kesalahan input |

Konsekuensi: **R8b hanya dapat menyala pada baris Toko Bangkrut.** Baris non-TB
dengan key yang sama persis adalah definisi Change Schedule Only CASE 1, dan
CASE 1 memang dikecualikan dari R8b — persis seperti kode lama
(`if(key4&&existingR8[key4]&&!changeScheduleOnly)`).

Dua hal lain yang mengikuti dokumen dan **berbeda dari V28.3 lama**:

- **Spasi pada Schedule Visit bukan lagi ERROR.** §3 menyatakan whitespace
  dibuang saat canonicalization, jadi `W1M, W3M` otomatis menjadi `W1M,W3M`.
  Versi lama mengeluarkan "Schedule Visit tidak boleh mengandung spasi".
- **Nilai `Reason` tidak divalidasi terhadap daftar.** Katalog pesan versi lama
  tidak punya rule untuk itu, jadi saya tidak menambah rule baru. `Rolling`
  dideteksi dengan *contains* `ROLLING`, `Toko Bangkrut` dengan *contains*
  `TOKO BANGKRUT`; kebijakan tanggal memakai pencocokan persis `Rolling`
  (§20 catatan 2), jadi dropdown sebaiknya tetap bernilai canonical `Rolling`.

Teks pesan error mengikuti katalog versi lama persis (mis. `[R8] R8a: key
Customer ID + Relationship + Salesman ID + Valid To duplikat dalam template.`)
supaya histori feedback ke area tetap terbaca sama; tambahan hanya berupa
sufiks `Actual=…` dan nomor row.
