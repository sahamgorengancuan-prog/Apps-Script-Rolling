
/* =============================================================
 * 12. API PUBLIK — VALIDASI (nama function dipertahankan)
 * ============================================================= */

/** Menu 1 — Validate ACTIVE Sheet. Engine yang sama dengan bulk. */
function RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814() {
  var ss = rscActiveSs_();
  var sh = ss.getActiveSheet();
  var spec = rscSpecFor_(sh.getName());
  if (!spec) {
    return rscAlert_('Validasi ACTIVE Sheet',
      'Sheet "' + sh.getName() + '" bukan sheet yang divalidasi.\n\nSheet yang dikenali:\n' +
      '- Change Rolling & Change Schedule\n- Change Sales Office\n- Change Salesman Type');
  }

  var masters;
  try {
    masters = rscLoadMasters_(ss);
  } catch (e) {
    var c = rscClassify_(e);
    return rscAlert_('Validasi ACTIVE Sheet', c.kind === RSC_ERR.INFRA
      ? 'Index master sedang dibangun execution lain. Coba lagi beberapa saat.'
      : ('Gagal memuat master: ' + c.message));
  }

  var needCols = Math.max(spec.errorCol, spec.header.length);
  var width = Math.max(needCols, sh.getLastColumn() || needCols);
  var header = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  var layoutErr = rscCheckLayout_(spec, header);
  if (layoutErr) return rscAlert_('Layout tidak sesuai', layoutErr);

  rscEnsureResultHeaders_(sh, spec);
  var dataRows = Math.max(0, rscLastDataRow_(sh, spec) - 1);
  var values = dataRows ? rscReadValuesChunked_(sh, 2, 1, dataRows, needCols) : [];
  var res = rscValidateValues_(spec, values, masters);
  rscWriteResults_(sh, spec, res, dataRows);
  rscApplyTemplateDropdowns_(sh, spec, masters);

  var codes = [];
  for (var k in res.byCode) {
    if (Object.prototype.hasOwnProperty.call(res.byCode, k)) codes.push(k + '=' + res.byCode[k]);
  }
  // PERF26 §16: Auto Revamp hanya jalan untuk sheet Rolling yang nol error.
  var auto = RSC_PERF12_AUTO_REVAMP_ACTIVE_AFTER_VALIDATION_20260819_(ss, spec, res);

  var notes = (masters.notes || []).join('\n');
  rscAlert_('Validasi selesai — ' + spec.label,
    'Baris     : ' + res.rowCount + '\n' +
    'Error     : ' + res.errorRows + '\n' +
    'Sched only: ' + res.changeScheduleOnlyRows + '\n' +
    (res.csoUnverifiedRows
      ? ('BELUM PASTI: ' + res.csoUnverifiedRows + ' baris berpola Change Schedule Only tidak dapat ' +
         'diverifikasi karena master m_bp_relation tidak terbaca.\n')
      : '') +
    'Dibetulkan: ' + res.mutatedRows + ' baris (auto-replace master/tanggal)\n' +
    (codes.length ? ('Rincian   : ' + codes.join(', ') + '\n') : '') +
    (auto.ran ? 'Auto Revamp: dijalankan karena 0 error.\n' : '') +
    (notes ? ('\nCatatan master:\n' + notes) : ''));
  return {
    rows: res.rowCount, errorRows: res.errorRows, mutatedRows: res.mutatedRows,
    byCode: res.byCode, notes: masters.notes, autoRevamp: auto
  };
}

