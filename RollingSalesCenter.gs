/**
 * ============================================================================
 *  ROLLING SALES CENTER — INTEGRATED VALIDATION ENGINE
 *  Single-file Apps Script. Menggantikan seluruh varian V28.3 / PERF17..PERF25.
 * ----------------------------------------------------------------------------
 *  Dipasang di: spreadsheet induk "USE THIS Template Rolling Sales".
 *  Bertugas   : memvalidasi seluruh link pada kolom E sheet "Rekap Approved",
 *               menulis Validation Status + Error Detail ke tiap file anak,
 *               dan melaporkan progres ke sheet "Job Logging Details".
 * ----------------------------------------------------------------------------
 *  PERBAIKAN INTI terhadap arsitektur lama
 *
 *  [F1] Lease DB tidak lagi global/coarse.
 *       Lama : satu lock "heavy DB reader" mengunci SEMUA master untuk SEMUA
 *              lane -> lane 1..4 saling blok, WAITING 45s, bundle di-defer.
 *       Baru : lease per-resource (per tabel master) yang hanya dipegang saat
 *              MEMBANGUN index. Setelah index jadi, semua execution membaca
 *              snapshot dari CacheService tanpa lock sama sekali.
 *              Critical section global hanya ~ms untuk compare-and-set lease.
 *
 *  [F2] DB_BUSY tidak lagi dihitung sebagai attempt validasi.
 *       Setiap error diklasifikasi: INFRA | ACCESS | DATA | FATAL.
 *       - INFRA  -> task kembali ke DEFERRED, kolom Defers++ , Attempts TETAP,
 *                   dijadwalkan ulang dengan exponential backoff + jitter.
 *       - DATA   -> Attempts++ ; HARD_ERROR hanya bila Attempts >= MAX_ATTEMPTS.
 *       Infra tidak akan pernah menghasilkan HARD_ERROR.
 *
 *  [F3] Tidak ada lagi full-scan fallback pada jumlah ID berapa pun.
 *       Master dibaca SEKALI menjadi hash-index (O(1) lookup). Jumlah key yang
 *       dibutuhkan (2.500 / 50.000 / berapa pun) tidak lagi mengubah strategi
 *       baca. Batas lama MAX_TARGETED_IDS dihapus total.
 *
 *  [F4] Satu file tidak lagi diproses beberapa lane sekaligus.
 *       Claim atomik (global lock singkat) + claimToken compare-and-swap saat
 *       commit. Token tidak cocok -> hasil dibuang, bukan ditimpa.
 *
 *  [F5] Watchdog tidak lagi spam "Authorization binding mismatch" tiap 2 menit.
 *       Auth diperiksa sekali; bila mismatch -> status BLOCKED sekali, trigger
 *       watchdog dilepas, dan alasan disimpan agar bisa di-resume manual.
 *
 *  [F6] Semua validasi memakai SATU engine deklaratif (RSC_SPECS).
 *       Sheet Change Rolling / Change Salesman Type / Change Sales Office /
 *       TOP Customer / Credit Limit memakai jalur normalisasi, penulisan,
 *       dan pelaporan yang identik.
 * ============================================================================
 */

/* ==========================================================================
 * 1. KONFIGURASI
 * ======================================================================== */

var RSC_CFG = {
  VERSION: 'RSC_V29_INTEGRATED',

  /* --- nama sheet di file induk --- */
  SHEET: {
    REKAP: 'Rekap Approved',
    DASHBOARD: 'Job Logging Details',
    MANIFEST: '_RSC_MANIFEST_V29',
    EM: 'em',
    READ_ME: 'Read Me'
  },

  /* --- tata letak sheet Rekap Approved (1-based) --- */
  REKAP: {
    HEADER_ROW: 4,
    FIRST_DATA_ROW: 5,
    COL_OFFICE: 1,
    COL_DESC: 2,
    COL_LINK_DRAFT: 4,
    COL_LINK_FINAL: 5,   // <- "Link E" yang divalidasi
    COL_STATUS: 6,
    COL_REASON: 7,
    COL_FEEDBACK: 8,
    MAX_SCAN_ROWS: 500
  },

  /* --- eksekusi paralel --- */
  RUN: {
    LANES: 4,
    BUNDLE_SIZE: 4,
    SOFT_DEADLINE_MS: 240000,   // 4 menit dari kuota 6 menit
    HARD_DEADLINE_MS: 300000,
    LEASE_MS: 420000,           // lease task 7 menit
    MAX_ATTEMPTS: 3,            // hanya untuk kegagalan DATA
    MAX_DEFERS: 12,             // hanya untuk kegagalan INFRA
    RETRY_BASE_MS: 8000,
    RETRY_MAX_MS: 120000,
    WORKER_TRIGGER_DELAY_MS: 5000,
    WATCHDOG_EVERY_MIN: 5,
    HEARTBEAT_STALE_MS: 210000
  },

  /* --- index master --- */
  INDEX: {
    CACHE_TTL_SEC: 21600,       // 6 jam (maksimum CacheService)
    CHUNK_BYTES: 90000,         // < 100KB limit per entry
    BUILD_LEASE_MS: 300000,
    WAIT_MS: 25000,             // tunggu builder lain, lalu defer (bukan gagal)
    WAIT_STEP_MS: 2500,
    READ_WINDOW_ROWS: 20000,
    CACHE_MAX_BYTES: 5000000,     // di atas ini, snapshot ditulis ke sheet index
    SHEET_WRITE_ROWS: 5000,       // ukuran blok saat materialisasi index
    SHEET_READ_ROWS: 50000
  },

  /* --- dashboard --- */
  DASH: {
    TITLE_ROW: 1,
    SUMMARY_ROW: 2,
    COUNTER_ROW: 3,
    HEADER_ROW: 6,
    SLOT_FIRST_ROW: 8,
    SLOT_COUNT: 8,              // WORKER_1..4, WATCHDOG, REVAMP, SYSTEM, LEGACY
    HISTORY_TITLE_ROW: 18,
    HISTORY_HEADER_ROW: 19,
    HISTORY_FIRST_ROW: 20,
    HISTORY_MAX: 400,
    MIN_WRITE_INTERVAL_MS: 4000
  },

  /* --- batas pesan & tampilan --- */
  MSG: {
    MAX_DETAIL_CHARS: 4000,     // batas aman per sel Error Detail
    MAX_ROWS_IN_MSG: 12,        // berapa nomor baris yang dicantumkan pada konflik
    MAX_VARIANTS: 6,            // berapa variasi Schedule Visit yang dicantumkan
    DROPDOWN_HEADROOM: 500
  },

  /* --- script properties --- */
  PROP: {
    RUN_ID: 'RSC_RUN_ID',
    RUN_STATE: 'RSC_RUN_STATE',
    DB_ID: 'RSC_DB_SPREADSHEET_ID',
    DB_ID_EXTRA: 'RSC_DB_EXTRA_IDS',   // dipisah koma; mis. spreadsheet m_bp_relation
    OWNER: 'RSC_BINDING_OWNER',
    BLOCKED: 'RSC_BLOCKED_REASON',
    INDEX_VER: 'RSC_INDEX_VER:',
    INDEX_STORE: 'RSC_INDEX_STORE_ID',
    LEASE: 'RSC_LEASE:',
    DASH_LAST: 'RSC_DASH_LAST_WRITE',
    PERIOD: 'RSC_PERIOD_START'
  },

  /* --- sumber DB eksternal (opsional, boleh lebih dari satu spreadsheet).
         Bila tidak dikonfigurasi, rule DB-dependent di-SKIP, BUKAN dijadikan
         HARD_ERROR seperti perilaku PERF19 lama. --- */
  DB_TABLES: {
    /* m_bp_relation berada di spreadsheet terpisah dan TANPA baris header:
       baris pertama berisi URL, data mulai baris berikutnya dengan urutan
       kolom tetap. Karena itu dipakai mode posisional. */
    BP_RELATION: {
      sheets: ['m_bp_relation', 'bp_relation', 'Database m_bp_relation'],
      positional: ['Customer ID', 'Relationship', 'Salesman ID', 'Valid From', 'Valid To'],
      keyCols: [['Customer ID', 'customer_id', 'bp_number', 'BP Number']],
      valCols: [
        { name: 'Relationship', aliases: ['Relationship', 'relationship', 'relation'] },
        { name: 'Salesman ID', aliases: ['Salesman ID', 'salesman_id'] },
        { name: 'Valid From', aliases: ['Valid From', 'valid_from'] },
        { name: 'Valid To', aliases: ['Valid To', 'valid_to'] }
      ],
      keyPattern: '^[0-9]{6,12}$',
      maxPerKey: 24,
      // Baris yang masa berlakunya sudah lewat tidak diindeks. Ini yang membuat
      // index tabel puluhan MB tetap ramping. Grace 60 hari disediakan agar
      // rolling yang di-backdate sedikit tetap punya pembanding.
      activeOnly: 'Valid To',
      activeGraceDays: 60
    },

    /* m_sales_info memakai header CSV asli dan tanggal epoch milidetik. */
    SALESMAN: {
      sheets: ['m_sales_info', 'm_salesman', 'salesman', 'sales_info'],
      keyCols: [['salesman_id', 'Salesman ID']],
      valCols: [
        { name: 'Sales Office', aliases: ['sls_office', 'Sales Office', 'sales_office'] },
        { name: 'Sales Organization', aliases: ['sls_org', 'Sales Organization', 'sales_org'] },
        { name: 'Sales Type', aliases: ['sales_type', 'Sales Type'] },
        { name: 'Coverage', aliases: ['coverage', 'Coverage'] },
        { name: 'Name', aliases: ['salesman_name', 'Name'] },
        { name: 'Valid From', aliases: ['valid_from', 'Valid From'] },
        { name: 'Valid To', aliases: ['valid_to', 'Valid To'] }
      ],
      keyPattern: '^[A-Za-z0-9]{6,15}$',
      maxPerKey: 8
    },

    BP_GENERAL: {
      sheets: ['m_bp_general', '_rsc_bp_general_lookup', 'bp_general', 'm_customer'],
      keyCols: [['Customer ID', 'customer_id', 'bp_number', 'BP Number', 'BP Number Source']],
      valCols: [
        { name: 'Sales Office', aliases: ['sls_office', 'Sales Office', 'sales_office'] },
        { name: 'Sales Organization', aliases: ['sls_org', 'Sales Organization', 'sales_org'] },
        { name: 'Name', aliases: ['bp_name', 'name', 'Name', 'customer_name'] }
      ],
      keyPattern: '^[0-9]{6,12}$',
      maxPerKey: 4
    },

    VISIT_SCHEDULE: {
      sheets: ['m_visit_schedule', 'visit_schedule', 'm_schedule_visit', 'm_visit'],
      keyCols: [
        ['Customer ID', 'customer_id', 'bp_number', 'BP Number'],
        ['Salesman ID', 'salesman_id']
      ],
      valCols: [
        { name: 'Schedule Visit', aliases: ['schedule_visit', 'Schedule Visit', 'visit_schedule'] },
        { name: 'Visit Category', aliases: ['visit_category', 'Visit Category'] },
        { name: 'Valid From', aliases: ['valid_from', 'Valid From'] },
        { name: 'Valid To', aliases: ['valid_to', 'Valid To'] }
      ],
      maxPerKey: 8
    },

    RELATION_TYPE: {
      sheets: ['m_relationship', 'm_bp_relation_type', 'relationship'],
      keyCols: [['Relationship', 'relationship', 'relation_id']],
      valCols: [{ name: 'Description', aliases: ['Description', 'description', 'relation_desc'] }],
      maxPerKey: 1
    }
  },

  /* --- master bawaan (fallback bila DB eksternal tidak tersedia) --- */
  RELATIONSHIP_BUILTIN: {
    ZWS003: 'Sales Rep. Food',
    ZWS004: 'Sales Rep. Non-Food',
    ZWS005: 'Sales Rep. Frozen',
    ZWS006: 'Sales Rep. Cosmetic',
    ZWS007: 'Sales Rep. Reguler',
    ZWS011: 'Superior',
    ZWS012: 'Collector Food',
    ZWS013: 'Collector Non-Food',
    ZWS014: 'Collector Frozen',
    ZWS015: 'Collector Cosmetic',
    ZWS016: 'Collector Reguler',
    ZWS022: 'Collector Industrial Relation'
  },
  VISIT_CATEGORY: { F1: 1, F2: 2, F4: 4, F8: 8 },
  VISIT_TYPES: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
  WEEKDAY_TOKENS: ['M', 'T', 'W', 'TH', 'F', 'S', 'SU'],
  REASONS: ['Rolling', 'Toko Bangkrut'],
  OPEN_ENDED_DATE: '9999-12-31'
};

/* ==========================================================================
 * 2. UTILITAS DASAR
 * ======================================================================== */

