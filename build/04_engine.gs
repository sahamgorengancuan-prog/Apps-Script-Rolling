
/* =============================================================
 * 7. SPESIFIKASI SHEET + ENGINE VALIDASI (Standard V28.3 / PERF26)
 * -------------------------------------------------------------
 * Satu engine dipakai Active Sheet maupun Bulk Link E, sehingga keputusan
 * bisnis dijamin identik. Yang berbeda hanya orchestration-nya.
 *
 *   RSC_STD_VALIDATE_ONE_SHEET_20260814_
 *     -> RSC_STD_VALIDATE_ROLLING_20260814_
 *          -> RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_20260814_
 *               1. RSC_V28_3_CREATE_ROLLING_SNAPSHOT_20260814_   (baca + canonicalize)
 *               2. RSC_V28_3_LOAD_ROLLING_MASTERS_20260814_      (subset master)
 *               3. RSC_STD_LOAD_RELATION_CONTEXT_20260814_       (konteks m_bp_relation)
 *               4. RSC_STD_DETECT_CHANGE_SCHEDULE_ONLY_20260819_ (CASE 1 / CASE 2)
 *               5. RSC_V28_3_APPLY_ROLLING_MUTATIONS_20260814_   (auto-replace)
 *               6. RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_RULES_20260814_
 *               7. RSC_V28_3_WRITE_ROLLING_SNAPSHOT_20260814_    (A:N + O:P + warna)
 * ============================================================= */

var RSC_SHEET_SPECS = [
  {
    key: 'ROLLING',
    validator: 'ROLLING',
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
    dataCols: 14,
    dateFields: ['Valid From', 'Valid To', 'Visit Valid From', 'Visit Valid To'],
    idFields: ['Sales Office', 'Delivering Plant', 'Customer ID', 'Relationship', 'Salesman ID',
               'Salesman BP Type', 'Visit Category', 'Visit Type'],
    rowRules: ['S0', 'R1', 'R1A', 'R2', 'R3', 'R4', 'R5', 'R6', 'R9', 'R9A', 'R10', 'R11', 'R12'],
    tableRules: ['R7', 'R8a', 'R8b', 'TB']
  },
  {
    key: 'SALESMAN_TYPE',
    validator: 'SALESMAN_TYPE',
    label: 'Change Salesman Type',
    names: ['Change Salesman Type'],
    header: ['Salesman ID', 'Sales Organization', 'Sales Office', 'Sales Type', 'Coverage',
             'Valid From', 'Valid To', 'Validation Status', 'Error Detail'],
    statusCol: 8,
    errorCol: 9,
    dataCols: 7,
    dateFields: ['Valid From', 'Valid To'],
    idFields: ['Salesman ID', 'Sales Organization', 'Sales Office', 'Sales Type'],
    dupKey: ['Salesman ID', 'Sales Organization', 'Sales Office', 'Sales Type', 'Coverage', 'Valid To'],
    rowRules: [],
    tableRules: []
  },
  {
    key: 'SALES_OFFICE',
    validator: 'SALES_OFFICE',
    label: 'Change Sales Office',
    names: ['Change Sales Office'],
    header: ['BP Number Source', 'Delivering Plant', 'Distr. Channel', 'Division',
             'Sales Organization', 'Sales Office', 'Validation Status', 'Error Detail'],
    statusCol: 7,
    errorCol: 8,
    dataCols: 6,
    dateFields: [],
    idFields: ['Delivering Plant', 'Distr. Channel', 'Division', 'Sales Organization', 'Sales Office'],
    dupKey: ['BP Number Source', 'Delivering Plant', 'Sales Organization', 'Distr. Channel', 'Division', 'Sales Office'],
    rowRules: [],
    tableRules: []
  }
];

function rscSpecFor_(sheetName) {
  var k = rscKey_(sheetName);
  if (!k) return null;
  var i, n;
  for (i = 0; i < RSC_SHEET_SPECS.length; i++) {
    for (n = 0; n < RSC_SHEET_SPECS[i].names.length; n++) {
      if (k === rscKey_(RSC_SHEET_SPECS[i].names[n])) return RSC_SHEET_SPECS[i];
    }
  }
  // Toleransi hanya untuk nama tab yang terpotong 31 karakter oleh xlsx.
  if (sheetName && String(sheetName).length >= RSC_SHEET_NAME_LIMIT) {
    for (i = 0; i < RSC_SHEET_SPECS.length; i++) {
      for (n = 0; n < RSC_SHEET_SPECS[i].names.length; n++) {
        var nk = rscKey_(RSC_SHEET_SPECS[i].names[n]);
        if (nk.indexOf(k) === 0) return RSC_SHEET_SPECS[i];
      }
    }
  }
  return null;
}

function rscPrimarySpec_() {
  for (var i = 0; i < RSC_SHEET_SPECS.length; i++) if (RSC_SHEET_SPECS[i].primary) return RSC_SHEET_SPECS[i];
  return RSC_SHEET_SPECS[0];
}

/* -------------------------------------------------------------
 * 7.1 CANONICALIZATION (dijalankan sebelum rule apa pun)
 * ----------------------------------------------------------- */

var RSC_SALESMAN_NORMAL_RE = /^S\d+$/;
var RSC_SALESMAN_DUMMY_RE = /^S0000[0TSM][A-Z0-9]{4}$/;
var RSC_SS_PAIR_RE = /^S[A-Z0-9]+$/;
var RSC_RELATIONSHIP_FORMAT_RE = /^(ZWS\d{3}|BUR001)$/;
var RSC_BP_TYPE_FORMAT_RE = /^ZD\d{2}$/;
var RSC_PLANT_FORMAT_RE = /^[A-Z0-9]{4}$/;

/** Kode/ID: buang label dropdown, apostrof, spasi, zero-width; uppercase. */
function RSC_STD_CANON_CODE_20260814_(v) {
  return RSC_NORMALIZE_ID_(v);
}

/** Visit Type: 1 / 01 / 1.0 -> 01. Selalu 2 digit bila numerik. */
function RSC_STD_CANON_VISIT_TYPE_20260814_(v) {
  var s = RSC_NORMALIZE_ID_(v);
  if (!s) return '';
  if (/^\d+$/.test(s)) {
    var n = Number(s);
    return (n >= 0 && n < 100) ? rscPad_(n, 2) : s;
  }
  return s;
}

/**
 * Schedule Visit: koma full-width -> koma biasa, whitespace dibuang,
 * uppercase, token dirapikan. Normalisasi ini terjadi SEBELUM R6, jadi
 * "W1M, W3M" otomatis menjadi "W1M,W3M" dan bukan ERROR.
 */
function RSC_STD_CANON_SCHEDULE_20260814_(v) {
  var raw = rscText_(v);
  if (!raw) return '';
  var s = raw.replace(/，/g, ',').replace(/[;\/]/g, ',').toUpperCase().replace(/\s+/g, '');
  var parts = s.split(',');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] !== '') out.push(parts[i]);
    else out.push('');
  }
  // token kosong dipertahankan supaya R6 dapat melaporkan koma ganda
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join(',');
}

/**
 * Tanggal fleksibel -> YYYY-MM-DD.
 * Mengembalikan { raw, value, hadInput, parsed } supaya R4 dapat membedakan
 * "kosong" (wajib) dari "terisi tetapi tidak bisa dibaca" (format salah).
 */
function RSC_STD_CANON_DATE_20260814_(v) {
  var raw = (Object.prototype.toString.call(v) === '[object Date]') ? v : rscText_(v);
  var hadInput = (Object.prototype.toString.call(v) === '[object Date]')
    ? !isNaN(v.getTime())
    : rscText_(v) !== '';
  if (!hadInput) return { raw: '', value: '', hadInput: false, parsed: false };

  var direct = rscDateStr_(v);
  if (direct) return { raw: rscText_(v), value: direct, hadInput: true, parsed: true };

  var s = rscText_(v);
  var m = s.match(/^(\d{4})[.](\d{1,2})[.](\d{1,2})$/);
  if (m) return { raw: s, value: m[1] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[3], 2), hadInput: true, parsed: true };
  m = s.match(/^(\d{1,2})[.](\d{1,2})[.](\d{4})$/);
  if (m) return { raw: s, value: m[3] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[1], 2), hadInput: true, parsed: true };
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return { raw: s, value: m[1] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[3], 2), hadInput: true, parsed: true };

  return { raw: s, value: '', hadInput: true, parsed: false };
}

/** Deteksi pasangan S* Customer + S* Salesman. */
function RSC_STD_IS_SS_PAIR_20260814_(customerId, salesmanId) {
  var c = RSC_NORMALIZE_ID_(customerId), s = RSC_NORMALIZE_ID_(salesmanId);
  return !!(c && s && RSC_SS_PAIR_RE.test(c) && RSC_SS_PAIR_RE.test(s));
}

function RSC_STD_IS_DUMMY_SALESMAN_20260814_(salesmanId) {
  return RSC_SALESMAN_DUMMY_RE.test(RSC_NORMALIZE_ID_(salesmanId));
}

function RSC_STD_IS_NORMAL_SALESMAN_20260814_(salesmanId) {
  var s = RSC_NORMALIZE_ID_(salesmanId);
  return RSC_SALESMAN_NORMAL_RE.test(s) && !RSC_SALESMAN_DUMMY_RE.test(s);
}