/** Menu 2 — Start / Resume Bulk Validation seluruh link kolom E. */
function RSC_STANDARD_BULK_START_20260814() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();

  if (RSC_IS_HARD_STOPPED_()) {
    return rscAlert_('Bulk Validation', 'Sistem dalam kondisi HARD STOP.\n' +
      'Jalankan Admin / Recovery -> Re-Arm System after HARD STOP terlebih dahulu.');
  }

  rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, ss.getId());
  rscSetProp_(V.pMasterSsId, ss.getId());
  rscSetProp_(V.pBlocked, '');
  rscSetProp_(V.pStop, '');

  // Resume: kalau masih ada run berjalan dengan sisa antrean, jangan bangun ulang.
  var existingRun = rscGetProp_(V.pRunId, '');
  if (existingRun && rscGetProp_(V.pRunState, '') === 'RUNNING') {
    var cur = rscQueueStats_(ss, existingRun);
    if (cur.unfinished > 0) {
      rscArmPrewarm_(V.workerDelayMs);
      rscArmWatchdog_();
      rscAlert_('Bulk Validation', 'Melanjutkan run yang masih berjalan.\n\n' + rscFormatStats_(existingRun, cur));
      return { runId: existingRun, resumed: true, stats: cur };
    }
  }

  var runId = V.version + '|' + rscUuid_();
  rscSetProp_(V.pRunId, runId);
  rscSetProp_(V.pRunState, 'BUILDING');
  rscSetProp_(V.pStartedAt, rscStamp_());
  rscSetProp_(V.pFinishedAt, '');
  rscSetProp_(V.pOwner, rscWhoAmI_());

  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'START', stage: 'Build manifest', progress: 0,
    message: 'Membuat manifest dan queue Link E.', startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });

  var stats = rscBuildManifest_(ss, runId);
  rscSetProp_(V.pRunState, 'RUNNING');

  var qs = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, qs);
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'QUEUED', stage: 'Manifest ready', progress: 0,
    currentTotal: '0 / ' + stats.total,
    message: 'Queue siap dari sheet "' + stats.sheet + '". Link=' + stats.links + ', valid=' + stats.valid +
      ', skipped=' + stats.skipped + ', task unik=' + stats.tasks + '.',
    startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });

  // Index dibangun lebih dulu di execution tersendiri; lane dinyalakan olehnya.
  var prewarmed = rscArmPrewarm_(V.workerDelayMs);
  var armed = prewarmed ? 0 : rscArmAllLanes_();
  rscArmWatchdog_();

  rscJobLogSet_(ss, 'WATCHDOG', {
    job: 'BULK WATCHDOG', state: 'WAITING',
    stage: prewarmed ? 'Menunggu index prewarm' : 'Workers armed', progress: 1,
    message: prewarmed
      ? 'Index master dibangun lebih dulu, lane dinyalakan setelahnya.'
      : (armed + ' worker lane dijadwalkan.'),
    startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });

  rscToast_('Bulk validation dimulai. ' + stats.tasks + ' file masuk antrean.');
  return { runId: runId, stats: stats, armed: armed, prewarm: prewarmed };
}

/** Menu — RESTART FROM TOP. */
function RSC_PERF17_RESTART_BULK_FROM_TOP_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(V.pRunState, 'STOPPED');
  rscDeleteTriggers_(rscAllHandlers_());
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'START', stage: 'Restart From Top', progress: 0,
    message: 'Run lama di-invalidasi. Manifest akan dibangun ulang dari baris pertama.',
    startedAt: rscStamp_()
  }, { force: true, history: true });
  rscSetProp_(V.pRunId, '');
  return RSC_STANDARD_BULK_START_20260814();
}

/** Menu — STOP Bulk Validation. */
function RSC_STANDARD_BULK_STOP_20260814() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(V.pRunState, 'STOPPED');
  rscSetProp_(V.pStop, '1');
  var removed = rscDeleteTriggers_(rscAllHandlers_());
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'STOPPED', stage: 'Run dihentikan', progress: 1,
    message: removed + ' trigger worker/watchdog/prewarm dilepas.', startedAt: rscStamp_()
  }, { force: true, history: true });
  rscAlert_('Bulk Validation', 'Run dihentikan. ' + removed + ' trigger dilepas.\n' +
    'Antrean tetap tersimpan; jalankan Start / Resume untuk melanjutkan.');
  return { stopped: true, triggersRemoved: removed };
}

