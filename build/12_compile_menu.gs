
/* =============================================================
 * 23. COMPILE UPLOAD READY
 * -------------------------------------------------------------
 * Menggabungkan baris dari seluruh file FINAL berstatus DONE menjadi satu
 * spreadsheet keluaran, satu tab per jenis sheet, memakai header template
 * yang sama persis. Baris ERROR tidak ikut agar tidak terkirim ke SAP.
 * ============================================================= */

function rscCompileTargets_(ss, onlyStatuses) {
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var lastRow = master.getLastRow();
  var out = [];
  if (lastRow < L.firstDataRow) return out;

  var n = lastRow - L.firstDataRow + 1;
  var width = Math.max(master.getLastColumn(), L.linkCol + 2);
  var vals = master.getRange(L.firstDataRow, 1, n, width).getDisplayValues();
  var statusCol = RSC_UR_20260721.statusCol;

  for (var r = 0; r < vals.length; r++) {
    var id = rscFileId_(vals[r][L.linkCol - 1]);
    if (!id) continue;
    if (onlyStatuses && onlyStatuses.length) {
      var st = rscKey_(vals[r][statusCol - 1]);
      var match = false;
      for (var s = 0; s < onlyStatuses.length; s++) if (st === rscKey_(onlyStatuses[s])) match = true;
      if (!match) continue;
    }
    out.push({
      row: L.firstDataRow + r, fileId: id,
      office: rscText_(vals[r][L.officeCol - 1]), desc: rscText_(vals[r][L.descCol - 1])
    });
  }
  return out;
}

/**
 * Kumpulkan baris valid dari setiap file.
 * Kolom tambahan "Sales Office Source" dan "Source File" ditaruh di depan agar
 * hasil compile bisa ditelusuri kembali ke file asalnya.
 */
function rscCompileCollect_(targets, specKeys) {
  var buckets = {};
  var stats = { files: 0, rows: 0, skippedError: 0, failed: 0, notes: [] };

  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var child;
    try { child = SpreadsheetApp.openById(t.fileId); }
    catch (e) { stats.failed++; stats.notes.push(t.office + ': ' + rscClassify_(e).kind); continue; }
    stats.files++;

    var sheets = child.getSheets();
    for (var s = 0; s < sheets.length; s++) {
      var sh = sheets[s];
      var spec = rscSpecFor_(sh.getName());
      if (!spec) continue;
      if (specKeys && specKeys.indexOf(spec.key) < 0) continue;
      var lastRow = sh.getLastRow();
      if (lastRow < 2) continue;

      var width = Math.max(spec.errorCol, spec.header.length);
      var header = sh.getRange(1, 1, 1, Math.max(width, sh.getLastColumn())).getDisplayValues()[0];
      if (rscCheckLayout_(spec, header)) {
        stats.notes.push(t.office + ' / ' + sh.getName() + ': layout tidak sesuai, dilewati');
        continue;
      }
      var vals = sh.getRange(2, 1, lastRow - 1, width).getDisplayValues();
      if (!buckets[spec.key]) {
        buckets[spec.key] = { spec: spec, rows: [] };
      }
      for (var r = 0; r < vals.length; r++) {
        var status = rscKey_(vals[r][spec.statusCol - 1]);
        var hasData = false;
        for (var c = 0; c < spec.header.length - 2; c++) if (rscText_(vals[r][c])) hasData = true;
        if (!hasData) continue;
        if (status === 'ERROR') { stats.skippedError++; continue; }
        var line = [t.office, t.fileId];
        for (var c2 = 0; c2 < spec.header.length - 2; c2++) line.push(vals[r][c2]);
        buckets[spec.key].rows.push(line);
        stats.rows++;
      }
    }
  }
  return { buckets: buckets, stats: stats };
}

function rscCompileWrite_(title, collected) {
  var out = SpreadsheetApp.create(title);
  var first = true;
  for (var key in collected.buckets) {
    if (!Object.prototype.hasOwnProperty.call(collected.buckets, key)) continue;
    var b = collected.buckets[key];
    var header = ['Sales Office Source', 'Source File'];
    for (var c = 0; c < b.spec.header.length - 2; c++) header.push(b.spec.header[c]);

    var sh;
    if (first) { sh = out.getSheets()[0]; sh.setName(b.spec.label.substring(0, 90)); first = false; }
    else sh = out.insertSheet(b.spec.label.substring(0, 90));

    sh.getRange(1, 1, 1, header.length).setValues([header]);
    var C = TEMPLATE_UI_PARAMETERS.colors;
    sh.getRange(1, 1, 1, header.length).setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (b.rows.length) sh.getRange(2, 1, b.rows.length, header.length).setValues(b.rows);
  }
  return out;
}