function rscIsRollingReason_(reason) {
  return rscText_(reason).toUpperCase().indexOf('ROLLING') >= 0;
}

function rscIsTokoBangkrutReason_(reason) {
  return rscText_(reason).toUpperCase().indexOf('TOKO BANGKRUT') >= 0;
}

/**
 * Kebijakan tanggal Rolling (§9 PERF26).
 * Reason = Rolling  : Valid From dan Visit Valid From WAJIB dateNew.
 *                     Histori m_bp_relation tidak boleh menarik mundur.
 * PAIR_NO_RELATION  : field relasi apa adanya, hanya Visit Valid From = dateNew.
 */
function RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_(reason, csoMode, sourceValidFrom, dateNew) {
  var next = String(dateNew === null || dateNew === undefined ? '' : dateNew);
  var isRolling = rscKey_(reason) === rscKey_('Rolling');
  if (!isRolling) {
    return { validFrom: rscDateStr_(sourceValidFrom), visitValidFrom: rscDateStr_(sourceValidFrom), policy: 'AS_IS' };
  }
  if (String(csoMode || '') === 'PAIR_NO_RELATION') {
    return { validFrom: rscDateStr_(sourceValidFrom), visitValidFrom: next, policy: 'VISIT_ONLY' };
  }
  return { validFrom: next, visitValidFrom: next, policy: 'ROLLING_HARDCODED' };
}

/* -------------------------------------------------------------
 * 7.2 SCHEDULE VISIT (R6 + matriks frekuensi F1/F2/F4/F8)
 * ----------------------------------------------------------- */

function rscParseSchedule_(v) {
  var raw = RSC_STD_CANON_SCHEDULE_20260814_(v);
  var res = { tokens: [], valid: [], invalid: [], empties: 0, weekdays: {}, weeks: {},
              byDay: {}, canonical: raw };
  if (!raw) return res;
  var parts = raw.split(',');
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i];
    if (!t) { res.empties++; continue; }
    res.tokens.push(t);
    var m = t.match(/^W([1-4])(SU|TH|M|T|W|F|S)$/);
    if (m) {
      res.valid.push(t);
      res.weeks[m[1]] = true;
      res.weekdays[m[2]] = true;
      if (!res.byDay[m[2]]) res.byDay[m[2]] = {};
      res.byDay[m[2]][m[1]] = true;
    } else {
      res.invalid.push(t);
    }
  }
  return res;
}

/**
 * Matriks frekuensi PERF26 §11.
 *   F1 : tepat 1 token
 *   F2 : tepat 2 token, hari sama, minggu 1+3 atau 2+4
 *   F4 : tepat 4 token, hari sama, mencakup W1..W4
 *   F8 : tepat 8 token, tepat 2 hari berbeda, tiap hari mencakup W1..W4
 * Mengembalikan array pesan error (kosong bila lulus).
 */
function RSC_STD_VALIDATE_SCHEDULE_RULES_20260814_(visitCategory, scheduleText) {
  var out = [];
  var sch = rscParseSchedule_(scheduleText);
  if (!sch.tokens.length && !sch.empties) return out;

  if (sch.empties) out.push('Schedule Visit tidak boleh memiliki token kosong.');
  for (var iv = 0; iv < sch.invalid.length; iv++) {
    out.push('Token Schedule Visit tidak valid: ' + sch.invalid[iv] + '. Format W<1-4><M/T/W/TH/F/S/SU>.');
  }
  var seen = {};
  for (var it = 0; it < sch.tokens.length; it++) {
    if (seen[sch.tokens[it]]) out.push('Schedule Visit tidak boleh memiliki token duplikat: ' + sch.tokens[it] + '.');
    seen[sch.tokens[it]] = true;
  }
  if (out.length) return out;

  var cat = RSC_NORMALIZE_ID_(visitCategory);
  if (VISIT_CATEGORY_OPTIONS.indexOf(cat) < 0) return out;

  var need = VISIT_CATEGORY_FREQUENCY[cat];
  var days = Object.keys(sch.weekdays);
  var weeks = Object.keys(sch.weeks).sort().join(',');

  if (cat === 'F1') {
    if (sch.valid.length !== 1) out.push('F1 harus berisi tepat 1 token schedule.');
    return out;
  }
  if (cat === 'F2') {
    if (sch.valid.length !== 2) { out.push('F2 harus berisi tepat 2 token schedule.'); return out; }
    if (days.length !== 1) out.push('F2 wajib menggunakan hari yang sama.');
    if (weeks !== '1,3' && weeks !== '2,4') out.push('F2 pasangan minggu hanya boleh W1+W3 atau W2+W4.');
    return out;
  }
  if (cat === 'F4') {
    if (sch.valid.length !== 4) { out.push('F4 harus berisi tepat 4 token schedule.'); return out; }
    if (days.length !== 1 || weeks !== '1,2,3,4') {
      out.push('F4 harus hari yang sama dan mencakup W1,W2,W3,W4.');
    }
    return out;
  }
  if (cat === 'F8') {
    if (sch.valid.length !== 8) out.push('F8 harus berisi tepat 8 token schedule.');
    if (days.length !== 2) out.push('F8 harus terdiri dari tepat 2 hari berbeda.');
    for (var d = 0; d < days.length; d++) {
      var w = Object.keys(sch.byDay[days[d]]).sort().join(',');
      if (w !== '1,2,3,4') out.push('Untuk F8, hari ' + days[d] + ' harus mencakup W1,W2,W3,W4.');
    }
    return out;
  }
  if (need && sch.valid.length !== need) {
    out.push('Visit Category ' + cat + ' membutuhkan ' + need + ' token schedule.');
  }
  return out;
}

/* -------------------------------------------------------------
 * 7.3 MASTER / DATABASE AUTHORITATIVE
 * ----------------------------------------------------------- */

/** Master Sales Office + hirarki Sales Org / Dist Channel / Division dari sheet "em". */
function rscOfficeMaster_(masterSs) {
  if (RSC_MEM_INDEX.OFFICES) return RSC_MEM_INDEX.OFFICES;
  var out = { available: false, map: {}, orgs: {}, orgDist: {}, orgDistDiv: {}, full: {} };
  try {
    var sh = rscFindSheet_(masterSs, [TEMPLATE_UI_PARAMETERS.sheetEm]);
    if (!sh) { RSC_MEM_INDEX.OFFICES = out; return out; }
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2) { RSC_MEM_INDEX.OFFICES = out; return out; }
    var header = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var hmap = rscHeaderMap_(header);
    var cOffice = rscPickCol_(hmap, ['Sales Office']);
    if (cOffice < 0) { RSC_MEM_INDEX.OFFICES = out; return out; }
    var cDesc = (cOffice + 1 < header.length && rscKey_(header[cOffice + 1]) === 'DESCRIPTION') ? cOffice + 1 : -1;
    var cOrg = rscPickCol_(hmap, ['Sales Org', 'Sales Organization']);
    var cDist = rscPickCol_(hmap, ['Distribution channel', 'Distr. Channel', 'Distribution Channel']);
    var cDiv = rscPickCol_(hmap, ['Division']);
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var code = RSC_NORMALIZE_ID_(vals[r][cOffice]);
      if (!code) continue;
      var org = cOrg >= 0 ? RSC_NORMALIZE_ID_(vals[r][cOrg]) : '';
      var dist = cDist >= 0 ? RSC_NORMALIZE_ID_(vals[r][cDist]) : '';
      var div = cDiv >= 0 ? RSC_NORMALIZE_ID_(vals[r][cDiv]) : '';
      if (!out.map[code]) {
        out.map[code] = { code: code, desc: cDesc >= 0 ? rscText_(vals[r][cDesc]) : '', org: org };
      }
      if (org) {
        out.orgs[org] = true;
        if (dist) out.orgDist[org + '|' + dist] = true;
        if (dist && div) out.orgDistDiv[org + '|' + dist + '|' + div] = true;
        if (dist && div) out.full[org + '|' + dist + '|' + div + '|' + code] = true;
      }
    }
    out.available = Object.keys(out.map).length > 0;
    out.hasHierarchy = Object.keys(out.orgDistDiv).length > 0;
  } catch (e) { out.available = false; out.error = String(e); }
  RSC_MEM_INDEX.OFFICES = out;
  return out;
}

/**
 * Master Relationship.
 * Sumber utama: m_rel_salesman_type_rlt (DB sekunder dicoba lebih dulu).
 * Fallback   : daftar canonical di parameter (ZWS + BUR001).
 */
function rscRelationshipMaster_() {
  if (RSC_MEM_INDEX.RELTYPE) return RSC_MEM_INDEX.RELTYPE;
  var out = { available: true, source: 'parameters', map: {}, builtin: {} };
  for (var i = 0; i < RELATIONSHIP_OPTIONS.length; i++) {
    var opt = RELATIONSHIP_OPTIONS[i];
    var id = RSC_NORMALIZE_ID_(opt);
    var dash = opt.indexOf(' - ');
    out.map[id] = dash > 0 ? opt.substring(dash + 3) : '';
    out.builtin[id] = true;
  }
  // ZWS001..ZWS022 dan BUR001 diterima built-in walau tidak ada di dropdown.
  for (var n = 1; n <= 22; n++) out.builtin['ZWS' + rscPad_(n, 3)] = true;
  out.builtin['BUR001'] = true;

  try {
    var idx = rscGetIndex_('RELTYPE');
    if (idx && idx.available && idx.map) {
      var keys = Object.keys(idx.map);
      if (keys.length) {
        out.source = 'm_rel_salesman_type_rlt';
        for (var k = 0; k < keys.length; k++) {
          if (Object.prototype.hasOwnProperty.call(out.map, keys[k])) continue;
          var recs = idx.map[keys[k]];
          var desc = (recs && recs.length) ? rscText_(rscRecObj_(idx, recs[0])['Description']) : '';
          out.map[keys[k]] = desc || keys[k];
        }
      }
    }
  } catch (e) { /* master relationship opsional */ }

  RSC_MEM_INDEX.RELTYPE = out;
  return out;
}

