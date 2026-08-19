
/* =============================================================
 * 13. MESIN JOB LATAR BELAKANG BERSAMA
 * -------------------------------------------------------------
 * Semua job yang menyusuri link kolom E (perbaikan tanggal Rolling, replace
 * tanggal by m_bp_relation, Toko Bangkrut) dulunya punya implementasi sendiri
 * yang hampir sama. Sekarang semuanya memakai satu mesin resumable:
 * checkpoint di Script Properties, soft deadline, dan trigger lanjutan.
 * ============================================================= */

function rscBgState_(key) {
  var raw = rscGetProp_('RSC_BG_' + key, '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function rscBgSave_(key, state) { rscSetProp_('RSC_BG_' + key, JSON.stringify(state)); }
function rscBgClear_(key) { rscSetProp_('RSC_BG_' + key, ''); }

/**
 * Jalankan job latar belakang atas seluruh link FINAL.
 * job = {
 *   key, handlerFn, title, softDeadlineMs, maxFilesPerRun, triggerDelayMs,
 *   apply: function (childSs, masters, state) -> { updated, skipped, note }
 * }
 */
function rscBgRun_(job) {
  var ss = rscActiveSs_();
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var started = Date.now();

  var state = rscBgState_(job.key);
  if (!state) {
    state = {
      key: job.key, runId: rscUuid_(), row: L.firstDataRow,
      processed: 0, updated: 0, skipped: 0, failed: 0,
      startedAt: rscStamp_(), notes: []
    };
  }

  var masters = null;
  try {
    masters = rscLoadMasters_(ss);
  } catch (e) {
    var c = rscClassify_(e);
    if (c.kind === RSC_ERR.INFRA) {
      rscBgSave_(job.key, state);
      rscBgArm_(job);
      rscJobLogSet_(ss, 'SYSTEM', {
        job: job.title, state: 'WAITING', stage: 'Master belum siap', progress: 0,
        message: 'Index master sedang dibangun. Job dijadwalkan ulang.',
        lastError: '[INFRA] ' + c.message, startedAt: state.startedAt
      }, { force: true, history: true });
      return state;
    }
    throw e;
  }

  var lastRow = master.getLastRow();
  var filesThisRun = 0;

  while (state.row <= lastRow) {
    if ((Date.now() - started) > job.softDeadlineMs) break;
    if (filesThisRun >= job.maxFilesPerRun) break;

    var link = rscText_(master.getRange(state.row, L.linkCol).getDisplayValue());
    var row = state.row;
    state.row++;
    if (!link) continue;
    var fileId = rscFileId_(link);
    if (!fileId) { state.skipped++; continue; }

    filesThisRun++;
    state.processed++;
    try {
      var child = SpreadsheetApp.openById(fileId);
      var res = job.apply(child, masters, state) || {};
      state.updated += Number(res.updated || 0);
      state.skipped += Number(res.skipped || 0);
      if (res.note) state.notes.push('row ' + row + ': ' + res.note);
      rscJobLogSet_(ss, 'SYSTEM', {
        job: job.title, state: 'RUNNING', stage: job.title,
        progress: rscRound_((row - L.firstDataRow + 1) / Math.max(1, lastRow - L.firstDataRow + 1), 4),
        currentTotal: state.processed + ' / ' + (lastRow - L.firstDataRow + 1),
        fileId: fileId, fileName: child.getName(),
        message: 'Diperbarui ' + state.updated + ' sel sejauh ini.',
        startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1)
      });
    } catch (err) {
      var cc = rscClassify_(err);
      state.failed++;
      state.notes.push('row ' + row + ' [' + cc.kind + ']: ' + String(cc.message).substring(0, 200));
      if (cc.kind === RSC_ERR.INFRA) state.row = row;   // ulangi baris ini nanti
    }
  }

  if (state.row <= lastRow) {
    rscBgSave_(job.key, state);
    rscBgArm_(job);
    rscJobLogSet_(ss, 'SYSTEM', {
      job: job.title, state: 'WAITING', stage: 'Lanjut di eksekusi berikutnya',
      progress: rscRound_((state.row - L.firstDataRow) / Math.max(1, lastRow - L.firstDataRow + 1), 4),
      currentTotal: state.processed + ' / ' + (lastRow - L.firstDataRow + 1),
      message: 'Diperbarui ' + state.updated + ', dilewati ' + state.skipped + ', gagal ' + state.failed + '.',
      startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1)
    }, { force: true, history: true });
    return state;
  }

  rscBgClear_(job.key);
  rscDeleteTriggers_([job.handlerFn]);
  rscJobLogSet_(ss, 'SYSTEM', {
    job: job.title, state: 'DONE', stage: 'Selesai', progress: 1,
    currentTotal: state.processed + ' / ' + state.processed,
    message: 'Diperbarui ' + state.updated + ', dilewati ' + state.skipped + ', gagal ' + state.failed + '.',
    startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1)
  }, { force: true, history: true });
  return state;
}