function rscCompileRun_(title, statuses, specKeys, propKey) {
  var ss = rscActiveSs_();
  var targets = rscCompileTargets_(ss, statuses);
  if (!targets.length) {
    rscAlert_(title, 'Tidak ada baris rekap yang cocok dengan status: ' + statuses.join(', ') + '.');
    return null;
  }
  var collected = rscCompileCollect_(targets, specKeys);
  var name = title + ' — ' + rscStamp_();
  var out = rscCompileWrite_(name, collected);

  var record = {
    at: rscStamp_(), id: out.getId(), name: name,
    files: collected.stats.files, rows: collected.stats.rows,
    skippedError: collected.stats.skippedError, failed: collected.stats.failed
  };
  rscSetProp_(propKey, JSON.stringify(record));

  var history = rscGetProp_('RSC_COMPILE_TARGET_IDS', '');
  rscSetProp_('RSC_COMPILE_TARGET_IDS', (history ? (history + ',') : '') + out.getId());

  rscAlert_(title,
    'File keluaran : ' + name +
    '\nURL           : ' + out.getUrl() +
    '\n\nFile sumber   : ' + collected.stats.files +
    '\nBaris ikut    : ' + collected.stats.rows +
    '\nBaris ERROR dilewati : ' + collected.stats.skippedError +
    '\nFile gagal dibuka    : ' + collected.stats.failed +
    (collected.stats.notes.length ? ('\n\nCatatan:\n- ' + collected.stats.notes.slice(0, 10).join('\n- ')) : '') +
    '\n\nHasil memakai header template yang sama, ditambah dua kolom penelusuran' +
    '\ndi depan (Sales Office Source, Source File).');
  return record;
}

function RSC_UR_START_20260721() {
  return rscCompileRun_('Compile Upload Ready',
    RSC_UR_20260721.doneStatusValues, ['ROLLING'], RSC_UR_20260721.pLastStats);
}

function RSC_UR_START_ST_RL_20260727() {
  return rscCompileRun_('Compile ST-RL',
    RSC_UR_20260721.doneStatusValues, ['SALESMAN_TYPE', 'SALES_OFFICE'], RSC_UR_20260721.pStrlStats);
}

function rscCompileStatus_(title, propKey) {
  var raw = rscGetProp_(propKey, '');
  if (!raw) { rscAlert_(title, 'Belum pernah dijalankan.'); return null; }
  var rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  rscAlert_(title, rec
    ? ('Terakhir     : ' + rec.at + '\nFile         : ' + rec.name +
       '\nID           : ' + rec.id + '\nFile sumber  : ' + rec.files +
       '\nBaris        : ' + rec.rows + '\nERROR dilewati: ' + rec.skippedError)
    : raw.substring(0, 1000));
  return rec;
}

function RSC_UR_STATUS_20260721() { return rscCompileStatus_('Main Compile Status', RSC_UR_20260721.pLastStats); }
function RSC_UR_STATUS_ST_RL_20260727() { return rscCompileStatus_('ST/RL Compile Status', RSC_UR_20260721.pStrlStats); }

/** Buang baris duplikat persis pada seluruh tab hasil compile terakhir. */
function RSC_UR_CLEANSE_DUPLICATE_OUTPUTS_20260724() {
  var raw = rscGetProp_(RSC_UR_20260721.pLastStats, '');
  if (!raw) return rscAlert_('Cleanse Duplicate', 'Belum ada hasil compile.');
  var rec = JSON.parse(raw);
  var out = SpreadsheetApp.openById(rec.id);
  var sheets = out.getSheets(), removed = 0;
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 3) continue;
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    var seen = {}, keep = [];
    for (var r = 0; r < vals.length; r++) {
      var sig = vals[r].join('|');
      if (sig.replace(/\|/g, '') === '') continue;
      if (seen[sig]) { removed++; continue; }
      seen[sig] = true;
      keep.push(vals[r]);
    }
    sh.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, lastCol).setValues(keep);
  }
  rscAlert_('Cleanse Duplicate', removed + ' baris duplikat dibuang dari ' + rec.name + '.');
  return { removed: removed };
}

/** Rapatkan kolom yang bergeser: buang kolom yang seluruhnya kosong. */
function RSC_UR_REPAIR_SHIFTED_OUTPUTS_20260724() {
  var raw = rscGetProp_(RSC_UR_20260721.pLastStats, '');
  if (!raw) return rscAlert_('Repair Shifted Output', 'Belum ada hasil compile.');
  var rec = JSON.parse(raw);
  var out = SpreadsheetApp.openById(rec.id);
  var sheets = out.getSheets(), fixed = 0;
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;
    var grid = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    var keepCols = [];
    for (var c = 0; c < lastCol; c++) {
      var any = false;
      for (var r = 0; r < grid.length; r++) if (rscText_(grid[r][c])) { any = true; break; }
      if (any) keepCols.push(c);
    }
    if (keepCols.length === lastCol) continue;
    var out2 = [];
    for (var r2 = 0; r2 < grid.length; r2++) {
      var line = [];
      for (var k = 0; k < keepCols.length; k++) line.push(grid[r2][keepCols[k]]);
      out2.push(line);
    }
    sh.clear();
    sh.getRange(1, 1, out2.length, keepCols.length).setValues(out2);
    fixed++;
  }
  rscAlert_('Repair Shifted Output', fixed + ' tab dirapatkan (kolom kosong dibuang).');
  return { fixed: fixed };
}

