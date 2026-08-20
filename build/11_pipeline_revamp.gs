
/* =============================================================
 * 20. AUTO TEMPLATE REVAMP
 * -------------------------------------------------------------
 * Hanya file berstatus COMPLETE_OK yang di-revamp. Baris Change Schedule Only
 * ditulis sebagai visit-only (Relationship / Valid From / Valid To dikosongkan
 * dan kolom "Change Schedule Only" diberi tanda x), lalu baris duplikat persis
 * dibuang. Setelah itu dropdown dan format disegarkan.
 * ============================================================= */

function rscRevampFile_(fileId, masters) {
  var child = SpreadsheetApp.openById(fileId);
  var sh = rscChildRollingSheet_(child);
  if (!sh) return { skipped: 1, note: 'sheet Change Rolling tidak ada' };
  var spec = rscPrimarySpec_();
  var needCols = Math.max(spec.errorCol, spec.header.length);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { skipped: 1, note: 'tidak ada baris data' };

  var width = Math.max(needCols, sh.getLastColumn());
  var header = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  if (rscCheckLayout_(spec, header)) return { skipped: 1, note: 'layout belum sesuai FSD' };

  var csoCol = rscPickCol_(rscHeaderMap_(header), ['Change Schedule Only']);
  var values = sh.getRange(2, 1, lastRow - 1, width).getValues();
  var res = rscValidateValues_(spec, values, masters);

  var out = [], seen = {}, dropped = 0, marked = 0;
  for (var i = 0; i < res.ctx.rows.length; i++) {
    var row = res.ctx.rows[i];
    var raw = values[row.sheetRow - 2].slice(0, width);
    while (raw.length < width) raw.push('');

    if (row.cso && row.cso.yes) {
      raw[3] = '';                       // Relationship
      raw[6] = '';                       // Valid From
      raw[7] = '';                       // Valid To
      if (csoCol >= 0) raw[csoCol] = 'x';
      marked++;
    }
    var key = [];
    for (var c = 0; c < spec.header.length - 2; c++) key.push(rscText_(raw[c]));
    var sig = key.join('|');
    if (seen[sig]) { dropped++; continue; }
    seen[sig] = true;
    out.push(raw);
  }

  var blank = [];
  for (var b = 0; b < width; b++) blank.push('');
  var target = lastRow - 1;
  while (out.length < target) out.push(blank.slice());
  if (out.length) sh.getRange(2, 1, out.length, width).setValues(out);
  rscApplyTemplateDropdowns_(sh, spec, masters);

  return { updated: 1, marked: marked, dropped: dropped, rows: res.ctx.rows.length };
}