function rscBgArm_(job) {
  try {
    rscDeleteTriggers_([job.handlerFn]);
    ScriptApp.newTrigger(job.handlerFn).timeBased().after(job.triggerDelayMs).create();
    return true;
  } catch (e) { return false; }
}

/** Peta kolom sheet Change Rolling di file anak berdasarkan header. */
function rscRollingColumns_(sh) {
  var spec = rscPrimarySpec_();
  var width = Math.max(sh.getLastColumn(), spec.errorCol);
  if (width < 1 || sh.getLastRow() < 1) return null;
  var header = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  var hmap = rscHeaderMap_(header);
  var col = {};
  for (var i = 0; i < spec.header.length; i++) {
    var idx = rscPickCol_(hmap, [spec.header[i]]);
    col[spec.header[i]] = idx >= 0 ? idx + 1 : (i + 1);
  }
  col.__width = width;
  return col;
}

function rscChildRollingSheet_(childSs) {
  var sheets = childSs.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var spec = rscSpecFor_(sheets[i].getName());
    if (spec && spec.key === 'ROLLING') return sheets[i];
  }
  return null;
}

/* ---------------- JOB 1: Fix G/L Reason Rolling ---------------- */

var RSC_JOB_ROLLING_DATES_ = {
  key: 'FIX_ROLLING_REASON_DATES',
  handlerFn: 'RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611',
  title: 'FIX ROLLING REASON DATES',
  softDeadlineMs: ROLLING_SALES_CENTER_PARAMETERS.softDeadlineMs,
  maxFilesPerRun: BACKGROUND_ROLLING_REASON_DATE_FIX_PARAMETERS.hardMaxFilesPerRun,
  triggerDelayMs: ROLLING_SALES_CENTER_PARAMETERS.bgDelayMs,
  apply: function (childSs, masters) {
    var sh = rscChildRollingSheet_(childSs);
    if (!sh) return { skipped: 1, note: 'sheet Change Rolling tidak ada' };
    var col = rscRollingColumns_(sh);
    var lastRow = sh.getLastRow();
    if (!col || lastRow < 2) return { skipped: 1, note: 'tidak ada baris data' };

    var n = lastRow - 1;
    var reason = sh.getRange(2, col['Reason'], n, 1).getDisplayValues();
    var vf = sh.getRange(2, col['Valid From'], n, 1).getValues();
    var vvf = sh.getRange(2, col['Visit Valid From'], n, 1).getValues();
    var dateNew = VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew;
    var updated = 0;

    for (var r = 0; r < n; r++) {
      if (rscKey_(reason[r][0]) !== rscKey_('Rolling')) continue;
      if (rscDateStr_(vf[r][0]) !== dateNew) { vf[r][0] = dateNew; updated++; }
      if (rscDateStr_(vvf[r][0]) !== dateNew) { vvf[r][0] = dateNew; updated++; }
    }
    if (updated) {
      sh.getRange(2, col['Valid From'], n, 1).setValues(vf);
      sh.getRange(2, col['Visit Valid From'], n, 1).setValues(vvf);
    }
    return { updated: updated };
  }
};

