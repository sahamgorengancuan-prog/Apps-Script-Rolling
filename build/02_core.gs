
/* =============================================================
 * 2. CORE UTILITIES
 * ============================================================= */

var RSC_ID_NORMALIZE_CACHE_ = Object.create(null);
var RSC_ID_NORMALIZE_COUNT_ = 0;
var RSC_ID_NORMALIZE_LIMIT_ = 20000;

/** Teks sel yang sudah dibersihkan: NBSP/zero-width dibuang, spasi dirapatkan. */
function rscText_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    return (v === Math.floor(v) && Math.abs(v) < 1e15) ? String(Math.round(v)) : String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  var s = String(v);
  s = s.replace(/[\u00A0\u180E\u200B-\u200D\u2028\u2029\u202F\u2060\uFEFF]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/** Kunci perbandingan header/enum: huruf besar tanpa karakter non-alfanumerik. */
function rscKey_(v) {
  return rscText_(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Normalisasi ID. Menangani:
 *  - dropdown "KODE - Deskripsi"  -> "KODE"
 *  - apostrof teks Sheets         -> dibuang
 *  - angka bergaya 110252135.0    -> 110252135
 *  - notasi eksponen 1.1025e+8    -> 110252135
 * Hasil di-cache karena dipanggil jutaan kali pada file besar.
 */
function RSC_NORMALIZE_ID_(value) {
  var raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return '';
  if (Object.prototype.hasOwnProperty.call(RSC_ID_NORMALIZE_CACHE_, raw)) {
    return RSC_ID_NORMALIZE_CACHE_[raw];
  }

  var s = raw.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/^'+/, '').trim();
  var label = s.match(/^\s*([A-Za-z0-9]+)\s*(?:-|–|—|\|)\s+.+$/);
  if (label && label[1]) s = label[1];
  s = s.replace(/\s+/g, '');
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (/^\d+(?:\.\d+)?[eE]\+?\d+$/.test(s)) {
    var n = Number(s);
    if (isFinite(n)) s = String(Math.round(n));
  }
  s = s.toUpperCase();

  if (RSC_ID_NORMALIZE_COUNT_ < RSC_ID_NORMALIZE_LIMIT_) {
    RSC_ID_NORMALIZE_CACHE_[raw] = s;
    RSC_ID_NORMALIZE_COUNT_++;
  }
  return s;
}

/** Ambil bagian ID dari nilai dropdown, tanpa uppercase paksa. */
function rscIdOnly_(v) {
  var s = rscText_(v);
  if (!s) return '';
  var m = s.match(/^([A-Za-z0-9_.\-]+)\s*(?:-|–|—|\|)\s+/);
  return m ? m[1] : s;
}

/** fileId Google Sheets dari URL/ID mentah. Ketat: teks bebas ditolak. */
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

function rscPad_(n, w) {
  var s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

/**
 * Tanggal -> 'YYYY-MM-DD'.
 * Menerima objek Date, epoch milidetik (dipakai m_sales_info), serial
 * spreadsheet, teks ISO, dan teks DD/MM/YYYY.
 */
function rscDateStr_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return rscPad_(v.getFullYear(), 4) + '-' + rscPad_(v.getMonth() + 1, 2) + '-' + rscPad_(v.getDate(), 2);
  }
  if (typeof v === 'number' && isFinite(v)) v = String(Math.round(v));

  var s = rscText_(v);
  if (!s) return '';

  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[3], 2);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return m[3] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[1], 2);

  if (/^\d+(\.\d+)?$/.test(s)) {
    var num = Number(s), d = null;
    if (num >= 1e11) d = new Date(num);                                  // epoch milidetik
    else if (num > 0 && num < 500000) d = new Date(Math.round((num - 25569) * 86400000)); // serial
    if (d && !isNaN(d.getTime())) {
      return rscPad_(d.getUTCFullYear(), 4) + '-' + rscPad_(d.getUTCMonth() + 1, 2) + '-' + rscPad_(d.getUTCDate(), 2);
    }
  }
  return '';
}

function rscIsValidDateStr_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (s === OPEN_ENDED_DATE_TEXT) return true;
  var y = Number(s.slice(0, 4)), mo = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Stempel waktu tampilan, mengikuti zona dan format dashboard lama. */