/** Normalisasi teks sel: trim, buang NBSP/zero-width, rapatkan spasi. */
function rscText_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    // Hindari notasi eksponen / ".0" pada ID numerik seperti Customer ID.
    return (v === Math.floor(v) && Math.abs(v) < 1e15) ? String(Math.round(v)) : String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  var s = String(v);
  s = s.replace(/[\u00A0\u180E\u200B-\u200D\u2028\u2029\uFEFF]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/** Normalisasi untuk perbandingan header/enum: uppercase tanpa non-alfanumerik. */
function rscKey_(v) {
  return rscText_(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Ambil ID saja dari nilai dropdown "KODE - Deskripsi".
 * "2AA0 - STA Bogor" -> "2AA0" ; "2AA0" -> "2AA0".
 */
function rscIdOnly_(v) {
  var s = rscText_(v);
  if (!s) return '';
  var m = s.match(/^([A-Za-z0-9_.\-]+)\s+-\s+/);
  return m ? m[1] : s;
}

/** Ekstrak fileId Google Sheets dari URL/ID mentah. Kosong bila bukan link valid. */
function rscFileId_(v) {
  var s = rscText_(v);
  if (!s) return '';
  var m = s.match(/\/d\/([A-Za-z0-9_-]{25,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([A-Za-z0-9_-]{25,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return s;
  return '';
}

/**
 * Varian longgar khusus nilai KONFIGURASI (Script Properties / prompt admin).
 * Menerima URL maupun ID telanjang dengan panjang berapa pun, karena nilai ini
 * diketik operator dan bukan hasil tempelan massal seperti kolom E.
 * Parser kolom E sengaja tetap ketat agar teks seperti "TIDAK ADA ROLINGAN"
 * tidak pernah berubah menjadi fileId palsu.
 */
function rscConfigId_(v) {
  var s = rscText_(v);
  if (!s) return '';
  var strict = rscFileId_(s);
  if (strict) return strict;
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
  return '';
}

/** Tanggal -> 'YYYY-MM-DD'. Menerima Date, serial, atau string. */
function rscDateStr_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && isFinite(v)) v = String(Math.round(v));
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return rscPad_(v.getFullYear(), 4) + '-' + rscPad_(v.getMonth() + 1, 2) + '-' + rscPad_(v.getDate(), 2);
  }
  var s = rscText_(v);
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[3], 2);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return m[3] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[1], 2);
  if (/^\d+(\.\d+)?$/.test(s)) {
    var num = Number(s);
    var d;
    if (num >= 1e11) {
      // Epoch milidetik (dipakai DB master: 253402214400000 = 9999-12-31).
      d = new Date(num);
    } else if (num > 0 && num < 500000) {
      // Serial tanggal gaya spreadsheet.
      d = new Date(Math.round((num - 25569) * 86400000));
    }
    if (d && !isNaN(d.getTime())) {
      return rscPad_(d.getUTCFullYear(), 4) + '-' + rscPad_(d.getUTCMonth() + 1, 2) + '-' + rscPad_(d.getUTCDate(), 2);
    }
  }
  return '';
}

function rscPad_(n, w) {
  var s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

function rscIsValidDateStr_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (s === RSC_CFG.OPEN_ENDED_DATE) return true;
  var y = Number(s.slice(0, 4)), mo = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function rscNowIso_() { return new Date().toISOString(); }

function rscUuid_() {
  try { return Utilities.getUuid(); }
  catch (e) { return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e9); }
}

function rscSleep_(ms) {
  try { Utilities.sleep(ms); }
  catch (e) { /* di luar GAS: no-op */ }
}

/** Potong array menjadi potongan berukuran n. */
function rscChunk_(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function rscUniq_(arr) {
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) {
    var k = String(arr[i]);
    if (!seen[k]) { seen[k] = 1; out.push(arr[i]); }
  }
  return out;
}

function rscRound_(n, d) {
  var f = Math.pow(10, d || 0);
  return Math.round(Number(n || 0) * f) / f;
}

function rscProps_() { return PropertiesService.getScriptProperties(); }
function rscCache_() { return CacheService.getScriptCache(); }

function rscGetProp_(k, dflt) {
  try {
    var v = rscProps_().getProperty(k);
    return (v === null || v === undefined) ? (dflt === undefined ? '' : dflt) : v;
  } catch (e) { return dflt === undefined ? '' : dflt; }
}

function rscSetProp_(k, v) {
  try {
    if (v === null || v === undefined || v === '') rscProps_().deleteProperty(k);
    else rscProps_().setProperty(k, String(v));
  } catch (e) { /* diabaikan: properti bersifat best-effort */ }
}

/** Awal periode rolling (YYYY-MM-01). Dipakai rule tanggal. */
function rscPeriodStart_() {
  var p = rscGetProp_(RSC_CFG.PROP.PERIOD, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  var d = new Date();
  return rscPad_(d.getFullYear(), 4) + '-' + rscPad_(d.getMonth() + 1, 2) + '-01';
}

/* ==========================================================================
 * 3. KLASIFIKASI ERROR  — inti perbaikan [F2]
 * ======================================================================== */

var RSC_ERR = {
  INFRA: 'INFRA',     // lock/lease/kuota/timeout/5xx  -> defer, TIDAK menambah Attempts
  ACCESS: 'ACCESS',   // tidak punya akses / file hilang -> kegagalan data (perlu tindakan user)
  DATA: 'DATA',       // layout/isi salah               -> Attempts++
  FATAL: 'FATAL'      // bug kode                       -> Attempts++, dilaporkan penuh
};

/** Error infrastruktur yang harus di-defer, bukan dihitung sebagai attempt. */
function RscInfraError(msg, meta) {
  this.name = 'RscInfraError';
  this.message = msg;
  this.rscKind = RSC_ERR.INFRA;
  this.meta = meta || {};
}
RscInfraError.prototype = Object.create(Error.prototype);

/** Kegagalan data pada file yang divalidasi. */
function RscDataError(msg, meta) {
  this.name = 'RscDataError';
  this.message = msg;
  this.rscKind = RSC_ERR.DATA;
  this.meta = meta || {};
}
RscDataError.prototype = Object.create(Error.prototype);

function RscAccessError(msg, meta) {
  this.name = 'RscAccessError';
  this.message = msg;
  this.rscKind = RSC_ERR.ACCESS;
  this.meta = meta || {};
}
RscAccessError.prototype = Object.create(Error.prototype);

var RSC_INFRA_PATTERNS = [
  /lock/i, /lease/i, /busy/i, /contention/i, /concurrent/i,
  /timed? ?out/i, /timeout/i, /deadline/i,
  /rate limit/i, /quota/i, /too many/i, /try again/i, /coba lagi/i,
  /internal error/i, /service error/i, /unavailable/i, /backend/i,
  /server error/i, /\b50[0234]\b/, /transient/i,
  /gagal sementara/i, /sedang dipakai/i
];

var RSC_ACCESS_PATTERNS = [
  /permission/i, /izin/i, /access denied/i, /not authorized/i, /unauthorized/i,
  /you do not have/i, /tidak memiliki akses/i,
  /not found/i, /tidak ditemukan/i, /no item with the given id/i, /\b40[34]\b/
];

/**
 * Menentukan jenis error tanpa pernah salah menghitung DB_BUSY sebagai
 * kegagalan validasi. Ini yang membuat "Task gagal pada attempt N" tidak lagi
 * muncul untuk kondisi DB sibuk.
 */
function rscClassify_(err) {
  if (!err) return { kind: RSC_ERR.FATAL, message: 'Unknown error' };
  if (err.rscKind) return { kind: err.rscKind, message: err.message || String(err), meta: err.meta || {} };

  var msg = (err && err.message) ? String(err.message) : String(err);
  var i;
  for (i = 0; i < RSC_INFRA_PATTERNS.length; i++) {
    if (RSC_INFRA_PATTERNS[i].test(msg)) return { kind: RSC_ERR.INFRA, message: msg };
  }
  for (i = 0; i < RSC_ACCESS_PATTERNS.length; i++) {
    if (RSC_ACCESS_PATTERNS[i].test(msg)) return { kind: RSC_ERR.ACCESS, message: msg };
  }
  return { kind: RSC_ERR.FATAL, message: msg };
}

function rscIsInfra_(err) { return rscClassify_(err).kind === RSC_ERR.INFRA; }

/** Backoff eksponensial + jitter, dibatasi RETRY_MAX_MS. */
function rscBackoffMs_(n) {
  var base = RSC_CFG.RUN.RETRY_BASE_MS * Math.pow(2, Math.max(0, n - 1));
  var capped = Math.min(base, RSC_CFG.RUN.RETRY_MAX_MS);
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

/**
 * Jalankan fn dengan retry otomatis khusus error INFRA.
 * Error DATA/ACCESS langsung dilempar (retry tidak akan menolong).
 */
function rscRetry_(label, tries, fn) {
  var last = null;
  for (var i = 1; i <= tries; i++) {
    try { return fn(i); }
    catch (e) {
      last = e;
      var c = rscClassify_(e);
      if (c.kind !== RSC_ERR.INFRA || i === tries) throw e;
      rscSleep_(rscBackoffMs_(i));
    }
  }
  throw last;
}

/* ==========================================================================
 * 4. LEASE PER-RESOURCE  — inti perbaikan [F1]
 * --------------------------------------------------------------------------
 * Masalah lama: satu LockService global dipegang selama seluruh pembacaan DB
 * berat, sehingga 4 lane saling menunggu 45 detik dan seluruh bundle di-defer.
 *
 * Pola baru:
 *   - LockService global hanya dipakai <2 detik untuk compare-and-set entri
 *     lease di Script Properties.
 *   - Pekerjaan panjang berjalan TANPA memegang lock global.
 *   - Lease punya expiry, jadi execution yang mati tidak mengunci selamanya.
 *   - Resource berbeda (mis. index BP_RELATION vs VISIT_SCHEDULE) berjalan
 *     paralel penuh.
 * ======================================================================== */

/** Critical section super pendek yang dilindungi lock global. */
function rscAtomic_(fn, waitMs) {
  var lock = null;
  try { lock = LockService.getScriptLock(); } catch (e) { lock = null; }
  if (!lock) return fn();                 // lingkungan tanpa LockService (uji)
  if (!lock.tryLock(waitMs || 3000)) {
    throw new RscInfraError('Tidak dapat mengambil lock global untuk operasi atomik.');
  }
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch (e2) { /* sudah lepas */ } }
}

/** Coba ambil lease bernama. Mengembalikan token bila berhasil, '' bila sibuk. */
function rscLeaseAcquire_(resource, ttlMs) {
  var key = RSC_CFG.PROP.LEASE + resource;
  var token = rscUuid_();
  var now = Date.now();
  return rscAtomic_(function () {
    var raw = rscGetProp_(key, '');
    if (raw) {
      var cur = null;
      try { cur = JSON.parse(raw); } catch (e) { cur = null; }
      if (cur && Number(cur.until) > now) return '';   // masih dipegang orang lain
    }
    rscSetProp_(key, JSON.stringify({ token: token, until: now + (ttlMs || 60000), by: rscWhoAmI_() }));
    return token;
  }, 3000);
}

/** Lepas lease hanya bila token cocok (mencegah lepas milik orang lain). */
function rscLeaseRelease_(resource, token) {
  if (!token) return;
  var key = RSC_CFG.PROP.LEASE + resource;
  try {
    rscAtomic_(function () {
      var raw = rscGetProp_(key, '');
      if (!raw) return;
      var cur = null;
      try { cur = JSON.parse(raw); } catch (e) { cur = null; }
      if (cur && cur.token === token) rscSetProp_(key, '');
    }, 3000);
  } catch (e) { /* lease akan kedaluwarsa sendiri */ }
}

function rscWhoAmI_() {
  try { return Session.getEffectiveUser().getEmail() || 'unknown'; }
  catch (e) { return 'unknown'; }
}

function rscActiveUser_() {
  try { return Session.getActiveUser().getEmail() || rscWhoAmI_(); }
  catch (e) { return rscWhoAmI_(); }
}

/* ==========================================================================
 * 5. SNAPSHOT CACHE BERPOTONG
 * --------------------------------------------------------------------------
 * CacheService dibatasi ~100KB per entry. Snapshot index dipecah menjadi
 * potongan < CHUNK_BYTES dan disatukan kembali saat dibaca. Satu entry "meta"
 * menyimpan jumlah potongan sehingga pembacaan parsial terdeteksi.
 * ======================================================================== */

function rscSnapKey_(name, ver, part) {
  return 'RSCSNAP:' + name + ':' + ver + ':' + part;
}

function rscSnapWrite_(name, ver, obj) {
  var json = JSON.stringify(obj);
  var parts = [];
  for (var i = 0; i < json.length; i += RSC_CFG.INDEX.CHUNK_BYTES) {
    parts.push(json.substring(i, i + RSC_CFG.INDEX.CHUNK_BYTES));
  }
  var map = {};
  for (var p = 0; p < parts.length; p++) map[rscSnapKey_(name, ver, p)] = parts[p];
  map[rscSnapKey_(name, ver, 'meta')] = JSON.stringify({ n: parts.length, bytes: json.length, at: rscNowIso_() });
  try {
    var cache = rscCache_();
    var keys = Object.keys(map);
    // putAll dibatasi jumlah entri; tulis bertahap.
    var groups = rscChunk_(keys, 50);
    for (var g = 0; g < groups.length; g++) {
      var sub = {};
      for (var k = 0; k < groups[g].length; k++) sub[groups[g][k]] = map[groups[g][k]];
      cache.putAll(sub, RSC_CFG.INDEX.CACHE_TTL_SEC);
    }
    return { ok: true, parts: parts.length, bytes: json.length };
  } catch (e) {
    return { ok: false, parts: parts.length, bytes: json.length, error: String(e) };
  }
}

function rscSnapRead_(name, ver) {
  var cache;
  try { cache = rscCache_(); } catch (e) { return null; }
  var metaRaw = cache.get(rscSnapKey_(name, ver, 'meta'));
  if (!metaRaw) return null;
  var meta;
  try { meta = JSON.parse(metaRaw); } catch (e) { return null; }
  var keys = [];
  for (var i = 0; i < meta.n; i++) keys.push(rscSnapKey_(name, ver, i));
  var got = cache.getAll(keys);
  var buf = '';
  for (var j = 0; j < keys.length; j++) {
    var piece = got[keys[j]];
    if (piece === null || piece === undefined) return null;   // potongan hilang -> anggap miss
    buf += piece;
  }
  try { return JSON.parse(buf); } catch (e) { return null; }
}

/* ==========================================================================
 * 6. LAYER INDEX MASTER  — inti perbaikan [F3]
 * --------------------------------------------------------------------------
 * Master dibaca SEKALI per versi menjadi hash-index. Setelah itu setiap lookup
 * adalah O(1), berapa pun jumlah ID yang dibutuhkan. Tidak ada lagi ambang
 * "MAX_TARGETED_IDS" yang memicu full scan.
 * ======================================================================== */

var RSC_MEM_INDEX = {};   // cache tingkat-execution (paling cepat)

/* --------------------------------------------------------------------------
 * Penyimpanan index bertingkat.
 *
 * CacheService dibatasi ~100KB per entry dan kapasitas total yang tidak besar.
 * Tabel seperti m_bp_relation (puluhan MB / ratusan ribu baris) menghasilkan
 * snapshot yang jauh melewati batas itu, sehingga penulisan ke cache gagal dan
 * SETIAP execution terpaksa membangun ulang index dari sumber — persis pola
 * yang membuat versi lama macet.
 *
 * Karena itu snapshot besar dimaterialisasi ke spreadsheet index tersendiri
 * (2 kolom: key + nilai terpaket). Membacanya jauh lebih murah daripada
 * memindai sumber aslinya, dan hasilnya tetap dibagi ke semua execution.
 * -------------------------------------------------------------------------- */

/** Spreadsheet penampung index. Dibuat sekali, lalu dipakai ulang. */
function rscIndexStore_(createIfMissing) {
  var id = rscGetProp_(RSC_CFG.PROP.INDEX_STORE, '');
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) { rscSetProp_(RSC_CFG.PROP.INDEX_STORE, ''); }
  }
  if (!createIfMissing) return null;
  try {
    var ss = SpreadsheetApp.create('_RSC_INDEX_CACHE (jangan dihapus)');
    rscSetProp_(RSC_CFG.PROP.INDEX_STORE, ss.getId());
    return ss;
  } catch (e2) { return null; }
}

function rscIdxSheetName_(tableName) { return 'IDX_' + tableName; }

/** Tulis index ke sheet: A1 = penanda versi, mulai baris 2 = [key, nilai JSON]. */
function rscIdxSheetWrite_(tableName, ver, built) {
  var ss = rscIndexStore_(true);
  if (!ss) return { ok: false, reason: 'NO_STORE' };
  var name = rscIdxSheetName_(tableName);
  var sh = ss.getSheetByName(name);
  try {
    if (sh) ss.deleteSheet(sh);
    sh = ss.insertSheet(name);
  } catch (e) { return { ok: false, reason: String(e) }; }

  var keys = Object.keys(built.map);
  sh.getRange(1, 1, 1, 2).setValues([[
    ver,
    JSON.stringify({ rows: built.rows, sheet: built.sheet, source: built.source, mode: built.mode, keys: keys.length })
  ]]);

  var row = 2, i = 0;
  var block = RSC_CFG.INDEX.SHEET_WRITE_ROWS;
  while (i < keys.length) {
    var n = Math.min(block, keys.length - i);
    var out = [];
    for (var k = 0; k < n; k++) {
      out.push([keys[i + k], JSON.stringify(built.map[keys[i + k]])]);
    }
    sh.getRange(row, 1, n, 2).setValues(out);
    row += n; i += n;
  }
  return { ok: true, keys: keys.length };
}

/** Baca index dari sheet bila penanda versinya cocok. */
function rscIdxSheetRead_(tableName, ver) {
  var ss = rscIndexStore_(false);
  if (!ss) return null;
  var sh = ss.getSheetByName(rscIdxSheetName_(tableName));
  if (!sh) return null;
  var head = sh.getRange(1, 1, 1, 2).getDisplayValues()[0];
  if (rscText_(head[0]) !== ver) return null;                 // index basi
  var meta = {};
  try { meta = JSON.parse(head[1] || '{}'); } catch (e) { meta = {}; }

  var last = sh.getLastRow();
  var map = {}, row = 2;
  var win = RSC_CFG.INDEX.SHEET_READ_ROWS;
  while (row <= last) {
    var n = Math.min(win, last - row + 1);
    var vals = sh.getRange(row, 1, n, 2).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var key = vals[r][0];
      if (!key) continue;
      try { map[key] = JSON.parse(vals[r][1]); } catch (e2) { /* baris rusak dilewati */ }
    }
    row += n;
  }
  return {
    available: true, map: map, rows: meta.rows || 0, sheet: meta.sheet || '',
    source: meta.source || '', mode: meta.mode || '', storedIn: 'sheet'
  };
}

/** Simpan snapshot: cache bila muat, selain itu materialisasi ke sheet index. */
function rscIndexPersist_(tableName, ver, built) {
  var json = JSON.stringify(built);
  if (json.length <= RSC_CFG.INDEX.CACHE_MAX_BYTES) {
    var w = rscSnapWrite_(tableName, ver, built);
    if (w.ok) { built.storedIn = 'cache'; return built; }
  }
  var r = rscIdxSheetWrite_(tableName, ver, built);
  built.storedIn = r.ok ? 'sheet' : 'memory-only';
  built.persistNote = r.ok ? '' : ('gagal materialisasi index: ' + (r.reason || '-'));
  return built;
}

/** Semua spreadsheet DB yang dikonfigurasi (utama + tambahan, dipisah koma). */
function rscDbSources_() {
  var out = [];
  var main = rscConfigId_(rscGetProp_(RSC_CFG.PROP.DB_ID, ''));
  if (main) out.push(main);
  var extra = rscGetProp_(RSC_CFG.PROP.DB_ID_EXTRA, '');
  if (extra) {
    var parts = extra.split(/[,;\s]+/);
    for (var i = 0; i < parts.length; i++) {
      var id = rscConfigId_(parts[i]);
      if (id && out.indexOf(id) < 0) out.push(id);
    }
  }
  return out;
}

function rscDbId_() { var a = rscDbSources_(); return a.length ? a[0] : ''; }

/** Versi index = sidik jari file DB. Berubah bila DB diperbarui. */
function rscIndexVersion_() {
  var ids = rscDbSources_();
  if (!ids.length) return 'nodb';
  var tag = ids.join(',');
  var cached = rscGetProp_(RSC_CFG.PROP.INDEX_VER + tag, '');
  var cachedAt = Number(rscGetProp_(RSC_CFG.PROP.INDEX_VER + tag + ':at', '0'));
  if (cached && (Date.now() - cachedAt) < 300000) return cached;   // stabil 5 menit
  var stamps = [];
  for (var i = 0; i < ids.length; i++) {
    try { stamps.push(DriveApp.getFileById(ids[i]).getLastUpdated().getTime()); }
    catch (e) { stamps.push(Math.floor(Date.now() / 3600000)); }   // fallback per jam
  }
  var ver = 'v' + stamps.join('-');
  rscSetProp_(RSC_CFG.PROP.INDEX_VER + tag, ver);
  rscSetProp_(RSC_CFG.PROP.INDEX_VER + tag + ':at', String(Date.now()));
  return ver;
}

/**
 * Cari sheet yang cocok dari daftar alias (case/spasi-insensitif).
 *
 * Pencocokan sengaja KETAT. Toleransi prefix hanya diberikan untuk kasus nyata
 * "nama sheet terpotong 31 karakter" (batas nama tab pada file hasil ekspor
 * xlsx). Tanpa batasan ini, alias pendek seperti "m_bp" akan menyambar tab
 * "m_bp_relation", dan alias "m_bp_relation_type" akan menyambar tab
 * "m_bp_relation" — keduanya membuat master terbaca dari tabel yang salah.
 */
var RSC_SHEET_NAME_LIMIT = 31;

function rscFindSheet_(ss, aliases) {
  var sheets = ss.getSheets();
  var byKey = {};
  for (var i = 0; i < sheets.length; i++) {
    var k = rscKey_(sheets[i].getName());
    if (!(k in byKey)) byKey[k] = sheets[i];
  }

  // 1. kecocokan persis
  for (var a = 0; a < aliases.length; a++) {
    var hit = byKey[rscKey_(aliases[a])];
    if (hit) return hit;
  }

  // 2. hanya untuk nama tab yang terpotong batas 31 karakter
  for (var b = 0; b < aliases.length; b++) {
    var want = rscKey_(aliases[b]);
    for (var key in byKey) {
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) continue;
      var truncated = byKey[key].getName().length >= RSC_SHEET_NAME_LIMIT;
      if (truncated && want.length > key.length && want.indexOf(key) === 0) return byKey[key];
    }
  }
  return null;
}

/** Peta headerKey -> indeks kolom (0-based). */
function rscHeaderMap_(headerRow) {
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    var k = rscKey_(headerRow[i]);
    if (k && !(k in map)) map[k] = i;
  }
  return map;
}

function rscPickCol_(hmap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var k = rscKey_(candidates[i]);
    if (k in hmap) return hmap[k];
  }
  return -1;
}

/**
 * Bangun index untuk satu tabel master.
 * Membaca bertahap per READ_WINDOW_ROWS baris agar aman untuk sheet besar,
 * dan hanya kolom yang dibutuhkan yang disalin ke dalam index.
 */
/** Cari sheet tabel di seluruh spreadsheet DB yang dikonfigurasi. */
function rscLocateTable_(spec) {
  var ids = rscDbSources_();
  for (var i = 0; i < ids.length; i++) {
    var ss;
    try { ss = SpreadsheetApp.openById(ids[i]); }
    catch (e) {
      var c = rscClassify_(e);
      if (c.kind === RSC_ERR.INFRA) throw new RscInfraError('Gagal membuka spreadsheet DB: ' + c.message);
      continue;                                  // sumber ini tidak terbaca, coba berikutnya
    }
    var sh = rscFindSheet_(ss, spec.sheets);
    if (sh) return { sheet: sh, ssId: ids[i], ssName: ss.getName() };
  }
  return null;
}

/**
 * Tentukan pemetaan kolom.
 * Mode header : baris 1 adalah nama kolom (mis. m_sales_info).
 * Mode posisional: baris 1 sudah berisi data atau catatan lain, sehingga urutan
 *                  kolom diambil dari spec.positional (mis. m_bp_relation yang
 *                  baris pertamanya berupa URL, bukan header).
 */