function RSC_START_FIX_ROLLING_REASON_DATES_BG_20260611() {
  rscBgClear_(RSC_JOB_ROLLING_DATES_.key);
  var s = rscBgRun_(RSC_JOB_ROLLING_DATES_);
  rscAlert_('Fix G/L Reason Rolling',
    'Reason = Rolling dipaksa ke Valid From / Visit Valid From = ' +
    VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew + '.\n\n' +
    'File diproses : ' + s.processed + '\nSel diperbarui: ' + s.updated +
    '\nDilewati      : ' + s.skipped + '\nGagal         : ' + s.failed +
    (s.row ? '\n\nJob berlanjut otomatis di latar belakang.' : ''));
  return s;
}

function RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611() { return rscBgRun_(RSC_JOB_ROLLING_DATES_); }

/* ------- JOB 2: Replace Dates by m_bp_relation (Toko Bangkrut saja) ------- */

var RSC_JOB_VALIDATE_DATE_ = {
  key: 'VALIDATE_DATE_IN_TEMPLATE',
  handlerFn: 'RSC_CONTINUE_VALIDATE_DATE_IN_TEMPLATE_BG_20260619',
  title: 'REPLACE DATE BY m_bp_relation',
  softDeadlineMs: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.softDeadlineMs,
  maxFilesPerRun: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.hardMaxFilesPerRun,
  triggerDelayMs: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.triggerDelayMs,
  apply: function (childSs, masters) {
    // Bagian Reason = Rolling TIDAK membutuhkan DB. Hanya penarikan Valid From
    // historis untuk baris non-Rolling yang perlu m_bp_relation, jadi index yang
    // tidak tersedia tidak boleh membatalkan seluruh file.
    var idx = masters.idx && masters.idx.RELATION;
    var hasIdx = !!(idx && idx.available);
    var sh = rscChildRollingSheet_(childSs);
    if (!sh) return { skipped: 1, note: 'sheet Change Rolling tidak ada' };
    var col = rscRollingColumns_(sh);
    var lastRow = sh.getLastRow();
    if (!col || lastRow < 2) return { skipped: 1, note: 'tidak ada baris data' };

    var n = lastRow - 1;
    var cust = sh.getRange(2, col['Customer ID'], n, 1).getDisplayValues();
    var rel = sh.getRange(2, col['Relationship'], n, 1).getDisplayValues();
    var sls = sh.getRange(2, col['Salesman ID'], n, 1).getDisplayValues();
    var reason = sh.getRange(2, col['Reason'], n, 1).getDisplayValues();
    var vf = sh.getRange(2, col['Valid From'], n, 1).getValues();
    var vvf = sh.getRange(2, col['Visit Valid From'], n, 1).getValues();
    var dateNew = VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew;
    var updated = 0;

    for (var r = 0; r < n; r++) {
      var isRolling = rscKey_(reason[r][0]) === rscKey_('Rolling');
      if (isRolling) {
        // Rolling SELALU memakai dateNew. Histori DB tidak boleh menarik mundur.
        if (rscDateStr_(vf[r][0]) !== dateNew) { vf[r][0] = dateNew; updated++; }
        if (rscDateStr_(vvf[r][0]) !== dateNew) { vvf[r][0] = dateNew; updated++; }
        continue;
      }
      // Selain Rolling: ambil Valid From historis dari relasi yang cocok.
      if (!hasIdx) continue;
      var recs = idx.map[RSC_NORMALIZE_ID_(cust[r][0])];
      if (!recs) continue;
      var wantRel = RSC_NORMALIZE_ID_(rel[r][0]);
      var wantSls = RSC_NORMALIZE_ID_(sls[r][0]);
      var best = '';
      for (var k = 0; k < recs.length; k++) {
        if (wantRel && RSC_NORMALIZE_ID_(recs[k][0]) !== wantRel) continue;
        if (wantSls && RSC_NORMALIZE_ID_(recs[k][1]) !== wantSls) continue;
        var from = rscDateStr_(recs[k][2]);
        if (from && (!best || from < best)) best = from;
      }
      if (best && rscDateStr_(vf[r][0]) !== best) { vf[r][0] = best; updated++; }
    }
    if (updated) {
      sh.getRange(2, col['Valid From'], n, 1).setValues(vf);
      sh.getRange(2, col['Visit Valid From'], n, 1).setValues(vvf);
    }
    return { updated: updated, note: hasIdx ? '' : 'master m_bp_relation tidak tersedia; hanya bagian Rolling diproses' };
  }
};