/** Rapikan spasi berlebih pada seluruh sel hasil compile. */
function RSC_UR_CLEANSE_SPACE_20260722() {
  var raw = rscGetProp_(RSC_UR_20260721.pLastStats, '');
  if (!raw) return rscAlert_('Cleanse Empty Space', 'Belum ada hasil compile.');
  var rec = JSON.parse(raw);
  var out = SpreadsheetApp.openById(rec.id);
  var sheets = out.getSheets(), changed = 0;
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    var dirty = false;
    for (var r = 0; r < vals.length; r++) {
      for (var c = 0; c < lastCol; c++) {
        var t = rscText_(vals[r][c]);
        if (t !== vals[r][c]) { vals[r][c] = t; dirty = true; changed++; }
      }
    }
    if (dirty) sh.getRange(2, 1, vals.length, lastCol).setValues(vals);
  }
  rscAlert_('Cleanse Empty Space', changed + ' sel dirapikan.');
  return { changed: changed };
}

function RSC_V28_PURGE_ALL_COMPILE_TARGETS_20260814() {
  var ids = rscGetProp_('RSC_COMPILE_TARGET_IDS', '').split(',');
  var trashed = 0, failed = 0;
  for (var i = 0; i < ids.length; i++) {
    var id = rscText_(ids[i]);
    if (!id) continue;
    try { DriveApp.getFileById(id).setTrashed(true); trashed++; }
    catch (e) { failed++; }
  }
  rscSetProp_('RSC_COMPILE_TARGET_IDS', '');
  rscSetProp_(RSC_UR_20260721.pLastStats, '');
  rscSetProp_(RSC_UR_20260721.pStrlStats, '');
  rscAlert_('PURGE Compile Targets',
    'Dipindahkan ke sampah: ' + trashed + '\nGagal: ' + failed +
    '\n\nHanya file hasil compile yang dibuat script ini yang dihapus.');
  return { trashed: trashed, failed: failed };
}

/* =============================================================
 * 24. MARK EXACT DATA WITH CURRENT (BigQuery)
 * ============================================================= */

function RSC_MARK_EXACT_DATA_WITH_CURRENT_20260611() {
  var E = EXACT_DATA_WITH_CURRENT_PARAMETERS;
  if (typeof BigQuery === 'undefined') {
    return rscAlert_('Mark Exact Data With Current',
      'Advanced Service BigQuery belum diaktifkan pada project ini.\n\n' +
      'Aktifkan lewat Apps Script: Services -> BigQuery API -> Add.\n' +
      'Project  : ' + E.BQ_PROJECT_ID + '\n' +
      'Dataset  : ' + E.BQ_DATASET_ID + '\n' +
      'Tabel    : ' + E.BQ_TABLE_ID);
  }
  var ss = rscActiveSs_();
  var targets = rscCompileTargets_(ss, null);
  var marked = 0, files = 0, failed = 0;

  for (var i = 0; i < targets.length; i++) {
    var child;
    try { child = SpreadsheetApp.openById(targets[i].fileId); } catch (e) { failed++; continue; }
    var sh = rscChildRollingSheet_(child);
    if (!sh) continue;
    var col = rscRollingColumns_(sh);
    var lastRow = sh.getLastRow();
    if (!col || lastRow < 2) continue;
    files++;

    var n = lastRow - 1;
    var cust = sh.getRange(2, col['Customer ID'], n, 1).getDisplayValues();
    var rel = sh.getRange(2, col['Relationship'], n, 1).getDisplayValues();
    var sls = sh.getRange(2, col['Salesman ID'], n, 1).getDisplayValues();
    var ids = [];
    for (var r = 0; r < n; r++) {
      var c = RSC_NORMALIZE_ID_(cust[r][0]);
      if (c) ids.push(c);
    }
    ids = rscUniq_(ids);
    if (!ids.length) continue;

    var exact = {};
    var batches = rscChunk_(ids, E.BQ_BP_ID_BATCH_SIZE);
    for (var b = 0; b < batches.length; b++) {
      var quoted = [];
      for (var q = 0; q < batches[b].length; q++) quoted.push("'" + batches[b][q].replace(/'/g, '') + "'");
      var sql = 'SELECT bp_id, relationship_cat_id, bp_id_rlt2 FROM `' +
        E.BQ_PROJECT_ID + '.' + E.BQ_DATASET_ID + '.' + E.BQ_TABLE_ID +
        '` WHERE bp_id IN (' + quoted.join(',') + ')';
      try {
        var job = BigQuery.Jobs.query({ query: sql, useLegacySql: false }, E.BQ_PROJECT_ID);
        var rows = (job && job.rows) || [];
        for (var k = 0; k < rows.length; k++) {
          var f = rows[k].f;
          exact[RSC_NORMALIZE_ID_(f[0].v) + '|' + RSC_NORMALIZE_ID_(f[1].v) + '|' + RSC_NORMALIZE_ID_(f[2].v)] = true;
        }
      } catch (eq) { failed++; }
    }

    var outCol = [];
    for (var r2 = 0; r2 < n; r2++) {
      var key = RSC_NORMALIZE_ID_(cust[r2][0]) + '|' + RSC_NORMALIZE_ID_(rel[r2][0]) + '|' + RSC_NORMALIZE_ID_(sls[r2][0]);
      if (exact[key]) { outCol.push([E.OUTPUT_TEXT]); marked++; }
      else outCol.push([E.CLEAR_R_IF_NOT_MATCH ? '' : sh.getRange(2 + r2, E.OUTPUT_COL_R).getDisplayValue()]);
    }
    sh.getRange(2, E.OUTPUT_COL_R, n, 1).setValues(outCol);
  }

  rscAlert_('Mark Exact Data With Current',
    'File diproses : ' + files + '\nBaris ditandai: ' + marked + '\nGagal         : ' + failed);
  return { files: files, marked: marked, failed: failed };
}

/* =============================================================
 * 25. COPY-AWARE AUTOMATION + AUTO VALIDATE ON EDIT
 * ============================================================= */

function handleCopyAwareOpenAutomation_(e) {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  var ss = rscActiveSs_();
  var last = rscGetProp_(C.pLastAutoBootstrappedSpreadsheetId, '');
  if (last === ss.getId()) return;
  rscSetProp_(C.pLastAutoBootstrappedSpreadsheetId, ss.getId());
  rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, ss.getId());
  if (C.removeAllProtectionsOnFirstOpenOfEachSpreadsheet) {
    runSafelyWithOptionalRethrow_('remove protections', RSC_REMOVE_ALL_PROTECTIONS_CURRENT_FILE_20260612, false);
  }
  if (C.runLocalValidationOnFirstOpenOfEachSpreadsheet) {
    runSafelyWithOptionalRethrow_('local validation', RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814, false);
  }
}

function RSC_ACTIVATE_COPY_AWARE_AUTOMATION_20260611() {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  var ss = rscActiveSs_();
  rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, ss.getId());
  rscSetProp_(C.pAuthorizedJobsStatus, 'ACTIVE ' + rscStamp_());
  var installed = [];
  if (C.autoValidateOnEdit) {
    try {
      rscDeleteTriggers_([C.autoValidateOnEditHandler]);
      ScriptApp.newTrigger(C.autoValidateOnEditHandler).forSpreadsheet(ss).onEdit().create();
      installed.push('auto validate on edit');
    } catch (e) { installed.push('auto validate on edit GAGAL: ' + e); }
  }
  if (C.installScheduledLocalValidationJob) {
    try {
      rscDeleteTriggers_([C.localValidationJobHandler]);
      ScriptApp.newTrigger(C.localValidationJobHandler).timeBased()
        .everyHours(C.localValidationJobEveryHours).create();
      installed.push('scheduled local validation');
    } catch (e2) { installed.push('scheduled local validation GAGAL: ' + e2); }
  }
  rscAlert_('Activate Jobs for This Copy',
    'File ini didaftarkan sebagai master aktif.\n\nTerpasang:\n- ' +
    (installed.length ? installed.join('\n- ') : '(tidak ada, sesuai parameter)'));
  return installed;
}