function rscResolveColumns_(spec, headerRow) {
  var hmap = rscHeaderMap_(headerRow);
  var keyIdx = [], ok = true;
  for (var k = 0; k < spec.keyCols.length; k++) {
    var ci = rscPickCol_(hmap, spec.keyCols[k]);
    if (ci < 0) { ok = false; break; }
    keyIdx.push(ci);
  }
  if (ok && keyIdx.length) {
    var valIdx = [];
    for (var v = 0; v < spec.valCols.length; v++) {
      valIdx.push({ name: spec.valCols[v].name, idx: rscPickCol_(hmap, spec.valCols[v].aliases) });
    }
    return { mode: 'header', firstDataRow: 2, keyIdx: keyIdx, valIdx: valIdx };
  }

  if (!spec.positional) return null;

  var pos = {};
  for (var p = 0; p < spec.positional.length; p++) pos[rscKey_(spec.positional[p])] = p;
  var pKey = [];
  for (var kk = 0; kk < spec.keyCols.length; kk++) {
    var found = -1;
    for (var a = 0; a < spec.keyCols[kk].length; a++) {
      var idx = pos[rscKey_(spec.keyCols[kk][a])];
      if (idx !== undefined) { found = idx; break; }
    }
    if (found < 0) return null;
    pKey.push(found);
  }
  var pVal = [];
  for (var vv = 0; vv < spec.valCols.length; vv++) {
    var fi = -1;
    for (var b = 0; b < spec.valCols[vv].aliases.length; b++) {
      var pi = pos[rscKey_(spec.valCols[vv].aliases[b])];
      if (pi !== undefined) { fi = pi; break; }
    }
    pVal.push({ name: spec.valCols[vv].name, idx: fi });
  }
  return { mode: 'positional', firstDataRow: 1, keyIdx: pKey, valIdx: pVal };
}

/**
 * Bangun index untuk satu tabel master.
 * Dibaca bertahap per READ_WINDOW_ROWS baris agar aman untuk sheet puluhan MB,
 * dan hanya kolom yang dibutuhkan yang disalin ke dalam index.
 */
function rscBuildIndex_(tableName) {
  var spec = RSC_CFG.DB_TABLES[tableName];
  if (!spec) throw new RscDataError('Tabel master tidak dikenal: ' + tableName);
  if (!rscDbSources_().length) return { available: false, reason: 'DB_NOT_CONFIGURED', map: {}, rows: 0 };

  var loc = rscLocateTable_(spec);
  if (!loc) return { available: false, reason: 'TABLE_NOT_FOUND', map: {}, rows: 0 };

  var sh = loc.sheet;
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { available: true, map: {}, rows: 0, sheet: sh.getName() };

  var headerRow = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var cols = rscResolveColumns_(spec, headerRow);
  if (!cols) return { available: false, reason: 'KEY_COLUMN_MISSING', map: {}, rows: 0, sheet: sh.getName() };

  var keyRe = spec.keyPattern ? new RegExp(spec.keyPattern) : null;
  var maxPerKey = spec.maxPerKey || 8;
  var map = {}, total = 0, skipped = 0, expired = 0;

  // Untuk tabel besar, baris yang masa berlakunya sudah lewat tidak perlu
  // diindeks: rule hanya memeriksa relasi yang masih aktif.
  var activeIdx = -1;
  var cutoff = '';
  if (spec.activeOnly) {
    for (var ai = 0; ai < cols.valIdx.length; ai++) {
      if (cols.valIdx[ai].name === spec.activeOnly) { activeIdx = cols.valIdx[ai].idx; break; }
    }
    var grace = Number(spec.activeGraceDays || 0);
    cutoff = rscDateStr_(new Date(Date.now() - grace * 86400000));
  }
  var row = cols.firstDataRow;
  var win = RSC_CFG.INDEX.READ_WINDOW_ROWS;

  while (row <= lastRow) {
    var n = Math.min(win, lastRow - row + 1);
    var block = sh.getRange(row, 1, n, lastCol).getDisplayValues();
    for (var r = 0; r < block.length; r++) {
      var parts = [], blank = true, bad = false;
      for (var kk = 0; kk < cols.keyIdx.length; kk++) {
        var kv = rscIdOnly_(block[r][cols.keyIdx[kk]]);
        if (kv) blank = false;
        if (kk === 0 && keyRe && kv && !keyRe.test(kv)) bad = true;
        parts.push(kv.toUpperCase());
      }
      if (blank) continue;
      if (bad) { skipped++; continue; }      // baris URL/catatan pada sheet tanpa header
      if (activeIdx >= 0) {
        var vt = rscDateStr_(block[r][activeIdx]);
        if (vt && vt < cutoff) { expired++; continue; }
      }
      var key = parts.join('|');
      var rec = {};
      for (var vv = 0; vv < cols.valIdx.length; vv++) {
        rec[cols.valIdx[vv].name] = cols.valIdx[vv].idx >= 0 ? rscText_(block[r][cols.valIdx[vv].idx]) : '';
      }
      if (!map[key]) map[key] = [];
      if (map[key].length < maxPerKey) map[key].push(rec);
      total++;
    }
    row += n;
  }

  return {
    available: true, map: map, rows: total, skippedRows: skipped, expiredRows: expired,
    sheet: sh.getName(), source: loc.ssName, sourceId: loc.ssId, mode: cols.mode
  };
}

/**
 * Ambil index (memori -> cache -> bangun). Tidak pernah memegang lock global
 * selama pembangunan; hanya lease per-tabel.
 */
function rscGetIndex_(tableName) {
  var ver = rscIndexVersion_();
  var memKey = tableName + ':' + ver;
  if (RSC_MEM_INDEX[memKey]) return RSC_MEM_INDEX[memKey];

  if (!rscDbSources_().length) {
    var none = { available: false, reason: 'DB_NOT_CONFIGURED', map: {}, rows: 0, ver: ver };
    RSC_MEM_INDEX[memKey] = none;
    return none;
  }

  var snap = rscSnapRead_(tableName, ver);
  if (snap) { snap.ver = ver; snap.storedIn = 'cache'; RSC_MEM_INDEX[memKey] = snap; return snap; }

  var sheetSnap = rscIdxSheetRead_(tableName, ver);
  if (sheetSnap) { sheetSnap.ver = ver; RSC_MEM_INDEX[memKey] = sheetSnap; return sheetSnap; }

  var resource = 'IDX:' + tableName + ':' + ver;
  var token = rscLeaseAcquire_(resource, RSC_CFG.INDEX.BUILD_LEASE_MS);

  if (!token) {
    // Builder lain sedang bekerja. Tunggu sebentar, lalu baca cache.
    var waited = 0;
    while (waited < RSC_CFG.INDEX.WAIT_MS) {
      rscSleep_(RSC_CFG.INDEX.WAIT_STEP_MS);
      waited += RSC_CFG.INDEX.WAIT_STEP_MS;
      var again = rscSnapRead_(tableName, ver) || rscIdxSheetRead_(tableName, ver);
      if (again) { again.ver = ver; RSC_MEM_INDEX[memKey] = again; return again; }
    }
    throw new RscInfraError(
      'Index master "' + tableName + '" sedang dibangun execution lain. Task dijadwalkan ulang tanpa menambah Attempts.',
      { resource: resource, waitedMs: waited }
    );
  }

  try {
    var recheck = rscSnapRead_(tableName, ver) || rscIdxSheetRead_(tableName, ver);
    if (recheck) { recheck.ver = ver; RSC_MEM_INDEX[memKey] = recheck; return recheck; }
    var built = rscBuildIndex_(tableName);
    built.ver = ver;
    built.builtAt = rscNowIso_();
    if (built.available) rscIndexPersist_(tableName, ver, built);
    RSC_MEM_INDEX[memKey] = built;
    return built;
  } finally {
    rscLeaseRelease_(resource, token);
  }
}

/**
 * Lookup banyak key sekaligus. O(k) murni terhadap index in-memory.
 * Tidak ada ambang jumlah ID dan tidak ada jalur full-scan.
 */
function rscLookupMany_(index, keys) {
  var out = {};
  if (!index || !index.available) return out;
  for (var i = 0; i < keys.length; i++) {
    var k = String(keys[i]).toUpperCase();
    var hit = index.map[k];
    if (hit) out[k] = hit;
  }
  return out;
}

function rscIndexHas_(index, key) {
  if (!index || !index.available) return null;      // null = tidak diketahui
  return !!index.map[String(key).toUpperCase()];
}

/* ==========================================================================
 * 7. REGISTRY SPEC SHEET  — inti perbaikan [F6]
 * --------------------------------------------------------------------------
 * Semua sheet yang divalidasi dideklarasikan di sini. Engine, normalisasi,
 * penulisan hasil, dan pelaporan identik untuk semuanya; yang berbeda hanya
 * daftar kolom dan daftar rule.
 * ======================================================================== */

var RSC_SPECS = [
  {
    key: 'ROLLING',
    label: 'Change Rolling & Change Schedule',
    names: ['Change Rolling & Change Schedule', 'Change Rolling & Change Schedul', 'Change Rolling'],
    primary: true,
    header: [
      'Sales Office', 'Delivering Plant', 'Customer ID', 'Relationship', 'Salesman ID',
      'Salesman BP Type', 'Valid From', 'Valid To', 'Visit Category', 'Visit Type',
      'Schedule Visit', 'Visit Valid From', 'Visit Valid To', 'Reason',
      'Validation Status', 'Error Detail'
    ],
    statusCol: 15,
    errorCol: 16,
    dateFields: ['Valid From', 'Valid To', 'Visit Valid From', 'Visit Valid To'],
    idFields: ['Sales Office', 'Delivering Plant', 'Relationship', 'Salesman BP Type', 'Visit Category', 'Visit Type'],
    required: ['Sales Office', 'Delivering Plant', 'Customer ID', 'Relationship', 'Salesman ID',
               'Salesman BP Type', 'Valid From', 'Valid To', 'Visit Category', 'Visit Type',
               'Schedule Visit', 'Visit Valid From', 'Visit Valid To', 'Reason'],
    rowRules: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R9', 'R10'],
    tableRules: ['R7', 'R8a', 'R8b', 'TB']
  },
  {
    key: 'SALESMAN_TYPE',
    label: 'Change Salesman Type',
    names: ['Change Salesman Type'],
    header: ['Salesman ID', 'Sales Organization', 'Sales Office', 'Sales Type', 'Coverage',
             'Valid From', 'Valid To', 'Validation Status', 'Error Detail'],
    statusCol: 8,
    errorCol: 9,
    dateFields: ['Valid From', 'Valid To'],
    idFields: ['Sales Organization', 'Sales Office', 'Sales Type'],
    required: ['Salesman ID', 'Sales Organization', 'Sales Office', 'Sales Type', 'Valid From', 'Valid To'],
    rowRules: ['R1', 'R3', 'R4', 'R9'],
    tableRules: ['R8a']
  },
  {
    key: 'SALES_OFFICE',
    label: 'Change Sales Office',
    names: ['Change Sales Office'],
    header: ['BP Number Source', 'Delivering Plant', 'Distr. Channel', 'Division',
             'Sales Organization', 'Sales Office', 'Validation Status', 'Error Detail'],
    statusCol: 7,
    errorCol: 8,
    dateFields: [],
    idFields: ['Sales Organization', 'Sales Office', 'Distr. Channel', 'Division'],
    required: ['BP Number Source', 'Sales Organization', 'Sales Office'],
    rowRules: ['R1', 'R3', 'R10'],
    tableRules: ['R8a']
  }
];

function rscSpecFor_(sheetName) {
  var k = rscKey_(sheetName);
  for (var i = 0; i < RSC_SPECS.length; i++) {
    var names = RSC_SPECS[i].names;
    for (var n = 0; n < names.length; n++) {
      var nk = rscKey_(names[n]);
      if (k === nk || k.indexOf(nk) === 0 || nk.indexOf(k) === 0) return RSC_SPECS[i];
    }
  }
  return null;
}

function rscPrimarySpec_() {
  for (var i = 0; i < RSC_SPECS.length; i++) if (RSC_SPECS[i].primary) return RSC_SPECS[i];
  return RSC_SPECS[0];
}

function rscColLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/* ==========================================================================
 * 8. ENGINE VALIDASI
 * ======================================================================== */

/** Master lokal (Sales Office) diturunkan dari sheet "em" di file induk. */
function rscOfficeMaster_(masterSs) {
  var memKey = 'OFFICES';
  if (RSC_MEM_INDEX[memKey]) return RSC_MEM_INDEX[memKey];
  var out = { available: false, map: {}, plants: {} };
  try {
    var sh = rscFindSheet_(masterSs, [RSC_CFG.SHEET.EM]);
    if (!sh) { RSC_MEM_INDEX[memKey] = out; return out; }
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2) { RSC_MEM_INDEX[memKey] = out; return out; }
    var header = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var hmap = rscHeaderMap_(header);
    var cOffice = rscPickCol_(hmap, ['Sales Office']);
    var cDesc = -1;
    // "Description" muncul dua kali (Sales Org & Sales Office). Ambil yang
    // tepat setelah kolom Sales Office.
    if (cOffice >= 0 && cOffice + 1 < header.length && rscKey_(header[cOffice + 1]) === 'DESCRIPTION') cDesc = cOffice + 1;
    var cOrg = rscPickCol_(hmap, ['Sales Org', 'Sales Organization']);
    if (cOffice < 0) { RSC_MEM_INDEX[memKey] = out; return out; }
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var code = rscIdOnly_(vals[r][cOffice]).toUpperCase();
      if (!code) continue;
      if (!out.map[code]) {
        out.map[code] = {
          code: code,
          desc: cDesc >= 0 ? rscText_(vals[r][cDesc]) : '',
          org: cOrg >= 0 ? rscIdOnly_(vals[r][cOrg]).toUpperCase() : ''
        };
      }
    }
    out.available = Object.keys(out.map).length > 0;
  } catch (e) {
    out.available = false;
    out.error = String(e);
  }
  RSC_MEM_INDEX[memKey] = out;
  return out;
}

/** Master Relationship: DB eksternal bila ada, jika tidak pakai daftar bawaan. */
function rscRelationshipMaster_() {
  var memKey = 'RELTYPE';
  if (RSC_MEM_INDEX[memKey]) return RSC_MEM_INDEX[memKey];
  var out = { available: true, source: 'builtin', map: {} };
  var k;
  for (k in RSC_CFG.RELATIONSHIP_BUILTIN) {
    if (Object.prototype.hasOwnProperty.call(RSC_CFG.RELATIONSHIP_BUILTIN, k)) {
      out.map[k] = RSC_CFG.RELATIONSHIP_BUILTIN[k];
    }
  }
  try {
    var idx = rscGetIndex_('RELATION_TYPE');
    if (idx && idx.available && idx.rows > 0) {
      var m = {};
      for (var key in idx.map) {
        if (Object.prototype.hasOwnProperty.call(idx.map, key)) m[key] = (idx.map[key][0] || {}).Description || '';
      }
      if (Object.keys(m).length) { out.map = m; out.source = 'db'; }
    }
  } catch (e) {
    // index sedang dibangun -> tetap pakai daftar bawaan, jangan gagalkan task.
    out.note = 'fallback builtin: ' + String(e && e.message ? e.message : e);
  }
  RSC_MEM_INDEX[memKey] = out;
  return out;
}

/** Uraikan "W1W,W3W" menjadi token terstruktur. */
function rscParseSchedule_(v) {
  var raw = rscText_(v).toUpperCase();
  if (!raw) return { tokens: [], valid: [], invalid: [], weekdays: {}, weeks: {} };
  var parts = raw.split(/[,;\/]+/);
  var tokens = [], valid = [], invalid = [], weekdays = {}, weeks = {};
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i].replace(/\s+/g, '');
    if (!t) continue;
    tokens.push(t);
    var m = t.match(/^W([1-4])(SU|TH|M|T|W|F|S)$/);
    if (m) {
      valid.push(t);
      weeks[m[1]] = true;
      weekdays[m[2]] = true;
    } else {
      invalid.push(t);
    }
  }
  return { tokens: tokens, valid: valid, invalid: invalid, weekdays: weekdays, weeks: weeks, canonical: tokens.slice().sort().join(',') };
}

/**
 * Bangun konteks validasi dari nilai mentah sheet.
 * Semua nilai dinormalisasi sekali di sini agar rule tidak mengulang parsing.
 */
function rscBuildContext_(spec, values, opts) {
  var ctx = {
    spec: spec,
    rows: [],
    errors: [],
    masters: opts.masters || {},
    skipped: {},
    firstDataRow: 2
  };
  var fieldIdx = {};
  for (var c = 0; c < spec.header.length; c++) fieldIdx[spec.header[c]] = c;

  for (var r = 0; r < values.length; r++) {
    var raw = values[r];
    var f = {}, nonEmpty = false;
    for (var h = 0; h < spec.header.length; h++) {
      var name = spec.header[h];
      if (name === 'Validation Status' || name === 'Error Detail') continue;
      var val = raw[h];
      var norm;
      if (spec.dateFields.indexOf(name) >= 0) norm = rscDateStr_(val);
      else if (spec.idFields.indexOf(name) >= 0) norm = rscIdOnly_(val).toUpperCase();
      else norm = rscText_(val);
      f[name] = norm;
      if (norm) nonEmpty = true;
    }
    if (!nonEmpty) continue;                       // baris kosong diabaikan total
    ctx.rows.push({ i: ctx.rows.length, sheetRow: r + 2, f: f, raw: raw });
    ctx.errors.push([]);
  }
  ctx.fieldIdx = fieldIdx;
  return ctx;
}

function rscAddErr_(ctx, i, code, msg) {
  ctx.errors[i].push('[' + code + '] ' + msg);
}

/* ---------------------------- RULE PER BARIS ---------------------------- */