function rscStamp_(date) {
  var d = date || new Date();
  try {
    var tz = (Session.getScriptTimeZone && Session.getScriptTimeZone()) || ROLLING_SALES_CENTER_PARAMETERS.timezone;
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss');
  } catch (e) {
    return rscPad_(d.getFullYear(), 4) + '-' + rscPad_(d.getMonth() + 1, 2) + '-' + rscPad_(d.getDate(), 2) +
      ' ' + rscPad_(d.getHours(), 2) + ':' + rscPad_(d.getMinutes(), 2) + ':' + rscPad_(d.getSeconds(), 2);
  }
}

function rscNowIso_() { return new Date().toISOString(); }

function rscUuid_() {
  try { return Utilities.getUuid(); }
  catch (e) { return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e9); }
}

function rscSleep_(ms) {
  try { Utilities.sleep(ms); } catch (e) { /* di luar GAS */ }
}

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

function rscColLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** "2,3,4 ...(+18 baris)" — menjaga pesan tetap pendek pada file besar. */
function rscRowsLabel_(rows) {
  var n = RSC_STANDARD_VALIDATION_V27_20260814.msgMaxRowsInMessage;
  if (rows.length <= n) return rows.join(',');
  return rows.slice(0, n).join(',') + ' ...(+' + (rows.length - n) + ' baris)';
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
  } catch (e) { /* properti bersifat best-effort */ }
}

function rscWhoAmI_() {
  try { return Session.getEffectiveUser().getEmail() || 'unknown'; }
  catch (e) { return 'unknown'; }
}

function rscActiveSs_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (ss) return ss;
  var id = rscGetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, '');
  if (!id) id = rscGetProp_(RSC_STANDARD_VALIDATION_V27_20260814.pMasterSsId, '');
  if (!id) throw new Error('Master spreadsheet belum diketahui. Buka file induk lalu jalankan menu sekali.');
  return SpreadsheetApp.openById(id);
}

/** Tampilkan dialog bila ada UI; kalau tidak, kembalikan teksnya saja. */
function rscAlert_(title, message) {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.alert(String(title), String(message), ui.ButtonSet.OK);
  } catch (e) { /* konteks tanpa UI */ }
  return message;
}

function rscToast_(message, title) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(String(message), String(title || 'Rolling Sales Center'), 5); }
  catch (e) { /* konteks tanpa UI */ }
}

function writeRollingSalesCenterLog_(message) {
  try { Logger.log(String(message)); } catch (e) { /* abaikan */ }
}

function runSafelyWithOptionalRethrow_(label, fn, rethrow) {
  try { return fn(); }
  catch (e) {
    writeRollingSalesCenterLog_(label + ' gagal: ' + e);
    if (rethrow) throw e;
    return null;
  }
}

/* =============================================================
 * 3. KLASIFIKASI ERROR  — inti perbaikan [F2]
 * ============================================================= */

var RSC_ERR = { INFRA: 'INFRA', ACCESS: 'ACCESS', DATA: 'DATA', FATAL: 'FATAL' };

function RscInfraError(msg, meta) {
  this.name = 'RscInfraError';
  this.message = msg;
  this.rscKind = RSC_ERR.INFRA;
  this.meta = meta || {};
}
RscInfraError.prototype = Object.create(Error.prototype);

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
  /maximum allowed size/i, /smaller range of cells/i, /too large/i, /exceeds/i,
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
 * Menentukan jenis kegagalan. Ini yang membuat "[PERF19 DB BUSY]" berhenti
 * menghasilkan "Task gagal pada attempt N" seperti pada versi lama.
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

/** Backoff eksponensial + jitter, dibatasi retryMaxMs. */
function rscBackoffMs_(n) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var base = V.retryBaseMs * Math.pow(2, Math.max(0, n - 1));
  var capped = Math.min(base, V.retryMaxMs);
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

/** Retry otomatis KHUSUS error INFRA. Kegagalan data langsung dilempar. */
function rscRetry_(label, tries, fn) {
  var last = null;
  for (var i = 1; i <= tries; i++) {
    try { return fn(i); }
    catch (e) {
      last = e;
      if (rscClassify_(e).kind !== RSC_ERR.INFRA || i === tries) throw e;
      rscSleep_(rscBackoffMs_(i));
    }
  }
  throw last;
}

/* =============================================================
 * 4. LEASE PER-RESOURCE — inti perbaikan [F1]
 * ============================================================= */