function rscFormatStats_(runId, s) {
  return 'Run ID : ' + (runId || '-') +
    '\nTotal  : ' + s.total +
    '\nQUEUED ' + s.queued + ' | ACTIVE ' + s.active + ' | RETRY ' + s.retry + ' | DEFERRED ' + s.deferred +
    '\nCOMPLETE_OK ' + s.ok + ' | WITH_ERRORS ' + s.withErrors +
    '\nHARD_ERROR ' + s.hard + ' | BLOCKED_INFRA ' + s.blocked + ' | SKIPPED ' + s.skipped +
    '\nBaris error total: ' + s.errorRows +
    '\nProgress: ' + Math.round(s.progress * 100) + '%';
}

/** Menu — Status Bulk Validation. */
function RSC_STANDARD_BULK_STATUS_20260814() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, s);
  var extra = '\nState  : ' + rscGetProp_(V.pRunState, '-') +
    '\nMulai  : ' + rscGetProp_(V.pStartedAt, '-') +
    '\nSelesai: ' + rscGetProp_(V.pFinishedAt, '-');
  rscAlert_('Status Bulk Validation', rscFormatStats_(runId, s) + extra);
  return s;
}

/** Menu — Open Manifest. */
function RSC_STANDARD_BULK_OPEN_MANIFEST_20260814() {
  var ss = rscActiveSs_();
  var sh = rscManifestSheet_(ss);
  try { sh.showSheet(); ss.setActiveSheet(sh); } catch (e) { /* tanpa UI */ }
  return sh.getName();
}

/* ------------------------- HANDLER TRIGGER ------------------------- */

function RSC_STANDARD_BULK_WORKER_1_20260814() { return rscRunLane_(1); }
function RSC_STANDARD_BULK_WORKER_2_20260814() { return rscRunLane_(2); }
function RSC_STANDARD_BULK_WORKER_3_20260814() { return rscRunLane_(3); }
function RSC_STANDARD_BULK_WORKER_4_20260814() { return rscRunLane_(4); }

/**
 * Pemanasan index — perbaikan [F7].
 * Dijalankan di execution tersendiri sebelum lane menyala, supaya kuota 6 menit
 * worker tidak habis hanya untuk memindai tabel besar seperti m_bp_relation.
 */
function RSC_PERF19_PREWARM_DB_INDEXES_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var started = Date.now();
  var startedStamp = rscStamp_(new Date(started));

  if (!rscDbSources_().length) {
    rscJobLogSet_(ss, 'SYSTEM', {
      job: 'INDEX PREWARM', state: 'IDLE', stage: 'DB tidak dikonfigurasi', progress: 1,
      message: 'RSC_DB_PARAMETERS.spreadsheetId kosong. Rule berbasis DB dilewati.',
      startedAt: startedStamp, runId: runId
    }, { force: true, history: true });
    rscArmAllLanes_();
    return { ok: true, reason: 'NO_DB' };
  }

  var tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  var report = [], pending = [];

  for (var i = 0; i < tables.length; i++) {
    if ((Date.now() - started) > V.workerSoftDeadlineMs) { pending = tables.slice(i); break; }
    rscJobLogSet_(ss, 'SYSTEM', {
      job: 'INDEX PREWARM', state: 'RUNNING', stage: 'Build index ' + tables[i],
      progress: rscRound_(i / tables.length, 4), currentTotal: (i + 1) + ' / ' + tables.length,
      message: 'Membangun index master sekali untuk seluruh run.',
      startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
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

  if (pending.length) rscArmPrewarm_(V.workerDelayMs);

  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'INDEX PREWARM', state: pending.length ? 'WAITING' : 'DONE',
    stage: pending.length ? 'Index sebagian siap' : 'Index siap', progress: 1,
    message: report.join(' | ') + (pending.length ? (' | tersisa: ' + pending.join(',')) : ''),
    startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
  }, { force: true, history: true });

  rscArmAllLanes_();
  return { ok: true, report: report, pending: pending };
}

/**
 * Watchdog — perbaikan [F5].
 * Otorisasi diperiksa SEKALI. Bila binding tidak cocok, status BLOCKED ditulis
 * satu kali lalu trigger watchdog dilepas, tidak looping tiap beberapa menit.
 */