function RSC_START_VALIDATE_DATE_IN_TEMPLATE_20260619() {
  rscBgClear_(RSC_JOB_VALIDATE_DATE_.key);
  var s = rscBgRun_(RSC_JOB_VALIDATE_DATE_);
  rscAlert_('Replace Dates by m_bp_relation',
    'Reason Rolling tetap memakai ' + VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew +
    ' (histori DB tidak menarik mundur).\nBaris non-Rolling mengambil Valid From terkecil dari relasi yang cocok.\n\n' +
    'File diproses : ' + s.processed + '\nSel diperbarui: ' + s.updated +
    '\nDilewati      : ' + s.skipped + '\nGagal         : ' + s.failed);
  return s;
}

function RSC_CONTINUE_VALIDATE_DATE_IN_TEMPLATE_BG_20260619() { return rscBgRun_(RSC_JOB_VALIDATE_DATE_); }

/* ---------------- JOB 3: Toko Bangkrut Date by DB ---------------- */

var RSC_JOB_TOKO_BANGKRUT_ = {
  key: 'TOKO_BANGKRUT_DATES',
  handlerFn: 'RSC_CONTINUE_TOKO_BANGKRUT_DATES_BY_DB_BG_20260622',
  title: 'TOKO BANGKRUT DATE BY DB',
  softDeadlineMs: RSC_TOKO_BANGKRUT_DB_DATE_PARAMETERS_20260622.softDeadlineMs,
  maxFilesPerRun: RSC_TOKO_BANGKRUT_DB_DATE_PARAMETERS_20260622.hardMaxFilesPerRun,
  triggerDelayMs: RSC_TOKO_BANGKRUT_DB_DATE_PARAMETERS_20260622.triggerDelayMs,
  apply: function (childSs, masters) {
    var sh = rscChildRollingSheet_(childSs);
    if (!sh) return { skipped: 1, note: 'sheet Change Rolling tidak ada' };
    var col = rscRollingColumns_(sh);
    var lastRow = sh.getLastRow();
    if (!col || lastRow < 2) return { skipped: 1, note: 'tidak ada baris data' };

    var n = lastRow - 1;
    var reason = sh.getRange(2, col['Reason'], n, 1).getDisplayValues();
    var vt = sh.getRange(2, col['Valid To'], n, 1).getValues();
    var vvt = sh.getRange(2, col['Visit Valid To'], n, 1).getValues();
    var dateClose = VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose;
    var updated = 0;

    for (var r = 0; r < n; r++) {
      if (rscKey_(reason[r][0]) !== rscKey_('Toko Bangkrut')) continue;
      if (rscDateStr_(vt[r][0]) !== dateClose) { vt[r][0] = dateClose; updated++; }
      if (rscDateStr_(vvt[r][0]) !== dateClose) { vvt[r][0] = dateClose; updated++; }
    }
    if (updated) {
      sh.getRange(2, col['Valid To'], n, 1).setValues(vt);
      sh.getRange(2, col['Visit Valid To'], n, 1).setValues(vvt);
    }
    return { updated: updated };
  }
};

function RSC_START_TOKO_BANGKRUT_DATES_BY_DB_20260622() {
  rscBgClear_(RSC_JOB_TOKO_BANGKRUT_.key);
  var s = rscBgRun_(RSC_JOB_TOKO_BANGKRUT_);
  rscAlert_('Toko Bangkrut Date',
    'Reason = Toko Bangkrut dipaksa ke Valid To / Visit Valid To = ' +
    VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose + '.\n\n' +
    'File diproses : ' + s.processed + '\nSel diperbarui: ' + s.updated +
    '\nDilewati      : ' + s.skipped + '\nGagal         : ' + s.failed);
  return s;
}