/** Muat seluruh master sekali per execution. */
function RSC_V28_3_LOAD_ROLLING_MASTERS_20260814_(masterSs) {
  var m = {
    office: rscOfficeMaster_(masterSs),
    relationship: rscRelationshipMaster_(),
    dateNew: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew,
    dateClose: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose,
    openEnded: OPEN_ENDED_DATE_TEXT,
    idx: {},
    dbConfigured: rscDbSources_().length > 0,
    notes: []
  };
  if (!m.dbConfigured) {
    m.notes.push('DB master belum dikonfigurasi; rule berbasis DB dilewati (bukan error).');
    return m;
  }
  var names = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  for (var i = 0; i < names.length; i++) {
    m.idx[names[i]] = rscGetIndex_(names[i]);
    if (!m.idx[names[i]].available) {
      m.notes.push('Master ' + names[i] + ' tidak tersedia (' +
        (m.idx[names[i]].reason || '-') + '); rule terkait dilewati.');
    }
  }
  return m;
}

/** Nama lama dipertahankan sebagai alias. */
function rscLoadMasters_(masterSs) {
  return RSC_V28_3_LOAD_ROLLING_MASTERS_20260814_(masterSs);
}

/* -------------------------------------------------------------
 * 7.4 SNAPSHOT — baca A:N lalu canonicalize
 * ----------------------------------------------------------- */

function RSC_V28_3_CREATE_ROLLING_SNAPSHOT_20260814_(spec, values, masters) {
  var snap = {
    spec: spec, masters: masters || {}, rows: [], errors: [], skipped: {},
    fieldIdx: {}, mutations: 0, needs: { customers: {}, salesmen: {}, mvs: {} }
  };
  for (var c = 0; c < spec.header.length; c++) snap.fieldIdx[spec.header[c]] = c;

  for (var r = 0; r < values.length; r++) {
    var raw = values[r], f = {}, dates = {}, nonEmpty = false;
    for (var h = 0; h < spec.header.length; h++) {
      var name = spec.header[h];
      if (name === 'Validation Status' || name === 'Error Detail') continue;
      var val = raw[h], norm;
      if (spec.dateFields.indexOf(name) >= 0) {
        var dc = RSC_STD_CANON_DATE_20260814_(val);
        dates[name] = dc;
        norm = dc.value;
        if (dc.hadInput) nonEmpty = true;
      } else if (name === 'Visit Type') {
        norm = RSC_STD_CANON_VISIT_TYPE_20260814_(val);
      } else if (name === 'Schedule Visit') {
        norm = RSC_STD_CANON_SCHEDULE_20260814_(val);
      } else if (spec.idFields.indexOf(name) >= 0) {
        norm = RSC_STD_CANON_CODE_20260814_(val);
      } else {
        norm = rscText_(val);
      }
      f[name] = norm;
      if (norm) nonEmpty = true;
    }
    if (!nonEmpty) continue;

    var row = {
      i: snap.rows.length, sheetRow: r + 2, raw: raw, f: f, dates: dates,
      cso: null, changed: false, mvsKey: '', mvsPicked: '', mutations: []
    };
    if (spec.validator === 'ROLLING') {
      row.ssPair = RSC_STD_IS_SS_PAIR_20260814_(f['Customer ID'], f['Salesman ID']);
      row.isRolling = rscIsRollingReason_(f['Reason']);
      row.isTB = rscIsTokoBangkrutReason_(f['Reason']);
      row.isDummy = RSC_STD_IS_DUMMY_SALESMAN_20260814_(f['Salesman ID']);
      row.isNormalSalesman = RSC_STD_IS_NORMAL_SALESMAN_20260814_(f['Salesman ID']);
      if (f['Customer ID']) snap.needs.customers[f['Customer ID']] = true;
      if (f['Salesman ID']) snap.needs.salesmen[f['Salesman ID']] = true;
      if (row.isTB && !row.ssPair) {
        var key = [f['Visit Category'], f['Customer ID'], f['Salesman ID'], f['Visit Type']].join('|');
        row.mvsKey = key;
        snap.needs.mvs[key] = true;
      }
    }
    snap.rows.push(row);
    snap.errors.push([]);
  }
  return snap;
}

function rscBuildContext_(spec, values, masters) {
  return RSC_V28_3_CREATE_ROLLING_SNAPSHOT_20260814_(spec, values, masters);
}

function rscAddErr_(ctx, i, code, msg) { ctx.errors[i].push('[' + code + '] ' + msg); }

function rscRowIndexBySheetRow_(ctx, sheetRow) {
  if (!ctx._byRow) {
    ctx._byRow = {};
    for (var i = 0; i < ctx.rows.length; i++) ctx._byRow[ctx.rows[i].sheetRow] = i;
  }
  var v = ctx._byRow[sheetRow];
  return (v === undefined) ? -1 : v;
}

/* -------------------------------------------------------------
 * 7.5 KONTEKS RELASI (m_bp_relation)
 * ----------------------------------------------------------- */

/**
 * Bangun konteks relasi yang dibutuhkan CSO, R8b, dan Toko Bangkrut, dalam
 * satu lintasan atas ID yang benar-benar dipakai template (tidak full scan).
 */
function RSC_STD_LOAD_RELATION_CONTEXT_20260814_(snap) {
  var idx = snap.masters.idx && snap.masters.idx.RELATION;
  var ctxOut = {
    available: !!(idx && idx.available),
    exactKey: {},     // cust|rel|sls|validTo -> true
    tripleOpen: {},   // cust|rel|sls -> validFrom terbaik untuk record open-ended
    tripleClosed: {}, // cust|rel|sls -> validFrom terbaru untuk record tertutup
    pair: {},         // cust|sls -> true
    byCustomer: {},   // cust -> daftar record
    earliest: {}      // cust -> valid from paling awal
  };
  if (!ctxOut.available) return ctxOut;

  var open = snap.masters.openEnded || OPEN_ENDED_DATE_TEXT;
  var customers = Object.keys(snap.needs.customers);
  for (var c = 0; c < customers.length; c++) {
    var cust = customers[c];
    var recs = idx.map[cust];
    if (!recs || !recs.length) continue;
    ctxOut.byCustomer[cust] = recs;
    for (var r = 0; r < recs.length; r++) {
      var rel = RSC_NORMALIZE_ID_(recs[r][0]);
      var sls = RSC_NORMALIZE_ID_(recs[r][1]);
      var vf = rscDateStr_(recs[r][2]);
      var vt = rscDateStr_(recs[r][3]);
      if (sls) ctxOut.pair[cust + '|' + sls] = true;
      if (rel && sls) {
        ctxOut.exactKey[cust + '|' + rel + '|' + sls + '|' + vt] = true;
        var triple = cust + '|' + rel + '|' + sls;
        if (vt === open) {
          if (!ctxOut.tripleOpen[triple] || vf > ctxOut.tripleOpen[triple]) ctxOut.tripleOpen[triple] = vf;
        } else {
          if (!ctxOut.tripleClosed[triple] || vf > ctxOut.tripleClosed[triple]) ctxOut.tripleClosed[triple] = vf;
        }
      }
      if (vf && (!ctxOut.earliest[cust] || vf < ctxOut.earliest[cust])) ctxOut.earliest[cust] = vf;
    }
    // Histori tertutup di luar jendela aktif tetap diikutsertakan bila ada.
    if (idx.closed) {
      var pfx = cust + '|';
      var ck = idx.closedKeys && idx.closedKeys[cust];
      if (ck) {
        for (var k = 0; k < ck.length; k++) {
          var full = pfx + ck[k];
          var val = idx.closed[full];
          if (val && (!ctxOut.tripleClosed[full] || val > ctxOut.tripleClosed[full])) {
            ctxOut.tripleClosed[full] = val;
          }
        }
      }
    }
    if (idx.earliest && idx.earliest[cust]) {
      var e = idx.earliest[cust];
      if (!ctxOut.earliest[cust] || e < ctxOut.earliest[cust]) ctxOut.earliest[cust] = e;
    }
  }

  // Pasangan yang hanya muncul pada baris kedaluwarsa / di luar cap index.
  // Tanpa ini, baris "rubah jadwal" pada relasi lama salah dianggap bukan
  // Change Schedule Only lalu dihujani R2/R4/R8a.
  if (idx.pairExtra) {
    var pe = Object.keys(idx.pairExtra);
    for (var q = 0; q < pe.length; q++) ctxOut.pair[pe[q]] = true;
    ctxOut.pairExtraUsed = pe.length;
  }
  ctxOut.pairTruncated = !!idx.pairTruncated;
  return ctxOut;
}