var RSC_ROW_RULES = {

  /** R1 — kolom wajib tidak boleh kosong. */
  R1: function (ctx, row, i) {
    var missing = [];
    for (var k = 0; k < ctx.spec.required.length; k++) {
      var name = ctx.spec.required[k];
      if (!row.f[name]) missing.push(name);
    }
    if (missing.length) {
      rscAddErr_(ctx, i, 'R1', 'Kolom wajib kosong: ' + missing.join(', ') + '.');
    }
  },

  /** R2 — Relationship harus terdaftar di master Relationship. */
  R2: function (ctx, row, i) {
    var rel = row.f['Relationship'];
    if (!rel) return;
    var master = ctx.masters.relationship;
    if (!master || !master.available) return;
    if (!master.map[rel]) {
      rscAddErr_(ctx, i, 'R2', 'Relationship tidak terdaftar pada master Relationship.');
    }
  },

  /** R3 — Sales Office (dan Delivering Plant) harus ada di master em. */
  R3: function (ctx, row, i) {
    var off = row.f['Sales Office'];
    var master = ctx.masters.office;
    if (!master || !master.available) { ctx.skipped['R3'] = 'master em tidak tersedia'; return; }
    if (off && !master.map[off]) {
      rscAddErr_(ctx, i, 'R3', 'Sales Office "' + off + '" tidak terdaftar pada master em.');
    }
    var plant = row.f['Delivering Plant'];
    if (plant && off && plant !== off) {
      rscAddErr_(ctx, i, 'R3', 'Delivering Plant "' + plant + '" harus sama dengan Sales Office "' + off + '".');
    }
  },

  /** R4 — format & urutan tanggal. */
  R4: function (ctx, row, i) {
    var spec = ctx.spec;
    var bad = [];
    for (var d = 0; d < spec.dateFields.length; d++) {
      var name = spec.dateFields[d];
      var v = row.f[name];
      if (!v) continue;
      if (!rscIsValidDateStr_(v)) bad.push(name + '="' + rscText_(row.raw[ctx.fieldIdx[name]]) + '"');
    }
    if (bad.length) {
      rscAddErr_(ctx, i, 'R4', 'Format tanggal harus YYYY-MM-DD: ' + bad.join(', ') + '.');
      return;
    }
    var vf = row.f['Valid From'], vt = row.f['Valid To'];
    if (vf && vt && vf > vt) {
      rscAddErr_(ctx, i, 'R4', 'Valid From (' + vf + ') tidak boleh melewati Valid To (' + vt + ').');
    }
    var vvf = row.f['Visit Valid From'], vvt = row.f['Visit Valid To'];
    if (vvf && vvt && vvf > vvt) {
      rscAddErr_(ctx, i, 'R4', 'Visit Valid From (' + vvf + ') tidak boleh melewati Visit Valid To (' + vvt + ').');
    }
    if (vf && vvf && vvf < vf) {
      rscAddErr_(ctx, i, 'R4', 'Visit Valid From (' + vvf + ') tidak boleh lebih awal dari Valid From (' + vf + ').');
    }
    var period = ctx.masters.periodStart;
    if (period && vf && vf !== RSC_CFG.OPEN_ENDED_DATE && vf < period && row.f['Reason'] !== 'Toko Bangkrut') {
      rscAddErr_(ctx, i, 'R4', 'Valid From (' + vf + ') mendahului awal periode rolling (' + period + ').');
    }
  },

  /** R5 — Visit Category & Visit Type. */
  R5: function (ctx, row, i) {
    var cat = row.f['Visit Category'];
    if (cat && !(cat in RSC_CFG.VISIT_CATEGORY)) {
      rscAddErr_(ctx, i, 'R5', 'Visit Category "' + cat + '" tidak valid. Gunakan F1, F2, F4, atau F8.');
    }
    var typ = row.f['Visit Type'];
    if (typ) {
      var t2 = typ.length === 1 ? '0' + typ : typ;
      if (RSC_CFG.VISIT_TYPES.indexOf(t2) < 0) {
        rscAddErr_(ctx, i, 'R5', 'Visit Type "' + typ + '" tidak valid. Gunakan 01 sampai 12 (2 digit).');
      } else if (t2 !== typ) {
        rscAddErr_(ctx, i, 'R5', 'Visit Type harus 2 digit. Tulis "' + t2 + '", bukan "' + typ + '".');
      }
    }
    var reason = row.f['Reason'];
    if (reason && RSC_CFG.REASONS.indexOf(reason) < 0) {
      rscAddErr_(ctx, i, 'R5', 'Reason "' + reason + '" tidak valid. Gunakan Rolling atau Toko Bangkrut.');
    }
  },

  /**
   * R6 — Schedule Visit harus konsisten dengan Visit Category.
   *      F1=1 token, F2=2, F4=4, F8=8; token wajib berformat W{1-4}{hari};
   *      minggu tidak boleh duplikat; F2 harus pola {1,3} atau {2,4};
   *      F4 harus mencakup minggu 1-4 pada hari yang sama.
   */
  R6: function (ctx, row, i) {
    var cat = row.f['Visit Category'];
    var sch = rscParseSchedule_(row.f['Schedule Visit']);
    if (!sch.tokens.length) return;

    if (sch.invalid.length) {
      rscAddErr_(ctx, i, 'R6', 'Token Schedule Visit tidak dikenal: ' + sch.invalid.join(', ') +
        '. Format yang benar W1M..W4SU.');
      return;
    }
    if (rscUniq_(sch.valid).length !== sch.valid.length) {
      rscAddErr_(ctx, i, 'R6', 'Schedule Visit mengandung token duplikat: ' + sch.tokens.join(',') + '.');
      return;
    }
    if (!cat || !(cat in RSC_CFG.VISIT_CATEGORY)) return;   // sudah dilaporkan R5

    var need = RSC_CFG.VISIT_CATEGORY[cat];
    if (sch.valid.length !== need) {
      rscAddErr_(ctx, i, 'R6', 'Visit Category ' + cat + ' membutuhkan ' + need +
        ' token Schedule Visit, ditemukan ' + sch.valid.length + ' (' + sch.tokens.join(',') + ').');
      return;
    }

    var days = Object.keys(sch.weekdays);
    var weeks = Object.keys(sch.weeks).sort().join(',');

    if (cat === 'F8') {
      if (days.length !== 2) {
        rscAddErr_(ctx, i, 'R6', 'F8 harus terdiri dari 2 hari kunjungan x 4 minggu. Ditemukan ' + days.length + ' hari.');
      } else if (weeks !== '1,2,3,4') {
        rscAddErr_(ctx, i, 'R6', 'F8 harus mencakup minggu 1,2,3,4 pada kedua hari. Ditemukan minggu ' + weeks + '.');
      }
      return;
    }

    if (days.length !== 1) {
      rscAddErr_(ctx, i, 'R6', 'Semua token Schedule Visit harus pada hari yang sama. Ditemukan hari: ' + days.join(',') + '.');
      return;
    }
    if (cat === 'F4' && weeks !== '1,2,3,4') {
      rscAddErr_(ctx, i, 'R6', 'F4 harus mencakup minggu 1,2,3,4. Ditemukan minggu ' + weeks + '.');
    }
    if (cat === 'F2' && weeks !== '1,3' && weeks !== '2,4') {
      rscAddErr_(ctx, i, 'R6', 'F2 harus berpola minggu 1&3 atau 2&4. Ditemukan minggu ' + weeks + '.');
    }
  },

  /** R9 — format & keberadaan Salesman. */
  R9: function (ctx, row, i) {
    var sid = row.f['Salesman ID'];
    if (sid && !/^S\d{9}$/.test(sid.toUpperCase())) {
      rscAddErr_(ctx, i, 'R9', 'Salesman ID "' + sid + '" tidak sesuai format S + 9 digit.');
    }
    var bp = row.f['Salesman BP Type'];
    if (bp && !/^Z[A-Z]\d{2}$/.test(bp)) {
      rscAddErr_(ctx, i, 'R9', 'Salesman BP Type "' + bp + '" tidak sesuai format (contoh ZD01).');
    }
    var idx = ctx.masters.idx && ctx.masters.idx.SALESMAN;
    if (!idx || !idx.available) { ctx.skipped['R9-master'] = 'master salesman tidak tersedia'; return; }
    if (sid && !idx.map[sid.toUpperCase()]) {
      rscAddErr_(ctx, i, 'R9', 'Salesman ID "' + sid + '" tidak ditemukan pada master salesman.');
    }
  },

  /** R10 — format & keberadaan Customer. */
  R10: function (ctx, row, i) {
    var cid = row.f['Customer ID'] || row.f['BP Number Source'];
    if (!cid) return;
    if (!/^\d{8,12}$/.test(cid)) {
      rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" harus berupa 8-12 digit angka.');
      return;
    }
    var idx = ctx.masters.idx && ctx.masters.idx.BP_GENERAL;
    if (!idx || !idx.available) { ctx.skipped['R10-master'] = 'master BP general tidak tersedia'; return; }
    var hit = idx.map[cid];
    if (!hit) {
      rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" tidak ditemukan pada master BP.');
      return;
    }
    var off = row.f['Sales Office'];
    if (off && hit[0] && hit[0]['Sales Office']) {
      var masterOff = rscIdOnly_(hit[0]['Sales Office']).toUpperCase();
      if (masterOff && masterOff !== off) {
        rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" terdaftar pada Sales Office ' + masterOff +
          ', tidak sesuai dengan isian ' + off + '.');
      }
    }
  }
};

/* --------------------------- RULE LINTAS BARIS --------------------------- */

var RSC_TABLE_RULES = {

  /**
   * R7 — Customer ID + Salesman ID yang sama wajib punya Schedule Visit identik.
   *      Pesan mempertahankan format lama agar histori feedback tetap terbaca.
   */
  R7: function (ctx) {
    var groups = {};
    for (var i = 0; i < ctx.rows.length; i++) {
      var f = ctx.rows[i].f;
      var cid = f['Customer ID'], sid = f['Salesman ID'];
      if (!cid || !sid) continue;
      var key = cid + '|' + sid;
      var sch = rscParseSchedule_(f['Schedule Visit']).canonical;
      if (!groups[key]) groups[key] = { variants: {}, order: [] };
      if (!groups[key].variants[sch]) { groups[key].variants[sch] = []; groups[key].order.push(sch); }
      groups[key].variants[sch].push(ctx.rows[i].sheetRow);
    }
    for (var k in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, k)) continue;
      var g = groups[k];
      if (g.order.length < 2) continue;
      var parts = [];
      for (var v = 0; v < g.order.length && v < RSC_CFG.MSG.MAX_VARIANTS; v++) {
        var sch2 = g.order[v];
        parts.push((sch2 || '(kosong)') + ' (row ' + rscRowsLabel_(g.variants[sch2]) + ')');
      }
      if (g.order.length > RSC_CFG.MSG.MAX_VARIANTS) {
        parts.push('... +' + (g.order.length - RSC_CFG.MSG.MAX_VARIANTS) + ' variasi lain');
      }
      var msg = 'Customer ID + Salesman ID yang sama tidak boleh memiliki Schedule Visit berbeda. Konflik: ' +
        parts.join(' vs ');
      for (var v2 = 0; v2 < g.order.length; v2++) {
        var rowsList = g.variants[g.order[v2]];
        for (var rr = 0; rr < rowsList.length; rr++) {
          var idx = rscRowIndexBySheetRow_(ctx, rowsList[rr]);
          if (idx >= 0) rscAddErr_(ctx, idx, 'R7', msg);
        }
      }
    }
  },

  /** R8a — duplikat kunci di dalam template itu sendiri. */
  R8a: function (ctx) {
    var keyFields = ctx.spec.key === 'ROLLING'
      ? ['Customer ID', 'Relationship', 'Salesman ID', 'Valid To']
      : ctx.spec.required.slice(0, Math.min(4, ctx.spec.required.length));
    var seen = {};
    var i;
    for (i = 0; i < ctx.rows.length; i++) {
      var parts = [];
      for (var k = 0; k < keyFields.length; k++) parts.push(ctx.rows[i].f[keyFields[k]] || '');
      var key = parts.join('|');
      if (key.replace(/\|/g, '') === '') continue;
      if (!seen[key]) seen[key] = [];
      seen[key].push(i);
    }
    for (var kk in seen) {
      if (!Object.prototype.hasOwnProperty.call(seen, kk)) continue;
      if (seen[kk].length < 2) continue;
      var rowsTxt = [];
      for (var a = 0; a < seen[kk].length; a++) rowsTxt.push(ctx.rows[seen[kk][a]].sheetRow);
      var label = rscRowsLabel_(rowsTxt);
      for (var b = 0; b < seen[kk].length; b++) {
        rscAddErr_(ctx, seen[kk][b], 'R8',
          'R8a: key ' + keyFields.join(' + ') + ' duplikat dalam template (row ' + label + ').');
      }
    }
  },

  /** R8b — bentrok dengan relasi aktif di master (hanya bila DB tersedia). */
  R8b: function (ctx) {
    var idx = ctx.masters.idx && ctx.masters.idx.BP_RELATION;
    if (!idx || !idx.available) { ctx.skipped['R8b'] = 'master m_bp_relation tidak tersedia'; return; }
    for (var i = 0; i < ctx.rows.length; i++) {
      var f = ctx.rows[i].f;
      if (f['Reason'] === 'Toko Bangkrut') continue;
      var cid = f['Customer ID'];
      if (!cid) continue;
      var recs = idx.map[cid];
      if (!recs) continue;
      for (var r = 0; r < recs.length; r++) {
        var rec = recs[r];
        if (rscIdOnly_(rec['Relationship']).toUpperCase() !== f['Relationship']) continue;
        var mSid = rscIdOnly_(rec['Salesman ID']).toUpperCase();
        var mVt = rscDateStr_(rec['Valid To']);
        if (mSid && mSid !== f['Salesman ID'] && (!mVt || mVt >= f['Valid From'])) {
          rscAddErr_(ctx, i, 'R8',
            'R8b: relasi aktif di master masih memakai Salesman ' + mSid + ' (Valid To ' + (mVt || '-') +
            '). Tutup relasi lama sebelum rolling ke ' + f['Salesman ID'] + '.');
          break;
        }
      }
    }
  },

  /** TB — Toko Bangkrut wajib punya jadwal aktif di master untuk ditutup. */
  TB: function (ctx) {
    var idx = ctx.masters.idx && ctx.masters.idx.VISIT_SCHEDULE;
    var hasIdx = !!(idx && idx.available);
    if (!hasIdx) ctx.skipped['TB'] = 'master m_visit_schedule tidak tersedia';
    for (var i = 0; i < ctx.rows.length; i++) {
      var f = ctx.rows[i].f;
      if (f['Reason'] !== 'Toko Bangkrut') continue;
      if (f['Valid To'] === RSC_CFG.OPEN_ENDED_DATE) {
        rscAddErr_(ctx, i, 'TB', 'Toko Bangkrut: Valid To wajib diisi tanggal penutupan, bukan ' + RSC_CFG.OPEN_ENDED_DATE + '.');
      }
      if (!hasIdx) continue;
      var key = (f['Customer ID'] || '') + '|' + (f['Salesman ID'] || '');
      if (!idx.map[key.toUpperCase()]) {
        rscAddErr_(ctx, i, 'TB', 'Toko Bangkrut: key tidak ditemukan di m_visit_schedule.');
      }
    }
  }
};

/** "2,3,4,5 ...(+18 baris)" — menjaga pesan tetap ringkas pada file besar. */
function rscRowsLabel_(rows) {
  var n = RSC_CFG.MSG.MAX_ROWS_IN_MSG;
  if (rows.length <= n) return rows.join(',');
  return rows.slice(0, n).join(',') + ' ...(+' + (rows.length - n) + ' baris)';
}

function rscRowIndexBySheetRow_(ctx, sheetRow) {
  if (!ctx._byRow) {
    ctx._byRow = {};
    for (var i = 0; i < ctx.rows.length; i++) ctx._byRow[ctx.rows[i].sheetRow] = i;
  }
  var v = ctx._byRow[sheetRow];
  return (v === undefined) ? -1 : v;
}

/**
 * Verifikasi header terhadap spec.
 * Format pesan dipertahankan: `Layout A:P tidak sesuai template FSD. $D: expected "X", got "Y"`
 */
function rscCheckLayout_(spec, headerRow) {
  var problems = [];
  for (var c = 0; c < spec.header.length; c++) {
    var want = spec.header[c];
    var got = rscText_(headerRow[c]);
    if (rscKey_(got) !== rscKey_(want)) {
      problems.push('$' + rscColLetter_(c + 1) + ': expected "' + want + '", got "' + got + '"');
    }
  }
  if (!problems.length) return null;
  return 'Layout A:' + rscColLetter_(spec.header.length) + ' tidak sesuai template FSD. ' + problems.join('; ');
}

/**
 * Jalankan seluruh rule. Mengembalikan {status[], detail[], errorRows, summary}.
 * Rule yang membutuhkan DB dan DB-nya tidak tersedia akan tercatat di
 * `skipped` — TIDAK menjadi error file (perbaikan atas perilaku PERF19 lama
 * yang menjadikan lookup hilang sebagai HARD_ERROR).
 */
function rscValidateValues_(spec, values, masters) {
  var t0 = Date.now();
  var ctx = rscBuildContext_(spec, values, { masters: masters });
  var tNorm = Date.now();

  var i, r;
  for (r = 0; r < ctx.rows.length; r++) {
    for (i = 0; i < spec.rowRules.length; i++) {
      var fn = RSC_ROW_RULES[spec.rowRules[i]];
      if (fn) fn(ctx, ctx.rows[r], r);
    }
  }
  for (i = 0; i < spec.tableRules.length; i++) {
    var tf = RSC_TABLE_RULES[spec.tableRules[i]];
    if (tf) tf(ctx);
  }
  var tRules = Date.now();

  var status = [], detail = [], errorRows = 0;
  var byCode = {};
  for (r = 0; r < ctx.rows.length; r++) {
    var errs = rscUniq_(ctx.errors[r]);
    if (errs.length) {
      errorRows++;
      status.push('ERROR');
      var joined = errs.join(' | ');
      if (joined.length > RSC_CFG.MSG.MAX_DETAIL_CHARS) {
        joined = joined.substring(0, RSC_CFG.MSG.MAX_DETAIL_CHARS - 20) + ' ...(dipotong)';
      }
      detail.push(joined);
      for (var e = 0; e < errs.length; e++) {
        var code = (errs[e].match(/^\[([A-Za-z0-9]+)\]/) || [])[1] || 'X';
        byCode[code] = (byCode[code] || 0) + 1;
      }
    } else {
      status.push('OK');
      detail.push('');
    }
  }

  return {
    ctx: ctx,
    rowCount: ctx.rows.length,
    errorRows: errorRows,
    status: status,
    detail: detail,
    byCode: byCode,
    skipped: ctx.skipped,
    timing: { normalizeSec: rscRound_((tNorm - t0) / 1000, 3), rulesSec: rscRound_((tRules - tNorm) / 1000, 3) }
  };
}

/* ==========================================================================
 * 9. PENULIS HASIL KE FILE ANAK
 * ======================================================================== */

/**
 * Tulis Validation Status + Error Detail dalam SATU setValues per sheet.
 * Baris kosong dibiarkan kosong agar tidak mengotori template.
 */
function rscWriteResults_(sheet, spec, result, dataRowCount) {
  var out = [];
  for (var i = 0; i < dataRowCount; i++) out.push(['', '']);
  for (var r = 0; r < result.ctx.rows.length; r++) {
    var pos = result.ctx.rows[r].sheetRow - 2;
    if (pos >= 0 && pos < dataRowCount) out[pos] = [result.status[r], result.detail[r]];
  }
  if (!dataRowCount) return 0;

  if (spec.errorCol === spec.statusCol + 1) {
    sheet.getRange(2, spec.statusCol, dataRowCount, 2).setValues(out);
  } else {
    var s = [], d = [];
    for (var k = 0; k < out.length; k++) { s.push([out[k][0]]); d.push([out[k][1]]); }
    sheet.getRange(2, spec.statusCol, dataRowCount, 1).setValues(s);
    sheet.getRange(2, spec.errorCol, dataRowCount, 1).setValues(d);
  }
  return dataRowCount;
}