function rscRevampJob_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var R = RSC_TEMPLATE_REVAMP_20260722;
  var ss = rscActiveSs_();
  var started = Date.now();
  var runId = rscGetProp_(V.pRunId, '');

  var state = null;
  try { state = JSON.parse(rscGetProp_(R.pJob, '') || 'null'); } catch (e) { state = null; }
  if (!state) {
    state = { index: 0, files: [], processed: 0, marked: 0, dropped: 0, skipped: 0, failed: 0, startedAt: rscStamp_() };
    var vals = rscManifestRead_(rscManifestSheet_(ss));
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][RSC_M.RUN_ID] !== runId) continue;
      if (vals[i][RSC_M.STATUS] !== RSC_STATUS.DONE_OK) continue;
      if (vals[i][RSC_M.FILE_ID]) state.files.push(vals[i][RSC_M.FILE_ID]);
    }
  }

  if (!state.files.length) {
    rscSetProp_(R.pJob, '');
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'IDLE', stage: 'Tidak ada file COMPLETE_OK', progress: 1,
      message: 'Revamp hanya berjalan untuk file yang lolos validasi tanpa error.',
      startedAt: state.startedAt, runId: runId
    }, { force: true, history: true });
    return state;
  }

  var masters;
  try { masters = rscLoadMasters_(ss); }
  catch (e) {
    var c = rscClassify_(e);
    rscSetProp_(R.pJob, JSON.stringify(state));
    if (c.kind === RSC_ERR.INFRA) { rscArmRevamp_(); return state; }
    throw e;
  }

  // Hitung file per RUN, bukan modulo terhadap total kumulatif. Versi modulo
  // membuat putaran berikutnya langsung break sebelum memproses apa pun,
  // sehingga job tidak pernah maju.
  var doneThisRun = 0;
  while (state.index < state.files.length) {
    if ((Date.now() - started) > R.softDeadlineMs) break;
    if (doneThisRun >= R.hardMaxFilesPerRun) break;
    doneThisRun++;
    var fid = state.files[state.index];
    state.index++;
    state.processed++;
    try {
      var r = rscRevampFile_(fid, masters);
      state.marked += Number(r.marked || 0);
      state.dropped += Number(r.dropped || 0);
      state.skipped += Number(r.skipped || 0);
    } catch (err) { state.failed++; }
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'RUNNING', stage: 'Revamp template',
      progress: rscRound_(state.index / state.files.length, 4),
      currentTotal: state.index + ' / ' + state.files.length, fileId: fid,
      message: 'Schedule-only ditandai ' + state.marked + ', duplikat dibuang ' + state.dropped + '.',
      startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
    });
  }

  if (state.index < state.files.length) {
    rscSetProp_(R.pJob, JSON.stringify(state));
    rscArmRevamp_();
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'WAITING', stage: 'Lanjut di eksekusi berikutnya',
      progress: rscRound_(state.index / state.files.length, 4),
      currentTotal: state.index + ' / ' + state.files.length,
      message: 'Diproses ' + state.processed + ', gagal ' + state.failed + '.',
      startedAt: state.startedAt, runId: runId
    }, { force: true, history: true });
    return state;
  }

  rscSetProp_(R.pJob, '');
  rscSetProp_(R.pStats, JSON.stringify(state));
  rscDeleteTriggers_([R.handler]);
  rscJobLogSet_(ss, 'REVAMP', {
    job: 'AUTO TEMPLATE REVAMP', state: 'DONE', stage: 'Revamp selesai', progress: 1,
    currentTotal: state.index + ' / ' + state.files.length,
    message: 'File ' + state.processed + ', schedule-only ' + state.marked +
      ', duplikat dibuang ' + state.dropped + ', gagal ' + state.failed + '.',
    startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
  }, { force: true, history: true });
  return state;
}

function rscArmRevamp_() {
  var R = RSC_TEMPLATE_REVAMP_20260722;
  try {
    rscDeleteTriggers_([R.handler]);
    ScriptApp.newTrigger(R.handler).timeBased().after(R.triggerDelayMs).create();
    return true;
  } catch (e) { return false; }
}

function RSC_RUN_TEMPLATE_REVAMP_INTEGRATED_20260723() {
  var s = rscRevampJob_();
  rscAlert_('Template Revamp',
    'File diproses     : ' + s.processed +
    '\nSchedule-only     : ' + s.marked +
    '\nDuplikat dibuang  : ' + s.dropped +
    '\nDilewati          : ' + s.skipped +
    '\nGagal             : ' + s.failed +
    (s.index < s.files.length ? '\n\nBerlanjut otomatis di latar belakang.' : ''));
  return s;
}

function RSC_CONTINUE_TEMPLATE_REVAMP_INTEGRATED_20260723() { return rscRevampJob_(); }