/**
 * Deteksi Change Schedule Only (PERF26 §8).
 * CASE 1 EXACT_REL_VALID_TO : Customer + Relationship + Salesman + Valid To
 *                             cocok persis dengan record m_bp_relation.
 * CASE 2 PAIR_NO_RELATION   : Relationship kosong dan pasangan
 *                             Customer + Salesman ada di m_bp_relation.
 */
function RSC_STD_DETECT_CHANGE_SCHEDULE_ONLY_20260819_(snap, relCtx) {
  if (!relCtx || !relCtx.available) {
    // Tanpa m_bp_relation kita TIDAK TAHU apakah baris ini Change Schedule Only.
    // Sesuai PERF26 §19, kegagalan teknis tidak boleh mengubah OK/ERROR: baris
    // yang berbentuk CASE 2 (Relationship kosong, Customer + Salesman terisi)
    // diperlakukan sebagai belum-terverifikasi, bukan langsung error.
    var unknown = 0;
    for (var u = 0; u < snap.rows.length; u++) {
      var ru = snap.rows[u], fu = ru.f;
      if (!fu['Relationship'] && fu['Customer ID'] && fu['Salesman ID']) {
        ru.csoUnknown = true;
        unknown++;
      }
    }
    snap.csoUnverifiedRows = unknown;
    snap.skipped['CSO'] = 'master m_bp_relation tidak tersedia' +
      (unknown ? ('; ' + unknown + ' baris berpola Change Schedule Only tidak dapat diverifikasi') : '');
    return;
  }
  for (var i = 0; i < snap.rows.length; i++) {
    var row = snap.rows[i], f = row.f;
    var cust = f['Customer ID'], sls = f['Salesman ID'], rel = f['Relationship'];
    if (!cust || !sls) continue;

    if (!rel) {
      if (relCtx.pair[cust + '|' + sls]) row.cso = { yes: true, mode: 'PAIR_NO_RELATION' };
      continue;
    }
    var vt = f['Valid To'];
    if (vt && relCtx.exactKey[cust + '|' + rel + '|' + sls + '|' + vt]) {
      // Toko Bangkrut sengaja TIDAK diperlakukan sebagai Change Schedule Only.
      if (!row.isTB) row.cso = { yes: true, mode: 'EXACT_REL_VALID_TO' };
      else row.csoSuppressed = 'EXACT_REL_VALID_TO';
    }
  }
}

function rscDetectChangeScheduleOnly_(ctx) {
  RSC_STD_DETECT_CHANGE_SCHEDULE_ONLY_20260819_(ctx, RSC_STD_LOAD_RELATION_CONTEXT_20260814_(ctx));
}

/* -------------------------------------------------------------
 * 7.6 m_visit_schedule — subset terarah untuk Toko Bangkrut
 * ----------------------------------------------------------- */

/**
 * Ambil hanya key MVS yang dipakai template.
 * Key: Visit Category + Customer ID + Salesman ID + Visit Type.
 * Nilai: daftar effective start date (Visit Valid From) terurut naik.
 */
function RSC_MVS_getIndexSubset_20260819_(snap) {
  var idx = snap.masters.idx && snap.masters.idx.VISIT;
  var out = { available: !!(idx && idx.available), map: {}, keys: 0 };
  if (!out.available) return out;

  var wanted = snap.needs.mvs;
  var keys = Object.keys(wanted);
  for (var i = 0; i < keys.length; i++) {
    var parts = keys[i].split('|');
    var cat = parts[0], cust = parts[1], sls = parts[2], typ = parts[3];
    var recs = idx.map[cust + '|' + sls];
    if (!recs || !recs.length) continue;
    var dates = [];
    for (var r = 0; r < recs.length; r++) {
      var rec = rscRecObj_(idx, recs[r]);
      var rcat = RSC_NORMALIZE_ID_(rec['Visit Category']);
      var rtyp = RSC_STD_CANON_VISIT_TYPE_20260814_(rec['Visit Type']);
      if (cat && rcat && rcat !== cat) continue;
      if (typ && rtyp && rtyp !== typ) continue;
      var vf = rscDateStr_(rec['Valid From']);
      if (vf && dates.indexOf(vf) < 0) dates.push(vf);
    }
    if (!dates.length) continue;
    dates.sort();
    out.map[keys[i]] = dates;
    out.keys++;
  }
  return out;
}

/**
 * Pilih effective date Toko Bangkrut (PERF26 §10.2):
 *   1. tanggal paling akhir yang <= dateClose;
 *   2. bila tidak ada, tanggal paling awal yang tersedia.
 */
function RSC_MVS_PICK_EFFECTIVE_DATE_20260819_(dates, dateClose) {
  if (!dates || !dates.length) return '';
  var best = '';
  for (var i = 0; i < dates.length; i++) {
    if (dates[i] <= dateClose && (!best || dates[i] > best)) best = dates[i];
  }
  if (best) return best;
  var min = dates[0];
  for (var k = 1; k < dates.length; k++) if (dates[k] < min) min = dates[k];
  return min;
}

/**
 * Valid From Toko Bangkrut dari m_bp_relation (PERF26 §10.1):
 *   1. exact triple Customer + Relationship + Salesman;
 *   2. record open-ended (9999-12-31) diprioritaskan atas record tertutup;
 *   3. pada rank sama, Valid From terbaru;
 *   4. bila kosong, fallback Valid From paling awal milik Customer.
 */
function RSC_TB_RESOLVE_VALID_FROM_20260622_(relCtx, cust, rel, sls) {
  if (!relCtx || !relCtx.available) return { value: '', source: 'NO_DB' };
  var triple = cust + '|' + rel + '|' + sls;
  if (rel && sls && relCtx.tripleOpen[triple]) return { value: relCtx.tripleOpen[triple], source: 'EXACT_OPEN' };
  if (rel && sls && relCtx.tripleClosed[triple]) return { value: relCtx.tripleClosed[triple], source: 'EXACT_CLOSED' };
  if (relCtx.earliest[cust]) return { value: relCtx.earliest[cust], source: 'CUSTOMER_FALLBACK' };
  return { value: '', source: 'NOT_FOUND' };
}

/* -------------------------------------------------------------
 * 7.7 MUTATION SEBELUM VALIDATION (PERF26 §13)
 * -------------------------------------------------------------
 * Beberapa field bersifat authoritative auto-replace, jadi isian user
 * dibetulkan lebih dulu dan rule final menilai baris canonical, bukan raw.
 * ----------------------------------------------------------- */

function rscSetField_(row, name, value) {
  var cur = row.f[name] === undefined ? '' : row.f[name];
  var next = value === undefined || value === null ? '' : String(value);
  if (cur === next) return false;
  row.f[name] = next;
  row.changed = true;
  row.mutations.push(name);
  return true;
}

/**
 * Isi field hanya bila masih kosong.
 * Dipakai untuk field Toko Bangkrut yang PUNYA rule ERROR sendiri: kalau user
 * sudah mengisi nilai yang berbeda, nilai itu dibiarkan supaya rule TB dapat
 * melaporkannya, bukan ditimpa diam-diam. Field yang tidak punya rule ERROR
 * (Salesman BP Type, tanggal Rolling) tetap di-overwrite authoritative.
 */
function rscFillIfBlank_(row, name, value) {
  if (row.f[name]) return false;
  return rscSetField_(row, name, value);
}

function RSC_V28_3_APPLY_ROLLING_MUTATIONS_20260814_(snap, relCtx, mvs) {
  var M = snap.masters;
  var bpIdx = M.idx && M.idx.BP;
  var dateNew = M.dateNew, dateClose = M.dateClose;

  for (var i = 0; i < snap.rows.length; i++) {
    var row = snap.rows[i], f = row.f;
    var relOptional = !!(row.cso && row.cso.mode === 'PAIR_NO_RELATION');
    var visitOptional = !!row.ssPair;

    /* 1. Salesman BP Type authoritative dari m_bp_general_view. */
    if (bpIdx && bpIdx.available && f['Salesman ID']) {
      var recs = bpIdx.map[f['Salesman ID']];
      if (recs && recs.length) {
        var expected = RSC_NORMALIZE_ID_(rscRecObj_(bpIdx, recs[0])['Salesman BP Type']);
        row.expectedBpType = expected;
        if (expected) rscSetField_(row, 'Salesman BP Type', expected);
      }
    }

    /* 2. Toko Bangkrut lebih dulu — ia mengunci tanggal relasi dan visit. */
    if (row.isTB) {
      if (!relOptional) {
        var tb = RSC_TB_RESOLVE_VALID_FROM_20260622_(relCtx, f['Customer ID'], f['Relationship'], f['Salesman ID']);
        row.tbValidFromSource = tb.source;
        if (tb.value) rscSetField_(row, 'Valid From', tb.value);   // tidak punya rule ERROR sendiri
        if (dateClose) rscFillIfBlank_(row, 'Valid To', dateClose);
      }
      if (!visitOptional) {
        if (dateClose) rscFillIfBlank_(row, 'Visit Valid To', dateClose);
        if (mvs && mvs.available && row.mvsKey) {
          var dates = mvs.map[row.mvsKey];
          if (dates && dates.length) {
            row.mvsPicked = RSC_MVS_PICK_EFFECTIVE_DATE_20260819_(dates, dateClose);
            if (row.mvsPicked) rscFillIfBlank_(row, 'Visit Valid From', row.mvsPicked);
          }
        }
      }
      continue;
    }

    /* 3. Rolling. Histori DB tidak boleh menarik Valid From ke masa lalu. */
    if (row.isRolling) {
      var mode = (row.cso && row.cso.yes) ? row.cso.mode : '';
      var policy = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_(
        f['Reason'], mode, f['Valid From'], dateNew);
      row.rollingPolicy = policy.policy;
      if (policy.policy === 'ROLLING_HARDCODED') {
        if (dateNew) rscSetField_(row, 'Valid From', dateNew);
      }
      if (!visitOptional && dateNew) rscSetField_(row, 'Visit Valid From', dateNew);
    }
  }

  var changed = 0;
  for (var k = 0; k < snap.rows.length; k++) if (snap.rows[k].changed) changed++;
  snap.mutations = changed;
  return changed;
}

