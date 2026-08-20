
/* =============================================================
 * 11. PEMROSESAN FILE + ORKESTRATOR WORKER
 * ============================================================= */

/** Buka satu file anak, validasi semua sheet yang dikenali, tulis hasilnya. */
function rscProcessTask_(task, masters, onStage) {
  var t0 = Date.now(), tOpen = Date.now();
  var child;
  try {
    child = SpreadsheetApp.openById(task.fileId);
  } catch (e) {
    var c = rscClassify_(e);
    if (c.kind === RSC_ERR.INFRA) throw new RscInfraError('Gagal membuka file: ' + c.message);
    throw new RscAccessError('File tidak dapat dibuka / tidak ada akses: ' + c.message);
  }
  var openSec = rscRound_((Date.now() - tOpen) / 1000, 3);
  var fileName = '';
  try { fileName = child.getName(); } catch (e2) { fileName = task.name || task.fileId; }

  var sheets = child.getSheets();
  var processed = [], layoutProblems = [];
  var totalRows = 0, totalErrors = 0, totalCso = 0, totalUnverified = 0;
  var normSec = 0, rulesSec = 0, writeSec = 0;

  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var spec = rscSpecFor_(sh.getName());
    if (!spec) continue;

    if (onStage) {
      onStage({
        stage: 'Validate ' + spec.label, fileName: fileName, fileId: task.fileId,
        sheet: sh.getName(), message: 'Menjalankan engine validasi ' + ROLLING_SALES_CENTER_PARAMETERS.version + '.'
      });
    }

    var needCols = Math.max(spec.errorCol, spec.header.length);
    var width = Math.max(needCols, sh.getLastColumn() || needCols);
    var header = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
    var layoutErr = rscCheckLayout_(spec, header);
    if (layoutErr) { layoutProblems.push(sh.getName() + ' :: ' + layoutErr); continue; }

    rscEnsureResultHeaders_(sh, spec);
    var dataRows = Math.max(0, sh.getLastRow() - 1);

    // getValues (bukan getDisplayValues) supaya sel tanggal terbaca sebagai
    // objek Date. Format tampilan bergantung locale dan bisa membuat
    // 01/08/2026 terbaca sebagai 8 Januari.
    var values = dataRows ? sh.getRange(2, 1, dataRows, needCols).getValues() : [];

    var res = rscValidateValues_(spec, values, masters);
    normSec += res.timing.normalizeSec;
    rulesSec += res.timing.rulesSec;

    var tW = Date.now();
    rscWriteResults_(sh, spec, res, dataRows);
    rscApplyTemplateDropdowns_(sh, spec, masters);
    writeSec += rscRound_((Date.now() - tW) / 1000, 3);

    totalRows += res.rowCount;
    totalErrors += res.errorRows;
    totalCso += res.changeScheduleOnlyRows;
    totalUnverified += res.csoUnverifiedRows || 0;
    processed.push({
      sheet: sh.getName(), spec: spec.key, rows: res.rowCount, errorRows: res.errorRows,
      changeScheduleOnly: res.changeScheduleOnlyRows, csoUnverified: res.csoUnverifiedRows || 0,
      byCode: res.byCode, skipped: res.skipped
    });
  }

  if (!processed.length) {
    throw new RscDataError(layoutProblems.length
      ? layoutProblems.join(' || ')
      : 'Tidak ditemukan sheet yang dikenali (Change Rolling & Change Schedule / Change Sales Office / Change Salesman Type).');
  }

  return {
    fileName: fileName, rowCount: totalRows, errorRows: totalErrors, changeScheduleOnlyRows: totalCso,
    csoUnverifiedRows: totalUnverified,
    processed: processed, layoutProblems: layoutProblems,
    summary: JSON.stringify({ sheets: processed, layout: layoutProblems }).substring(0, 45000),
    openSec: openSec, masterSec: 0,
    normalizeSec: rscRound_(normSec, 3), rulesSec: rscRound_(rulesSec, 3),
    writeSec: rscRound_(writeSec, 3), totalSec: rscRound_((Date.now() - t0) / 1000, 3)
  };
}