function RSC_SCHEDULED_LOCAL_VALIDATION_JOB_20260611() {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  rscSetProp_(C.pLastLocalValidationAt, rscStamp_());
  return runSafelyWithOptionalRethrow_('scheduled local validation',
    RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814, false);
}

/**
 * onEdit terinstal. Edit beruntun digabung: hanya satu validasi penuh
 * dijalankan per burst, bukan satu per keystroke.
 */
function RSC_V28_2_AUTHORIZED_ON_EDIT_20260814(e) {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  if (!C.autoValidateOnEdit) return;
  try {
    var sh = (e && e.range) ? e.range.getSheet() : SpreadsheetApp.getActiveSheet();
    if (!rscSpecFor_(sh.getName())) return;
    rscSetProp_(C.pAutoValidateLastEditAt, String(Date.now()));
    rscSetProp_(C.pAutoValidateSheetId, String(sh.getSheetId()));
    if (rscGetProp_(C.pAutoValidateQueued, '') === '1') return;
    rscSetProp_(C.pAutoValidateQueued, '1');
    rscDeleteTriggers_([C.autoValidateWorkerHandler]);
    ScriptApp.newTrigger(C.autoValidateWorkerHandler).timeBased()
      .after(Math.max(1000, C.autoValidateDebounceMs)).create();
  } catch (err) { /* onEdit tidak boleh melempar */ }
}

function RSC_V28_2_AUTO_VALIDATE_WORKER_20260814() {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  rscSetProp_(C.pAutoValidateQueued, '');
  var lastEdit = Number(rscGetProp_(C.pAutoValidateLastEditAt, '0'));
  if (Date.now() - lastEdit < C.autoValidateDebounceMs) {
    // Masih ada edit baru; tunda sekali lagi supaya satu burst = satu validasi.
    rscSetProp_(C.pAutoValidateQueued, '1');
    try {
      rscDeleteTriggers_([C.autoValidateWorkerHandler]);
      ScriptApp.newTrigger(C.autoValidateWorkerHandler).timeBased()
        .after(C.autoValidateDebounceMs).create();
    } catch (e) { /* best-effort */ }
    return { deferred: true };
  }
  var ss = rscActiveSs_();
  var sheetId = Number(rscGetProp_(C.pAutoValidateSheetId, '0'));
  var target = null, sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === sheetId) target = sheets[i];
  if (!target) return { skipped: true };

  var spec = rscSpecFor_(target.getName());
  if (!spec) return { skipped: true };
  var masters;
  try { masters = rscLoadMasters_(ss); } catch (e2) { return { deferred: true, reason: rscClassify_(e2).kind }; }

  var needCols = Math.max(spec.errorCol, spec.header.length);
  var width = Math.max(needCols, target.getLastColumn() || needCols);
  if (rscCheckLayout_(spec, target.getRange(1, 1, 1, width).getDisplayValues()[0])) return { skipped: true };
  var dataRows = Math.max(0, rscLastDataRow_(target, spec) - 1);
  var values = dataRows ? rscReadValuesChunked_(target, 2, 1, dataRows, needCols) : [];
  var res = rscValidateValues_(spec, values, masters);
  rscWriteResults_(target, spec, res, dataRows);
  rscSetProp_(C.pAutoValidateLastResult,
    JSON.stringify({ at: rscStamp_(), sheet: target.getName(), rows: res.rowCount, errorRows: res.errorRows }));
  return { rows: res.rowCount, errorRows: res.errorRows };
}