/* -------------------------------------------------------------
 * 7.8 BUSINESS RULES — S0, R1..R12, TB
 * ----------------------------------------------------------- */

function rscRelOptional_(row) {
  return !!(row.csoUnknown || (row.cso && row.cso.mode === 'PAIR_NO_RELATION'));
}
function rscVisitOptional_(row) { return !!row.ssPair; }

var RSC_ROW_RULES = {

  /** S0 — Sales Office wajib + terdaftar di em; Delivering Plant 4 alphanumeric. */
  S0: function (snap, row, i) {
    var f = row.f;
    var off = f['Sales Office'];
    if (!off) {
      rscAddErr_(snap, i, 'S0', 'Sales Office wajib diisi.');
    } else {
      var em = snap.masters.office;
      if (em && em.available) {
        if (!em.map[off]) rscAddErr_(snap, i, 'S0', 'Sales Office tidak ada di master em. Actual=' + off + '.');
      } else {
        snap.skipped['S0-em'] = 'master em tidak tersedia';
      }
    }
    var plant = f['Delivering Plant'];
    if (plant && !RSC_PLANT_FORMAT_RE.test(plant)) {
      rscAddErr_(snap, i, 'S0', 'Delivering Plant harus 4 karakter alphanumeric. Actual=' + plant + '.');
    }
  },

  /** R1 — Customer ID dan Salesman ID: wajib, format, dan keberadaan di BP master. */
  R1: function (snap, row, i) {
    var f = snap.rows[i].f;
    var bp = snap.masters.idx && snap.masters.idx.BP;
    var bpOk = !!(bp && bp.available);
    if (!bpOk) snap.skipped['R1-bp'] = 'master m_bp_general_view tidak tersedia';

    var cust = f['Customer ID'];
    if (!cust) {
      rscAddErr_(snap, i, 'R1', 'Customer ID wajib diisi.');
    } else {
      if (!row.ssPair && !/^\d+$/.test(cust)) {
        rscAddErr_(snap, i, 'R1',
          'Customer ID harus numerik; exception hanya Salesman-to-Salesman/BP-Dummy pair. Actual=' + cust + '.');
      }
      if (bpOk && !bp.map[cust]) {
        rscAddErr_(snap, i, 'R1', 'Customer ID tidak ditemukan di m_bp_general_view.bp_id. Actual=' + cust + '.');
      }
    }

    var sls = f['Salesman ID'];
    if (!sls) {
      rscAddErr_(snap, i, 'R1', 'Salesman ID wajib diisi.');
      return;
    }
    if (!row.isDummy && !row.isNormalSalesman) {
      rscAddErr_(snap, i, 'R1', 'Salesman ID tidak sesuai format. Normal "S" + angka, Dummy ' +
        '"S00000/S0000T/S0000S/S0000M" + 4 karakter office. Actual=' + sls + '.');
    }
    if (bpOk && !bp.map[sls]) {
      rscAddErr_(snap, i, 'R1', 'Salesman ID tidak ditemukan di m_bp_general_view.bp_id. Actual=' + sls + '.');
    }
  },

  /** R1A — Salesman normal wajib ada di m_sales_info. Dummy dikecualikan. */
  R1A: function (snap, row, i) {
    var sls = row.f['Salesman ID'];
    if (!sls || row.isDummy || !row.isNormalSalesman) return;
    var idx = snap.masters.idx && snap.masters.idx.SALESMAN;
    if (!idx || !idx.available) { snap.skipped['R1A'] = 'master m_sales_info tidak tersedia'; return; }
    if (!idx.map[sls]) {
      rscAddErr_(snap, i, 'R1A', 'Salesman normal tidak ditemukan di m_sales_info.salesman_id. Actual=' + sls + '.');
    }
  },

  /** R2 — Relationship wajib, format ZWSddd / BUR001, dan terdaftar. */
  R2: function (snap, row, i) {
    var rel = row.f['Relationship'];
    if (!rel) {
      if (!rscRelOptional_(row)) rscAddErr_(snap, i, 'R2', 'Relationship wajib diisi.');
      return;
    }
    if (!RSC_RELATIONSHIP_FORMAT_RE.test(rel)) {
      rscAddErr_(snap, i, 'R2', 'Relationship harus format ZWSnnn atau BUR001. Actual=' + rel + '.');
      return;
    }
    var master = snap.masters.relationship;
    if (!master) return;
    if (master.builtin && master.builtin[rel]) return;
    if (master.map && Object.prototype.hasOwnProperty.call(master.map, rel)) return;
    rscAddErr_(snap, i, 'R2', 'Relationship tidak terdaftar pada canonical LOV/master Relationship. Actual=' + rel + '.');
  },

  /** R3 — Salesman BP Type wajib, format ZDnn, dan sama dengan master BP. */
  R3: function (snap, row, i) {
    var bpType = row.f['Salesman BP Type'];
    if (!bpType) { rscAddErr_(snap, i, 'R3', 'Salesman BP Type wajib diisi.'); return; }
    if (!RSC_BP_TYPE_FORMAT_RE.test(bpType)) {
      rscAddErr_(snap, i, 'R3', 'Salesman BP Type harus format ZDnn, contoh ZD01. Actual=' + bpType + '.');
      return;
    }
    var bp = snap.masters.idx && snap.masters.idx.BP;
    if (!bp || !bp.available || !row.f['Salesman ID']) return;
    if (!bp.map[row.f['Salesman ID']]) return;             // ketiadaan Salesman sudah dilaporkan R1
    var expected = row.expectedBpType || '';
    if (!expected) {
      if (bp.fieldPresent && bp.fieldPresent['Salesman BP Type']) {
        rscAddErr_(snap, i, 'R3', 'bp_type_id untuk Salesman ID tidak ditemukan di m_bp_general_view. Actual=' +
          row.f['Salesman ID'] + '.');
      }
      return;
    }
    if (expected !== bpType) {
      rscAddErr_(snap, i, 'R3', 'Salesman BP Type tidak sesuai master. Expected=' + expected + ', actual=' + bpType + '.');
    }
  },

  /** R4 — kelengkapan dan validitas keempat tanggal. */
  R4: function (snap, row, i) {
    var relOpt = rscRelOptional_(row), visitOpt = rscVisitOptional_(row);
    var checks = [
      ['Valid From', !relOpt],
      ['Valid To', !relOpt],
      ['Visit Valid From', !visitOpt],
      ['Visit Valid To', !visitOpt]
    ];
    for (var c = 0; c < checks.length; c++) {
      var name = checks[c][0], required = checks[c][1];
      if (!required) continue;
      var d = row.dates[name] || { hadInput: false, parsed: false, value: '', raw: '' };
      var val = row.f[name];
      if (!val && !d.hadInput) { rscAddErr_(snap, i, 'R4', name + ' wajib diisi.'); continue; }
      if (!val || !rscIsValidDateStr_(val)) {
        rscAddErr_(snap, i, 'R4', name + ' harus format YYYY-MM-DD. Actual="' + (d.raw || val) + '".');
      }
    }
  },

  /** R5 — Visit Category wajib dan harus F1/F2/F4/F8. */
  R5: function (snap, row, i) {
    var cat = row.f['Visit Category'];
    if (!cat) {
      if (!rscVisitOptional_(row)) rscAddErr_(snap, i, 'R5', 'Visit Category wajib diisi.');
      return;
    }
    if (VISIT_CATEGORY_OPTIONS.indexOf(cat) < 0) {
      rscAddErr_(snap, i, 'R5', 'Visit Category harus F1, F2, F4, atau F8. Actual=' + cat + '.');
    }
  },

  /** R6 — Schedule Visit wajib dan konsisten dengan matriks frekuensi. */
  R6: function (snap, row, i) {
    var sch = row.f['Schedule Visit'];
    if (!sch) {
      if (!rscVisitOptional_(row)) rscAddErr_(snap, i, 'R6', 'Schedule Visit wajib diisi.');
      return;
    }
    if (rscVisitOptional_(row)) return;
    var msgs = RSC_STD_VALIDATE_SCHEDULE_RULES_20260814_(row.f['Visit Category'], sch);
    for (var m = 0; m < msgs.length; m++) rscAddErr_(snap, i, 'R6', msgs[m]);
  },

  /** R9 — periode relasi harus naik. */
  R9: function (snap, row, i) {
    if (rscRelOptional_(row)) return;
    var vf = row.f['Valid From'], vt = row.f['Valid To'];
    if (!vf || !vt || !rscIsValidDateStr_(vf) || !rscIsValidDateStr_(vt)) return;
    if (vt <= vf) {
      rscAddErr_(snap, i, 'R9', 'Valid To harus lebih besar dari Valid From. Actual=' + vf + ' s/d ' + vt + '.');
    }
  },

  /** R9A — Change Rolling normal wajib open-ended 9999-12-31. */
  R9A: function (snap, row, i) {
    if (rscRelOptional_(row) || row.isTB) return;
    var vt = row.f['Valid To'];
    if (!vt || !rscIsValidDateStr_(vt)) return;
    if (vt !== OPEN_ENDED_DATE_TEXT) {
      rscAddErr_(snap, i, 'R9A', 'Valid To harus ' + OPEN_ENDED_DATE_TEXT +
        ' untuk Change Rolling selain Toko Bangkrut. Actual=' + vt + '.');
    }
  },

  /** R10 — periode visit harus naik. */
  R10: function (snap, row, i) {
    if (rscVisitOptional_(row)) return;
    var vvf = row.f['Visit Valid From'], vvt = row.f['Visit Valid To'];
    if (!vvf || !vvt || !rscIsValidDateStr_(vvf) || !rscIsValidDateStr_(vvt)) return;
    if (vvt <= vvf) {
      rscAddErr_(snap, i, 'R10', 'Visit Valid To harus lebih besar dari Visit Valid From. Actual=' +
        vvf + ' s/d ' + vvt + '.');
    }
  },

  /** R11 — periode visit harus berada di dalam periode relasi. */
  R11: function (snap, row, i) {
    if (rscVisitOptional_(row) || rscRelOptional_(row)) return;
    var vf = row.f['Valid From'], vt = row.f['Valid To'];
    var vvf = row.f['Visit Valid From'], vvt = row.f['Visit Valid To'];
    var outside = (vvf && vf && rscIsValidDateStr_(vvf) && rscIsValidDateStr_(vf) && vvf < vf) ||
                  (vvt && vt && rscIsValidDateStr_(vvt) && rscIsValidDateStr_(vt) && vvt > vt);
    if (outside) {
      rscAddErr_(snap, i, 'R11', 'Periode Visit Valid harus berada di dalam Valid From - Valid To. Actual visit=' +
        (vvf || '-') + ' s/d ' + (vvt || '-') + ', relation=' + (vf || '-') + ' s/d ' + (vt || '-') + '.');
    }
  },

  /** R12 — Visit Type wajib dan harus 01..12. */
  R12: function (snap, row, i) {
    var typ = row.f['Visit Type'];
    if (!typ) {
      if (!rscVisitOptional_(row)) rscAddErr_(snap, i, 'R12', 'Visit Type wajib diisi.');
      return;
    }
    if (VISIT_TYPE_OPTIONS.indexOf(typ) < 0) {
      rscAddErr_(snap, i, 'R12', 'Visit Type harus 01 sampai 12 dan tetap 2 digit. Actual=' + typ + '.');
    }
  }
};