/** Segarkan dropdown template sesuai master. Kosmetik; kegagalan diabaikan. */
function rscApplyTemplateDropdowns_(sheet, spec, masters) {
  if (spec.key !== 'ROLLING') return;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var lastRow = Math.min(
    Math.max(sheet.getLastRow() + V.dropdownHeadroomRows, 200),
    Math.max(sheet.getMaxRows(), 2));
  var n = lastRow - 1;
  if (n < 1) return;

  function listRule(items, help) {
    return SpreadsheetApp.newDataValidation()
      .requireValueInList(items, true).setAllowInvalid(true).setHelpText(help).build();
  }
  try {
    var offices = [];
    if (masters.office && masters.office.available) {
      for (var code in masters.office.map) {
        if (!Object.prototype.hasOwnProperty.call(masters.office.map, code)) continue;
        var o = masters.office.map[code];
        offices.push(o.desc ? (code + ' - ' + o.desc) : code);
      }
      offices.sort();
    }
    if (offices.length) {
      var offRule = listRule(offices, 'Pilih Sales Office dari master em. ID-only juga diterima.');
      sheet.getRange(2, 1, n, 1).setDataValidation(offRule);
      sheet.getRange(2, 2, n, 1).setDataValidation(offRule);
    }
    sheet.getRange(2, 4, n, 1).setDataValidation(
      listRule(RELATIONSHIP_OPTIONS.slice(), 'Pilih Relationship. ID-only juga diterima setelah normalisasi.'));
    sheet.getRange(2, 9, n, 1).setDataValidation(
      listRule(VISIT_CATEGORY_OPTIONS.slice(), 'Visit Category hanya F1, F2, F4, atau F8.'));
    sheet.getRange(2, 10, n, 1).setDataValidation(
      listRule(VISIT_TYPE_OPTIONS.slice(), 'Visit Type hanya 01 sampai 12. Gunakan format 2 digit.'));
    sheet.getRange(2, 14, n, 1).setDataValidation(
      listRule(REASON_OPTIONS.slice(), 'Reason hanya Rolling atau Toko Bangkrut.'));
  } catch (e) { /* dropdown kosmetik */ }
}

/** Muat master sekali per lane, bukan per file. */
function rscLoadMastersForRun_(ss) { return rscLoadMasters_(ss); }

/* ------------------------------ WORKER ------------------------------- */