/** Ringkasan yang terbaca manusia, bukan JSON mentah berisi ratusan file ID. */
function rscJobSummaryText_(raw, running) {
  if (!raw) return 'Belum pernah dijalankan.';
  var st = null;
  try { st = JSON.parse(raw); } catch (e) { return raw.substring(0, 800); }
  var total = (st.files && st.files.length) || st.total || 0;
  return (running ? 'Sedang berjalan.' : 'Tidak berjalan. Hasil terakhir:') +
    '\nMulai            : ' + (st.startedAt || '-') +
    '\nProgres          : ' + (st.index === undefined ? '-' : (st.index + ' / ' + total)) +
    '\nFile diproses    : ' + (st.processed === undefined ? '-' : st.processed) +
    (st.marked === undefined ? '' : ('\nSchedule-only    : ' + st.marked)) +
    (st.dropped === undefined ? '' : ('\nDuplikat dibuang : ' + st.dropped)) +
    (st.copied === undefined ? '' : ('\nDisalin          : ' + st.copied)) +
    (st.updated === undefined ? '' : ('\nSel diperbarui   : ' + st.updated)) +
    '\nDilewati         : ' + (st.skipped === undefined ? '-' : st.skipped) +
    '\nGagal            : ' + (st.failed === undefined ? '-' : st.failed);
}

function RSC_SHOW_TEMPLATE_REVAMP_STATUS_20260722() {
  var R = RSC_TEMPLATE_REVAMP_20260722;
  var running = rscGetProp_(R.pJob, '');
  var text = rscJobSummaryText_(running || rscGetProp_(R.pStats, ''), !!running);
  rscAlert_('Status Template Revamp', text);
  return text;
}

function RSC_STOP_TEMPLATE_REVAMP_JOB_20260722() {
  var R = RSC_TEMPLATE_REVAMP_20260722;
  var removed = rscDeleteTriggers_([R.handler]);
  rscAlert_('STOP Template Revamp', removed + ' trigger dilepas. Checkpoint tetap tersimpan.');
  return { removed: removed };
}

function RSC_RESET_TEMPLATE_REVAMP_JOB_20260722() {
  var R = RSC_TEMPLATE_REVAMP_20260722;
  rscSetProp_(R.pJob, '');
  rscSetProp_(R.pStats, '');
  rscDeleteTriggers_([R.handler]);
  rscAlert_('Reset Template Revamp', 'Checkpoint dan statistik revamp dihapus.');
  return true;
}

/** Gate otomatis setelah bulk validation selesai. */
/**
 * PERF26 §16 — Auto Revamp untuk ACTIVE sheet.
 * Hanya berjalan bila sheet yang divalidasi persis "Change Rolling & Change
 * Schedule" DAN hasil validasinya nol error. Selain itu tidak melakukan apa pun.
 */
function RSC_PERF12_AUTO_REVAMP_ACTIVE_AFTER_VALIDATION_20260819_(ss, spec, res) {
  var out = { ran: false, reason: '' };
  try {
    if (!spec || spec.key !== 'ROLLING') { out.reason = 'BUKAN_SHEET_ROLLING'; return out; }
    if (!res || res.errorRows > 0) { out.reason = 'MASIH_ADA_ERROR'; return out; }
    if (!res.rowCount) { out.reason = 'TIDAK_ADA_BARIS'; return out; }
    var R = RSC_TEMPLATE_REVAMP_20260722;
    if (R && R.autoAfterActiveValidation === false) { out.reason = 'DIMATIKAN_PARAMETER'; return out; }
    out.result = rscRevampFile_(ss.getId(), null);
    out.ran = true;
    out.reason = 'OK';
  } catch (e) {
    out.reason = 'GAGAL: ' + rscClassify_(e).message;
  }
  return out;
}

function RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);
  if (s.unfinished > 0) {
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'WAITING', stage: 'Menunggu validasi selesai',
      progress: s.progress, message: 'Masih ada ' + s.unfinished + ' task berjalan.',
      startedAt: rscStamp_(), runId: runId
    }, { force: true });
    return { started: false, unfinished: s.unfinished };
  }
  if (!s.ok) {
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'IDLE', stage: 'Tidak ada COMPLETE_OK', progress: 1,
      message: 'Tidak ada file yang lolos tanpa error.', startedAt: rscStamp_(), runId: runId
    }, { force: true });
    return { started: false, ok: 0 };
  }
  rscSetProp_(RSC_TEMPLATE_REVAMP_20260722.pJob, '');
  rscArmRevamp_();
  rscJobLogSet_(ss, 'REVAMP', {
    job: 'AUTO TEMPLATE REVAMP', state: 'START', stage: 'Start after bulk validation', progress: 0,
    message: 'Validation queue selesai. Menjalankan Auto Revamp untuk ' + s.ok + ' file COMPLETE_OK.',
    startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });
  return { started: true, files: s.ok };
}