var RSC_TABLE_RULES = {

  /** R7 — Customer + Salesman yang sama wajib punya Schedule Visit identik. */
  R7: function (snap) {
    var groups = {};
    for (var i = 0; i < snap.rows.length; i++) {
      var row = snap.rows[i];
      if (rscVisitOptional_(row)) continue;
      var cid = row.f['Customer ID'], sid = row.f['Salesman ID'];
      var sch = row.f['Schedule Visit'] || '';
      // Baris tanpa Schedule Visit tidak ikut dibandingkan; kekosongannya sudah
      // dilaporkan R6 dan tidak boleh menjadi "varian" konflik R7.
      if (!cid || !sid || !sch) continue;
      var key = cid + '|' + sid;
      if (!groups[key]) groups[key] = { variants: {}, order: [] };
      if (!groups[key].variants[sch]) { groups[key].variants[sch] = []; groups[key].order.push(sch); }
      groups[key].variants[sch].push(row.sheetRow);
    }
    for (var k in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, k)) continue;
      var g = groups[k];
      if (g.order.length < 2) continue;
      var parts = [];
      var lim = RSC_STANDARD_VALIDATION_V27_20260814.msgMaxVariants;
      for (var v = 0; v < g.order.length && v < lim; v++) {
        parts.push((g.order[v] || '(kosong)') + ' (row ' + rscRowsLabel_(g.variants[g.order[v]]) + ')');
      }
      if (g.order.length > lim) parts.push('... +' + (g.order.length - lim) + ' variasi lain');
      var msg = 'Customer ID + Salesman ID yang sama tidak boleh memiliki Schedule Visit berbeda. Konflik: ' +
        parts.join(' vs ');
      for (var v2 = 0; v2 < g.order.length; v2++) {
        var list = g.variants[g.order[v2]];
        for (var rr = 0; rr < list.length; rr++) {
          var idx = rscRowIndexBySheetRow_(snap, list[rr]);
          if (idx >= 0) rscAddErr_(snap, idx, 'R7', msg);
        }
      }
    }
  },

  /** R8a — duplikat Customer+Relationship+Salesman+Valid To dalam template. */
  R8a: function (snap) {
    var keyFields = ['Customer ID', 'Relationship', 'Salesman ID', 'Valid To'];
    var seen = {};
    for (var i = 0; i < snap.rows.length; i++) {
      if (snap.rows[i].cso && snap.rows[i].cso.yes) continue;   // Change Schedule Only dikecualikan
      if (snap.rows[i].csoUnknown) continue;                    // status CSO belum dapat diverifikasi
      var parts = [];
      for (var k = 0; k < keyFields.length; k++) parts.push(snap.rows[i].f[keyFields[k]] || '');
      var key = parts.join('|');
      if (key.replace(/\|/g, '') === '') continue;
      if (!seen[key]) seen[key] = [];
      seen[key].push(i);
    }
    for (var kk in seen) {
      if (!Object.prototype.hasOwnProperty.call(seen, kk)) continue;
      if (seen[kk].length < 2) continue;
      var rowsTxt = [];
      for (var a = 0; a < seen[kk].length; a++) rowsTxt.push(snap.rows[seen[kk][a]].sheetRow);
      var label = rscRowsLabel_(rowsTxt);
      for (var b = 0; b < seen[kk].length; b++) {
        rscAddErr_(snap, seen[kk][b], 'R8',
          'R8a: key ' + keyFields.join(' + ') + ' duplikat dalam template (row ' + label + ').');
      }
    }
  },

  /** R8b — key yang sama sudah ada di m_bp_relation. CSO exact dikecualikan. */
  R8b: function (snap) {
    var relCtx = snap.relCtx;
    if (!relCtx || !relCtx.available) { snap.skipped['R8b'] = 'master m_bp_relation tidak tersedia'; return; }
    for (var i = 0; i < snap.rows.length; i++) {
      var row = snap.rows[i], f = row.f;
      if (row.cso && row.cso.yes) continue;
      var cust = f['Customer ID'], rel = f['Relationship'], sls = f['Salesman ID'], vt = f['Valid To'];
      if (!cust || !rel || !sls || !vt) continue;
      if (relCtx.exactKey[cust + '|' + rel + '|' + sls + '|' + vt]) {
        rscAddErr_(snap, i, 'R8', 'R8b: key Customer ID + Relationship + Salesman ID + Valid To sudah ada di ' +
          'm_bp_relation. Actual=' + cust + ' + ' + rel + ' + ' + sls + ' + ' + vt + '.');
      }
    }
  },

  /** TB — Toko Bangkrut: tanggal penutupan dan keberadaan key di m_visit_schedule. */
  TB: function (snap) {
    var dateClose = snap.masters.dateClose;
    var mvs = snap.mvs || { available: false, map: {} };
    if (!mvs.available) snap.skipped['TB-mvs'] = 'master m_visit_schedule tidak tersedia';

    for (var i = 0; i < snap.rows.length; i++) {
      var row = snap.rows[i], f = row.f;
      if (!row.isTB) continue;
      var relOpt = rscRelOptional_(row), visitOpt = rscVisitOptional_(row);

      if (!relOpt) {
        if (f['Valid To'] && f['Valid To'] !== dateClose) {
          rscAddErr_(snap, i, 'TB', 'Toko Bangkrut: Valid To harus ' + dateClose + '. Actual=' + f['Valid To'] + '.');
        }
        if (row.tbValidFromSource === 'NOT_FOUND') {
          rscAddErr_(snap, i, 'TB', 'Toko Bangkrut: Valid From tidak dapat ditentukan dari m_bp_relation. Actual=' +
            f['Customer ID'] + ' + ' + f['Relationship'] + ' + ' + f['Salesman ID'] + '.');
        }
      }
      if (visitOpt) continue;

      if (f['Visit Valid To'] && f['Visit Valid To'] !== dateClose) {
        rscAddErr_(snap, i, 'TB', 'Toko Bangkrut: Visit Valid To harus ' + dateClose +
          '. Actual=' + f['Visit Valid To'] + '.');
      }
      var missing = [];
      if (!f['Visit Category']) missing.push('Visit Category');
      if (!f['Customer ID']) missing.push('Customer ID');
      if (!f['Salesman ID']) missing.push('Salesman ID');
      if (!f['Visit Type']) missing.push('Visit Type');
      if (missing.length) {
        rscAddErr_(snap, i, 'TB', 'Toko Bangkrut: key m_visit_schedule wajib lengkap ' +
          '(Visit Category + Customer ID + Salesman ID + Visit Type). Kolom kosong: ' + missing.join(', ') + '.');
        continue;
      }
      if (!mvs.available) continue;
      if (!mvs.map[row.mvsKey]) {
        rscAddErr_(snap, i, 'TB', 'Toko Bangkrut: key tidak ditemukan di m_visit_schedule. Actual=' +
          row.mvsKey.split('|').join(' + ') + '.');
        continue;
      }
      if (!row.mvsPicked) {
        rscAddErr_(snap, i, 'TB', 'Toko Bangkrut: Visit Valid From tidak sesuai m_visit_schedule. Expected=[none].');
        continue;
      }
      if (f['Visit Valid From'] !== row.mvsPicked) {
        rscAddErr_(snap, i, 'TB', 'Toko Bangkrut: Visit Valid From tidak sesuai m_visit_schedule. Expected=' +
          row.mvsPicked + ', actual=' + f['Visit Valid From'] + '.');
      }
    }
  }
};