function RSC_STANDARD_BULK_WATCHDOG_20260814() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var state = rscGetProp_(V.pRunState, '');

  if (RSC_IS_HARD_STOPPED_() || state !== 'RUNNING') {
    rscDeleteTriggers_([V.watchdogHandler]);
    rscJobLogSet_(ss, 'WATCHDOG', {
      job: 'BULK WATCHDOG', state: 'IDLE', stage: 'No active run', progress: 1,
      message: 'Tidak ada run aktif. Watchdog dilepas.', startedAt: rscStamp_(), runId: runId
    }, { force: true });
    return { ok: true, reason: 'NO_RUN' };
  }

  var owner = rscGetProp_(V.pOwner, '');
  var me = rscWhoAmI_();
  if (owner && me && me !== 'unknown' && owner !== me) {
    var reason = 'Trigger dijalankan sebagai ' + me + ', sedangkan run dimiliki ' + owner +
      '. Jalankan Admin / Recovery -> Authorize External DB + Bind Workers memakai akun pemilik.';
    rscSetProp_(V.pBlocked, reason);
    rscDeleteTriggers_([V.watchdogHandler]);
    rscJobLogSet_(ss, 'WATCHDOG', {
      job: 'BULK WATCHDOG', state: 'BLOCKED', stage: 'Authorization binding mismatch', progress: 1,
      message: 'Watchdog dihentikan sekali, tidak diulang.', lastError: '[AUTH] ' + reason,
      startedAt: rscStamp_(), runId: runId
    }, { force: true, history: true });
    return { ok: false, reason: 'AUTH_MISMATCH' };
  }

  var stats = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, stats);
  if (stats.unfinished === 0) {
    rscFinishRunIfDone_(ss, runId, stats);
    rscDeleteTriggers_([V.watchdogHandler]);
    return { ok: true, reason: 'DONE', stats: stats };
  }

  var revived = 0;
  try {
    var sh = rscJobLogSheet_(ss);
    var J = RSC_PERF16_JOBLOG_20260819;
    var firstWorker = J.liveSlots.indexOf('WORKER_1');
    var rows = sh.getRange(J.liveStartRow + firstWorker, 1, V.workerCount, J.columns.length).getDisplayValues();
    for (var l = 0; l < V.workerCount; l++) {
      var hb = Date.parse(String(rows[l][13] || '').replace(' ', 'T'));
      var stale = !isFinite(hb) || (Date.now() - hb) > V.heartbeatStaleMs;
      if (stale && rscArmLane_(l + 1, 2000 + l * 1500)) revived++;
    }
  } catch (e) { /* best-effort */ }

  rscJobLogSet_(ss, 'WATCHDOG', {
    job: 'BULK WATCHDOG', state: 'RUNNING', stage: 'Health check', progress: stats.progress,
    currentTotal: stats.done + ' / ' + stats.total,
    message: 'Unfinished=' + stats.unfinished + ', lane dibangunkan=' + revived + '.',
    startedAt: rscStamp_(), runId: runId
  });
  return { ok: true, revived: revived, stats: stats };
}

/* --------------------- KONTROL & PERBAIKAN ANTREAN --------------------- */

/** Menu — Repair / Dedupe Worker Triggers. */
function RSC_PERF17_REPAIR_TRIGGER_TOPOLOGY_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var before = 0, after = 0;
  try { before = ScriptApp.getProjectTriggers().length; } catch (e) { before = -1; }
  rscDeleteTriggers_(rscAllHandlers_());
  var armed = 0;
  if (rscGetProp_(V.pRunState, '') === 'RUNNING') {
    armed = rscArmAllLanes_();
    rscArmWatchdog_();
  }
  try { after = ScriptApp.getProjectTriggers().length; } catch (e2) { after = -1; }
  rscAlert_('Repair Trigger Topology',
    'Trigger sebelum : ' + before + '\nTrigger sesudah : ' + after +
    '\nLane dipasang   : ' + armed +
    '\n\nDuplikasi trigger worker dibersihkan; tepat satu trigger per lane.');
  return { before: before, after: after, armed: armed };
}