/* =============================================================
 * 21. COPY TEMPLATE FINAL
 * ============================================================= */

function rscCopyJob_() {
  var P = RSC_TEMPLATE_COPY_20260611;
  var ss = rscActiveSs_();
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var started = Date.now();

  var state = null;
  try { state = JSON.parse(rscGetProp_(P.pJob, '') || 'null'); } catch (e) { state = null; }
  if (!state) state = { row: L.firstDataRow, copied: 0, skipped: 0, failed: 0, startedAt: rscStamp_() };

  var lastRow = master.getLastRow();
  var madeThisRun = 0;

  while (state.row <= lastRow) {
    if ((Date.now() - started) > P.softDeadlineMs) break;
    if (madeThisRun >= P.hardMaxCopiesPerRun) break;

    var row = state.row;
    state.row++;
    var finalLink = rscText_(master.getRange(row, L.finalColOverride || P.finalLinkCol).getDisplayValue());
    if (rscFileId_(finalLink)) { state.skipped++; continue; }

    var sourceLink = rscText_(master.getRange(row, P.sourceLinkCol).getDisplayValue());
    var sourceId = rscFileId_(sourceLink);
    if (!sourceId) { state.skipped++; continue; }

    var office = rscText_(master.getRange(row, L.officeCol).getDisplayValue());
    var desc = rscText_(master.getRange(row, L.descCol).getDisplayValue());
    madeThisRun++;
    try {
      var src = DriveApp.getFileById(sourceId);
      var name = 'Template Rolling Sales ' + (office ? (office + ' ') : '') + desc;
      var copy = src.makeCopy(name.substring(0, 200));
      try { copy.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT); }
      catch (eShare) { /* kebijakan domain bisa melarang */ }
      master.getRange(row, P.finalLinkCol)
        .setValue('https://docs.google.com/spreadsheets/d/' + copy.getId() + '/edit');
      state.copied++;
    } catch (err) {
      state.failed++;
      if (rscClassify_(err).kind === RSC_ERR.INFRA) state.row = row;
    }
    rscJobLogSet_(ss, 'SYSTEM', {
      job: 'COPY TEMPLATE FINAL', state: 'RUNNING', stage: 'Copy file',
      progress: rscRound_((row - L.firstDataRow + 1) / Math.max(1, lastRow - L.firstDataRow + 1), 4),
      currentTotal: state.copied + ' disalin',
      message: 'Baris ' + row + ' — ' + office + ' ' + desc,
      startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1)
    });
  }

  if (state.row <= lastRow) {
    rscSetProp_(P.pJob, JSON.stringify(state));
    try {
      rscDeleteTriggers_([P.handler]);
      ScriptApp.newTrigger(P.handler).timeBased().after(P.triggerDelayMs).create();
    } catch (e2) { /* best-effort */ }
  } else {
    rscSetProp_(P.pJob, '');
    rscSetProp_(P.pStats, JSON.stringify(state));
    rscDeleteTriggers_([P.handler]);
  }
  return state;
}

function RSC_START_COPY_ROLLING_TEMPLATE_FILES_20260611() {
  var s = rscCopyJob_();
  rscAlert_('Copy Template FINAL',
    'Disalin  : ' + s.copied + '\nDilewati : ' + s.skipped + '\nGagal    : ' + s.failed +
    '\n\nBaris yang kolom FINAL-nya sudah berisi link valid tidak disalin ulang.');
  return s;
}