/* -------------------------------------------------------------
 * 7.9 VALIDATOR TAMBAHAN — Change Sales Office & Change Salesman Type
 * ----------------------------------------------------------- */

function rscDupCheck_(snap, keyFields, code) {
  var seen = {};
  for (var i = 0; i < snap.rows.length; i++) {
    var parts = [];
    for (var k = 0; k < keyFields.length; k++) parts.push(snap.rows[i].f[keyFields[k]] || '');
    var key = parts.join('|').toUpperCase();
    if (key.replace(/\|/g, '') === '') continue;
    if (!seen[key]) seen[key] = [];
    seen[key].push(i);
  }
  for (var kk in seen) {
    if (!Object.prototype.hasOwnProperty.call(seen, kk)) continue;
    if (seen[kk].length < 2) continue;
    var rows = [];
    for (var a = 0; a < seen[kk].length; a++) rows.push(snap.rows[seen[kk][a]].sheetRow);
    var label = rscRowsLabel_(rows);
    for (var b = 0; b < seen[kk].length; b++) {
      rscAddErr_(snap, seen[kk][b], code,
        'Key ' + keyFields.join(' + ') + ' duplikat dalam template (row ' + label + ').');
    }
  }
}

/** Change Sales Office (PERF26 §17). */
function RSC_STD_VALIDATE_SALES_OFFICE_20260814_(snap) {
  var em = snap.masters.office;
  var emOk = !!(em && em.available);
  var hier = !!(emOk && em.hasHierarchy);
  if (!emOk) snap.skipped['SO-em'] = 'master em tidak tersedia';

  for (var i = 0; i < snap.rows.length; i++) {
    var f = snap.rows[i].f;
    var bp = rscText_(f['BP Number Source']);
    if (!bp) rscAddErr_(snap, i, 'SO1', 'BP Number Source wajib diisi.');
    else if (!/^\d+$/.test(RSC_NORMALIZE_ID_(bp))) {
      rscAddErr_(snap, i, 'SO1', 'BP Number Source "' + bp + '" harus berupa angka.');
    }

    var plant = f['Delivering Plant'];
    if (!plant) rscAddErr_(snap, i, 'SO2', 'Delivering Plant wajib diisi.');
    else if (!RSC_PLANT_FORMAT_RE.test(plant)) {
      rscAddErr_(snap, i, 'SO2', 'Delivering Plant "' + plant + '" harus 4 karakter alphanumeric.');
    }

    var org = f['Sales Organization'], dist = f['Distr. Channel'], div = f['Division'], off = f['Sales Office'];
    if (!org) rscAddErr_(snap, i, 'SO3', 'Sales Organization wajib diisi.');
    if (!dist) rscAddErr_(snap, i, 'SO4', 'Distribution Channel wajib diisi.');
    if (!div) rscAddErr_(snap, i, 'SO5', 'Division wajib diisi.');
    if (!off) rscAddErr_(snap, i, 'SO6', 'Sales Office wajib diisi.');
    if (!emOk || !hier) continue;

    if (org && !em.orgs[org]) {
      rscAddErr_(snap, i, 'SO3', 'Sales Organization "' + org + '" tidak terdaftar pada master em.');
      continue;
    }
    if (org && dist && !em.orgDist[org + '|' + dist]) {
      rscAddErr_(snap, i, 'SO4', 'Distribution Channel "' + dist + '" tidak relevan untuk Sales Organization ' + org + '.');
      continue;
    }
    if (org && dist && div && !em.orgDistDiv[org + '|' + dist + '|' + div]) {
      rscAddErr_(snap, i, 'SO5', 'Division "' + div + '" tidak relevan untuk ' + org + ' + ' + dist + '.');
      continue;
    }
    if (org && dist && div && off && !em.full[org + '|' + dist + '|' + div + '|' + off]) {
      rscAddErr_(snap, i, 'SO6', 'Sales Office "' + off + '" tidak relevan untuk ' + org + ' + ' + dist + ' + ' + div + '.');
    }
  }
  rscDupCheck_(snap, snap.spec.dupKey, 'SO7');
}

/** Change Salesman Type (PERF26 §18). */
function RSC_STD_VALIDATE_SALESMAN_TYPE_20260814_(snap) {
  var em = snap.masters.office;
  var emOk = !!(em && em.available);
  if (!emOk) snap.skipped['ST-em'] = 'master em tidak tersedia';

  var lov = {};
  for (var n = 0; n < SALES_TYPE_OPTIONS.length; n++) lov[RSC_NORMALIZE_ID_(SALES_TYPE_OPTIONS[n])] = true;

  for (var i = 0; i < snap.rows.length; i++) {
    var row = snap.rows[i], f = row.f;

    var sls = f['Salesman ID'];
    if (!sls) rscAddErr_(snap, i, 'ST1', 'Salesman ID wajib diisi.');
    else if (!RSC_STD_IS_DUMMY_SALESMAN_20260814_(sls) && !RSC_STD_IS_NORMAL_SALESMAN_20260814_(sls)) {
      rscAddErr_(snap, i, 'ST1', 'Salesman ID "' + sls + '" tidak sesuai format normal maupun Dummy.');
    }

    var org = f['Sales Organization'], off = f['Sales Office'];
    if (!org) rscAddErr_(snap, i, 'ST2', 'Sales Organization wajib diisi.');
    else if (emOk && !em.orgs[org]) {
      rscAddErr_(snap, i, 'ST2', 'Sales Organization "' + org + '" tidak terdaftar pada master em.');
    }
    if (!off) rscAddErr_(snap, i, 'ST3', 'Sales Office wajib diisi.');
    else if (emOk && !em.map[off]) {
      rscAddErr_(snap, i, 'ST3', 'Sales Office "' + off + '" tidak terdaftar pada master em.');
    } else if (emOk && off && org && em.map[off] && em.map[off].org && em.map[off].org !== org) {
      rscAddErr_(snap, i, 'ST3', 'Sales Office "' + off + '" bukan milik Sales Organization ' + org + '.');
    }

    var typ = f['Sales Type'];
    if (!typ) rscAddErr_(snap, i, 'ST4', 'Sales Type wajib diisi.');
    else if (!lov[typ]) rscAddErr_(snap, i, 'ST4', 'Sales Type "' + typ + '" harus dipilih dari LOV New code S4.');

    var vf = f['Valid From'], vt = f['Valid To'];
    var dFrom = row.dates['Valid From'] || {}, dTo = row.dates['Valid To'] || {};
    if (!vf && !dFrom.hadInput) rscAddErr_(snap, i, 'ST5', 'Valid From wajib diisi.');
    else if (!vf || !rscIsValidDateStr_(vf)) {
      rscAddErr_(snap, i, 'ST5', 'Format Valid From tidak valid: "' + (dFrom.raw || vf) + '". Gunakan YYYY-MM-DD.');
    }
    if (!vt && !dTo.hadInput) rscAddErr_(snap, i, 'ST6', 'Valid To wajib diisi.');
    else if (!vt || !rscIsValidDateStr_(vt)) {
      rscAddErr_(snap, i, 'ST6', 'Format Valid To tidak valid: "' + (dTo.raw || vt) + '". Gunakan YYYY-MM-DD.');
    } else if (vf && rscIsValidDateStr_(vf) && vt <= vf) {
      rscAddErr_(snap, i, 'ST6', 'Valid To (' + vt + ') harus lebih besar dari Valid From (' + vf + ').');
    }
  }
  rscDupCheck_(snap, snap.spec.dupKey, 'ST7');
}

/* -------------------------------------------------------------
 * 7.10 ORCHESTRATION
 * ----------------------------------------------------------- */