function rscRunLane_(lane) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var started = Date.now();
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var slot = 'WORKER_' + lane;
  var startedStamp = rscStamp_(new Date(started));

  if (RSC_IS_HARD_STOPPED_()) {
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'STOPPED', stage: 'HARD STOP aktif', progress: 1,
      message: 'Sistem dalam kondisi HARD STOP. Jalankan Re-Arm untuk melanjutkan.',
      startedAt: startedStamp, lane: 'Lane ' + lane, runId: runId
    }, { force: true });
    return { lane: lane, claimed: 0, committed: 0, reason: 'HARD_STOP' };
  }

  if (!runId || rscGetProp_(V.pRunState, '') !== 'RUNNING') {
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'IDLE', stage: 'No active run', progress: 1,
      message: 'Tidak ada run aktif.', startedAt: startedStamp, elapsedSec: 0, lane: 'Lane ' + lane
    }, { force: true });
    return { lane: lane, claimed: 0, committed: 0, reason: 'NO_ACTIVE_RUN' };
  }

  rscJobLogSet_(ss, slot, {
    job: 'VALIDATE LINK E', state: 'START', stage: 'Worker bootstrap', progress: 0.01,
    message: 'Worker lane ' + lane + ' mulai.', startedAt: startedStamp, elapsedSec: 0,
    lane: 'Lane ' + lane, runId: runId
  }, { force: true, history: true });

  var claimed;
  try {
    claimed = rscClaimBatch_(ss, runId, slot, V.claimBatchSize);
  } catch (eClaim) {
    var cc = rscClassify_(eClaim);
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'WAITING', stage: 'Claim ditunda', progress: 0.02,
      message: 'Antrean sedang dikunci lane lain. Dijadwalkan ulang tanpa penalti.',
      lastError: '[' + cc.kind + '] ' + cc.message,
      startedAt: startedStamp, lane: 'Lane ' + lane, runId: runId
    }, { force: true });
    rscArmLane_(lane, rscBackoffMs_(1));
    return { lane: lane, claimed: 0, committed: 0, reason: 'CLAIM_' + cc.kind };
  }

  if (!claimed.length) {
    var st0 = rscQueueStats_(ss, runId);
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'IDLE', stage: 'No claimable task', progress: 1,
      currentTotal: '0 / 0', message: 'Antrean kosong atau semua task sedang ditunda.',
      startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
      lane: 'Lane ' + lane, runId: runId
    }, { force: true });
    rscJobLogSummary_(ss, runId, st0);
    if (st0.unfinished > 0) {
      var waitMs = rscEarliestEligibleMs_(ss, runId);
      if (waitMs < 0) waitMs = V.workerIdleRetryDelayMs;
      rscArmLane_(lane, Math.min(Math.max(waitMs + 1000, 5000), 300000));
    } else {
      rscFinishRunIfDone_(ss, runId, st0);
    }
    return { lane: lane, claimed: 0, committed: 0, reason: 'EMPTY' };
  }

  var masters = null, committed = 0;
  try {
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'RUNNING', stage: 'Prefetch shared master', progress: 0.1,
      currentTotal: '0 / ' + claimed.length,
      message: 'Bundle ' + claimed.length + ' file di-claim. Memuat index master sekali untuk seluruh bundle.',
      startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
      lane: 'Lane ' + lane, runId: runId
    });
    masters = rscLoadMastersForRun_(ss);
  } catch (e) {
    var cls = rscClassify_(e);
    if (cls.kind === RSC_ERR.INFRA) {
      for (var d = 0; d < claimed.length; d++) rscDeferTask_(ss, claimed[d], cls.message);
      rscJobLogSet_(ss, slot, {
        job: 'VALIDATE LINK E', state: 'WAITING', stage: 'Bundle deferred (infra)', progress: 0.12,
        currentTotal: '0 / ' + claimed.length,
        message: claimed.length + ' task dikembalikan ke antrean tanpa menambah Attempts.',
        lastError: '[INFRA] ' + cls.message,
        startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
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
    if ((Date.now() - started) > V.workerSoftDeadlineMs) {
      for (var rel = i; rel < claimed.length; rel++) {
        rscReleaseTask_(ss, claimed[rel], 'Dilepas karena batas waktu eksekusi lane; tanpa penalti.');
      }
      break;
    }

    var pct = 0.1 + 0.8 * (i / claimed.length);
    var stage = {
      job: 'VALIDATE LINK E', state: 'RUNNING', stage: 'Validate Change Rolling',
      progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
      fileName: task.name, fileId: task.fileId,
      startedAt: startedStamp, lane: 'Lane ' + lane, runId: runId
    };
    rscJobLogSet_(ss, slot, stage);

    try {
      var res = rscProcessTask_(task, masters, function (st) {
        stage.stage = st.stage;
        stage.fileName = st.fileName;
        stage.sheet = st.sheet;
        stage.message = st.message;
        stage.elapsedSec = rscRound_((Date.now() - started) / 1000, 1);
        rscJobLogSet_(ss, slot, stage);
      });
      var ok = rscRetry_('commit', 3, function () { return rscCommitOk_(ss, task, res); });
      if (ok && ok.applied) {
        committed++;
        results.push({
          fileId: task.fileId, rows: res.rowCount, errorRows: res.errorRows,
          status: res.errorRows ? RSC_STATUS.DONE_ERRORS : RSC_STATUS.DONE_OK
        });
      } else {
        results.push({ fileId: task.fileId, status: 'DISCARDED', reason: (ok && ok.reason) || 'CAS_FAILED' });
      }
    } catch (err) {
      var c2 = rscClassify_(err);
      if (c2.kind === RSC_ERR.INFRA) {
        rscDeferTask_(ss, task, c2.message);
        results.push({ fileId: task.fileId, status: 'DEFERRED', kind: c2.kind });
        rscJobLogSet_(ss, slot, {
          job: 'VALIDATE LINK E', state: 'WAITING', stage: 'DB contention deferred',
          progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
          fileName: task.name, fileId: task.fileId,
          message: 'Task dikembalikan ke antrean tanpa menambah Attempts.',
          lastError: '[INFRA] ' + c2.message,
          startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
          lane: 'Lane ' + lane, runId: runId
        }, { force: true, history: true });
      } else {
        rscFailTask_(ss, task, c2.message, c2.kind);
        results.push({ fileId: task.fileId, status: 'FAILED', kind: c2.kind });
        rscJobLogSet_(ss, slot, {
          job: 'VALIDATE LINK E', state: 'ERROR', stage: 'File validation failed',
          progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
          fileName: task.name, fileId: task.fileId,
          message: 'Task gagal pada attempt ' + (Number(task.attempts || 0) + 1) + '.',
          lastError: '[' + c2.kind + '] ' + c2.message,
          startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
          lane: 'Lane ' + lane, runId: runId
        }, { force: true, history: true });
      }
    }
  }

  var stats = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, stats);
  rscJobLogSet_(ss, slot, {
    job: 'VALIDATE LINK E', state: stats.unfinished ? 'WAITING' : 'DONE',
    stage: stats.unfinished ? 'Bundle done — queue remains' : 'Bundle done — queue empty',
    progress: 1, currentTotal: committed + ' / ' + claimed.length,
    message: 'Claimed=' + claimed.length + ', committed=' + committed +
      ', elapsed=' + rscRound_((Date.now() - started) / 1000, 1) + 's.',
    startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
    lane: 'Lane ' + lane, runId: runId
  }, { force: true, history: true });

  if (stats.unfinished > 0) rscArmLane_(lane, V.workerDelayMs);
  else rscFinishRunIfDone_(ss, runId, stats);

  return { lane: lane, claimed: claimed.length, committed: committed, results: results, stats: stats };
}

/* --------------------------- TRIGGER HELPER --------------------------- */

function rscDeleteTriggers_(handlers) {
  var removed = 0;
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      if (handlers.indexOf(all[i].getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(all[i]); removed++; }
    }
  } catch (e) { /* best-effort */ }
  return removed;
}