/** Critical section sangat pendek yang dilindungi lock global. */
function rscAtomic_(fn, waitMs) {
  var lock = null;
  try { lock = LockService.getScriptLock(); } catch (e) { lock = null; }
  if (!lock) return fn();
  if (!lock.tryLock(waitMs || 3000)) {
    throw new RscInfraError('Tidak dapat mengambil lock global untuk operasi atomik.');
  }
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch (e2) { /* sudah lepas */ } }
}

/** Ambil lease bernama. Mengembalikan token, atau '' bila sedang dipegang. */
function rscLeaseAcquire_(resource, ttlMs) {
  var key = RSC_DB_PARAMETERS.pLeasePrefix + resource;
  var token = rscUuid_();
  var now = Date.now();
  return rscAtomic_(function () {
    var raw = rscGetProp_(key, '');
    if (raw) {
      var cur = null;
      try { cur = JSON.parse(raw); } catch (e) { cur = null; }
      if (cur && Number(cur.until) > now) return '';
    }
    rscSetProp_(key, JSON.stringify({ token: token, until: now + (ttlMs || 60000), by: rscWhoAmI_() }));
    return token;
  }, 3000);
}

/** Lepas lease hanya bila token cocok. */
function rscLeaseRelease_(resource, token) {
  if (!token) return;
  var key = RSC_DB_PARAMETERS.pLeasePrefix + resource;
  try {
    rscAtomic_(function () {
      var raw = rscGetProp_(key, '');
      if (!raw) return;
      var cur = null;
      try { cur = JSON.parse(raw); } catch (e) { cur = null; }
      if (cur && cur.token === token) rscSetProp_(key, '');
    }, 3000);
  } catch (e) { /* lease kedaluwarsa sendiri */ }
}

/* -------------------------------------------------------------
 * PEWARNAAN STATUS TERPUSAT
 * Semua permukaan (O:P, manifest, dashboard, rekap) memakai peta yang sama
 * supaya arti warna tidak pernah berbeda antar sheet.
 * ----------------------------------------------------------- */

function RSC_UI_STATUS_COLOR_20260820_(status) {
  var NONE = RSC_UI_STATUS_COLORS_20260820.NONE;
  var key = rscKey_(status);
  if (!key) return NONE;
  var name = RSC_UI_STATUS_MAP_20260820[key];
  if (!name) {
    for (var i = 0; i < RSC_UI_STATUS_KEYWORDS_20260820.length; i++) {
      if (key.indexOf(RSC_UI_STATUS_KEYWORDS_20260820[i][0]) >= 0) {
        name = RSC_UI_STATUS_KEYWORDS_20260820[i][1];
        break;
      }
    }
  }
  return RSC_UI_STATUS_COLORS_20260820[name || 'NONE'] || NONE;
}

/**
 * Warnai satu kolom status. `statuses` adalah array teks per baris.
 * Best-effort: kegagalan pewarnaan tidak pernah menggagalkan pipeline.
 */
function RSC_UI_PAINT_STATUS_COLUMN_20260820_(sheet, firstRow, col, statuses, width) {
  if (!sheet || !statuses || !statuses.length) return 0;
  width = width || 1;
  try {
    var bg = [], fc = [], fw = [];
    for (var i = 0; i < statuses.length; i++) {
      var p = RSC_UI_STATUS_COLOR_20260820_(statuses[i]);
      var rb = [], rf = [], rw = [];
      for (var c = 0; c < width; c++) {
        rb.push(p.bg);
        rf.push(p.font);
        rw.push(c === 0 && p.bold ? 'bold' : 'normal');
      }
      bg.push(rb); fc.push(rf); fw.push(rw);
    }
    var rng = sheet.getRange(firstRow, col, statuses.length, width);
    rng.setBackgrounds(bg);
    if (rng.setFontColors) rng.setFontColors(fc);
    if (rng.setFontWeights) rng.setFontWeights(fw);
    return statuses.length;
  } catch (e) {
    return 0;
  }
}

/* -------------------------------------------------------------
 * PEMBACAAN & PENULISAN SHEET BESAR
 * -------------------------------------------------------------
 * Google Sheets menolak satu request yang terlalu besar:
 *   "Requested data exceeds the maximum allowed size. Please get a smaller
 *    range of cells."
 * Template rolling nyata punya 50.708 baris berformat walau datanya hanya
 * ~1.400 baris, sehingga satu getValues() atas seluruh sheet selalu gagal dan
 * file tidak pernah selesai divalidasi. Semua akses dipotong per blok, dan
 * ukuran bloknya mengecil sendiri bila masih terlalu besar.
 * ----------------------------------------------------------- */