/** Menu — Kick / Recover Waiting Workers. */
function RSC_PERF14_KICK_WAITING_WORKERS_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  if (!runId) return rscAlert_('Kick Workers', 'Belum ada run. Jalankan Start Bulk Validation.');

  // Bebaskan lease yatim tanpa menambah Attempts.
  var released = rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var now = Date.now(), writes = [], n = 0;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      if (v[RSC_M.STATUS] !== RSC_STATUS.ACTIVE) continue;
      var lease = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
      if (isFinite(lease) && lease > now) continue;
      v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
      v[RSC_M.LEASE_UNTIL] = '';
      v[RSC_M.CLAIM_TOKEN] = '';
      v[RSC_M.WORKER] = '';
      v[RSC_M.MESSAGE] = 'Lease kedaluwarsa dibebaskan tanpa penalti.';
      v[RSC_M.UPDATED_AT] = rscStamp_();
      writes.push({ row: i + 2, values: v });
      n++;
    }
    rscManifestWriteRows_(sh, writes);
    return n;
  }, V.claimLockWaitMs);

  rscSetProp_(V.pRunState, 'RUNNING');
  var armed = rscArmAllLanes_();
  rscArmWatchdog_();
  var s = rscQueueStats_(ss, runId);
  rscAlert_('Kick Workers',
    'Lease kedaluwarsa dibebaskan : ' + released +
    '\nLane dijadwalkan ulang       : ' + armed + '\n\n' + rscFormatStats_(runId, s));
  return { released: released, armed: armed, stats: s };
}

/** Menu — Diagnose Worker Queue. */
function RSC_PERF14_DIAGNOSE_WORKER_QUEUE_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var s = rscQueueStats_(ss, runId);

  var byKind = {}, oldest = null, worstAttempts = 0, worstDefers = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    var kind = vals[i][RSC_M.ERR_KIND] || '-';
    byKind[kind] = (byKind[kind] || 0) + 1;
    worstAttempts = Math.max(worstAttempts, Number(vals[i][RSC_M.ATTEMPTS] || 0));
    worstDefers = Math.max(worstDefers, Number(vals[i][RSC_M.DEFERS] || 0));
    if (!rscIsTerminal_(vals[i][RSC_M.STATUS])) {
      var at = vals[i][RSC_M.UPDATED_AT];
      if (!oldest || String(at) < String(oldest)) oldest = at;
    }
  }
  var kinds = [];
  for (var k in byKind) if (Object.prototype.hasOwnProperty.call(byKind, k)) kinds.push(k + '=' + byKind[k]);

  var triggers = [];
  try {
    var all = ScriptApp.getProjectTriggers();
    var count = {};
    for (var t = 0; t < all.length; t++) {
      var fn = all[t].getHandlerFunction();
      count[fn] = (count[fn] || 0) + 1;
    }
    for (var f in count) if (Object.prototype.hasOwnProperty.call(count, f)) triggers.push(f + ' x' + count[f]);
  } catch (e) { triggers.push('(tidak dapat membaca trigger)'); }

  var msg = rscFormatStats_(runId, s) +
    '\n\nJenis error terakhir : ' + (kinds.join(', ') || '-') +
    '\nAttempts tertinggi   : ' + worstAttempts + ' (batas ' + V.maxAttempts + ')' +
    '\nDefers tertinggi     : ' + worstDefers + ' (batas ' + V.maxDefers + ', tidak menambah Attempts)' +
    '\nTask terlama diam    : ' + (oldest || '-') +
    '\n\nTrigger aktif:\n' + (triggers.join('\n') || '-');
  rscAlert_('Diagnose Worker Queue', msg);
  return { stats: s, byKind: byKind, triggers: triggers, worstAttempts: worstAttempts, worstDefers: worstDefers };
}

/**
 * Menu — Requeue Technical DB Failures.
 * Mengembalikan kegagalan teknis (INFRA/ACCESS) ke antrean dan MERESET
 * Attempts-nya, karena kegagalan itu memang bukan kesalahan data template.
 */