function RSC_CONTINUE_COPY_ROLLING_TEMPLATE_FILES_20260611() { return rscCopyJob_(); }

function RSC_SHOW_COPY_AND_TEMPLATE_VALIDATION_STATUS_20260611() {
  var P = RSC_TEMPLATE_COPY_20260611;
  var running = rscGetProp_(P.pJob, '');
  var text = rscJobSummaryText_(running || rscGetProp_(P.pStats, ''), !!running);
  rscAlert_('Status Copy FINAL', text);
  return text;
}

function RSC_STOP_COPY_AND_TEMPLATE_VALIDATION_JOBS_20260611() {
  var removed = rscDeleteTriggers_([RSC_TEMPLATE_COPY_20260611.handler]);
  rscAlert_('STOP Copy FINAL', removed + ' trigger dilepas. Checkpoint tetap tersimpan.');
  return { removed: removed };
}

/* =============================================================
 * 22. FULL PIPELINE 1 JAM
 * -------------------------------------------------------------
 * Menggabungkan urutan yang sebelumnya harus diklik satu per satu:
 * Validate ALL Link E -> Auto Revamp -> Compile.
 * ============================================================= */

function RSC_V28_PIPELINE_SET_STATE_20260814_(phase, message) {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  rscSetProp_(P.pPhase, String(phase || P.phases.IDLE));
  rscSetProp_(P.pLastMessage, String(message || ''));
  writeRollingSalesCenterLog_('Full Pipeline | ' + phase + ' | ' + message);
}

function RSC_V28_FULL_PIPELINE_RUN_NOW_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(P.pMasterSsId, ss.getId());
  rscSetProp_(P.pCycleId, rscUuid_());
  rscSetProp_(P.pRunStartedAt, rscStamp_());

  if (RSC_IS_HARD_STOPPED_()) {
    RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.BLOCKED, 'HARD STOP aktif.');
    return rscAlert_('Full Pipeline', 'HARD STOP aktif. Jalankan Re-Arm terlebih dahulu.');
  }

  RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.VALIDATING, 'Menjalankan bulk validation.');
  var start = RSC_STANDARD_BULK_START_20260814();

  try {
    rscDeleteTriggers_([P.watchdogHandler]);
    ScriptApp.newTrigger(P.watchdogHandler).timeBased().after(P.watchdogDelayMs).create();
  } catch (e) { /* best-effort */ }

  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'FULL PIPELINE', state: 'START', stage: 'Validate -> Revamp -> Compile', progress: 0,
    message: 'Siklus penuh dimulai. Task antre: ' + (start.stats ? start.stats.tasks : 0) + '.',
    startedAt: rscStamp_(), runId: rscGetProp_(V.pRunId, '')
  }, { force: true, history: true });

  rscAlert_('Full Pipeline',
    'Siklus dimulai.\n\n1. Bulk validation seluruh Link E\n2. Auto template revamp (file COMPLETE_OK)\n' +
    '3. Compile upload ready\n\nProgres dapat dipantau di sheet Job Logging Details.');
  return start;
}