function rscIsOversizedRangeError_(err) {
  var msg = (err && err.message) ? String(err.message) : String(err);
  return /maximum allowed size|smaller range of cells|too large|exceeds/i.test(msg);
}

/** Baca satu kolom sebagai teks, per blok. Dipakai untuk mencari baris terakhir. */
function rscReadColumnChunked_(sheet, col, firstRow, numRows) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var step = V.probeChunkRows || 20000;
  var out = [], r = 0;
  while (r < numRows) {
    var n = Math.min(step, numRows - r);
    try {
      var block = sheet.getRange(firstRow + r, col, n, 1).getDisplayValues();
      for (var i = 0; i < block.length; i++) out.push(block[i][0]);
      r += n;
    } catch (e) {
      if (rscIsOversizedRangeError_(e) && step > (V.minChunkRows || 100)) {
        step = Math.max(V.minChunkRows || 100, Math.floor(step / 4));
        continue;
      }
      throw e;
    }
  }
  return out;
}

/**
 * Baris data terakhir yang sebenarnya. getLastRow() ikut menghitung baris yang
 * hanya punya format atau dropdown, jadi tidak bisa dipakai apa adanya.
 */
function rscLastDataRow_(sheet, spec) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var last = sheet.getLastRow();
  if (last < 2) return 1;
  var cols = (V.probeColumns && V.probeColumns[spec.key]) || [1];
  var best = 1;
  for (var c = 0; c < cols.length; c++) {
    var col = cols[c];
    if (col > sheet.getMaxColumns()) continue;
    var vals = rscReadColumnChunked_(sheet, col, 2, last - 1);
    for (var i = vals.length - 1; i >= 0; i--) {
      if (rscText_(vals[i])) { if (i + 2 > best) best = i + 2; break; }
    }
  }
  return best;
}

/** Baca rentang persegi per blok baris. */
function rscReadValuesChunked_(sheet, firstRow, firstCol, numRows, numCols) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var step = V.readChunkRows || 5000;
  var out = [], r = 0;
  while (r < numRows) {
    var n = Math.min(step, numRows - r);
    try {
      var block = sheet.getRange(firstRow + r, firstCol, n, numCols).getValues();
      for (var i = 0; i < block.length; i++) out.push(block[i]);
      r += n;
    } catch (e) {
      if (rscIsOversizedRangeError_(e) && step > (V.minChunkRows || 100)) {
        step = Math.max(V.minChunkRows || 100, Math.floor(step / 4));
        continue;
      }
      throw e;
    }
  }
  return out;
}

function rscIsValidationRejectError_(err) {
  var msg = (err && err.message) ? String(err.message) : String(err);
  return /data validation|validasi data|dropdown|please select a value|pilih .* dari|invalid data|masukkan nilai/i.test(msg);
}

/**
 * Tulis nilai per blok, dan sembuhkan sendiri bila ditolak data validation.
 *
 * Template lama memasang aturan list "reject input" pada kolom Schedule Visit
 * yang formula sumbernya sudah menjadi #REF!, sehingga TIDAK ADA nilai yang
 * diterima dan setiap setValues() gagal dengan
 *   "Pilih Schedule Visit dari dropdown."
 * Aturan rusak itu dibuang lalu penulisan diulang; dropdown yang benar
 * dipasang kembali sesudahnya oleh rscApplyTemplateDropdowns_.
 */
function rscSetValuesChunked_(sheet, firstRow, firstCol, values, stats) {
  if (!values || !values.length) return 0;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var step = V.writeChunkRows || 5000;
  var numCols = values[0].length;
  var r = 0, repaired = 0;
  while (r < values.length) {
    var n = Math.min(step, values.length - r);
    var block = values.slice(r, r + n);
    var rng = sheet.getRange(firstRow + r, firstCol, n, numCols);
    try {
      rng.setValues(block);
      r += n;
    } catch (e) {
      if (rscIsOversizedRangeError_(e) && step > (V.minChunkRows || 100)) {
        step = Math.max(V.minChunkRows || 100, Math.floor(step / 4));
        continue;
      }
      if (rscIsValidationRejectError_(e)) {
        try {
          rng.setDataValidation(null);
          rng.setValues(block);
          repaired += n;
          r += n;
          continue;
        } catch (e2) { throw e2; }
      }
      throw e;
    }
  }
  if (stats && repaired) stats.validationRepairedRows = (stats.validationRepairedRows || 0) + repaired;
  return repaired;
}