/** Pastikan header Validation Status / Error Detail ada (untuk sheet lama). */
function rscEnsureResultHeaders_(sheet, spec) {
  var need = [];
  var cur = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), spec.errorCol)).getDisplayValues()[0];
  if (rscKey_(cur[spec.statusCol - 1]) !== rscKey_('Validation Status')) need.push([spec.statusCol, 'Validation Status']);
  if (rscKey_(cur[spec.errorCol - 1]) !== rscKey_('Error Detail')) need.push([spec.errorCol, 'Error Detail']);
  for (var i = 0; i < need.length; i++) sheet.getRange(1, need[i][0]).setValue(need[i][1]);
  return need.length;
}

/** Segarkan dropdown template agar konsisten dengan master. */
function rscApplyDropdowns_(sheet, spec, masters) {
  if (spec.key !== 'ROLLING') return;
  // Batasi jangkauan dropdown agar file 50.000 baris tidak membayar biaya
  // setDataValidation untuk seluruh kanvas kosong.
  var lastRow = Math.min(
    Math.max(sheet.getLastRow() + RSC_CFG.MSG.DROPDOWN_HEADROOM, 200),
    Math.max(sheet.getMaxRows(), 2));
  var n = lastRow - 1;
  if (n < 1) return;

  function listRule(items, help) {
    return SpreadsheetApp.newDataValidation()
      .requireValueInList(items, true)
      .setAllowInvalid(true)
      .setHelpText(help)
      .build();
  }

  var offices = [];
  if (masters.office && masters.office.available) {
    for (var code in masters.office.map) {
      if (!Object.prototype.hasOwnProperty.call(masters.office.map, code)) continue;
      var o = masters.office.map[code];
      offices.push(o.desc ? (code + ' - ' + o.desc) : code);
    }
    offices.sort();
  }
  var rels = [];
  if (masters.relationship && masters.relationship.available) {
    for (var rc in masters.relationship.map) {
      if (!Object.prototype.hasOwnProperty.call(masters.relationship.map, rc)) continue;
      rels.push(masters.relationship.map[rc] ? (rc + ' - ' + masters.relationship.map[rc]) : rc);
    }
    rels.sort();
  }

  try {
    if (offices.length) {
      var offRule = listRule(offices, 'Pilih Sales Office dari master em. ID-only juga diterima.');
      sheet.getRange(2, 1, n, 1).setDataValidation(offRule);
      sheet.getRange(2, 2, n, 1).setDataValidation(offRule);
    }
    if (rels.length) {
      sheet.getRange(2, 4, n, 1).setDataValidation(
        listRule(rels, 'Pilih Relationship. ID-only juga diterima setelah normalisasi.'));
    }
    sheet.getRange(2, 9, n, 1).setDataValidation(
      listRule(['F1', 'F2', 'F4', 'F8'], 'Visit Category hanya F1, F2, F4, atau F8.'));
    sheet.getRange(2, 10, n, 1).setDataValidation(
      listRule(RSC_CFG.VISIT_TYPES.slice(), 'Visit Type hanya 01 sampai 12. Gunakan format 2 digit.'));
    sheet.getRange(2, 14, n, 1).setDataValidation(
      listRule(RSC_CFG.REASONS.slice(), 'Reason hanya Rolling atau Toko Bangkrut.'));
  } catch (e) {
    // Dropdown bersifat kosmetik: kegagalan di sini tidak boleh menggagalkan validasi.
  }
}

/* ==========================================================================
 * 10. MANIFEST / ANTREAN  — inti perbaikan [F2] dan [F4]
 * ======================================================================== */

var RSC_MANIFEST_HEADER = [
  'Run ID', 'File ID', 'Master Rows JSON', 'URL', 'File Name', 'Status', 'Attempts', 'Worker',
  'Lease Until', 'Error Rows', 'Sheet Summary', 'Started At', 'Updated At', 'Duration Sec',
  'Message', 'Queue Wait Sec', 'Open File Sec', 'Master Load Sec', 'Normalize Sec', 'Rules Sec',
  'Write Sec', 'Total Sec', 'Defers', 'Next Eligible At', 'Claim Token', 'Last Error Kind'
];

var RSC_M = {
  RUN_ID: 0, FILE_ID: 1, MASTER_ROWS: 2, URL: 3, FILE_NAME: 4, STATUS: 5, ATTEMPTS: 6, WORKER: 7,
  LEASE_UNTIL: 8, ERROR_ROWS: 9, SHEET_SUMMARY: 10, STARTED_AT: 11, UPDATED_AT: 12, DURATION: 13,
  MESSAGE: 14, QUEUE_WAIT: 15, OPEN_SEC: 16, MASTER_SEC: 17, NORM_SEC: 18, RULES_SEC: 19,
  WRITE_SEC: 20, TOTAL_SEC: 21, DEFERS: 22, NEXT_AT: 23, CLAIM_TOKEN: 24, ERR_KIND: 25
};

var RSC_STATUS = {
  QUEUED: 'QUEUED',
  ACTIVE: 'ACTIVE',
  DEFERRED: 'DEFERRED',
  RETRY: 'RETRY',
  DONE_OK: 'COMPLETE_OK',
  DONE_ERRORS: 'COMPLETE_WITH_ERRORS',
  HARD_ERROR: 'HARD_ERROR',
  BLOCKED_INFRA: 'BLOCKED_INFRA',
  SKIPPED: 'SKIPPED_INVALID'
};

/** Status yang sudah final (tidak akan diambil worker lagi). */
function rscIsTerminal_(status) {
  return status === RSC_STATUS.DONE_OK || status === RSC_STATUS.DONE_ERRORS ||
         status === RSC_STATUS.HARD_ERROR || status === RSC_STATUS.SKIPPED;
}

var RSC_MANIFEST_MEMO = null;

function rscManifestSheet_(ss) {
  if (RSC_MANIFEST_MEMO && RSC_MANIFEST_MEMO.ssId === ss.getId()) return RSC_MANIFEST_MEMO.sheet;
  var sh = ss.getSheetByName(RSC_CFG.SHEET.MANIFEST);
  if (!sh) {
    sh = ss.insertSheet(RSC_CFG.SHEET.MANIFEST);
    sh.hideSheet();
  }
  var cur = sh.getRange(1, 1, 1, RSC_MANIFEST_HEADER.length).getDisplayValues()[0];
  if (rscKey_(cur[0]) !== rscKey_(RSC_MANIFEST_HEADER[0]) ||
      rscKey_(cur[RSC_M.ERR_KIND]) !== rscKey_(RSC_MANIFEST_HEADER[RSC_M.ERR_KIND])) {
    sh.getRange(1, 1, 1, RSC_MANIFEST_HEADER.length).setValues([RSC_MANIFEST_HEADER]);
    sh.setFrozenRows(1);
  }
  RSC_MANIFEST_MEMO = { ssId: ss.getId(), sheet: sh };
  return sh;
}

function rscManifestRead_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, RSC_MANIFEST_HEADER.length).getDisplayValues();
}

/** Tulis kembali beberapa baris manifest secara efisien (blok kontigu). */
function rscManifestWriteRows_(sh, rows) {
  if (!rows.length) return;
  rows.sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < rows.length) {
    var start = i;
    while (i + 1 < rows.length && rows[i + 1].row === rows[i].row + 1) i++;
    var block = [];
    for (var k = start; k <= i; k++) block.push(rows[k].values);
    sh.getRange(rows[start].row, 1, block.length, RSC_MANIFEST_HEADER.length).setValues(block);
    i++;
  }
}

/**
 * Bangun antrean dari kolom E "Rekap Approved".
 * File yang sama pada beberapa baris digabung menjadi satu task (Master Rows
 * JSON menyimpan seluruh baris asal) sehingga satu file hanya divalidasi sekali.
 */
function rscBuildManifest_(ss, runId) {
  var rekap = ss.getSheetByName(RSC_CFG.SHEET.REKAP);
  if (!rekap) throw new RscDataError('Sheet "' + RSC_CFG.SHEET.REKAP + '" tidak ditemukan di file induk.');

  var lastRow = Math.min(rekap.getLastRow(), RSC_CFG.REKAP.FIRST_DATA_ROW + RSC_CFG.REKAP.MAX_SCAN_ROWS);
  var stats = { links: 0, valid: 0, skipped: 0, tasks: 0 };
  var byFile = {}, order = [], skippedRows = [];

  if (lastRow >= RSC_CFG.REKAP.FIRST_DATA_ROW) {
    var n = lastRow - RSC_CFG.REKAP.FIRST_DATA_ROW + 1;
    var range = rekap.getRange(RSC_CFG.REKAP.FIRST_DATA_ROW, 1, n, RSC_CFG.REKAP.COL_FEEDBACK);
    var vals = range.getDisplayValues();

    // Sebagian admin menempel link sebagai =HYPERLINK(...) atau rich-text, sehingga
    // teks tampilannya berupa judul file. Ambil formula sebagai cadangan.
    var formulas = null;
    for (var pre = 0; pre < vals.length; pre++) {
      var probe = rscText_(vals[pre][RSC_CFG.REKAP.COL_LINK_FINAL - 1]);
      if (probe && !rscFileId_(probe)) {
        try { formulas = range.getFormulas(); } catch (eF) { formulas = null; }
        break;
      }
    }

    for (var r = 0; r < vals.length; r++) {
      var sheetRow = RSC_CFG.REKAP.FIRST_DATA_ROW + r;
      var linkRaw = rscText_(vals[r][RSC_CFG.REKAP.COL_LINK_FINAL - 1]);
      if (!linkRaw) continue;
      stats.links++;
      var fileId = rscFileId_(linkRaw);
      if (!fileId && formulas) {
        var f = rscText_(formulas[r][RSC_CFG.REKAP.COL_LINK_FINAL - 1]);
        var fromFormula = rscFileId_(f);
        if (fromFormula) { fileId = fromFormula; linkRaw = f; }
      }
      if (!fileId) {
        stats.skipped++;
        skippedRows.push({ row: sheetRow, url: linkRaw, office: rscText_(vals[r][0]) });
        continue;
      }
      stats.valid++;
      if (!byFile[fileId]) {
        byFile[fileId] = {
          fileId: fileId, url: linkRaw, rows: [],
          office: rscText_(vals[r][RSC_CFG.REKAP.COL_OFFICE - 1]),
          name: rscText_(vals[r][RSC_CFG.REKAP.COL_DESC - 1])
        };
        order.push(fileId);
      }
      byFile[fileId].rows.push(sheetRow);
    }
  }

  var now = rscNowIso_();
  var out = [];
  for (var o = 0; o < order.length; o++) {
    var t = byFile[order[o]];
    var row = new Array(RSC_MANIFEST_HEADER.length);
    for (var z = 0; z < row.length; z++) row[z] = '';
    row[RSC_M.RUN_ID] = runId;
    row[RSC_M.FILE_ID] = t.fileId;
    row[RSC_M.MASTER_ROWS] = JSON.stringify(t.rows);
    row[RSC_M.URL] = t.url;
    row[RSC_M.FILE_NAME] = t.office ? (t.office + ' - ' + t.name) : t.name;
    row[RSC_M.STATUS] = RSC_STATUS.QUEUED;
    row[RSC_M.ATTEMPTS] = 0;
    row[RSC_M.DEFERS] = 0;
    row[RSC_M.ERROR_ROWS] = 0;
    row[RSC_M.STARTED_AT] = now;
    row[RSC_M.UPDATED_AT] = now;
    row[RSC_M.MESSAGE] = 'Menunggu worker.';
    out.push(row);
    stats.tasks++;
  }
  for (var s = 0; s < skippedRows.length; s++) {
    var srow = new Array(RSC_MANIFEST_HEADER.length);
    for (var y = 0; y < srow.length; y++) srow[y] = '';
    srow[RSC_M.RUN_ID] = runId;
    srow[RSC_M.MASTER_ROWS] = JSON.stringify([skippedRows[s].row]);
    srow[RSC_M.URL] = skippedRows[s].url;
    srow[RSC_M.FILE_NAME] = skippedRows[s].office;
    srow[RSC_M.STATUS] = RSC_STATUS.SKIPPED;
    srow[RSC_M.ATTEMPTS] = 0;
    srow[RSC_M.DEFERS] = 0;
    srow[RSC_M.STARTED_AT] = now;
    srow[RSC_M.UPDATED_AT] = now;
    srow[RSC_M.MESSAGE] = 'Link E bukan URL/ID Google Sheets yang valid.';
    out.push(srow);
  }

  var sh = rscManifestSheet_(ss);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, RSC_MANIFEST_HEADER.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, RSC_MANIFEST_HEADER.length).setValues(out);

  stats.total = out.length;
  return stats;
}

/**
 * Claim atomik. Hanya bagian ini yang memegang lock global, dan hanya beberapa
 * ratus milidetik. Menghasilkan claimToken yang diverifikasi ulang saat commit
 * sehingga satu file mustahil diproses dua lane sekaligus.
 */
function rscClaimBatch_(ss, runId, worker, maxN) {
  return rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var now = Date.now();
    var nowIso = rscNowIso_();
    var picked = [], writes = [];

    for (var i = 0; i < vals.length && picked.length < maxN; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      var st = v[RSC_M.STATUS];
      if (rscIsTerminal_(st)) continue;

      if (st === RSC_STATUS.ACTIVE) {
        var lease = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
        if (isFinite(lease) && lease > now) continue;         // masih dipegang lane lain
      }
      if (st === RSC_STATUS.DEFERRED || st === RSC_STATUS.RETRY) {
        var next = Date.parse(v[RSC_M.NEXT_AT] || '');
        if (isFinite(next) && next > now) continue;           // belum waktunya
      }

      var token = rscUuid_();
      v[RSC_M.STATUS] = RSC_STATUS.ACTIVE;
      v[RSC_M.WORKER] = worker;
      v[RSC_M.LEASE_UNTIL] = new Date(now + RSC_CFG.RUN.LEASE_MS).toISOString();
      v[RSC_M.CLAIM_TOKEN] = token;
      v[RSC_M.UPDATED_AT] = nowIso;
      v[RSC_M.MESSAGE] = 'Di-claim oleh ' + worker + '.';
      writes.push({ row: i + 2, values: v });
      picked.push({
        row: i + 2,
        fileId: v[RSC_M.FILE_ID],
        url: v[RSC_M.URL],
        name: v[RSC_M.FILE_NAME],
        masterRows: v[RSC_M.MASTER_ROWS],
        attempts: Number(v[RSC_M.ATTEMPTS] || 0),
        defers: Number(v[RSC_M.DEFERS] || 0),
        token: token
      });
    }
    rscManifestWriteRows_(sh, writes);
    return picked;
  }, 20000);
}

/** Update satu task dengan verifikasi claimToken (compare-and-swap). */
function rscUpdateTask_(ss, task, mutate) {
  return rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var v = sh.getRange(task.row, 1, 1, RSC_MANIFEST_HEADER.length).getDisplayValues()[0];
    if (task.token && v[RSC_M.CLAIM_TOKEN] && v[RSC_M.CLAIM_TOKEN] !== task.token) {
      return { applied: false, reason: 'CLAIM_TOKEN_MISMATCH' };
    }
    mutate(v);
    v[RSC_M.UPDATED_AT] = rscNowIso_();
    sh.getRange(task.row, 1, 1, RSC_MANIFEST_HEADER.length).setValues([v]);
    return { applied: true };
  }, 20000);
}

function rscCommitOk_(ss, task, res) {
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.STATUS] = res.errorRows > 0 ? RSC_STATUS.DONE_ERRORS : RSC_STATUS.DONE_OK;
    v[RSC_M.ERROR_ROWS] = res.errorRows;
    v[RSC_M.SHEET_SUMMARY] = res.summary || '';
    v[RSC_M.MESSAGE] = res.errorRows > 0
      ? ('File selesai. Error rows=' + res.errorRows + '.')
      : 'File selesai. Error rows=0.';
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.ERR_KIND] = '';
    v[RSC_M.OPEN_SEC] = res.openSec || 0;
    v[RSC_M.MASTER_SEC] = res.masterSec || 0;
    v[RSC_M.NORM_SEC] = res.normalizeSec || 0;
    v[RSC_M.RULES_SEC] = res.rulesSec || 0;
    v[RSC_M.WRITE_SEC] = res.writeSec || 0;
    v[RSC_M.TOTAL_SEC] = res.totalSec || 0;
    v[RSC_M.DURATION] = res.totalSec || 0;
  });
}

/**
 * INFRA -> DEFER. Attempts TIDAK bertambah. Inilah perbaikan langsung terhadap
 * keluhan "DB_BUSY salah dihitung sebagai attempt validation".
 */
function rscDeferTask_(ss, task, message) {
  var defers = Number(task.defers || 0) + 1;
  var waitMs = rscBackoffMs_(defers);
  var blocked = defers >= RSC_CFG.RUN.MAX_DEFERS;
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.DEFERS] = defers;
    v[RSC_M.STATUS] = blocked ? RSC_STATUS.BLOCKED_INFRA : RSC_STATUS.DEFERRED;
    v[RSC_M.NEXT_AT] = new Date(Date.now() + waitMs).toISOString();
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.WORKER] = '';
    v[RSC_M.ERR_KIND] = RSC_ERR.INFRA;
    v[RSC_M.MESSAGE] = blocked
      ? ('Ditunda ' + defers + 'x karena kontensi infrastruktur. Perlu ditinjau. Attempts tetap ' + (task.attempts || 0) + '.')
      : ('Ditunda tanpa menambah Attempts (defer ke-' + defers + '), retry dalam ' + Math.round(waitMs / 1000) + ' detik.');
    v[RSC_M.SHEET_SUMMARY] = String(message || '').substring(0, 500);
  });
}

/** DATA/ACCESS/FATAL -> Attempts++ ; HARD_ERROR bila melewati batas. */
function rscFailTask_(ss, task, message, kind) {
  var attempts = Number(task.attempts || 0) + 1;
  var hard = attempts >= RSC_CFG.RUN.MAX_ATTEMPTS;
  var waitMs = rscBackoffMs_(attempts);
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.ATTEMPTS] = attempts;
    v[RSC_M.STATUS] = hard ? RSC_STATUS.HARD_ERROR : RSC_STATUS.RETRY;
    v[RSC_M.NEXT_AT] = hard ? '' : new Date(Date.now() + waitMs).toISOString();
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.WORKER] = '';
    v[RSC_M.ERR_KIND] = kind || RSC_ERR.DATA;
    v[RSC_M.MESSAGE] = 'Task gagal pada attempt ' + attempts + (hard ? ' (final).' : '.');
    v[RSC_M.SHEET_SUMMARY] = String(message || '').substring(0, 500);
  });
}

/** Lepas task yang belum sempat dikerjakan (deadline lane habis). Netral. */
function rscReleaseTask_(ss, task, message) {
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.WORKER] = '';
    v[RSC_M.NEXT_AT] = '';
    v[RSC_M.MESSAGE] = message || 'Dikembalikan ke antrean tanpa penalti.';
  });
}