function RSC_V28_FULL_PIPELINE_WATCHDOG_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var phase = rscGetProp_(P.pPhase, P.phases.IDLE);
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);

  if (phase === P.phases.VALIDATING) {
    if (s.unfinished > 0) {
      try {
        rscDeleteTriggers_([P.watchdogHandler]);
        ScriptApp.newTrigger(P.watchdogHandler).timeBased().after(P.watchdogDelayMs).create();
      } catch (e) { /* best-effort */ }
      return { phase: phase, unfinished: s.unfinished };
    }
    RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.REVAMP, 'Validasi selesai, menjalankan revamp.');
    RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819();
    try {
      rscDeleteTriggers_([P.watchdogHandler]);
      ScriptApp.newTrigger(P.watchdogHandler).timeBased().after(P.watchdogDelayMs).create();
    } catch (e2) { /* best-effort */ }
    return { phase: P.phases.REVAMP };
  }

  if (phase === P.phases.REVAMP) {
    if (rscGetProp_(RSC_TEMPLATE_REVAMP_20260722.pJob, '')) {
      try {
        rscDeleteTriggers_([P.watchdogHandler]);
        ScriptApp.newTrigger(P.watchdogHandler).timeBased().after(P.watchdogDelayMs).create();
      } catch (e3) { /* best-effort */ }
      return { phase: phase, revampRunning: true };
    }
    RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.COMPILE_MAIN, 'Revamp selesai, menjalankan compile.');
    runSafelyWithOptionalRethrow_('compile main', RSC_UR_START_20260721, false);
    RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.DONE, 'Siklus selesai.');
    rscSetProp_(P.pLastFinishedAt, rscStamp_());
    rscDeleteTriggers_([P.watchdogHandler]);
    rscJobLogSet_(ss, 'SYSTEM', {
      job: 'FULL PIPELINE', state: 'DONE', stage: 'Siklus selesai', progress: 1,
      message: 'OK=' + s.ok + ', dengan error=' + s.withErrors + ', hard=' + s.hard + '.',
      startedAt: rscGetProp_(P.pRunStartedAt, ''), runId: runId
    }, { force: true, history: true });
    return { phase: P.phases.DONE, stats: s };
  }

  rscDeleteTriggers_([P.watchdogHandler]);
  return { phase: phase };
}

function RSC_V28_FULL_PIPELINE_HOURLY_HANDLER_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  if (rscGetProp_(P.pEnabled, '') !== '1') return { skipped: true };
  if (RSC_IS_HARD_STOPPED_()) return { skipped: true, reason: 'HARD_STOP' };
  return RSC_V28_FULL_PIPELINE_RUN_NOW_20260814();
}

function RSC_V28_FULL_PIPELINE_INSTALL_HOURLY_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  rscSetProp_(P.pEnabled, '1');
  try {
    rscDeleteTriggers_([P.hourlyHandler]);
    ScriptApp.newTrigger(P.hourlyHandler).timeBased().everyHours(P.everyHours).create();
  } catch (e) {
    return rscAlert_('Automation 1 Hour', 'Gagal memasang trigger: ' + e);
  }
  rscAlert_('Automation 1 Hour',
    'Full pipeline dijadwalkan tiap ' + P.everyHours + ' jam.\n' +
    'Urutan: Validate ALL Link E -> Auto Revamp -> Compile.');
  return true;
}

function RSC_V28_FULL_PIPELINE_STATUS_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);
  var text = 'Automation : ' + (rscGetProp_(P.pEnabled, '') === '1' ? 'AKTIF' : 'nonaktif') +
    '\nFase       : ' + rscGetProp_(P.pPhase, P.phases.IDLE) +
    '\nMulai      : ' + rscGetProp_(P.pRunStartedAt, '-') +
    '\nSelesai    : ' + rscGetProp_(P.pLastFinishedAt, '-') +
    '\nPesan      : ' + rscGetProp_(P.pLastMessage, '-') +
    '\n\n' + rscFormatStats_(runId, s);
  rscAlert_('Full Pipeline Status', text);
  return text;
}

function RSC_V28_FULL_PIPELINE_STOP_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  rscSetProp_(P.pEnabled, '');
  RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.STOPPED, 'Dihentikan manual.');
  var removed = rscDeleteTriggers_([P.hourlyHandler, P.watchdogHandler]);
  removed += rscDeleteTriggers_(rscAllHandlers_());
  removed += rscDeleteTriggers_([RSC_TEMPLATE_REVAMP_20260722.handler]);
  rscSetProp_(RSC_STANDARD_VALIDATION_V27_20260814.pRunState, 'STOPPED');
  rscAlert_('STOP Automation', removed + ' trigger dilepas. Automation dinonaktifkan.');
  return { removed: removed };
}