/** Rakit status O:P dari daftar error tiap baris. */
function rscAssembleResult_(snap, timing) {
  var status = [], detail = [], errorRows = 0, byCode = {}, csoRows = 0, ssRows = 0, tbRows = 0;
  var maxChars = RSC_STANDARD_VALIDATION_V27_20260814.msgMaxDetailChars;
  for (var r = 0; r < snap.rows.length; r++) {
    var row = snap.rows[r];
    if (row.cso && row.cso.yes) csoRows++;
    if (row.ssPair) ssRows++;
    if (row.isTB) tbRows++;
    var errs = rscUniq_(snap.errors[r]);
    if (errs.length) {
      errorRows++;
      status.push('ERROR');
      var joined = errs.join(' | ');
      if (joined.length > maxChars) joined = joined.substring(0, maxChars - 20) + ' ...(dipotong)';
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
    ctx: snap, spec: snap.spec, rowCount: snap.rows.length, errorRows: errorRows,
    changeScheduleOnlyRows: csoRows, ssPairRows: ssRows, tokoBangkrutRows: tbRows,
    mutatedRows: snap.mutations || 0,
    csoUnverifiedRows: snap.csoUnverifiedRows || 0,
    status: status, detail: detail, byCode: byCode, skipped: snap.skipped,
    timing: timing
  };
}

/**
 * Jalankan seluruh business rule final atas snapshot yang sudah dimutasi:
 * S0, R1, R1A, R2, R3, R4, R5, R6, R7, R8a, R8b, R9, R9A, R10, R11, R12, TB.
 */
function RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_RULES_20260814_(snap) {
  var spec = snap.spec, i, r;
  for (r = 0; r < snap.rows.length; r++) {
    for (i = 0; i < spec.rowRules.length; i++) {
      var fn = RSC_ROW_RULES[spec.rowRules[i]];
      if (fn) fn(snap, snap.rows[r], r);
    }
  }
  for (i = 0; i < spec.tableRules.length; i++) {
    var tf = RSC_TABLE_RULES[spec.tableRules[i]];
    if (tf) tf(snap);
  }
  return snap;
}

/** Pipeline utama Rolling (PERF26 §1). */
function RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_20260814_(spec, values, masters) {
  var t0 = Date.now();
  var snap = RSC_V28_3_CREATE_ROLLING_SNAPSHOT_20260814_(spec, values, masters);
  var tNorm = Date.now();

  snap.relCtx = RSC_STD_LOAD_RELATION_CONTEXT_20260814_(snap);
  RSC_STD_DETECT_CHANGE_SCHEDULE_ONLY_20260819_(snap, snap.relCtx);
  snap.mvs = RSC_MVS_getIndexSubset_20260819_(snap);
  RSC_V28_3_APPLY_ROLLING_MUTATIONS_20260814_(snap, snap.relCtx, snap.mvs);
  var tMut = Date.now();

  RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_RULES_20260814_(snap);
  var tRules = Date.now();

  return rscAssembleResult_(snap, {
    normalizeSec: rscRound_((tNorm - t0) / 1000, 3),
    mutateSec: rscRound_((tMut - tNorm) / 1000, 3),
    rulesSec: rscRound_((tRules - tMut) / 1000, 3)
  });
}

/** Entry Rolling. */
function RSC_STD_VALIDATE_ROLLING_20260814_(spec, values, masters) {
  return RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_20260814_(spec, values, masters);
}

/** Router Active/Bulk ke jenis validator. Semua jalur memakai core yang sama. */
function RSC_STD_VALIDATE_ONE_SHEET_20260814_(spec, values, masters) {
  if (spec.validator === 'ROLLING') return RSC_STD_VALIDATE_ROLLING_20260814_(spec, values, masters);

  var t0 = Date.now();
  var snap = RSC_V28_3_CREATE_ROLLING_SNAPSHOT_20260814_(spec, values, masters);
  var tNorm = Date.now();
  if (spec.validator === 'SALES_OFFICE') RSC_STD_VALIDATE_SALES_OFFICE_20260814_(snap);
  else if (spec.validator === 'SALESMAN_TYPE') RSC_STD_VALIDATE_SALESMAN_TYPE_20260814_(snap);
  var tRules = Date.now();

  return rscAssembleResult_(snap, {
    normalizeSec: rscRound_((tNorm - t0) / 1000, 3),
    mutateSec: 0,
    rulesSec: rscRound_((tRules - tNorm) / 1000, 3)
  });
}

/** Nama lama dipertahankan untuk seluruh pemanggil internal. */
function rscValidateValues_(spec, values, masters) {
  return RSC_STD_VALIDATE_ONE_SHEET_20260814_(spec, values, masters);
}

/**
 * Verifikasi header. Format pesan dipertahankan supaya histori feedback
 * ke area tetap terbaca sama:
 *   Layout A:P tidak sesuai template FSD. $D: expected "Relationship", got ""
 */
function rscCheckLayout_(spec, headerRow) {
  var problems = [];
  for (var c = 0; c < spec.header.length; c++) {
    var want = spec.header[c], got = rscText_(headerRow[c]);
    if (rscKey_(got) !== rscKey_(want)) {
      problems.push('$' + rscColLetter_(c + 1) + ': expected "' + want + '", got "' + got + '"');
    }
  }
  if (!problems.length) return null;
  return 'Layout A:' + rscColLetter_(spec.header.length) + ' tidak sesuai template FSD. ' + problems.join('; ');
}

/* =============================================================
 * 8. PENULIS HASIL + PEWARNAAN STATUS
 * ============================================================= */

/**
 * Tulis kembali baris yang dimutasi (A:N) lalu status O:P dan warnanya.
 * Hanya baris yang benar-benar berubah yang ditulis, dalam blok berurutan,
 * supaya formula pada baris lain tidak tersentuh.
 */
function RSC_V28_3_WRITE_ROLLING_SNAPSHOT_20260814_(sheet, spec, result, dataRowCount) {
  if (!dataRowCount) return 0;
  var snap = result.ctx;

  if (result.mutatedRows) {
    var pending = [];
    for (var m = 0; m < snap.rows.length; m++) {
      var row = snap.rows[m];
      if (!row.changed) continue;
      var vals = [];
      for (var c = 0; c < spec.dataCols; c++) {
        var name = spec.header[c];
        vals.push(row.f[name] === undefined ? row.raw[c] : row.f[name]);
      }
      pending.push({ row: row.sheetRow, values: vals });
    }
    pending.sort(function (a, b) { return a.row - b.row; });
    var i = 0;
    while (i < pending.length) {
      var start = i;
      while (i + 1 < pending.length && pending[i + 1].row === pending[i].row + 1) i++;
      var block = [];
      for (var k = start; k <= i; k++) block.push(pending[k].values);
      rscSetValuesChunked_(sheet, pending[start].row, 1, block, result);
      i++;
    }
  }

  var out = [];
  for (var z = 0; z < dataRowCount; z++) out.push(['', '']);
  for (var r = 0; r < snap.rows.length; r++) {
    var pos = snap.rows[r].sheetRow - 2;
    if (pos >= 0 && pos < dataRowCount) out[pos] = [result.status[r], result.detail[r]];
  }
  if (spec.errorCol === spec.statusCol + 1) {
    rscSetValuesChunked_(sheet, 2, spec.statusCol, out, result);
  } else {
    var s = [], d = [];
    for (var q = 0; q < out.length; q++) { s.push([out[q][0]]); d.push([out[q][1]]); }
    rscSetValuesChunked_(sheet, 2, spec.statusCol, s, result);
    rscSetValuesChunked_(sheet, 2, spec.errorCol, d, result);
  }
  rscApplyStatusColors_(sheet, spec, out, dataRowCount);
  return dataRowCount;
}

function rscWriteResults_(sheet, spec, result, dataRowCount) {
  return RSC_V28_3_WRITE_ROLLING_SNAPSHOT_20260814_(sheet, spec, result, dataRowCount);
}

/**
 * Warna hasil validasi baris:
 *   OK    -> hijau, status tebal
 *   ERROR -> merah, status tebal, detail dibungkus (wrap)
 */
function rscApplyStatusColors_(sheet, spec, out, dataRowCount) {
  try {
    var bg = [], fc = [], fw = [];
    for (var i = 0; i < dataRowCount; i++) {
      var paint = RSC_UI_STATUS_COLOR_20260820_(out[i][0]);
      bg.push([paint.bg, paint.bg]);
      fc.push([paint.font, paint.font]);
      fw.push([paint.bold ? 'bold' : 'normal', 'normal']);
    }
    if (spec.errorCol !== spec.statusCol + 1) return;
    var V = RSC_STANDARD_VALIDATION_V27_20260814;
    var step = V.writeChunkRows || 5000;
    for (var r0 = 0; r0 < dataRowCount; r0 += step) {
      var n = Math.min(step, dataRowCount - r0);
      var rng = sheet.getRange(2 + r0, spec.statusCol, n, 2);
      rng.setBackgrounds(bg.slice(r0, r0 + n));
      if (rng.setFontColors) rng.setFontColors(fc.slice(r0, r0 + n));
      if (rng.setFontWeights) rng.setFontWeights(fw.slice(r0, r0 + n));
      var det = sheet.getRange(2 + r0, spec.errorCol, n, 1);
      if (det.setWrap) det.setWrap(true);
    }
  } catch (e) { /* warna bersifat kosmetik, tidak boleh menggagalkan validasi */ }
}

function rscEnsureResultHeaders_(sheet, spec) {
  var width = Math.max(sheet.getLastColumn(), spec.errorCol);
  var cur = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  var n = 0;
  if (rscKey_(cur[spec.statusCol - 1]) !== rscKey_(TEMPLATE_UI_PARAMETERS.validationStatusHeader)) {
    sheet.getRange(1, spec.statusCol).setValue(TEMPLATE_UI_PARAMETERS.validationStatusHeader); n++;
  }
  if (rscKey_(cur[spec.errorCol - 1]) !== rscKey_(TEMPLATE_UI_PARAMETERS.errorDetailHeader)) {
    sheet.getRange(1, spec.errorCol).setValue(TEMPLATE_UI_PARAMETERS.errorDetailHeader); n++;
  }
  return n;
}