/* =============================================================
 * 26. SELF-TEST MENYELURUH
 * ============================================================= */

function RSC_RUN_SELF_TEST_20260819() {
  var t = rscTestSuite_('SELF-TEST MENYELURUH');
  var subs = [
    RSC_PERF10_TEST_CORE_NORMALIZER_20260819,
    RSC_PERF10_TEST_MBP_CORE_PURE_20260819,
    RSC_PERF10_TEST_CACHE_BUCKET_CORE_20260819,
    RSC_PERF10_TEST_CHANGE_SCHEDULE_20260819,
    RSC_PERF11_TEST_ROLLING_VALID_FROM_POLICY_20260819,
    RSC_PERF12_TEST_STATUS_AND_GATE_20260819,
    RSC_PERF13_TEST_HARD_STOP_CORE_20260819,
    RSC_PERF17_TEST_SINGLETON_RESTART_POLICY_20260819,
    RSC_PERF20_TEST_AUTH_STATUS_LOGIC_20260819_,
    RSC_PERF21_TEST_QUOTA_SAFE_DB_TRANSPORT_20260819,
    RSC_PERF25_TEST_DB_CONTENTION_PARITY_20260819
  ];
  var totalPassed = 0, allFailed = [];
  for (var i = 0; i < subs.length; i++) {
    try {
      var r = subs[i]();
      totalPassed += r.passed;
      for (var f = 0; f < r.failed.length; f++) allFailed.push(r.title + ': ' + r.failed[f]);
      t.ok(r.title, r.ok);
    } catch (e) {
      allFailed.push('suite gagal dijalankan: ' + e);
      t.ok('suite ke-' + i, false, String(e));
    }
  }
  var res = t.finish('Total assertion lulus: ' + totalPassed +
    (allFailed.length ? ('\n\nDetail gagal:\n- ' + allFailed.join('\n- ')) : ''));
  res.totalPassed = totalPassed;
  res.allFailed = allFailed;
  return res;
}

/* =============================================================
 * 27. MENU
 * ============================================================= */

/**
 * Menu utama.
 *
 * PENTING: file .gs ini HARUS menjadi satu-satunya sumber. Bila file versi lama
 * masih ada di project yang sama, Apps Script gagal meng-compile seluruh project
 * karena identifier yang sama dideklarasikan dua kali
 * (`const ROLLING_SALES_CENTER_PARAMETERS` di file lama vs `var` di file ini),
 * dan akibatnya onOpen tidak pernah jalan sehingga MENU TIDAK MUNCUL sama sekali.
 * Hapus file lama, jangan hanya menambahkan file baru.
 */
function onOpen(e) {
  try {
    RSC_BUILD_MENU_20260820_();
  } catch (err) {
    // Menu utama gagal dibangun: pasang menu darurat supaya user tetap punya
    // jalan masuk, dan tampilkan penyebabnya.
    try {
      SpreadsheetApp.getUi()
        .createMenu(ROLLING_SALES_CENTER_PARAMETERS.menuName + ' (DARURAT)')
        .addItem('✅ Validate ACTIVE Sheet', 'RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814')
        .addItem('🚀 Validate ALL Links Kolom E', 'RSC_STANDARD_BULK_START_20260814')
        .addItem('🩺 Diagnose DB Access / Identity', 'RSC_PERF11_DIAGNOSE_DB_ACCESS_20260819')
        .addItem('❓ Kenapa menu tidak lengkap?', 'RSC_SHOW_MENU_BUILD_ERROR_20260820')
        .addToUi();
      rscSetProp_('RSC_MENU_BUILD_ERROR', String(err && err.message ? err.message : err));
    } catch (e2) { /* tidak ada UI (dipanggil dari editor / trigger) */ }
  }

  runSafelyWithOptionalRethrow_('Copy-aware open automation', function () {
    handleCopyAwareOpenAutomation_(e);
  }, false);

  runSafelyWithOptionalRethrow_('Simpan ID master', function () {
    rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, SpreadsheetApp.getActiveSpreadsheet().getId());
  }, false);
}

/** Tampilkan penyebab menu gagal dibangun. */
function RSC_SHOW_MENU_BUILD_ERROR_20260820() {
  var msg = rscGetProp_('RSC_MENU_BUILD_ERROR', '(tidak ada catatan)');
  return rscAlert_('Menu tidak lengkap',
    'Penyebab terakhir:\n' + msg + '\n\n' +
    'Penyebab paling sering: file .gs versi LAMA masih ada di project yang sama.\n' +
    'Apps Script menggabungkan semua file .gs ke satu scope, sehingga\n' +
    '`const ROLLING_SALES_CENTER_PARAMETERS` (file lama) bertabrakan dengan\n' +
    '`var ROLLING_SALES_CENTER_PARAMETERS` (file ini) dan seluruh project gagal\n' +
    'di-compile. Hapus file lama, sisakan satu file saja, lalu reload spreadsheet.');
}