function RSC_PERF23_REQUEUE_TECHNICAL_FAILURES_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  if (!runId) return rscAlert_('Requeue Technical Failures', 'Belum ada run aktif.');

  var n = rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var writes = [], count = 0;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      var st = v[RSC_M.STATUS];
      var kind = v[RSC_M.ERR_KIND];
      var technical = (kind === RSC_ERR.INFRA || kind === RSC_ERR.ACCESS);
      if (!technical && st !== RSC_STATUS.BLOCKED_INFRA) continue;
      if (st === RSC_STATUS.DONE_OK || st === RSC_STATUS.DONE_ERRORS) continue;
      v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
      v[RSC_M.ATTEMPTS] = 0;
      v[RSC_M.DEFERS] = 0;
      v[RSC_M.NEXT_AT] = '';
      v[RSC_M.LEASE_UNTIL] = '';
      v[RSC_M.CLAIM_TOKEN] = '';
      v[RSC_M.WORKER] = '';
      v[RSC_M.ERR_KIND] = '';
      v[RSC_M.MESSAGE] = 'Kegagalan teknis di-requeue; Attempts dan Defers direset.';
      v[RSC_M.UPDATED_AT] = rscStamp_();
      writes.push({ row: i + 2, values: v });
      count++;
    }
    rscManifestWriteRows_(sh, writes);
    return count;
  }, V.claimLockWaitMs);

  if (n > 0) {
    rscSetProp_(V.pRunState, 'RUNNING');
    rscArmPrewarm_(V.workerDelayMs);
    rscArmWatchdog_();
  }
  rscAlert_('Requeue Technical Failures',
    n + ' task teknis dikembalikan ke antrean dengan Attempts direset.\n' +
    (n ? 'Prewarm index dan watchdog dijadwalkan ulang.' : 'Tidak ada task teknis yang perlu di-requeue.'));
  return { requeued: n };
}

/** Menu — Repair Current Manifest + Requeue. */
function RSC_PERF23_REPAIR_CURRENT_MANIFEST_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  if (!runId) return rscAlert_('Repair Manifest', 'Belum ada run aktif.');

  var fixed = rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var writes = [], seen = {}, dupes = 0, orphan = 0, reset = 0;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      var changed = false;
      var fid = v[RSC_M.FILE_ID];

      // Duplikat fileId dalam satu run tidak boleh ada.
      if (fid) {
        if (seen[fid]) {
          v[RSC_M.STATUS] = RSC_STATUS.SKIPPED;
          v[RSC_M.MESSAGE] = 'Duplikat fileId dalam manifest; baris ini dinonaktifkan.';
          dupes++; changed = true;
        } else seen[fid] = true;
      }
      // ACTIVE tanpa lease yang sah adalah sisa execution yang mati.
      if (!changed && v[RSC_M.STATUS] === RSC_STATUS.ACTIVE) {
        var lease = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
        if (!isFinite(lease) || lease <= Date.now()) {
          v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
          v[RSC_M.LEASE_UNTIL] = '';
          v[RSC_M.CLAIM_TOKEN] = '';
          v[RSC_M.WORKER] = '';
          v[RSC_M.MESSAGE] = 'ACTIVE yatim dikembalikan ke antrean.';
          orphan++; changed = true;
        }
      }
      // Attempts melebihi batas karena kegagalan teknis lama.
      if (!changed && Number(v[RSC_M.ATTEMPTS] || 0) >= V.maxAttempts &&
          v[RSC_M.ERR_KIND] === RSC_ERR.INFRA) {
        v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
        v[RSC_M.ATTEMPTS] = 0;
        v[RSC_M.DEFERS] = 0;
        v[RSC_M.ERR_KIND] = '';
        v[RSC_M.MESSAGE] = 'Attempts akibat kegagalan infrastruktur direset.';
        reset++; changed = true;
      }
      if (changed) { v[RSC_M.UPDATED_AT] = rscStamp_(); writes.push({ row: i + 2, values: v }); }
    }
    rscManifestWriteRows_(sh, writes);
    return { dupes: dupes, orphan: orphan, reset: reset };
  }, V.claimLockWaitMs);

  rscSetProp_(V.pRunState, 'RUNNING');
  rscArmPrewarm_(V.workerDelayMs);
  rscArmWatchdog_();
  var s = rscQueueStats_(ss, runId);
  rscAlert_('Repair Manifest',
    'Duplikat fileId dinonaktifkan : ' + fixed.dupes +
    '\nACTIVE yatim dikembalikan     : ' + fixed.orphan +
    '\nAttempts infra direset        : ' + fixed.reset + '\n\n' + rscFormatStats_(runId, s));
  return { fixed: fixed, stats: s };
}