function rscArmLane_(lane, delayMs) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var fn = V.workerHandlers[lane - 1];
  try {
    rscDeleteTriggers_([fn]);
    ScriptApp.newTrigger(fn).timeBased().after(Math.max(1000, delayMs || V.workerDelayMs)).create();
    return true;
  } catch (e) { return false; }
}

function rscArmAllLanes_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var armed = 0;
  for (var l = 1; l <= V.workerCount; l++) if (rscArmLane_(l, V.workerDelayMs * l)) armed++;
  return armed;
}

function rscArmWatchdog_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  try {
    rscDeleteTriggers_([V.watchdogHandler]);
    ScriptApp.newTrigger(V.watchdogHandler).timeBased().everyMinutes(V.watchdogMinutes).create();
    return true;
  } catch (e) { return false; }
}

function rscArmPrewarm_(delayMs) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  try {
    rscDeleteTriggers_([V.prewarmHandler]);
    ScriptApp.newTrigger(V.prewarmHandler).timeBased().after(Math.max(1000, delayMs || V.workerDelayMs)).create();
    return true;
  } catch (e) { return false; }
}

function rscAllHandlers_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  return V.workerHandlers.concat([V.watchdogHandler, V.prewarmHandler]);
}

function rscFinishRunIfDone_(ss, runId, stats) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  if (stats.unfinished > 0) return false;
  rscSetProp_(V.pRunState, 'DONE');
  rscSetProp_(V.pFinishedAt, rscStamp_());
  rscSetProp_(V.pLastStatus, JSON.stringify(stats));
  rscDeleteTriggers_(V.workerHandlers.concat([V.prewarmHandler]));
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'DONE', stage: 'Queue selesai', progress: 1,
    currentTotal: stats.done + ' / ' + stats.total,
    message: 'OK=' + stats.ok + ', dengan error=' + stats.withErrors + ', hard=' + stats.hard +
      ', blocked=' + stats.blocked + ', skipped=' + stats.skipped + '.',
    startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });
  runSafelyWithOptionalRethrow_('Write back rekap', function () { rscWriteBackRekapStatus_(ss, runId); }, false);
  runSafelyWithOptionalRethrow_('Auto revamp gate', function () { RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819(); }, false);
  return true;
}

/** Tulis ringkasan hasil ke kolom Feedback pada sheet rekap. */
function rscWriteBackRekapStatus_(ss, runId) {
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var pending = {}, maxRow = L.firstDataRow, updates = 0;

  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    var rows;
    try { rows = JSON.parse(vals[i][RSC_M.MASTER_ROWS] || '[]'); } catch (e) { rows = []; }
    var st = vals[i][RSC_M.STATUS], txt;
    var unverified = 0;
    try {
      var sum = JSON.parse(vals[i][RSC_M.SHEET_SUMMARY] || '{}');
      var shts = sum.sheets || [];
      for (var u = 0; u < shts.length; u++) unverified += Number(shts[u].csoUnverified || 0);
    } catch (eU) { unverified = 0; }
    var warn = unverified
      ? (' [' + unverified + ' baris Change Schedule Only belum terverifikasi: master m_bp_relation tidak terbaca]')
      : '';
    if (st === RSC_STATUS.DONE_OK) txt = 'VALIDASI OK (0 error) — ' + rscStamp_() + warn;
    else if (st === RSC_STATUS.DONE_ERRORS) txt = 'PERLU REVISI: ' + vals[i][RSC_M.ERROR_ROWS] + ' baris error.' + warn;
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

  var n = maxRow - L.firstDataRow + 1;
  var col = master.getRange(L.firstDataRow, L.feedbackCol, n, 1).getDisplayValues();
  for (var k = 0; k < n; k++) {
    var v = pending[L.firstDataRow + k];
    col[k] = [v === undefined ? col[k][0] : v];
  }
  master.getRange(L.firstDataRow, L.feedbackCol, n, 1).setValues(col);
  var paint = [];
  for (var c2 = 0; c2 < n; c2++) paint.push(col[c2][0]);
  RSC_UI_PAINT_STATUS_COLUMN_20260820_(master, L.firstDataRow, L.feedbackCol, paint, 1);
  return updates;
}