/**
 * Berapa milidetik lagi task paling awal boleh diambil kembali.
 * Dipakai agar lane menjadwalkan diri tepat waktu, bukan bangun berulang
 * setiap beberapa detik seperti versi lama.
 */
function rscEarliestEligibleMs_(ss, runId) {
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var now = Date.now();
  var best = -1;
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (runId && v[RSC_M.RUN_ID] !== runId) continue;
    var st = v[RSC_M.STATUS];
    if (rscIsTerminal_(st)) continue;
    var at = 0;
    if (st === RSC_STATUS.DEFERRED || st === RSC_STATUS.RETRY) {
      var t = Date.parse(v[RSC_M.NEXT_AT] || '');
      at = isFinite(t) ? Math.max(0, t - now) : 0;
    } else if (st === RSC_STATUS.ACTIVE) {
      var l = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
      at = isFinite(l) ? Math.max(0, l - now) : 0;
    }
    if (best < 0 || at < best) best = at;
  }
  return best < 0 ? -1 : best;
}

function rscQueueStats_(ss, runId) {
  var sh = rscManifestSheet_(ss);
  var vals = rscManifestRead_(sh);
  var st = { total: 0, queued: 0, active: 0, retry: 0, deferred: 0, ok: 0, withErrors: 0, hard: 0, blocked: 0, skipped: 0, unfinished: 0 };
  for (var i = 0; i < vals.length; i++) {
    if (runId && vals[i][RSC_M.RUN_ID] !== runId) continue;
    st.total++;
    var s = vals[i][RSC_M.STATUS];
    if (s === RSC_STATUS.QUEUED) st.queued++;
    else if (s === RSC_STATUS.ACTIVE) st.active++;
    else if (s === RSC_STATUS.RETRY) st.retry++;
    else if (s === RSC_STATUS.DEFERRED) st.deferred++;
    else if (s === RSC_STATUS.DONE_OK) st.ok++;
    else if (s === RSC_STATUS.DONE_ERRORS) st.withErrors++;
    else if (s === RSC_STATUS.HARD_ERROR) st.hard++;
    else if (s === RSC_STATUS.BLOCKED_INFRA) st.blocked++;
    else if (s === RSC_STATUS.SKIPPED) st.skipped++;
    if (!rscIsTerminal_(s)) st.unfinished++;
  }
  st.done = st.ok + st.withErrors + st.hard + st.skipped;
  st.progress = st.total ? rscRound_(st.done / st.total, 4) : 0;
  return st;
}

/* ==========================================================================
 * 11. DASHBOARD "Job Logging Details"
 * ======================================================================== */

var RSC_DASH_HEADER = [
  'Slot', 'Job / Worker', 'State', 'Current Stage', 'Progress', 'Current / Total', 'File Name',
  'File ID', 'Sheet', 'Rows', 'Message', 'Last Error', 'Started At', 'Last Heartbeat',
  'Elapsed Sec', 'Worker / Lane', 'Run ID', 'Effective User'
];

var RSC_SLOTS = ['WORKER_1', 'WORKER_2', 'WORKER_3', 'WORKER_4', 'WATCHDOG', 'REVAMP', 'SYSTEM', 'LEGACY'];

function rscDashSheet_(ss) {
  var sh = ss.getSheetByName(RSC_CFG.SHEET.DASHBOARD);
  if (!sh) sh = ss.insertSheet(RSC_CFG.SHEET.DASHBOARD);
  var D = RSC_CFG.DASH;
  if (sh.getMaxRows() < D.HISTORY_FIRST_ROW + D.HISTORY_MAX) {
    sh.insertRowsAfter(sh.getMaxRows(), D.HISTORY_FIRST_ROW + D.HISTORY_MAX - sh.getMaxRows());
  }
  if (rscKey_(sh.getRange(D.HEADER_ROW, 1).getDisplayValue()) !== 'SLOT') {
    sh.getRange(D.TITLE_ROW, 1).setValue('ROLLING SALES CENTER — LIVE JOB LOGGING (' + RSC_CFG.VERSION + ')');
    sh.getRange(D.HEADER_ROW, 1, 1, RSC_DASH_HEADER.length).setValues([RSC_DASH_HEADER]);
    sh.getRange(D.HISTORY_TITLE_ROW, 1).setValue('EVENT HISTORY — newest first');
    sh.getRange(D.HISTORY_HEADER_ROW, 1, 1, RSC_DASH_HEADER.length).setValues([RSC_DASH_HEADER]);
    for (var s = 0; s < RSC_SLOTS.length; s++) {
      sh.getRange(D.SLOT_FIRST_ROW + s, 1).setValue(RSC_SLOTS[s]);
    }
  }
  return sh;
}

function rscSlotRow_(slot) {
  var i = RSC_SLOTS.indexOf(slot);
  return i < 0 ? -1 : RSC_CFG.DASH.SLOT_FIRST_ROW + i;
}

function rscDashRow_(slot, e) {
  return [
    slot,
    e.job || '',
    e.state || '',
    e.stage || '',
    e.progress === undefined ? '' : e.progress,
    e.currentTotal || '',
    e.fileName || '',
    e.fileId || '',
    e.sheet || '',
    e.rows === undefined ? '' : e.rows,
    e.message || '',
    e.lastError || '',
    e.startedAt || '',
    rscNowIso_(),
    e.elapsedSec === undefined ? '' : e.elapsedSec,
    e.lane || slot,
    e.runId || rscGetProp_(RSC_CFG.PROP.RUN_ID, ''),
    e.user || rscWhoAmI_()
  ];
}

/**
 * Perbarui satu slot live. Throttled: hanya menulis bila state berubah atau
 * interval minimum terlewati. Ini menghilangkan banjir ribuan baris log yang
 * terjadi pada versi lama.
 */
function rscDashSet_(ss, slot, e, opts) {
  opts = opts || {};
  var row = rscSlotRow_(slot);
  if (row < 0) return;
  var key = RSC_CFG.PROP.DASH_LAST + ':' + slot;
  var last = rscGetProp_(key, '');
  var sig = (e.state || '') + '|' + (e.stage || '') + '|' + (e.fileId || '');
  var parts = last.split('@@');
  var lastSig = parts[0] || '', lastAt = Number(parts[1] || 0);
  var changed = sig !== lastSig;
  if (!changed && !opts.force && (Date.now() - lastAt) < RSC_CFG.DASH.MIN_WRITE_INTERVAL_MS) return;

  try {
    var sh = rscDashSheet_(ss);
    var values = rscDashRow_(slot, e);
    sh.getRange(row, 1, 1, RSC_DASH_HEADER.length).setValues([values]);
    if (changed || opts.history) rscDashPushHistory_(sh, values);
    rscSetProp_(key, sig + '@@' + Date.now());
  } catch (err) {
    // Dashboard tidak boleh menggagalkan pipeline.
  }
}

function rscDashPushHistory_(sh, values) {
  var D = RSC_CFG.DASH;
  try {
    sh.insertRowsBefore(D.HISTORY_FIRST_ROW, 1);
    sh.getRange(D.HISTORY_FIRST_ROW, 1, 1, RSC_DASH_HEADER.length).setValues([values]);
    var maxRow = D.HISTORY_FIRST_ROW + D.HISTORY_MAX;
    if (sh.getMaxRows() > maxRow) sh.deleteRows(maxRow + 1, sh.getMaxRows() - maxRow);
  } catch (e) { /* histori bersifat best-effort */ }
}

function rscDashSummary_(ss, runId, stats) {
  try {
    var sh = rscDashSheet_(ss);
    var D = RSC_CFG.DASH;
    sh.getRange(D.SUMMARY_ROW, 1, 1, 10).setValues([[
      'Last Dashboard Update', rscNowIso_(), 'Run ID', runId,
      'Overall Progress', stats.progress, 'Total Tasks', stats.total, 'Unfinished', stats.unfinished
    ]]);
    sh.getRange(D.COUNTER_ROW, 1, 1, 12).setValues([[
      'QUEUED', stats.queued, 'ACTIVE', stats.active, 'RETRY', stats.retry + stats.deferred,
      'COMPLETE OK', stats.ok, 'WITH ERRORS', stats.withErrors, 'ERROR/HARD', stats.hard + stats.blocked
    ]]);
  } catch (e) { /* best-effort */ }
}

/* ==========================================================================
 * 12. ORKESTRATOR
 * ======================================================================== */

/**
 * Muat seluruh master sekali per eksekusi lane.
 * Index DB dimuat "lazy + toleran": bila salah satu index sedang dibangun
 * execution lain, error INFRA-nya dilempar ke pemanggil sehingga task di-defer
 * TANPA menambah Attempts.
 */
function rscLoadMasters_(ss) {
  var m = {
    office: rscOfficeMaster_(ss),
    relationship: rscRelationshipMaster_(),
    periodStart: rscPeriodStart_(),
    idx: {},
    dbConfigured: rscDbSources_().length > 0,
    notes: []
  };
  if (!m.dbConfigured) {
    m.notes.push('DB eksternal belum dikonfigurasi; rule berbasis master DB dilewati (bukan error).');
    return m;
  }
  var names = ['BP_GENERAL', 'BP_RELATION', 'VISIT_SCHEDULE', 'SALESMAN'];
  for (var i = 0; i < names.length; i++) {
    m.idx[names[i]] = rscGetIndex_(names[i]);   // melempar RscInfraError bila sedang dibangun
    if (!m.idx[names[i]].available) {
      m.notes.push('Master ' + names[i] + ' tidak tersedia (' + (m.idx[names[i]].reason || '-') + '); rule terkait dilewati.');
    }
  }
  return m;
}

/** Proses satu file anak: buka, validasi semua sheet yang dikenali, tulis hasil. */
function rscProcessTask_(task, masters, onStage) {
  var t0 = Date.now();
  var tOpen0 = Date.now();
  var child;
  try {
    child = SpreadsheetApp.openById(task.fileId);
  } catch (e) {
    var c = rscClassify_(e);
    if (c.kind === RSC_ERR.INFRA) throw new RscInfraError('Gagal membuka file: ' + c.message);
    throw new RscAccessError('File tidak dapat dibuka / tidak ada akses: ' + c.message);
  }
  var openSec = rscRound_((Date.now() - tOpen0) / 1000, 3);
  var fileName = '';
  try { fileName = child.getName(); } catch (e2) { fileName = task.name || task.fileId; }

  var sheets = child.getSheets();
  var processed = [], totalRows = 0, totalErrors = 0, layoutProblems = [];
  var normSec = 0, rulesSec = 0, writeSec = 0;

  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var spec = rscSpecFor_(sh.getName());
    if (!spec) continue;

    if (onStage) {
      onStage({
        stage: 'Validate ' + spec.label,
        fileName: fileName, fileId: task.fileId, sheet: sh.getName(),
        message: 'Menjalankan engine validasi terintegrasi ' + RSC_CFG.VERSION + '.'
      });
    }

    var lastRow = sh.getLastRow();
    var needCols = Math.max(spec.errorCol, spec.header.length);
    var header = sh.getRange(1, 1, 1, Math.max(needCols, sh.getLastColumn() || needCols)).getDisplayValues()[0];
    var layoutErr = rscCheckLayout_(spec, header);
    if (layoutErr) {
      layoutProblems.push(sh.getName() + ' :: ' + layoutErr);
      continue;                       // sheet ini dilewati, sheet lain tetap jalan
    }
    rscEnsureResultHeaders_(sh, spec);

    var dataRows = Math.max(0, lastRow - 1);
    // getValues() (bukan getDisplayValues) agar sel tanggal terbaca sebagai objek
    // Date. Format tampilan bergantung locale spreadsheet dan bisa membuat
    // 01/08/2026 terbaca sebagai 8 Januari.
    var values = dataRows ? sh.getRange(2, 1, dataRows, needCols).getValues() : [];

    var res = rscValidateValues_(spec, values, masters);
    normSec += res.timing.normalizeSec;
    rulesSec += res.timing.rulesSec;

    var tW = Date.now();
    rscWriteResults_(sh, spec, res, dataRows);
    rscApplyDropdowns_(sh, spec, masters);
    writeSec += rscRound_((Date.now() - tW) / 1000, 3);

    totalRows += res.rowCount;
    totalErrors += res.errorRows;
    processed.push({
      sheet: sh.getName(), spec: spec.key, rows: res.rowCount,
      errorRows: res.errorRows, byCode: res.byCode, skipped: res.skipped
    });
  }

  if (!processed.length) {
    var reason = layoutProblems.length
      ? layoutProblems.join(' || ')
      : 'Tidak ditemukan sheet yang dikenali (Change Rolling / Change Salesman Type / Change Sales Office).';
    throw new RscDataError(reason);
  }

  return {
    fileName: fileName,
    rowCount: totalRows,
    errorRows: totalErrors,
    processed: processed,
    layoutProblems: layoutProblems,
    summary: JSON.stringify({ sheets: processed, layout: layoutProblems }).substring(0, 45000),
    openSec: openSec,
    masterSec: 0,
    normalizeSec: rscRound_(normSec, 3),
    rulesSec: rscRound_(rulesSec, 3),
    writeSec: rscRound_(writeSec, 3),
    totalSec: rscRound_((Date.now() - t0) / 1000, 3)
  };
}

/** Satu putaran worker lane. Dipanggil oleh trigger rscWorker1..4. */
function rscRunLane_(lane) {
  var started = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(rscGetProp_('RSC_MASTER_ID', ''));
  var runId = rscGetProp_(RSC_CFG.PROP.RUN_ID, '');
  var slot = 'WORKER_' + lane;
  var startedIso = new Date(started).toISOString();

  if (!runId || rscGetProp_(RSC_CFG.PROP.RUN_STATE, '') !== 'RUNNING') {
    rscDashSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'IDLE', stage: 'No active run', progress: 1,
      message: 'Tidak ada run aktif.', startedAt: startedIso, elapsedSec: 0, lane: 'Lane ' + lane
    }, { force: true });
    return { lane: lane, claimed: 0, committed: 0, reason: 'NO_ACTIVE_RUN' };
  }

  rscDashSet_(ss, slot, {
    job: 'VALIDATE LINK E', state: 'START', stage: 'Worker bootstrap', progress: 0.01,
    message: 'Worker lane ' + lane + ' mulai.', startedAt: startedIso, elapsedSec: 0, lane: 'Lane ' + lane, runId: runId
  }, { force: true, history: true });

  var claimed;
  try {
    claimed = rscClaimBatch_(ss, runId, slot, RSC_CFG.RUN.BUNDLE_SIZE);
  } catch (eClaim) {
    var cc = rscClassify_(eClaim);
    rscDashSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'WAITING', stage: 'Claim ditunda',
      progress: 0.02, message: 'Antrean sedang dikunci lane lain. Menjadwalkan ulang tanpa penalti.',
      lastError: '[' + cc.kind + '] ' + cc.message,
      startedAt: startedIso, lane: 'Lane ' + lane, runId: runId
    }, { force: true });
    rscArmLane_(lane, rscBackoffMs_(1));
    return { lane: lane, claimed: 0, committed: 0, reason: 'CLAIM_' + cc.kind };
  }
  if (!claimed.length) {
    var st0 = rscQueueStats_(ss, runId);
    rscDashSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'IDLE', stage: 'No claimable task', progress: 1,
      currentTotal: '0 / 0', message: 'Antrean kosong atau semua task sedang ditunda.',
      startedAt: startedIso, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
      lane: 'Lane ' + lane, runId: runId
    }, { force: true });
    rscDashSummary_(ss, runId, st0);
    if (st0.unfinished > 0) {
      // Bangun tepat saat task berikutnya boleh diambil, bukan polling terus-menerus.
      var waitMs = rscEarliestEligibleMs_(ss, runId);
      if (waitMs < 0) waitMs = RSC_CFG.RUN.RETRY_BASE_MS * 3;
      rscArmLane_(lane, Math.min(Math.max(waitMs + 1000, 5000), 300000));
    } else {
      rscFinishRunIfDone_(ss, runId, st0);
    }
    return { lane: lane, claimed: 0, committed: 0, reason: 'EMPTY' };
  }

  // Master dimuat sekali untuk seluruh bundle.
  var masters = null, committed = 0, deferredAll = false;
  try {
    rscDashSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'RUNNING', stage: 'Prefetch shared master', progress: 0.1,
      currentTotal: '0 / ' + claimed.length,
      message: 'Bundle ' + claimed.length + ' file di-claim. Memuat index master sekali untuk seluruh bundle.',
      startedAt: startedIso, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
      lane: 'Lane ' + lane, runId: runId
    });
    masters = rscLoadMasters_(ss);
  } catch (e) {
    var cls = rscClassify_(e);
    if (cls.kind === RSC_ERR.INFRA) {
      // Seluruh bundle dikembalikan TANPA menambah Attempts.
      for (var d = 0; d < claimed.length; d++) rscDeferTask_(ss, claimed[d], cls.message);
      deferredAll = true;
      rscDashSet_(ss, slot, {
        job: 'VALIDATE LINK E', state: 'WAITING', stage: 'Bundle deferred (infra)', progress: 0.12,
        currentTotal: '0 / ' + claimed.length,
        message: claimed.length + ' task dikembalikan ke antrean tanpa menambah Attempts.',
        lastError: '[INFRA] ' + cls.message,
        startedAt: startedIso, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
        lane: 'Lane ' + lane, runId: runId
      }, { force: true, history: true });
      rscArmLane_(lane, rscBackoffMs_(1));
      return { lane: lane, claimed: claimed.length, committed: 0, deferred: claimed.length, reason: 'MASTER_INFRA' };
    }
    for (var d2 = 0; d2 < claimed.length; d2++) rscFailTask_(ss, claimed[d2], cls.message, cls.kind);
    rscArmLane_(lane, rscBackoffMs_(1));
    return { lane: lane, claimed: claimed.length, committed: 0, failed: claimed.length, reason: 'MASTER_' + cls.kind };
  }

  var results = [];
  for (var i = 0; i < claimed.length; i++) {
    var task = claimed[i];

    if ((Date.now() - started) > RSC_CFG.RUN.SOFT_DEADLINE_MS) {
      for (var rel = i; rel < claimed.length; rel++) {
        rscReleaseTask_(ss, claimed[rel], 'Dilepas karena batas waktu eksekusi lane; tanpa penalti.');
      }
      break;
    }

    var pct = 0.1 + 0.8 * (i / claimed.length);
    var stageInfo = {
      job: 'VALIDATE LINK E', state: 'RUNNING', stage: 'Validate Change Rolling',
      progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
      fileName: task.name, fileId: task.fileId,
      startedAt: startedIso, lane: 'Lane ' + lane, runId: runId
    };
    rscDashSet_(ss, slot, stageInfo);

    try {
      var res = rscProcessTask_(task, masters, function (st) {
        stageInfo.stage = st.stage;
        stageInfo.fileName = st.fileName;
        stageInfo.sheet = st.sheet;
        stageInfo.message = st.message;
        stageInfo.elapsedSec = rscRound_((Date.now() - started) / 1000, 1);
        rscDashSet_(ss, slot, stageInfo);
      });
      var ok = rscRetry_('commit', 3, function () { return rscCommitOk_(ss, task, res); });
      if (ok && ok.applied) {
        committed++;
        results.push({ fileId: task.fileId, status: res.errorRows ? 'COMPLETE_WITH_ERRORS' : 'COMPLETE_OK', errorRows: res.errorRows });
      } else {
        results.push({ fileId: task.fileId, status: 'DISCARDED', reason: (ok && ok.reason) || 'CAS_FAILED' });
      }
    } catch (err) {
      var c2 = rscClassify_(err);
      if (c2.kind === RSC_ERR.INFRA) {
        rscDeferTask_(ss, task, c2.message);
        results.push({ fileId: task.fileId, status: 'DEFERRED', kind: c2.kind });
        rscDashSet_(ss, slot, {
          job: 'VALIDATE LINK E', state: 'WAITING', stage: 'DB contention deferred',
          progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
          fileName: task.name, fileId: task.fileId,
          message: 'Task dikembalikan ke antrean tanpa menambah Attempts.',
          lastError: '[INFRA] ' + c2.message,
          startedAt: startedIso, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
          lane: 'Lane ' + lane, runId: runId
        }, { force: true, history: true });
      } else {
        rscFailTask_(ss, task, c2.message, c2.kind);
        results.push({ fileId: task.fileId, status: 'FAILED', kind: c2.kind });
        rscDashSet_(ss, slot, {
          job: 'VALIDATE LINK E', state: 'ERROR', stage: 'File validation failed',
          progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
          fileName: task.name, fileId: task.fileId,
          message: 'Task gagal pada attempt ' + (Number(task.attempts || 0) + 1) + '.',
          lastError: '[' + c2.kind + '] ' + c2.message,
          startedAt: startedIso, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
          lane: 'Lane ' + lane, runId: runId
        }, { force: true, history: true });
      }
    }
  }

  var stats = rscQueueStats_(ss, runId);
  rscDashSummary_(ss, runId, stats);
  rscDashSet_(ss, slot, {
    job: 'VALIDATE LINK E', state: stats.unfinished ? 'WAITING' : 'DONE',
    stage: stats.unfinished ? 'Bundle done — queue remains' : 'Bundle done — queue empty',
    progress: 1, currentTotal: committed + ' / ' + claimed.length,
    message: 'Claimed=' + claimed.length + ', committed=' + committed +
             ', elapsed=' + rscRound_((Date.now() - started) / 1000, 1) + 's.',
    startedAt: startedIso, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
    lane: 'Lane ' + lane, runId: runId
  }, { force: true, history: true });

  if (stats.unfinished > 0) rscArmLane_(lane, RSC_CFG.RUN.WORKER_TRIGGER_DELAY_MS);
  else rscFinishRunIfDone_(ss, runId, stats);

  return { lane: lane, claimed: claimed.length, committed: committed, results: results, stats: stats, deferredAll: deferredAll };
}