/** Menu — Audit Link E = Active Validation. */
function RSC_PERF15_AUDIT_LINK_E_ACTIVE_PARITY_20260819() {
  var ss = rscActiveSs_();
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var lastRow = master.getLastRow();
  var rows = [], total = 0, valid = 0, invalid = 0, dup = 0;
  var seen = {};

  if (lastRow >= L.firstDataRow) {
    var n = lastRow - L.firstDataRow + 1;
    var width = Math.max(master.getLastColumn(), L.linkCol);
    var vals = master.getRange(L.firstDataRow, 1, n, width).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var link = rscText_(vals[r][L.linkCol - 1]);
      if (!link) continue;
      total++;
      var id = rscFileId_(link);
      if (!id) { invalid++; rows.push([L.firstDataRow + r, rscText_(vals[r][L.officeCol - 1]), 'LINK TIDAK VALID', link.substring(0, 80)]); continue; }
      valid++;
      if (seen[id]) { dup++; rows.push([L.firstDataRow + r, rscText_(vals[r][L.officeCol - 1]), 'DUPLIKAT FILE', id]); }
      else seen[id] = L.firstDataRow + r;
    }
  }

  var spec = rscPrimarySpec_();
  var msg = 'Sheet rekap  : ' + master.getName() +
    '\nBaris header : ' + L.headerRow + ' (data mulai ' + L.firstDataRow + ')' +
    '\nKolom link   : ' + rscColLetter_(L.linkCol) +
    '\n\nLink terisi     : ' + total +
    '\nLink valid      : ' + valid +
    '\nLink tidak valid: ' + invalid +
    '\nFile duplikat   : ' + dup +
    '\nFile unik/task  : ' + Object.keys(seen).length +
    '\n\nSheet yang divalidasi tiap file: ' + spec.label +
    ' (layout A:' + rscColLetter_(spec.header.length) + ').' +
    '\nValidasi ACTIVE sheet dan bulk memakai engine yang sama, sehingga hasilnya identik.';
  rscAlert_('Audit Link E vs Active Validation', msg);
  return { total: total, valid: valid, invalid: invalid, duplicate: dup, unique: Object.keys(seen).length, detail: rows };
}

/* ------------------------- JOB LOGGING MENU ------------------------- */

function RSC_PERF16_OPEN_JOB_LOGGING_20260819() {
  var ss = rscActiveSs_();
  var sh = rscJobLogSheet_(ss);
  try { ss.setActiveSheet(sh); } catch (e) { /* tanpa UI */ }
  return sh.getName();
}

function RSC_PERF16_REFRESH_JOB_LOGGING_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, s);
  rscToast_('Dashboard diperbarui. Progress ' + Math.round(s.progress * 100) + '%.');
  return s;
}

function RSC_PERF16_CLEAR_JOB_LOG_HISTORY_20260819() {
  var J = RSC_PERF16_JOBLOG_20260819;
  var ss = rscActiveSs_();
  var sh = rscJobLogSheet_(ss);
  var last = sh.getLastRow();
  var removed = 0;
  if (last >= J.historyStartRow) {
    removed = last - J.historyStartRow + 1;
    sh.getRange(J.historyStartRow, 1, removed, J.columns.length).clearContent();
  }
  rscAlert_('Clear Event History', removed + ' baris histori dibersihkan.');
  return { removed: removed };
}