/** Bangun menu lengkap. Dipisah supaya bisa dipanggil ulang dari editor. */
function RSC_BUILD_MENU_20260820_() {
  var ui = SpreadsheetApp.getUi();

  ui.createMenu(ROLLING_SALES_CENTER_PARAMETERS.menuName)
    .addItem('✅ 1. Validate ACTIVE Sheet — Standard V28', 'RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814')
    .addItem('🚀 2. Validate ALL Links Kolom E — Manifest', 'RSC_STANDARD_BULK_START_20260814')
    .addItem('⚡ 3. Run FULL Pipeline NOW — Validate → Compile → ST/RL', 'RSC_V28_FULL_PIPELINE_RUN_NOW_20260814')
    .addSeparator()
    .addSubMenu(ui.createMenu('📦 Validation Bulk — Control')
      .addItem('▶ Start / Resume Bulk Validation', 'RSC_STANDARD_BULK_START_20260814')
      .addItem('🔄 RESTART FROM TOP — Fresh Run', 'RSC_PERF17_RESTART_BULK_FROM_TOP_20260819')
      .addItem('🧯 Repair / Dedupe Worker Triggers', 'RSC_PERF17_REPAIR_TRIGGER_TOPOLOGY_20260819')
      .addItem('⚡ Kick / Recover Waiting Workers', 'RSC_PERF14_KICK_WAITING_WORKERS_20260819')
      .addItem('🩺 Diagnose Worker Queue', 'RSC_PERF14_DIAGNOSE_WORKER_QUEUE_20260819')
      .addItem('♻ Requeue Technical DB Failures', 'RSC_PERF23_REQUEUE_TECHNICAL_FAILURES_20260819')
      .addItem('🛠 Repair Current Manifest + Requeue', 'RSC_PERF23_REPAIR_CURRENT_MANIFEST_20260819')
      .addItem('🔍 Audit Link E = Active Validation', 'RSC_PERF15_AUDIT_LINK_E_ACTIVE_PARITY_20260819')
      .addItem('🔐 Diagnose Bulk DB Access / Identity', 'RSC_PERF15_DIAGNOSE_BULK_ACCESS_20260819')
      .addItem('📡 Open Live Job Logging', 'RSC_PERF16_OPEN_JOB_LOGGING_20260819')
      .addItem('🔄 Refresh Job Logging', 'RSC_PERF16_REFRESH_JOB_LOGGING_20260819')
      .addItem('🧹 Clear Job Log History', 'RSC_PERF16_CLEAR_JOB_LOG_HISTORY_20260819')
      .addItem('📊 Status Bulk Validation', 'RSC_STANDARD_BULK_STATUS_20260814')
      .addItem('🧾 Open Manifest', 'RSC_STANDARD_BULK_OPEN_MANIFEST_20260814')
      .addItem('⏹ STOP Bulk Validation', 'RSC_STANDARD_BULK_STOP_20260814'))
    .addSubMenu(ui.createMenu('📡 Job Logging Details')
      .addItem('📡 Open Live Dashboard', 'RSC_PERF16_OPEN_JOB_LOGGING_20260819')
      .addItem('🔄 Refresh Dashboard', 'RSC_PERF16_REFRESH_JOB_LOGGING_20260819')
      .addItem('🧹 Clear Event History', 'RSC_PERF16_CLEAR_JOB_LOG_HISTORY_20260819'))
    .addSubMenu(ui.createMenu('⏱ Automation 1 Hour — Full Pipeline')
      .addItem('✅ Install / Refresh AUTO 1 HOUR', 'RSC_V28_FULL_PIPELINE_INSTALL_HOURLY_20260814')
      .addItem('⚡ Run FULL Pipeline NOW', 'RSC_V28_FULL_PIPELINE_RUN_NOW_20260814')
      .addItem('📊 Full Pipeline Status', 'RSC_V28_FULL_PIPELINE_STATUS_20260814')
      .addItem('⏹ STOP Automation + Current Pipeline', 'RSC_V28_FULL_PIPELINE_STOP_20260814'))
    .addSubMenu(ui.createMenu('📤 Compile Upload Ready — Integrated')
      .addItem('▶ Main Compile — Start / Upsert ALL DONE', 'RSC_UR_START_20260721')
      .addItem('▶ Compile ST/RL — Dual Source', 'RSC_UR_START_ST_RL_20260727')
      .addSeparator()
      .addItem('📊 Main Compile Status', 'RSC_UR_STATUS_20260721')
      .addItem('📊 ST/RL Status', 'RSC_UR_STATUS_ST_RL_20260727')
      .addSeparator()
      .addItem('🧹 Cleanse + Merge Duplicate Output', 'RSC_UR_CLEANSE_DUPLICATE_OUTPUTS_20260724')
      .addItem('🔧 Repair Shifted Output Columns', 'RSC_UR_REPAIR_SHIFTED_OUTPUTS_20260724')
      .addItem('🧽 Cleanse Empty Space', 'RSC_UR_CLEANSE_SPACE_20260722')
      .addSeparator()
      .addItem('☢ PURGE ALL Compile Target Files', 'RSC_V28_PURGE_ALL_COMPILE_TARGETS_20260814'))
    .addSubMenu(ui.createMenu('🧱 Template Revamp')
      .addItem('▶ Start / Continue Template Revamp', 'RSC_RUN_TEMPLATE_REVAMP_INTEGRATED_20260723')
      .addItem('📊 Status Template Revamp', 'RSC_SHOW_TEMPLATE_REVAMP_STATUS_20260722')
      .addItem('⏹ STOP Template Revamp', 'RSC_STOP_TEMPLATE_REVAMP_JOB_20260722')
      .addItem('♻ Reset / Cleanup Template Revamp', 'RSC_RESET_TEMPLATE_REVAMP_JOB_20260722'))
    .addSubMenu(ui.createMenu('🧩 Template & Copy')
      .addItem('Setup / Refresh ALL Template', 'RSC_SETUP_ALL_TEMPLATES_20260611')
      .addItem('Setup Credit Limit only', 'RSC_SETUP_CREDIT_LIMIT_ONLY_20260611')
      .addItem('Setup CR Change Sheets only', 'RSC_SETUP_ROLLING_CHANGE_SHEETS_ONLY_20260611')
      .addItem('Setup Change Salesman Type only', 'RSC_SETUP_CHANGE_SALESMAN_TYPE_ONLY_20260611')
      .addSeparator()
      .addItem('▶ Start / Lanjut Copy FINAL', 'RSC_START_COPY_ROLLING_TEMPLATE_FILES_20260611')
      .addItem('📊 Status Copy FINAL', 'RSC_SHOW_COPY_AND_TEMPLATE_VALIDATION_STATUS_20260611')
      .addItem('⏹ STOP Copy FINAL', 'RSC_STOP_COPY_AND_TEMPLATE_VALIDATION_JOBS_20260611')
      .addItem('♻ Reset Checkpoint Copy', 'RSC_RESET_INTEGRATED_COPY_FINAL_20260716'))
    .addSubMenu(ui.createMenu('🛠 Utilities')
      .addItem('Generate / Refresh Summary - CR', 'RSC_GENERATE_CR_VISIT_SCHEDULE_SUMMARY_20260611')
      .addItem('Mark Exact Data With Current - BigQuery', 'RSC_MARK_EXACT_DATA_WITH_CURRENT_20260611')
      .addSeparator()
      .addItem('Fix G/L Reason Rolling — background', 'RSC_START_FIX_ROLLING_REASON_DATES_BG_20260611')
      .addItem('Replace Dates by m_bp_relation — background', 'RSC_START_VALIDATE_DATE_IN_TEMPLATE_20260619')
      .addItem('Fix / Validate Toko Bangkrut Date', 'RSC_START_TOKO_BANGKRUT_DATES_BY_DB_20260622'))
    .addSubMenu(ui.createMenu('🧪 Audit & Performance')
      .addItem('✅ Run FULL Safe Audit + Benchmark', 'RSC_PERF12_FULL_AUDIT_20260819')
      .addItem('🧪 Run SELF-TEST Menyeluruh', 'RSC_RUN_SELF_TEST_20260819')
      .addItem('🔌 Scope + Dependency Audit', 'RSC_PERF10_RUN_DEPENDENCY_AUDIT_20260819')
      .addItem('🗄 Live DB Read-Only Audit', 'RSC_PERF10_LIVE_DB_READONLY_AUDIT_20260819')
      .addItem('🔐 Diagnose DB Access / Identity', 'RSC_PERF11_DIAGNOSE_DB_ACCESS_20260819')
      .addItem('🔑 Authorize External DB + Bind Workers', 'RSC_PERF18_AUTHORIZE_AND_BIND_20260819')
      .addItem('🧭 Audit Child Link Access (Col E)', 'RSC_PERF18_AUDIT_CHILD_LINK_ACCESS_20260819')
      .addItem('🪪 Show Authorization Binding Status', 'RSC_PERF18_SHOW_AUTH_STATUS_20260819')
      .addItem('🧪 Test OAuth Exact-Status Logic', 'RSC_PERF20_TEST_AUTH_STATUS_LOGIC_20260819_')
      .addItem('🧩 Optional _rsc Lookup Status', 'RSC_PERF19_TEST_DB_ACCELERATOR_20260819')
      .addItem('🛡 Test Quota-Safe DB Transport', 'RSC_PERF21_TEST_QUOTA_SAFE_DB_TRANSPORT_20260819')
      .addItem('📡 Show PERF21 DB Transport Status', 'RSC_PERF21_SHOW_TRANSPORT_STATUS_20260819')
      .addItem('🧩 PERF22 Scope Completeness Audit', 'RSC_PERF22_SCOPE_AUDIT_20260819_')
      .addItem('🗄 PERF23 Test Direct Raw DB', 'RSC_PERF23_TEST_DIRECT_RAW_DB_20260819')
      .addItem('🩺 PERF24 Diagnose Run Guards', 'RSC_PERF24_DIAGNOSE_RUN_GUARDS_20260819')
      .addItem('🧪 PERF25 Test DB Contention + Parity', 'RSC_PERF25_TEST_DB_CONTENTION_PARITY_20260819')
      .addItem('🧹 Clear Fast DB Lookup Cache', 'RSC_PERF19_CLEAR_DB_CACHE_20260819')
      .addItem('🧪 Test Authorization Binding Core', 'RSC_PERF18_TEST_AUTH_BINDING_CORE_20260819_')
      .addSeparator()
      .addItem('🧠 Test Change Schedule Logic', 'RSC_PERF10_TEST_CHANGE_SCHEDULE_20260819')
      .addItem('📅 Test Rolling Valid From Policy', 'RSC_PERF11_TEST_ROLLING_VALID_FROM_POLICY_20260819')
      .addItem('🎨 Test Status Color + Auto Revamp Gate', 'RSC_PERF12_TEST_STATUS_AND_GATE_20260819')
      .addItem('📡 Test Job Logging Dashboard', 'RSC_PERF16_TEST_JOB_LOGGING_20260819')
      .addItem('🧭 Test Worker Singleton + Restart Policy', 'RSC_PERF17_TEST_SINGLETON_RESTART_POLICY_20260819')
      .addItem('🔁 Process Pending Rekap Auto Revamp', 'RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819')
      .addItem('☢ Test HARD STOP Core — Safe Simulation', 'RSC_PERF13_TEST_HARD_STOP_CORE_20260819')
      .addItem('🔤 Test Core Normalizer', 'RSC_PERF10_TEST_CORE_NORMALIZER_20260819')
      .addItem('🧱 Test m_bp_relation Core Parser', 'RSC_PERF10_TEST_MBP_CORE_PURE_20260819')
      .addItem('⚡ Test Cache + Bucketing Core', 'RSC_PERF10_TEST_CACHE_BUCKET_CORE_20260819')
      .addSeparator()
      .addItem('📊 Benchmark ACTIVE Rolling — Read Only', 'RSC_PERF10_BENCHMARK_ACTIVE_ROLLING_20260819')
      .addItem('🧪 Synthetic Performance Benchmark', 'RSC_PERF10_SYNTHETIC_BENCHMARK_20260819')
      .addItem('📈 Show PERF Telemetry', 'RSC_PERF10_SHOW_TELEMETRY_20260819')
      .addItem('🧾 Show Last Audit Summary', 'RSC_PERF10_SHOW_LAST_AUDIT_20260819'))
    .addSubMenu(ui.createMenu('⚙ Admin / Recovery')
      .addItem('Activate Jobs for This Copy', 'RSC_ACTIVATE_COPY_AWARE_AUTOMATION_20260611')
      .addItem('Hapus Semua Protection di File Ini', 'RSC_REMOVE_ALL_PROTECTIONS_CURRENT_FILE_20260612')
      .addItem('Aktifkan Auto Validasi Link Kolom D', 'RSC_INSTALL_AUTO_VALIDATION_FOR_INPUT_LINKS_20260611')
      .addSeparator()
      .addItem('Setup Recommended Basic Triggers', 'RSC_INSTALL_RECOMMENDED_TRIGGERS_20260611')
      .addItem('Show Status Semua Job', 'RSC_SHOW_ALL_BACKGROUND_JOB_STATUS_20260611')
      .addItem('STOP Semua Background Job', 'RSC_STOP_ALL_BACKGROUND_JOBS_20260611')
      .addItem('Reset Integrated Checkpoint', 'RSC_RESET_CHECKPOINTS_20260611')
      .addSeparator()
      .addItem('☢ HARD STOP ALL + HARD RESET', 'RSC_PERF13_HARD_STOP_ALL_20260819')
      .addItem('🟢 Re-Arm System after HARD STOP', 'RSC_PERF13_REARM_AFTER_HARD_STOP_20260819')
      .addItem('🛑 HARD STOP Status', 'RSC_PERF13_SHOW_HARD_STOP_STATUS_20260819')
      .addSeparator()
      .addItem('🔑 Authorize External DB + Bind Workers', 'RSC_PERF18_AUTHORIZE_AND_BIND_20260819')
      .addItem('🧭 Audit Child Link Access (Col E)', 'RSC_PERF18_AUDIT_CHILD_LINK_ACCESS_20260819')
      .addItem('🪪 Show Authorization Binding Status', 'RSC_PERF18_SHOW_AUTH_STATUS_20260819')
      .addItem('🧪 Test OAuth Exact-Status Logic', 'RSC_PERF20_TEST_AUTH_STATUS_LOGIC_20260819_')
      .addItem('🧩 Optional _rsc Lookup Status', 'RSC_PERF19_TEST_DB_ACCELERATOR_20260819')
      .addItem('🛡 Test Quota-Safe DB Transport', 'RSC_PERF21_TEST_QUOTA_SAFE_DB_TRANSPORT_20260819')
      .addItem('📡 Show PERF21 DB Transport Status', 'RSC_PERF21_SHOW_TRANSPORT_STATUS_20260819')
      .addItem('🧩 PERF22 Scope Completeness Audit', 'RSC_PERF22_SCOPE_AUDIT_20260819_')
      .addItem('🧹 Clear Fast DB Lookup Cache', 'RSC_PERF19_CLEAR_DB_CACHE_20260819'))
    .addToUi();
  return true;
}