/* -------------------------- PEMANASAN INDEX --------------------------- */

/**
 * Membangun seluruh index master dalam eksekusi TERSENDIRI, sebelum lane mulai.
 *
 * Tanpa ini, lane yang kebetulan memenangkan lease pembangunan akan memakai
 * sebagian besar kuota 6 menitnya hanya untuk memindai tabel besar seperti
 * m_bp_relation, lalu menyerah di soft deadline. Dengan memisahkannya, biaya
 * pemindaian dibayar sekali per versi DB oleh satu execution khusus, dan lane
 * langsung mendapat index yang sudah jadi.
 */
function rscPrewarmIndexes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(rscGetProp_('RSC_MASTER_ID', ''));
  var runId = rscGetProp_(RSC_CFG.PROP.RUN_ID, '');
  var started = Date.now();
  var startedIso = new Date(started).toISOString();

  if (!rscDbSources_().length) {
    rscDashSet_(ss, 'SYSTEM', {
      job: 'INDEX PREWARM', state: 'IDLE', stage: 'DB tidak dikonfigurasi', progress: 1,
      message: 'Tidak ada DB master. Rule berbasis DB akan dilewati.',
      startedAt: startedIso, runId: runId
    }, { force: true, history: true });
    rscArmAllLanes_();
    return { ok: true, reason: 'NO_DB' };
  }

  var tables = ['BP_GENERAL', 'BP_RELATION', 'VISIT_SCHEDULE', 'SALESMAN', 'RELATION_TYPE'];
  var report = [], pending = [];

  for (var i = 0; i < tables.length; i++) {
    if ((Date.now() - started) > RSC_CFG.RUN.SOFT_DEADLINE_MS) {
      pending = tables.slice(i);
      break;
    }
    rscDashSet_(ss, 'SYSTEM', {
      job: 'INDEX PREWARM', state: 'RUNNING', stage: 'Build index ' + tables[i],
      progress: rscRound_(i / tables.length, 4), currentTotal: (i + 1) + ' / ' + tables.length,
      message: 'Membangun index master sekali untuk seluruh run.',
      startedAt: startedIso, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
    });
    try {
      var idx = rscGetIndex_(tables[i]);
      report.push(tables[i] + '=' + (idx.available
        ? (idx.rows + ' baris/' + (idx.storedIn || 'memory'))
        : ('n/a:' + (idx.reason || '-'))));
    } catch (e) {
      var c = rscClassify_(e);
      report.push(tables[i] + '=' + c.kind);
      if (c.kind === RSC_ERR.INFRA) pending.push(tables[i]);
    }
  }

  if (pending.length) {
    // Masih ada yang belum selesai: lanjutkan di eksekusi berikutnya, dan tetap
    // nyalakan lane karena index yang sudah jadi sudah bisa dipakai.
    try {
      rscDeleteTriggers_(['rscPrewarmIndexes']);
      ScriptApp.newTrigger('rscPrewarmIndexes').timeBased().after(RSC_CFG.RUN.WORKER_TRIGGER_DELAY_MS).create();
    } catch (e2) { /* best-effort */ }
  }

  rscDashSet_(ss, 'SYSTEM', {
    job: 'INDEX PREWARM', state: pending.length ? 'WAITING' : 'DONE',
    stage: pending.length ? 'Index sebagian siap' : 'Index siap', progress: 1,
    message: report.join(' | ') + (pending.length ? (' | tersisa: ' + pending.join(',')) : ''),
    startedAt: startedIso, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
  }, { force: true, history: true });

  rscArmAllLanes_();
  return { ok: true, report: report, pending: pending };
}

/* ------------------------------ TRIGGER ------------------------------- */

function rscWorker1() { return rscRunLane_(1); }
function rscWorker2() { return rscRunLane_(2); }
function rscWorker3() { return rscRunLane_(3); }
function rscWorker4() { return rscRunLane_(4); }

function rscDeleteTriggers_(handlers) {
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      if (handlers.indexOf(all[i].getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(all[i]);
    }
  } catch (e) { /* best-effort */ }
}

function rscArmLane_(lane, delayMs) {
  var fn = 'rscWorker' + lane;
  try {
    rscDeleteTriggers_([fn]);
    ScriptApp.newTrigger(fn).timeBased().after(Math.max(1000, delayMs || RSC_CFG.RUN.WORKER_TRIGGER_DELAY_MS)).create();
    return true;
  } catch (e) { return false; }
}

function rscArmAllLanes_() {
  var armed = 0;
  for (var l = 1; l <= RSC_CFG.RUN.LANES; l++) {
    if (rscArmLane_(l, RSC_CFG.RUN.WORKER_TRIGGER_DELAY_MS * l)) armed++;
  }
  return armed;
}

function rscArmWatchdog_() {
  try {
    rscDeleteTriggers_(['rscWatchdog']);
    ScriptApp.newTrigger('rscWatchdog').timeBased().everyMinutes(RSC_CFG.RUN.WATCHDOG_EVERY_MIN).create();
    return true;
  } catch (e) { return false; }
}

/* ---------------------------- KOORDINATOR ----------------------------- */

/** Mulai bulk validation baru untuk seluruh Link E. */
function rscStartBulkValidation() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  rscSetProp_('RSC_MASTER_ID', ss.getId());
  rscSetProp_(RSC_CFG.PROP.BLOCKED, '');

  var runId = RSC_CFG.VERSION + '|' + rscUuid_();
  rscSetProp_(RSC_CFG.PROP.RUN_ID, runId);
  rscSetProp_(RSC_CFG.PROP.RUN_STATE, 'BUILDING');
  rscSetProp_(RSC_CFG.PROP.OWNER, rscWhoAmI_());

  rscDashSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'START', stage: 'Build manifest', progress: 0,
    message: 'Membuat manifest dan queue Link E.', startedAt: rscNowIso_(), runId: runId
  }, { force: true, history: true });

  var stats = rscBuildManifest_(ss, runId);

  rscSetProp_(RSC_CFG.PROP.RUN_STATE, 'RUNNING');
  var qs = rscQueueStats_(ss, runId);
  rscDashSummary_(ss, runId, qs);
  rscDashSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'QUEUED', stage: 'Manifest ready', progress: 0,
    currentTotal: '0 / ' + stats.total,
    message: 'Queue siap. Link=' + stats.links + ', valid=' + stats.valid +
             ', skipped=' + stats.skipped + ', task unik=' + stats.tasks + '.',
    startedAt: rscNowIso_(), runId: runId
  }, { force: true, history: true });

  // Index dibangun lebih dulu di eksekusi tersendiri; lane dinyalakan olehnya.
  var prewarmed = false;
  try {
    rscDeleteTriggers_(['rscPrewarmIndexes']);
    ScriptApp.newTrigger('rscPrewarmIndexes').timeBased().after(RSC_CFG.RUN.WORKER_TRIGGER_DELAY_MS).create();
    prewarmed = true;
  } catch (e) { prewarmed = false; }

  var armed = prewarmed ? 0 : rscArmAllLanes_();
  rscArmWatchdog_();
  rscDashSet_(ss, 'WATCHDOG', {
    job: 'BULK WATCHDOG', state: 'WAITING', stage: prewarmed ? 'Menunggu index prewarm' : 'Workers armed',
    progress: 1,
    message: prewarmed
      ? 'Index master dibangun lebih dulu, lane akan dinyalakan setelahnya.'
      : (armed + ' worker lane dijadwalkan.'),
    startedAt: rscNowIso_(), runId: runId
  }, { force: true, history: true });

  return { runId: runId, stats: stats, armed: armed, prewarm: prewarmed };
}

/** Batalkan run berjalan dan bangun ulang antrean dari baris pertama. */
function rscRestartFromTop() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  rscSetProp_(RSC_CFG.PROP.RUN_STATE, 'STOPPED');
  rscDashSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'START', stage: 'Restart From Top', progress: 0,
    message: 'Run lama di-invalidasi. Manifest akan dibangun ulang.',
    startedAt: rscNowIso_()
  }, { force: true, history: true });
  return rscStartBulkValidation();
}

function rscStopRun() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  rscSetProp_(RSC_CFG.PROP.RUN_STATE, 'STOPPED');
  rscDeleteTriggers_(['rscWorker1', 'rscWorker2', 'rscWorker3', 'rscWorker4', 'rscWatchdog', 'rscPrewarmIndexes']);
  rscDashSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'STOPPED', stage: 'Run dihentikan', progress: 1,
    message: 'Semua trigger worker dan watchdog dilepas.', startedAt: rscNowIso_()
  }, { force: true, history: true });
  return true;
}

function rscFinishRunIfDone_(ss, runId, stats) {
  if (stats.unfinished > 0) return false;
  rscSetProp_(RSC_CFG.PROP.RUN_STATE, 'DONE');
  rscDeleteTriggers_(['rscWorker1', 'rscWorker2', 'rscWorker3', 'rscWorker4', 'rscPrewarmIndexes']);
  rscDashSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'DONE', stage: 'Queue selesai', progress: 1,
    currentTotal: stats.done + ' / ' + stats.total,
    message: 'OK=' + stats.ok + ', dengan error=' + stats.withErrors +
             ', hard=' + stats.hard + ', blocked=' + stats.blocked + ', skipped=' + stats.skipped + '.',
    startedAt: rscNowIso_(), runId: runId
  }, { force: true, history: true });
  try { rscWriteBackRekapStatus_(ss, runId); } catch (e) { /* best-effort */ }
  return true;
}

/** Tulis ringkasan hasil kembali ke kolom Feedback "Rekap Approved". */
function rscWriteBackRekapStatus_(ss, runId) {
  var rekap = ss.getSheetByName(RSC_CFG.SHEET.REKAP);
  if (!rekap) return 0;
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var pending = {}, maxRow = RSC_CFG.REKAP.FIRST_DATA_ROW, updates = 0;

  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    var rows;
    try { rows = JSON.parse(vals[i][RSC_M.MASTER_ROWS] || '[]'); } catch (e) { rows = []; }
    var st = vals[i][RSC_M.STATUS];
    var txt;
    if (st === RSC_STATUS.DONE_OK) txt = 'VALIDASI OK (0 error) — ' + rscNowIso_().substring(0, 16).replace('T', ' ');
    else if (st === RSC_STATUS.DONE_ERRORS) txt = 'PERLU REVISI: ' + vals[i][RSC_M.ERROR_ROWS] + ' baris error.';
    else if (st === RSC_STATUS.SKIPPED) txt = 'DILEWATI: ' + vals[i][RSC_M.MESSAGE];
    else if (st === RSC_STATUS.BLOCKED_INFRA) txt = 'TERTUNDA (infrastruktur): ' + vals[i][RSC_M.MESSAGE];
    else if (st === RSC_STATUS.HARD_ERROR) txt = 'GAGAL: ' + vals[i][RSC_M.SHEET_SUMMARY];
    else continue;
    for (var r = 0; r < rows.length; r++) {
      pending[rows[r]] = String(txt).substring(0, 4000);
      if (rows[r] > maxRow) maxRow = rows[r];
      updates++;
    }
  }
  if (!updates) return 0;

  // Satu pembacaan + satu penulisan untuk seluruh kolom Feedback.
  var first = RSC_CFG.REKAP.FIRST_DATA_ROW;
  var n = maxRow - first + 1;
  var col = rekap.getRange(first, RSC_CFG.REKAP.COL_FEEDBACK, n, 1).getDisplayValues();
  for (var k = 0; k < n; k++) {
    var v = pending[first + k];
    col[k] = [v === undefined ? col[k][0] : v];
  }
  rekap.getRange(first, RSC_CFG.REKAP.COL_FEEDBACK, n, 1).setValues(col);
  return updates;
}

/* ------------------------------ WATCHDOG ------------------------------- */

/**
 * Watchdog. Perbaikan [F5]: pemeriksaan otorisasi dilakukan SEKALI. Bila
 * binding tidak cocok, status BLOCKED ditulis satu kali lalu trigger watchdog
 * dilepas — tidak ada lagi loop pesan tiap 2 menit.
 */
function rscWatchdog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(rscGetProp_('RSC_MASTER_ID', ''));
  var runId = rscGetProp_(RSC_CFG.PROP.RUN_ID, '');
  var state = rscGetProp_(RSC_CFG.PROP.RUN_STATE, '');

  if (state !== 'RUNNING') {
    rscDeleteTriggers_(['rscWatchdog']);
    rscDashSet_(ss, 'WATCHDOG', {
      job: 'BULK WATCHDOG', state: 'IDLE', stage: 'No active run', progress: 1,
      message: 'Tidak ada run aktif. Watchdog dilepas.', startedAt: rscNowIso_(), runId: runId
    }, { force: true });
    return { ok: true, reason: 'NO_RUN' };
  }

  var owner = rscGetProp_(RSC_CFG.PROP.OWNER, '');
  var me = rscWhoAmI_();
  if (owner && me && me !== 'unknown' && owner !== me) {
    var reason = 'Trigger dijalankan sebagai ' + me + ', sedangkan run dimiliki ' + owner +
                 '. Jalankan menu Admin -> Bind Ulang Otorisasi memakai akun pemilik.';
    rscSetProp_(RSC_CFG.PROP.BLOCKED, reason);
    rscDeleteTriggers_(['rscWatchdog']);
    rscDashSet_(ss, 'WATCHDOG', {
      job: 'BULK WATCHDOG', state: 'BLOCKED', stage: 'Authorization binding mismatch', progress: 1,
      message: 'Watchdog dihentikan (sekali, tidak diulang).', lastError: '[AUTH] ' + reason,
      startedAt: rscNowIso_(), runId: runId
    }, { force: true, history: true });
    return { ok: false, reason: 'AUTH_MISMATCH' };
  }

  var stats = rscQueueStats_(ss, runId);
  rscDashSummary_(ss, runId, stats);

  if (stats.unfinished === 0) {
    rscFinishRunIfDone_(ss, runId, stats);
    rscDeleteTriggers_(['rscWatchdog']);
    return { ok: true, reason: 'DONE', stats: stats };
  }

  // Bangunkan lane yang mati (heartbeat basi) tanpa menyentuh Attempts.
  var revived = 0;
  try {
    var sh = rscDashSheet_(ss);
    var rows = sh.getRange(RSC_CFG.DASH.SLOT_FIRST_ROW, 1, RSC_CFG.RUN.LANES, RSC_DASH_HEADER.length).getDisplayValues();
    for (var l = 0; l < RSC_CFG.RUN.LANES; l++) {
      var hb = Date.parse(rows[l][13] || '');
      var stale = !isFinite(hb) || (Date.now() - hb) > RSC_CFG.RUN.HEARTBEAT_STALE_MS;
      if (stale) { if (rscArmLane_(l + 1, 2000 + l * 1500)) revived++; }
    }
  } catch (e) { /* best-effort */ }

  rscDashSet_(ss, 'WATCHDOG', {
    job: 'BULK WATCHDOG', state: 'RUNNING', stage: 'Health check', progress: stats.progress,
    currentTotal: stats.done + ' / ' + stats.total,
    message: 'Unfinished=' + stats.unfinished + ', lane dibangunkan=' + revived + '.',
    startedAt: rscNowIso_(), runId: runId
  });
  return { ok: true, revived: revived, stats: stats };
}

/* ==========================================================================
 * 13. MENU & ADMIN
 * ======================================================================== */

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Rolling Sales Center')
      .addItem('▶ Jalankan Validasi Semua Link E', 'rscStartBulkValidation')
      .addItem('⟳ Restart From Top', 'rscRestartFromTop')
      .addItem('■ Hentikan Run', 'rscStopRun')
      .addSeparator()
      .addItem('✓ Validasi Sheet Aktif (inline)', 'rscValidateActiveSheet')
      .addItem('📋 Ringkasan Antrean', 'rscShowQueueSummary')
      .addSeparator()
      .addSubMenu(SpreadsheetApp.getUi().createMenu('Admin / Recovery')
        .addItem('Set Link Spreadsheet DB Master', 'rscPromptSetDbId')
        .addItem('Inventarisasi Tab DB (Discovery)', 'rscDiscoverDb')
        .addItem('Bind Ulang Otorisasi', 'rscRebindAuthorization')
        .addItem('Bersihkan Cache Index', 'rscClearIndexCache')
        .addItem('Jalankan Self-Test', 'rscRunSelfTestUi'))
      .addToUi();
  } catch (e) { /* konteks tanpa UI */ }
}