function RSC_CONTINUE_TOKO_BANGKRUT_DATES_BY_DB_BG_20260622() { return rscBgRun_(RSC_JOB_TOKO_BANGKRUT_); }

/* =============================================================
 * 14. SETUP TEMPLATE (dropdown, format, header)
 * ============================================================= */

function rscSetupRollingSheet_(ss, masters) {
  var sh = ss.getSheetByName(TEMPLATE_UI_PARAMETERS.sheetRolling) ||
           rscFindSheet_(ss, [TEMPLATE_UI_PARAMETERS.sheetRolling]);
  if (!sh) return 0;
  var spec = rscPrimarySpec_();
  sh.getRange(1, 1, 1, spec.header.length).setValues([spec.header]);
  var C = TEMPLATE_UI_PARAMETERS.colors;
  sh.getRange(1, 1, 1, spec.header.length)
    .setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
  sh.setFrozenRows(1);
  rscApplyTemplateDropdowns_(sh, spec, masters);
  try {
    var n = Math.min(TEMPLATE_UI_PARAMETERS.maxRows, Math.max(sh.getMaxRows() - 1, 1));
    sh.getRange(2, 7, n, 2).setNumberFormat('yyyy-mm-dd');
    sh.getRange(2, 12, n, 2).setNumberFormat('yyyy-mm-dd');
  } catch (e) { /* format kosmetik */ }
  return 1;
}

function rscSetupSimpleSheet_(ss, specKey) {
  var spec = null;
  for (var i = 0; i < RSC_SHEET_SPECS.length; i++) if (RSC_SHEET_SPECS[i].key === specKey) spec = RSC_SHEET_SPECS[i];
  if (!spec) return 0;
  var sh = ss.getSheetByName(spec.label) || rscFindSheet_(ss, spec.names);
  if (!sh) return 0;
  var C = TEMPLATE_UI_PARAMETERS.colors;
  sh.getRange(1, 1, 1, spec.header.length).setValues([spec.header]);
  sh.getRange(1, 1, 1, spec.header.length)
    .setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
  sh.setFrozenRows(1);
  return 1;
}

function RSC_SETUP_ROLLING_CHANGE_SHEETS_ONLY_20260611() {
  var ss = rscActiveSs_();
  var masters = rscLoadMasters_(ss);
  var n = rscSetupRollingSheet_(ss, masters) +
          rscSetupSimpleSheet_(ss, 'SALES_OFFICE');
  rscAlert_('Setup CR Change Sheets', n + ' sheet disiapkan (header, format tanggal, dropdown).');
  return n;
}

function RSC_SETUP_CHANGE_SALESMAN_TYPE_ONLY_20260611() {
  var ss = rscActiveSs_();
  var n = rscSetupSimpleSheet_(ss, 'SALESMAN_TYPE');
  rscAlert_('Setup Change Salesman Type', n ? 'Sheet disiapkan.' : 'Sheet tidak ditemukan.');
  return n;
}

function RSC_SETUP_CREDIT_LIMIT_ONLY_20260611() {
  var ss = rscActiveSs_();
  var sh = ss.getSheetByName(TEMPLATE_UI_PARAMETERS.sheetCredit);
  if (!sh) { rscAlert_('Setup Credit Limit', 'Sheet "' + TEMPLATE_UI_PARAMETERS.sheetCredit + '" tidak ditemukan.'); return 0; }
  var C = TEMPLATE_UI_PARAMETERS.colors;
  var width = Math.max(1, sh.getLastColumn());
  sh.getRange(1, 1, 1, width).setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
  sh.setFrozenRows(1);
  rscAlert_('Setup Credit Limit', 'Header sheet Credit Limit disegarkan.');
  return 1;
}

