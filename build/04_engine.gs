
/* =============================================================
 * 7. SPESIFIKASI SHEET + ENGINE VALIDASI
 * -------------------------------------------------------------
 * Satu engine dipakai untuk semua sheet yang divalidasi. Yang berbeda hanya
 * daftar kolom dan daftar rule, sehingga normalisasi, penulisan hasil, dan
 * pelaporan dijamin identik di mana pun.
 * ============================================================= */

var RSC_SHEET_SPECS = [
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
    required: ['Sales Office', 'Delivering Plant', 'Customer ID', 'Salesman ID', 'Salesman BP Type',
               'Valid From', 'Valid To', 'Visit Category', 'Visit Type', 'Schedule Visit',
               'Visit Valid From', 'Visit Valid To', 'Reason'],
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
  for (var i = 0; i < RSC_SHEET_SPECS.length; i++) {
    var names = RSC_SHEET_SPECS[i].names;
    for (var n = 0; n < names.length; n++) {
      var nk = rscKey_(names[n]);
      if (k === nk || k.indexOf(nk) === 0 || nk.indexOf(k) === 0) return RSC_SHEET_SPECS[i];
    }
  }
  return null;
}

function rscPrimarySpec_() {
  for (var i = 0; i < RSC_SHEET_SPECS.length; i++) if (RSC_SHEET_SPECS[i].primary) return RSC_SHEET_SPECS[i];
  return RSC_SHEET_SPECS[0];
}

/**
 * Kebijakan tanggal Rolling.
 * Reason = Rolling  : Valid From dan Visit Valid From WAJIB dateNew.
 *                     Histori m_bp_relation tidak boleh menarik mundur.
 * Change Schedule Only mode PAIR_NO_RELATION: field relasi tetap apa adanya,
 *                     hanya Visit Valid From yang mengikuti dateNew.
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

/** Uraikan "W1W,W3W" menjadi token terstruktur. */
function rscParseSchedule_(v) {
  var raw = rscText_(v).toUpperCase();
  if (!raw) return { tokens: [], valid: [], invalid: [], weekdays: {}, weeks: {}, canonical: '' };
  var parts = raw.split(/[,;\/]+/);
  var tokens = [], valid = [], invalid = [], weekdays = {}, weeks = {};
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i].replace(/\s+/g, '');
    if (!t) continue;
    tokens.push(t);
    var m = t.match(/^W([1-4])(SU|TH|M|T|W|F|S)$/);
    if (m) { valid.push(t); weeks[m[1]] = true; weekdays[m[2]] = true; }
    else invalid.push(t);
  }
  return {
    tokens: tokens, valid: valid, invalid: invalid, weekdays: weekdays, weeks: weeks,
    canonical: tokens.slice().sort().join(',')
  };
}

/** Master Sales Office dari sheet "em" di file induk. */
function rscOfficeMaster_(masterSs) {
  if (RSC_MEM_INDEX.OFFICES) return RSC_MEM_INDEX.OFFICES;
  var out = { available: false, map: {} };
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
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var code = RSC_NORMALIZE_ID_(vals[r][cOffice]);
      if (!code || out.map[code]) continue;
      out.map[code] = {
        code: code,
        desc: cDesc >= 0 ? rscText_(vals[r][cDesc]) : '',
        org: cOrg >= 0 ? RSC_NORMALIZE_ID_(vals[r][cOrg]) : ''
      };
    }
    out.available = Object.keys(out.map).length > 0;
  } catch (e) { out.available = false; out.error = String(e); }
  RSC_MEM_INDEX.OFFICES = out;
  return out;
}

/** Master Relationship dari daftar parameter. */
function rscRelationshipMaster_() {
  if (RSC_MEM_INDEX.RELTYPE) return RSC_MEM_INDEX.RELTYPE;
  var out = { available: true, source: 'parameters', map: {} };
  for (var i = 0; i < RELATIONSHIP_OPTIONS.length; i++) {
    var opt = RELATIONSHIP_OPTIONS[i];
    var id = RSC_NORMALIZE_ID_(opt);
    var dash = opt.indexOf(' - ');
    out.map[id] = dash > 0 ? opt.substring(dash + 3) : '';
  }
  RSC_MEM_INDEX.RELTYPE = out;
  return out;
}