/**
 * Menerima SATU ATAU BEBERAPA link/ID DB sekaligus (dipisah baris atau koma).
 * Contoh pemakaian nyata: satu file "Database" dan satu file
 * "Database m_bp_relation" yang terpisah.
 */
function rscPromptSetDbId() {
  var ui = SpreadsheetApp.getUi();
  var cur = rscDbSources_();
  var res = ui.prompt('DB Master',
    'Tempel link / ID spreadsheet database master. Boleh lebih dari satu, ' +
    'pisahkan dengan baris baru atau koma.\n\nSaat ini: ' + (cur.length ? cur.join(', ') : '(kosong)') +
    '\n\nKosongkan lalu OK untuk menghapus (rule berbasis DB akan dilewati, bukan error).',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var ids = rscSetDbSources_(res.getResponseText());
  ui.alert(ids.length ? ('DB master di-set (' + ids.length + '): \n' + ids.join('\n')) : 'DB master dikosongkan.');
}

/** Simpan daftar sumber DB dari teks bebas. Dapat dipanggil tanpa UI. */
function rscSetDbSources_(text) {
  var parts = String(text || '').split(/[\n,;]+/);
  var ids = [];
  for (var i = 0; i < parts.length; i++) {
    var id = rscConfigId_(parts[i]);
    if (id && ids.indexOf(id) < 0) ids.push(id);
  }
  rscSetProp_(RSC_CFG.PROP.DB_ID, ids.length ? ids[0] : '');
  rscSetProp_(RSC_CFG.PROP.DB_ID_EXTRA, ids.length > 1 ? ids.slice(1).join(',') : '');
  RSC_MEM_INDEX = {};
  return ids;
}

/**
 * Inventarisasi seluruh tab pada setiap spreadsheet DB dan petakan ke tabel
 * yang dipakai engine. Hasilnya ditulis ke sheet "_RSC_DB_DISCOVERY" agar
 * operator bisa melihat tab mana yang dikenali dan mana yang belum.
 * Menjalankan ini tidak mengubah apa pun selain sheet laporan.
 */
function rscDiscoverDb() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ids = rscDbSources_();
  var rows = [['Spreadsheet', 'Spreadsheet ID', 'Tab', 'Baris', 'Kolom', 'Mode', 'Dipakai sebagai',
               'Header / contoh baris 1']];

  // Tab mana yang akhirnya dipilih untuk tiap tabel engine.
  var chosen = {};
  for (var t in RSC_CFG.DB_TABLES) {
    if (!Object.prototype.hasOwnProperty.call(RSC_CFG.DB_TABLES, t)) continue;
    try {
      var loc = rscLocateTable_(RSC_CFG.DB_TABLES[t]);
      if (loc) chosen[loc.ssId + '::' + loc.sheet.getName()] = t;
    } catch (e) { /* sumber tidak terbaca; tetap dilaporkan di bawah */ }
  }

  for (var i = 0; i < ids.length; i++) {
    var db;
    try { db = SpreadsheetApp.openById(ids[i]); }
    catch (e) {
      rows.push(['(tidak dapat dibuka)', ids[i], '', '', '', '', '', String(e)]);
      continue;
    }
    var sheets = db.getSheets();
    for (var sIdx = 0; sIdx < sheets.length; sIdx++) {
      var sh = sheets[sIdx];
      var lr = sh.getLastRow(), lc = sh.getLastColumn();
      var first = (lr >= 1 && lc >= 1)
        ? sh.getRange(1, 1, 1, Math.min(lc, 20)).getDisplayValues()[0].join(' | ')
        : '';
      var role = chosen[ids[i] + '::' + sh.getName()] || '';
      var mode = '';
      if (role) {
        var cols = rscResolveColumns_(RSC_CFG.DB_TABLES[role],
          (lr >= 1 && lc >= 1) ? sh.getRange(1, 1, 1, lc).getDisplayValues()[0] : []);
        mode = cols ? cols.mode : 'TIDAK TERPETAKAN';
      }
      rows.push([db.getName(), ids[i], sh.getName(), lr, lc, mode, role, first.substring(0, 500)]);
    }
  }

  // Tabel engine yang belum menemukan tab apa pun.
  for (var t2 in RSC_CFG.DB_TABLES) {
    if (!Object.prototype.hasOwnProperty.call(RSC_CFG.DB_TABLES, t2)) continue;
    var used = false;
    for (var c in chosen) { if (chosen[c] === t2) { used = true; break; } }
    if (!used) {
      rows.push(['(belum ditemukan)', '', '', '', '', '', t2,
        'Alias yang dicari: ' + RSC_CFG.DB_TABLES[t2].sheets.join(', ')]);
    }
  }

  var out = ss.getSheetByName('_RSC_DB_DISCOVERY');
  if (!out) out = ss.insertSheet('_RSC_DB_DISCOVERY');
  out.clear();
  out.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  out.setFrozenRows(1);
  try { ss.setActiveSheet(out); } catch (e) { /* tanpa UI */ }
  return rows;
}

function rscRebindAuthorization() {
  rscSetProp_(RSC_CFG.PROP.OWNER, rscWhoAmI_());
  rscSetProp_(RSC_CFG.PROP.BLOCKED, '');
  rscArmWatchdog_();
  rscArmAllLanes_();
  try { SpreadsheetApp.getUi().alert('Otorisasi di-bind ke ' + rscWhoAmI_() + '. Worker dan watchdog dijadwalkan ulang.'); }
  catch (e) { /* tanpa UI */ }
  return rscWhoAmI_();
}

function rscClearIndexCache() {
  RSC_MEM_INDEX = {};
  var tag = rscDbSources_().join(',');
  if (tag) {
    rscSetProp_(RSC_CFG.PROP.INDEX_VER + tag, '');
    rscSetProp_(RSC_CFG.PROP.INDEX_VER + tag + ':at', '');
  }
  var store = rscIndexStore_(false);
  if (store) {
    var sheets = store.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getName().indexOf('IDX_') === 0) {
        try { sheets[i].getRange(1, 1).setValue('stale'); } catch (e) { /* abaikan */ }
      }
    }
  }
  try { SpreadsheetApp.getUi().alert('Cache index dibersihkan. Index akan dibangun ulang saat dibutuhkan.'); }
  catch (e) { /* tanpa UI */ }
  return true;
}

function rscShowQueueSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var runId = rscGetProp_(RSC_CFG.PROP.RUN_ID, '');
  var s = rscQueueStats_(ss, runId);
  var msg = 'Run: ' + (runId || '-') +
    '\nTotal task: ' + s.total +
    '\nQUEUED ' + s.queued + ' | ACTIVE ' + s.active + ' | RETRY ' + s.retry + ' | DEFERRED ' + s.deferred +
    '\nCOMPLETE_OK ' + s.ok + ' | WITH_ERRORS ' + s.withErrors +
    '\nHARD_ERROR ' + s.hard + ' | BLOCKED_INFRA ' + s.blocked + ' | SKIPPED ' + s.skipped +
    '\nProgress: ' + Math.round(s.progress * 100) + '%';
  try { SpreadsheetApp.getUi().alert('Ringkasan Antrean', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { /* tanpa UI */ }
  return s;
}

/** Validasi sheet yang sedang dibuka — jalur cepat, engine yang sama persis. */
function rscValidateActiveSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getActiveSheet();
  var spec = rscSpecFor_(sh.getName());
  if (!spec) {
    try { SpreadsheetApp.getUi().alert('Sheet "' + sh.getName() + '" tidak termasuk sheet yang divalidasi.'); } catch (e) {}
    return null;
  }
  var masters;
  try {
    masters = rscLoadMasters_(ss);
  } catch (e) {
    var c = rscClassify_(e);
    var note = c.kind === RSC_ERR.INFRA
      ? 'Index master sedang dibangun execution lain. Coba lagi beberapa saat.'
      : ('Gagal memuat master: ' + c.message);
    try { SpreadsheetApp.getUi().alert(note); } catch (e2) {}
    return { error: note, kind: c.kind };
  }
  var needCols = Math.max(spec.errorCol, spec.header.length);
  var header = sh.getRange(1, 1, 1, Math.max(needCols, sh.getLastColumn() || needCols)).getDisplayValues()[0];
  var layoutErr = rscCheckLayout_(spec, header);
  if (layoutErr) {
    try { SpreadsheetApp.getUi().alert(layoutErr); } catch (e2) {}
    return { layoutError: layoutErr };
  }
  var dataRows = Math.max(0, sh.getLastRow() - 1);
  var values = dataRows ? sh.getRange(2, 1, dataRows, needCols).getValues() : [];
  var res = rscValidateValues_(spec, values, masters);
  rscWriteResults_(sh, spec, res, dataRows);
  try {
    SpreadsheetApp.getUi().alert('Validasi selesai.\nBaris: ' + res.rowCount + '\nError: ' + res.errorRows);
  } catch (e3) {}
  return { rows: res.rowCount, errorRows: res.errorRows, byCode: res.byCode };
}

/* ==========================================================================
 * 14. SELF-TEST  (jalankan langsung dari editor Apps Script)
 * ======================================================================== */

function rscRunSelfTestUi() {
  var r = rscSelfTest();
  try {
    SpreadsheetApp.getUi().alert('Self-Test ' + (r.ok ? 'LULUS' : 'GAGAL'),
      r.passed + ' lulus, ' + r.failed.length + ' gagal.\n\n' + r.failed.join('\n'),
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* tanpa UI */ }
  return r;
}

/** Uji unit murni (tanpa I/O) atas normalisasi, klasifikasi error, dan rule. */
function rscSelfTest() {
  var passed = 0, failed = [];
  function ok(name, cond) { if (cond) passed++; else failed.push('FAIL: ' + name); }
  function eq(name, a, b) { if (String(a) === String(b)) passed++; else failed.push('FAIL: ' + name + ' -> "' + a + '" != "' + b + '"'); }

  /* normalisasi */
  eq('idOnly dropdown', rscIdOnly_('2AA0 - STA Bogor'), '2AA0');
  eq('idOnly plain', rscIdOnly_('2AA0'), '2AA0');
  eq('fileId url', rscFileId_('https://docs.google.com/spreadsheets/d/1hyCWTVyW42xJ4HrGVRxbolaZpxZC1SVO5DgS7c90MjA/edit'), '1hyCWTVyW42xJ4HrGVRxbolaZpxZC1SVO5DgS7c90MjA');
  eq('fileId invalid', rscFileId_('COPY_ERROR: File/link source tidak ditemukan'), '');
  eq('date iso', rscDateStr_('2026-08-01 12:00:00'), '2026-08-01');
  eq('date open ended', rscDateStr_('9999-12-31 00:00:00'), '9999-12-31');
  ok('date valid', rscIsValidDateStr_('2026-02-28'));
  ok('date invalid', !rscIsValidDateStr_('2026-02-30'));

  /* klasifikasi error — jantung perbaikan F2 */
  eq('infra busy', rscClassify_(new Error('Serialized m_bp_relation reader sedang dipakai execution lain')).kind, RSC_ERR.INFRA);
  eq('infra lock', rscClassify_(new Error('Could not acquire lock')).kind, RSC_ERR.INFRA);
  eq('infra quota', rscClassify_(new Error('Service invoked too many times')).kind, RSC_ERR.INFRA);
  eq('access denied', rscClassify_(new Error('You do not have permission to access')).kind, RSC_ERR.ACCESS);
  eq('data error', rscClassify_(new RscDataError('Layout A:P tidak sesuai')).kind, RSC_ERR.DATA);

  /* tanggal dari DB master: epoch milidetik & serial */
  eq('epoch 9999-12-31', rscDateStr_('253402214400000'), '9999-12-31');
  eq('epoch 2026-03-01', rscDateStr_('1772323200000'), '2026-03-01');
  eq('epoch sebagai angka', rscDateStr_(1772323200000), '2026-03-01');
  eq('serial spreadsheet', rscDateStr_('46235'), '2026-08-01');
  eq('bukan tanggal', rscDateStr_('ZWS003'), '');

  /* parser ID konfigurasi vs parser link antrean */
  eq('config dari URL', rscConfigId_('https://docs.google.com/spreadsheets/d/1psDMLLr98FuHjKhhfBTwg8p0kBA3w26xrdXb6_tu7CU/edit?usp=drive_link'), '1psDMLLr98FuHjKhhfBTwg8p0kBA3w26xrdXb6_tu7CU');
  eq('config dari ID telanjang', rscConfigId_('DB_MASTER_ID'), 'DB_MASTER_ID');
  eq('config menolak teks berspasi', rscConfigId_('TIDAK ADA ROLINGAN'), '');
  eq('link antrean menolak ID pendek', rscFileId_('DB_MASTER_ID'), '');

  /* pencocokan nama tab tidak boleh menyambar tabel lain */
  var fakeSheets = ['m_bp_relation', 'm_sales_info', 'm_bp_general', 'catatan'];
  var fakeSs = {
    getSheets: function () {
      var out = [];
      for (var i = 0; i < fakeSheets.length; i++) {
        (function (nm) { out.push({ getName: function () { return nm; } }); })(fakeSheets[i]);
      }
      return out;
    }
  };
  var hitRel = rscFindSheet_(fakeSs, RSC_CFG.DB_TABLES.BP_RELATION.sheets);
  eq('BP_RELATION menemukan m_bp_relation', hitRel && hitRel.getName(), 'm_bp_relation');
  eq('RELATION_TYPE tidak menyambar m_bp_relation',
     rscFindSheet_(fakeSs, RSC_CFG.DB_TABLES.RELATION_TYPE.sheets), null);
  var hitGen = rscFindSheet_(fakeSs, RSC_CFG.DB_TABLES.BP_GENERAL.sheets);
  eq('BP_GENERAL menemukan m_bp_general', hitGen && hitGen.getName(), 'm_bp_general');
  eq('VISIT_SCHEDULE tidak menemukan apa pun',
     rscFindSheet_(fakeSs, RSC_CFG.DB_TABLES.VISIT_SCHEDULE.sheets), null);

  /* mode posisional untuk tabel tanpa header */
  var posCols = rscResolveColumns_(RSC_CFG.DB_TABLES.BP_RELATION,
    ['https://docs.google.com/spreadsheets/d/x/edit', '', '', '', '']);
  eq('m_bp_relation terdeteksi posisional', posCols && posCols.mode, 'positional');
  eq('data posisional mulai baris 1', posCols && posCols.firstDataRow, 1);
  var hdrCols = rscResolveColumns_(RSC_CFG.DB_TABLES.SALESMAN,
    ['id', 'sls_org', 'sls_office', 'salesman_id', 'salesman_name', 'sales_type']);
  eq('m_sales_info terdeteksi header', hdrCols && hdrCols.mode, 'header');
  eq('data header mulai baris 2', hdrCols && hdrCols.firstDataRow, 2);

  /* schedule parser */
  var p = rscParseSchedule_('W1W,W3W');
  eq('schedule count', p.valid.length, 2);
  eq('schedule weekday', Object.keys(p.weekdays).join(','), 'W');
  eq('schedule bad token', rscParseSchedule_('W5X').invalid.length, 1);

  /* engine end-to-end kecil */
  var spec = rscPrimarySpec_();
  var masters = {
    office: { available: true, map: { '2BA0': { code: '2BA0', desc: 'STA Kranggan Hub' } } },
    relationship: { available: true, map: { ZWS003: 'Sales Rep. Food', ZWS004: 'Sales Rep. Non-Food' } },
    periodStart: '2026-08-01',
    idx: {}
  };
  function row(over) {
    var base = ['2BA0', '2BA0', '110094788', 'ZWS003', 'S091010486', 'ZD01', '2026-08-01', '9999-12-31',
                'F2', '03', 'W1W,W3W', '2026-08-01', '9999-12-31', 'Rolling', '', ''];
    for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
    return base;
  }
  var r1 = rscValidateValues_(spec, [row({})], masters);
  eq('clean row OK', r1.status[0], 'OK');

  var r2 = rscValidateValues_(spec, [row({ 3: 'ZWS999' })], masters);
  ok('R2 unknown relationship', r2.detail[0].indexOf('[R2]') >= 0);

  var r3 = rscValidateValues_(spec, [row({ 8: 'F4', 10: 'W1W,W3W' })], masters);
  ok('R6 token count mismatch', r3.detail[0].indexOf('[R6]') >= 0);

  var r4 = rscValidateValues_(spec, [row({ 8: 'F2', 10: 'W1W,W2W' })], masters);
  ok('R6 F2 week pattern', r4.detail[0].indexOf('[R6]') >= 0);

  var r5 = rscValidateValues_(spec, [row({}), row({ 10: 'W2W,W4W' })], masters);
  ok('R7 schedule conflict', r5.detail[0].indexOf('[R7]') >= 0 && r5.detail[1].indexOf('[R7]') >= 0);

  var r6 = rscValidateValues_(spec, [row({}), row({})], masters);
  ok('R8a duplicate key', r6.detail[0].indexOf('[R8]') >= 0);

  var r7 = rscValidateValues_(spec, [row({ 13: 'Toko Bangkrut' })], masters);
  ok('TB open ended not allowed', r7.detail[0].indexOf('[TB]') >= 0);

  var r8 = rscValidateValues_(spec, [row({ 0: '9ZZ9', 1: '9ZZ9' })], masters);
  ok('R3 unknown office', r8.detail[0].indexOf('[R3]') >= 0);

  var r9 = rscValidateValues_(spec, [row({ 4: 'X1' })], masters);
  ok('R9 salesman format', r9.detail[0].indexOf('[R9]') >= 0);

  var r10 = rscValidateValues_(spec, [row({ 2: '11ABC' })], masters);
  ok('R10 customer format', r10.detail[0].indexOf('[R10]') >= 0);

  /* layout */
  var badHeader = spec.header.slice(); badHeader[3] = '';
  var lay = rscCheckLayout_(spec, badHeader);
  ok('layout message format', lay && lay.indexOf('$D: expected "Relationship", got ""') >= 0);
  ok('layout clean', rscCheckLayout_(spec, spec.header.slice()) === null);

  /* backoff */
  ok('backoff naik', rscBackoffMs_(3) >= rscBackoffMs_(1) * 1.5);
  ok('backoff dibatasi', rscBackoffMs_(20) <= RSC_CFG.RUN.RETRY_MAX_MS * 1.3);

  return { ok: failed.length === 0, passed: passed, failed: failed };
}