function RSC_SETUP_ALL_TEMPLATES_20260611() {
  var ss = rscActiveSs_();
  var masters = rscLoadMasters_(ss);
  var n = rscSetupRollingSheet_(ss, masters) +
          rscSetupSimpleSheet_(ss, 'SALES_OFFICE') +
          rscSetupSimpleSheet_(ss, 'SALESMAN_TYPE');
  runSafelyWithOptionalRethrow_('Setup credit limit', function () {
    var sh = ss.getSheetByName(TEMPLATE_UI_PARAMETERS.sheetCredit);
    if (sh) {
      var C = TEMPLATE_UI_PARAMETERS.colors;
      sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn()))
        .setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }, false);
  rscAlert_('Setup ALL Template', n + ' sheet utama disiapkan ulang (header, format, dropdown).');
  return n;
}

/* =============================================================
 * 15. SUMMARY - CR
 * ============================================================= */

function RSC_GENERATE_CR_VISIT_SCHEDULE_SUMMARY_20260611() {
  var P = CR_VISIT_SCHEDULE_SUMMARY_PARAMETERS;
  var ss = rscActiveSs_();
  var sh = ss.getSheetByName(P.sourceSheetName) || rscFindSheet_(ss, [P.sourceSheetName]);
  if (!sh) return rscAlert_('Summary - CR', 'Sheet "' + P.sourceSheetName + '" tidak ditemukan.');

  var col = rscRollingColumns_(sh);
  var lastRow = sh.getLastRow();
  if (!col || lastRow < 2) return rscAlert_('Summary - CR', 'Tidak ada baris data.');

  var n = lastRow - 1;
  var width = Math.max(col.__width, 16);
  var vals = sh.getRange(2, 1, n, width).getDisplayValues();
  var tokens = P.baseScheduleTokens;
  var tokenIndex = {};
  for (var t = 0; t < tokens.length; t++) tokenIndex[rscKey_(tokens[t])] = t;

  var bySalesman = {}, order = [];
  var iSls = col['Salesman ID'] - 1, iSch = col['Schedule Visit'] - 1;
  var iStatus = col['Validation Status'] - 1, iOffice = col['Sales Office'] - 1;

  for (var r = 0; r < n; r++) {
    if (!P.includeErrorRows && rscKey_(vals[r][iStatus]) === 'ERROR') continue;
    var sid = RSC_NORMALIZE_ID_(vals[r][iSls]);
    if (!sid) continue;
    if (!bySalesman[sid]) {
      bySalesman[sid] = { office: rscText_(vals[r][iOffice]), counts: [], total: 0 };
      for (var z = 0; z < tokens.length; z++) bySalesman[sid].counts.push(0);
      order.push(sid);
    }
    var parsed = rscParseSchedule_(vals[r][iSch]);
    for (var k = 0; k < parsed.valid.length; k++) {
      var ti = tokenIndex[rscKey_(parsed.valid[k])];
      if (ti !== undefined) { bySalesman[sid].counts[ti]++; bySalesman[sid].total++; }
    }
  }

  var out = [['Sales Office', 'Salesman ID'].concat(tokens).concat(['Total'])];
  order.sort();
  for (var o = 0; o < order.length; o++) {
    var rec = bySalesman[order[o]];
    out.push([rec.office, order[o]].concat(rec.counts).concat([rec.total]));
  }

  var target = ss.getSheetByName(P.outputSheetFallbackName);
  if (!target) target = ss.insertSheet(P.outputSheetFallbackName);
  target.clear();
  target.getRange(1, 1, out.length, out[0].length).setValues(out);
  var C = TEMPLATE_UI_PARAMETERS.colors;
  target.getRange(1, 1, 1, out[0].length).setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
  target.setFrozenRows(1);
  target.setFrozenColumns(2);
  try { ss.setActiveSheet(target); } catch (e) { /* tanpa UI */ }

  rscAlert_('Summary - CR', 'Ringkasan dibuat untuk ' + order.length + ' salesman dari ' + n + ' baris.');
  return { salesmen: order.length, rows: n };
}