/** Muat seluruh master sekali per execution. */
function rscLoadMasters_(masterSs) {
  var m = {
    office: rscOfficeMaster_(masterSs),
    relationship: rscRelationshipMaster_(),
    dateNew: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew,
    dateClose: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose,
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

/* ---------------------- KONTEKS & DETEKSI CSO ---------------------- */

function rscBuildContext_(spec, values, masters) {
  var ctx = { spec: spec, rows: [], errors: [], masters: masters || {}, skipped: {}, fieldIdx: {} };
  for (var c = 0; c < spec.header.length; c++) ctx.fieldIdx[spec.header[c]] = c;

  for (var r = 0; r < values.length; r++) {
    var raw = values[r], f = {}, nonEmpty = false;
    for (var h = 0; h < spec.header.length; h++) {
      var name = spec.header[h];
      if (name === 'Validation Status' || name === 'Error Detail') continue;
      var val = raw[h], norm;
      if (spec.dateFields.indexOf(name) >= 0) norm = rscDateStr_(val);
      else if (spec.idFields.indexOf(name) >= 0) norm = RSC_NORMALIZE_ID_(val);
      else norm = rscText_(val);
      f[name] = norm;
      if (norm) nonEmpty = true;
    }
    if (!nonEmpty) continue;
    ctx.rows.push({ i: ctx.rows.length, sheetRow: r + 2, f: f, raw: raw, cso: null });
    ctx.errors.push([]);
  }
  return ctx;
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

/**
 * Deteksi Change Schedule Only.
 * CASE 1 (EXACT_REL_VALID_TO) : Customer + Relationship + Salesman + Valid To
 *                               sudah ada di m_bp_relation.
 * CASE 2 (PAIR_NO_RELATION)   : Relationship kosong, pasangan Customer +
 *                               Salesman ada di m_bp_relation.
 * Baris Change Schedule Only dikecualikan dari duplicate check R8.
 */
function rscDetectChangeScheduleOnly_(ctx) {
  var idx = ctx.masters.idx && ctx.masters.idx.RELATION;
  if (!idx || !idx.available) { ctx.skipped['CSO'] = 'master m_bp_relation tidak tersedia'; return; }
  for (var i = 0; i < ctx.rows.length; i++) {
    var f = ctx.rows[i].f;
    var cust = f['Customer ID'];
    if (!cust) continue;
    var recs = idx.map[RSC_NORMALIZE_ID_(cust)];
    if (!recs) continue;
    var rel = f['Relationship'], sls = RSC_NORMALIZE_ID_(f['Salesman ID']), vt = f['Valid To'];
    for (var r = 0; r < recs.length; r++) {
      var mRel = RSC_NORMALIZE_ID_(recs[r][0]);
      var mSls = RSC_NORMALIZE_ID_(recs[r][1]);
      var mVt = rscDateStr_(recs[r][3]);
      if (!rel && mSls && mSls === sls) {
        ctx.rows[i].cso = { yes: true, mode: 'PAIR_NO_RELATION' };
        break;
      }
      if (rel && mRel === rel && mSls === sls && (!vt || !mVt || mVt === vt)) {
        ctx.rows[i].cso = { yes: true, mode: 'EXACT_REL_VALID_TO' };
        break;
      }
    }
  }
}

/* ---------------------------- RULE PER BARIS ---------------------------- */

var RSC_ROW_RULES = {

  /** R1 — kolom wajib. Relationship boleh kosong khusus Change Schedule Only. */
  R1: function (ctx, row, i) {
    var missing = [];
    for (var k = 0; k < ctx.spec.required.length; k++) {
      if (!row.f[ctx.spec.required[k]]) missing.push(ctx.spec.required[k]);
    }
    if (ctx.spec.key === 'ROLLING' && !row.f['Relationship'] && !(row.cso && row.cso.yes)) {
      missing.push('Relationship');
    }
    if (missing.length) rscAddErr_(ctx, i, 'R1', 'Kolom wajib kosong: ' + rscUniq_(missing).join(', ') + '.');
  },

  /** R2 — Relationship harus terdaftar di master Relationship. */
  R2: function (ctx, row, i) {
    var rel = row.f['Relationship'];
    if (!rel) return;
    var master = ctx.masters.relationship;
    if (!master || !master.available) return;
    if (!master.map[rel]) rscAddErr_(ctx, i, 'R2', 'Relationship tidak terdaftar pada master Relationship.');
  },

  /** R3 — Sales Office dan Delivering Plant. */
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

  /** R4 — format tanggal, urutan, dan kebijakan tanggal periode. */
  R4: function (ctx, row, i) {
    var spec = ctx.spec, bad = [];
    for (var d = 0; d < spec.dateFields.length; d++) {
      var name = spec.dateFields[d], v = row.f[name];
      if (!v) continue;
      if (!rscIsValidDateStr_(v)) bad.push(name + '="' + rscText_(row.raw[ctx.fieldIdx[name]]) + '"');
    }
    if (bad.length) {
      rscAddErr_(ctx, i, 'R4', 'Format tanggal harus YYYY-MM-DD: ' + bad.join(', ') + '.');
      return;
    }
    var vf = row.f['Valid From'], vt = row.f['Valid To'];
    var vvf = row.f['Visit Valid From'], vvt = row.f['Visit Valid To'];
    if (vf && vt && vf > vt) rscAddErr_(ctx, i, 'R4', 'Valid From (' + vf + ') tidak boleh melewati Valid To (' + vt + ').');
    if (vvf && vvt && vvf > vvt) rscAddErr_(ctx, i, 'R4', 'Visit Valid From (' + vvf + ') tidak boleh melewati Visit Valid To (' + vvt + ').');
    if (spec.key !== 'ROLLING') return;

    var reason = row.f['Reason'];
    var mode = (row.cso && row.cso.yes) ? row.cso.mode : '';
    var policy = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_(reason, mode, vf, ctx.masters.dateNew);

    if (rscKey_(reason) === rscKey_('Rolling')) {
      if (policy.policy === 'ROLLING_HARDCODED' && vf && vf !== ctx.masters.dateNew) {
        rscAddErr_(ctx, i, 'R4', 'Reason Rolling: Valid From harus ' + ctx.masters.dateNew + ', ditemukan ' + vf + '.');
      }
      if (vvf && vvf !== ctx.masters.dateNew) {
        rscAddErr_(ctx, i, 'R4', 'Reason Rolling: Visit Valid From harus ' + ctx.masters.dateNew + ', ditemukan ' + vvf + '.');
      }
    } else if (rscKey_(reason) === rscKey_('Toko Bangkrut')) {
      if (vt && vt !== ctx.masters.dateClose) {
        rscAddErr_(ctx, i, 'R4', 'Reason Toko Bangkrut: Valid To harus ' + ctx.masters.dateClose + ', ditemukan ' + vt + '.');
      }
      if (vvt && vvt !== ctx.masters.dateClose) {
        rscAddErr_(ctx, i, 'R4', 'Reason Toko Bangkrut: Visit Valid To harus ' + ctx.masters.dateClose + ', ditemukan ' + vvt + '.');
      }
    }
  },

  /** R5 — Visit Category, Visit Type, Reason. */
  R5: function (ctx, row, i) {
    var cat = row.f['Visit Category'];
    if (cat && VISIT_CATEGORY_OPTIONS.indexOf(cat) < 0) {
      rscAddErr_(ctx, i, 'R5', 'Visit Category "' + cat + '" tidak valid. Gunakan ' + VISIT_CATEGORY_OPTIONS.join(', ') + '.');
    }
    var typ = row.f['Visit Type'];
    if (typ) {
      var t2 = typ.length === 1 ? '0' + typ : typ;
      if (VISIT_TYPE_OPTIONS.indexOf(t2) < 0) {
        rscAddErr_(ctx, i, 'R5', 'Visit Type "' + typ + '" tidak valid. Gunakan 01 sampai 12 (2 digit).');
      } else if (t2 !== typ) {
        rscAddErr_(ctx, i, 'R5', 'Visit Type harus 2 digit. Tulis "' + t2 + '", bukan "' + typ + '".');
      }
    }
    var reason = row.f['Reason'];
    if (reason && REASON_OPTIONS.indexOf(reason) < 0) {
      rscAddErr_(ctx, i, 'R5', 'Reason "' + reason + '" tidak valid. Gunakan ' + REASON_OPTIONS.join(' atau ') + '.');
    }
  },

  /** R6 — Schedule Visit harus konsisten dengan Visit Category. */
  R6: function (ctx, row, i) {
    var cat = row.f['Visit Category'];
    var sch = rscParseSchedule_(row.f['Schedule Visit']);
    if (!sch.tokens.length) return;

    if (sch.invalid.length) {
      rscAddErr_(ctx, i, 'R6', 'Token Schedule Visit tidak dikenal: ' + sch.invalid.join(', ') +
        '. Format yang benar W1M sampai W4SU.');
      return;
    }
    if (rscUniq_(sch.valid).length !== sch.valid.length) {
      rscAddErr_(ctx, i, 'R6', 'Schedule Visit mengandung token duplikat: ' + sch.tokens.join(',') + '.');
      return;
    }
    if (!cat || VISIT_CATEGORY_OPTIONS.indexOf(cat) < 0) return;

    var need = VISIT_CATEGORY_FREQUENCY[cat];
    if (sch.valid.length !== need) {
      rscAddErr_(ctx, i, 'R6', 'Visit Category ' + cat + ' membutuhkan ' + need +
        ' token Schedule Visit, ditemukan ' + sch.valid.length + ' (' + sch.tokens.join(',') + ').');
      return;
    }
    var days = Object.keys(sch.weekdays);
    var weeks = Object.keys(sch.weeks).sort().join(',');

    if (cat === 'F8') {
      if (days.length !== 2) {
        rscAddErr_(ctx, i, 'R6', 'F8 harus 2 hari kunjungan x 4 minggu. Ditemukan ' + days.length + ' hari.');
      } else if (weeks !== '1,2,3,4') {
        rscAddErr_(ctx, i, 'R6', 'F8 harus mencakup minggu 1,2,3,4. Ditemukan minggu ' + weeks + '.');
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

  /** R9 — Salesman: format dan keberadaan di m_sales_info. */
  R9: function (ctx, row, i) {
    var sid = RSC_NORMALIZE_ID_(row.f['Salesman ID']);
    if (sid && !/^[A-Z0-9]{6,12}$/.test(sid)) {
      rscAddErr_(ctx, i, 'R9', 'Salesman ID "' + sid + '" tidak sesuai format.');
    }
    var bp = row.f['Salesman BP Type'];
    if (bp && !/^Z[A-Z]\d{2}$/.test(bp)) {
      rscAddErr_(ctx, i, 'R9', 'Salesman BP Type "' + bp + '" tidak sesuai format (contoh ZD01).');
    }
    var idx = ctx.masters.idx && ctx.masters.idx.SALESMAN;
    if (!idx || !idx.available) { ctx.skipped['R9-master'] = 'master m_sales_info tidak tersedia'; return; }
    if (sid && !idx.map[sid]) {
      rscAddErr_(ctx, i, 'R9', 'Salesman ID "' + sid + '" tidak ditemukan pada master m_sales_info.');
    }
  },

  /** R10 — Customer: format, keberadaan di m_bp_general_view, dan BP Type. */
  R10: function (ctx, row, i) {
    var cid = RSC_NORMALIZE_ID_(row.f['Customer ID'] || row.f['BP Number Source']);
    if (!cid) return;
    if (!/^\d{6,12}$/.test(cid)) {
      rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" harus berupa 6-12 digit angka.');
      return;
    }
    var idx = ctx.masters.idx && ctx.masters.idx.BP;
    if (!idx || !idx.available) { ctx.skipped['R10-master'] = 'master m_bp_general_view tidak tersedia'; return; }
    var recs = idx.map[cid];
    if (!recs) {
      rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" tidak ditemukan pada master BP.');
      return;
    }
    var rec = rscRecObj_(idx, recs[0]);
    var off = row.f['Sales Office'];
    var masterOff = RSC_NORMALIZE_ID_(rec['Sales Office']);
    if (off && masterOff && masterOff !== off) {
      rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" terdaftar pada Sales Office ' + masterOff +
        ', tidak sesuai dengan isian ' + off + '.');
    }
    var bpType = row.f['Salesman BP Type'];
    var masterType = RSC_NORMALIZE_ID_(rec['Salesman BP Type']);
    if (bpType && masterType && masterType !== bpType) {
      rscAddErr_(ctx, i, 'R10', 'Salesman BP Type "' + bpType + '" berbeda dengan master (' + masterType + ').');
    }
  }
};

/* --------------------------- RULE LINTAS BARIS --------------------------- */

var RSC_TABLE_RULES = {

  /** R7 — Customer + Salesman yang sama wajib punya Schedule Visit identik. */
  R7: function (ctx) {
    var groups = {};
    for (var i = 0; i < ctx.rows.length; i++) {
      var f = ctx.rows[i].f;
      var cid = RSC_NORMALIZE_ID_(f['Customer ID']), sid = RSC_NORMALIZE_ID_(f['Salesman ID']);
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
          var idx = rscRowIndexBySheetRow_(ctx, list[rr]);
          if (idx >= 0) rscAddErr_(ctx, idx, 'R7', msg);
        }
      }
    }
  },

  /**
   * R8a — duplikat kunci dalam template.
   * Baris Change Schedule Only dikecualikan sesuai aturan CASE 1/CASE 2.
   */
  R8a: function (ctx) {
    var keyFields = ctx.spec.key === 'ROLLING'
      ? ['Customer ID', 'Relationship', 'Salesman ID', 'Valid To']
      : ctx.spec.required.slice(0, Math.min(4, ctx.spec.required.length));
    var seen = {};
    for (var i = 0; i < ctx.rows.length; i++) {
      if (ctx.rows[i].cso && ctx.rows[i].cso.yes) continue;
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

  /** R8b — bentrok dengan relasi aktif di m_bp_relation. */
  R8b: function (ctx) {
    var idx = ctx.masters.idx && ctx.masters.idx.RELATION;
    if (!idx || !idx.available) { ctx.skipped['R8b'] = 'master m_bp_relation tidak tersedia'; return; }
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i], f = row.f;
      if (rscKey_(f['Reason']) === rscKey_('Toko Bangkrut')) continue;
      if (row.cso && row.cso.yes) continue;
      var cid = RSC_NORMALIZE_ID_(f['Customer ID']);
      var rel = f['Relationship'];
      if (!cid || !rel) continue;
      var recs = idx.map[cid];
      if (!recs) continue;
      for (var r = 0; r < recs.length; r++) {
        if (RSC_NORMALIZE_ID_(recs[r][0]) !== rel) continue;
        var mSid = RSC_NORMALIZE_ID_(recs[r][1]);
        var mVt = rscDateStr_(recs[r][3]);
        if (mSid && mSid !== RSC_NORMALIZE_ID_(f['Salesman ID']) && (!mVt || !f['Valid From'] || mVt >= f['Valid From'])) {
          rscAddErr_(ctx, i, 'R8',
            'R8b: relasi aktif di master masih memakai Salesman ' + mSid + ' (Valid To ' + (mVt || '-') +
            '). Tutup relasi lama sebelum rolling ke ' + f['Salesman ID'] + '.');
          break;
        }
      }
    }
  },

  /** TB — Toko Bangkrut wajib punya jadwal aktif di m_visit_schedule. */
  TB: function (ctx) {
    var idx = ctx.masters.idx && ctx.masters.idx.VISIT;
    var hasIdx = !!(idx && idx.available);
    if (!hasIdx) ctx.skipped['TB'] = 'master m_visit_schedule tidak tersedia';
    for (var i = 0; i < ctx.rows.length; i++) {
      var f = ctx.rows[i].f;
      if (rscKey_(f['Reason']) !== rscKey_('Toko Bangkrut')) continue;
      if (f['Valid To'] === OPEN_ENDED_DATE_TEXT) {
        rscAddErr_(ctx, i, 'TB', 'Toko Bangkrut: Valid To wajib tanggal penutupan, bukan ' + OPEN_ENDED_DATE_TEXT + '.');
      }
      if (!hasIdx) continue;
      var key = RSC_NORMALIZE_ID_(f['Customer ID']) + '|' + RSC_NORMALIZE_ID_(f['Salesman ID']);
      if (!idx.map[key]) rscAddErr_(ctx, i, 'TB', 'Toko Bangkrut: key tidak ditemukan di m_visit_schedule.');
    }
  }
};

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

/** Jalankan seluruh rule pada nilai mentah satu sheet. */
function rscValidateValues_(spec, values, masters) {
  var t0 = Date.now();
  var ctx = rscBuildContext_(spec, values, masters);
  if (spec.key === 'ROLLING') rscDetectChangeScheduleOnly_(ctx);
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

  var status = [], detail = [], errorRows = 0, byCode = {}, csoRows = 0;
  var maxChars = RSC_STANDARD_VALIDATION_V27_20260814.msgMaxDetailChars;
  for (r = 0; r < ctx.rows.length; r++) {
    if (ctx.rows[r].cso && ctx.rows[r].cso.yes) csoRows++;
    var errs = rscUniq_(ctx.errors[r]);
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
    ctx: ctx, rowCount: ctx.rows.length, errorRows: errorRows, changeScheduleOnlyRows: csoRows,
    status: status, detail: detail, byCode: byCode, skipped: ctx.skipped,
    timing: {
      normalizeSec: rscRound_((tNorm - t0) / 1000, 3),
      rulesSec: rscRound_((tRules - tNorm) / 1000, 3)
    }
  };
}

/* =============================================================
 * 8. PENULIS HASIL
 * ============================================================= */

function rscWriteResults_(sheet, spec, result, dataRowCount) {
  if (!dataRowCount) return 0;
  var out = [];
  for (var i = 0; i < dataRowCount; i++) out.push(['', '']);
  for (var r = 0; r < result.ctx.rows.length; r++) {
    var pos = result.ctx.rows[r].sheetRow - 2;
    if (pos >= 0 && pos < dataRowCount) out[pos] = [result.status[r], result.detail[r]];
  }
  if (spec.errorCol === spec.statusCol + 1) {
    sheet.getRange(2, spec.statusCol, dataRowCount, 2).setValues(out);
  } else {
    var s = [], d = [];
    for (var k = 0; k < out.length; k++) { s.push([out[k][0]]); d.push([out[k][1]]); }
    sheet.getRange(2, spec.statusCol, dataRowCount, 1).setValues(s);
    sheet.getRange(2, spec.errorCol, dataRowCount, 1).setValues(d);
  }
  rscApplyStatusColors_(sheet, spec, out, dataRowCount);
  return dataRowCount;
}

/** Warna status mengikuti konvensi lama: hijau OK, merah muda ERROR. */
function rscApplyStatusColors_(sheet, spec, out, dataRowCount) {
  try {
    var C = TEMPLATE_UI_PARAMETERS.colors;
    var bg = [];
    for (var i = 0; i < dataRowCount; i++) {
      var st = out[i][0];
      var c = st === 'OK' ? C.ok : (st === 'ERROR' ? C.error : null);
      bg.push([c, c]);
    }
    if (spec.errorCol === spec.statusCol + 1) {
      sheet.getRange(2, spec.statusCol, dataRowCount, 2).setBackgrounds(bg);
    }
  } catch (e) { /* warna bersifat kosmetik */ }
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
