
/* =============================================================
 * 16. HARD STOP / RE-ARM
 * ============================================================= */

function RSC_IS_HARD_STOPPED_() {
  return rscGetProp_(RSC_PERF13_HARD_STOP_20260819.pHardStop, '') === '1';
}

function RSC_PERF13_HARD_STOP_ALL_20260819() {
  var H = RSC_PERF13_HARD_STOP_20260819;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(H.pHardStop, '1');
  rscSetProp_(H.pHardStopAt, rscStamp_());
  rscSetProp_(H.pHardStopBy, rscWhoAmI_());
  rscSetProp_(H.pHardStopReason, 'HARD STOP manual dari menu Admin / Recovery.');
  rscSetProp_(V.pRunState, 'STOPPED');

  var removed = 0;
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) { ScriptApp.deleteTrigger(all[i]); removed++; }
  } catch (e) { removed = -1; }

  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'HARD STOP', state: 'STOPPED', stage: 'HARD STOP ALL', progress: 1,
    message: 'Semua trigger project dilepas (' + removed + '). Antrean tetap tersimpan.',
    startedAt: rscStamp_()
  }, { force: true, history: true });
  rscAlert_('HARD STOP ALL',
    'Semua trigger dilepas: ' + removed +
    '\nRun ditandai STOPPED.\n\nData manifest TIDAK dihapus.' +
    '\nJalankan "Re-Arm System after HARD STOP" untuk melanjutkan.');
  return { removed: removed };
}

function RSC_PERF13_REARM_AFTER_HARD_STOP_20260819() {
  var H = RSC_PERF13_HARD_STOP_20260819;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(H.pHardStop, '');
  rscSetProp_(H.pHardStopReason, '');
  rscSetProp_(V.pBlocked, '');
  rscSetProp_(V.pOwner, rscWhoAmI_());

  var runId = rscGetProp_(V.pRunId, '');
  var s = runId ? rscQueueStats_(ss, runId) : { unfinished: 0, total: 0 };
  var armed = 0;
  if (runId && s.unfinished > 0) {
    rscSetProp_(V.pRunState, 'RUNNING');
    rscArmPrewarm_(V.workerDelayMs);
    rscArmWatchdog_();
    armed = V.workerCount;
  }
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'HARD STOP', state: 'START', stage: 'Re-Arm', progress: 0,
    message: 'HARD STOP dicabut. Sisa antrean: ' + s.unfinished + '.', startedAt: rscStamp_()
  }, { force: true, history: true });
  rscAlert_('Re-Arm System',
    'HARD STOP dicabut oleh ' + rscWhoAmI_() + '.' +
    '\nSisa antrean : ' + s.unfinished +
    '\nLane dijadwal: ' + (armed ? 'ya (lewat prewarm index)' : 'tidak perlu'));
  return { rearmed: true, stats: s };
}

function RSC_PERF13_SHOW_HARD_STOP_STATUS_20260819() {
  var H = RSC_PERF13_HARD_STOP_20260819;
  var active = RSC_IS_HARD_STOPPED_();
  var msg = 'HARD STOP : ' + (active ? 'AKTIF' : 'tidak aktif') +
    '\nWaktu     : ' + rscGetProp_(H.pHardStopAt, '-') +
    '\nOleh      : ' + rscGetProp_(H.pHardStopBy, '-') +
    '\nAlasan    : ' + rscGetProp_(H.pHardStopReason, '-');
  rscAlert_('HARD STOP Status', msg);
  return { active: active };
}

/* =============================================================
 * 17. HARNESS UJI RINGAN
 * ============================================================= */

function rscTestSuite_(title) {
  var passed = [], failed = [];
  return {
    ok: function (name, cond, extra) {
      if (cond) passed.push(name);
      else failed.push(name + (extra ? ' :: ' + extra : ''));
    },
    eq: function (name, a, b) {
      if (String(a) === String(b)) passed.push(name + ' (' + a + ')');
      else failed.push(name + ' :: got "' + a + '" want "' + b + '"');
    },
    finish: function (extraText) {
      var res = { title: title, ok: failed.length === 0, passed: passed.length, failed: failed };
      rscAlert_(title + (res.ok ? ' — LULUS' : ' — GAGAL'),
        passed.length + ' lulus, ' + failed.length + ' gagal.' +
        (failed.length ? ('\n\nGagal:\n- ' + failed.join('\n- ')) : '') +
        (extraText ? ('\n\n' + extraText) : ''));
      return res;
    }
  };
}

function RSC_PERF13_TEST_HARD_STOP_CORE_20260819() {
  var H = RSC_PERF13_HARD_STOP_20260819;
  var before = rscGetProp_(H.pHardStop, '');
  var t = rscTestSuite_('HARD STOP CORE');
  rscSetProp_(H.pHardStop, '1');
  t.ok('flag aktif terbaca', RSC_IS_HARD_STOPPED_() === true);
  rscSetProp_(H.pHardStop, '');
  t.ok('flag nonaktif terbaca', RSC_IS_HARD_STOPPED_() === false);
  rscSetProp_(H.pHardStop, before);
  t.ok('flag dikembalikan seperti semula', rscGetProp_(H.pHardStop, '') === before);
  return t.finish();
}

/* =============================================================
 * 18. AUDIT & DIAGNOSTIK
 * ============================================================= */

function RSC_PERF10_RUN_DEPENDENCY_AUDIT_20260819() {
  var ss = rscActiveSs_();
  var lines = [];
  lines.push('Versi engine : ' + ROLLING_SALES_CENTER_PARAMETERS.version);
  lines.push('Master file  : ' + ss.getName() + ' (' + ss.getId() + ')');

  try { lines.push('Sheet rekap  : ' + rscMasterSheet_(ss).getName()); }
  catch (e) { lines.push('Sheet rekap  : TIDAK DITEMUKAN'); }

  var em = rscOfficeMaster_(ss);
  lines.push('Master em    : ' + (em.available ? (Object.keys(em.map).length + ' sales office') : 'TIDAK TERSEDIA'));
  lines.push('Relationship : ' + Object.keys(rscRelationshipMaster_().map).length + ' tipe');

  var ids = rscDbSources_();
  lines.push('');
  lines.push('DB sources   : ' + (ids.length ? ids.join(', ') : '(kosong)'));
  for (var i = 0; i < ids.length; i++) {
    try {
      var db = SpreadsheetApp.openById(ids[i]);
      lines.push('  OK  ' + db.getName() + ' — ' + db.getSheets().length + ' tab');
    } catch (e2) {
      lines.push('  ERR ' + ids[i] + ' — ' + rscClassify_(e2).kind);
    }
  }

  lines.push('');
  var tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  for (var t = 0; t < tables.length; t++) {
    try {
      var idx = rscGetIndex_(tables[t]);
      lines.push('Index ' + tables[t] + ' : ' + (idx.available
        ? (idx.rows + ' baris, tab "' + idx.sheet + '", mode ' + (idx.mode || '-') +
           ', simpan di ' + (idx.storedIn || '-'))
        : ('TIDAK TERSEDIA (' + (idx.reason || '-') + ')')));
    } catch (e3) {
      var c3 = rscClassify_(e3);
      lines.push('Index ' + tables[t] + ' : ' + c3.kind + ' — ' + c3.message);
    }
  }

  lines.push('');
  lines.push('Periode      : dateNew=' + VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew +
    ', dateClose=' + VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose);
  lines.push('Worker       : ' + RSC_STANDARD_VALIDATION_V27_20260814.workerCount +
    ' lane, bundle ' + RSC_STANDARD_VALIDATION_V27_20260814.claimBatchSize);
  lines.push('Akun efektif : ' + rscWhoAmI_());

  var text = lines.join('\n');
  rscSetProp_('RSC_LAST_AUDIT', text.substring(0, 8000));
  rscSetProp_('RSC_LAST_AUDIT_AT', rscStamp_());
  rscAlert_('Scope + Dependency Audit', text);
  return text;
}

function RSC_PERF10_LIVE_DB_READONLY_AUDIT_20260819() {
  var lines = [], tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  for (var t = 0; t < tables.length; t++) {
    try {
      var idx = rscGetIndex_(tables[t]);
      if (!idx.available) { lines.push(tables[t] + ' : n/a (' + (idx.reason || '-') + ')'); continue; }
      var keys = Object.keys(idx.map).slice(0, 3);
      var sample = [];
      for (var k = 0; k < keys.length; k++) sample.push(keys[k] + ' -> ' + JSON.stringify(idx.map[keys[k]][0]));
      lines.push(tables[t] + ' : ' + idx.rows + ' baris, ' + Object.keys(idx.map).length + ' key' +
        (idx.expiredRows ? (', ' + idx.expiredRows + ' kedaluwarsa dilewati') : '') +
        '\n   ' + (sample.join('\n   ') || '(kosong)'));
    } catch (e) {
      lines.push(tables[t] + ' : ' + rscClassify_(e).kind);
    }
  }
  var text = lines.join('\n\n');
  rscAlert_('Live DB Read-Only Audit', text);
  return text;
}

function RSC_PERF11_DIAGNOSE_DB_ACCESS_20260819() {
  var ids = rscDbSources_();
  var lines = ['Akun efektif : ' + rscWhoAmI_(), ''];
  for (var i = 0; i < ids.length; i++) {
    try {
      var ss = SpreadsheetApp.openById(ids[i]);
      var names = [], sheets = ss.getSheets();
      for (var s = 0; s < sheets.length && s < 25; s++) names.push(sheets[s].getName());
      lines.push('OK  ' + ids[i] + '\n    ' + ss.getName() + '\n    tab: ' + names.join(', '));
    } catch (e) {
      var c = rscClassify_(e);
      lines.push('ERR ' + ids[i] + '\n    [' + c.kind + '] ' + c.message);
    }
  }
  if (!ids.length) lines.push('RSC_DB_PARAMETERS.spreadsheetId masih kosong.');

  // Resolusi tiap tabel master: tab mana yang terpakai dan berapa key terbaca.
  var tables = ['BP', 'RELATION', 'SALESMAN', 'VISIT', 'RELTYPE'];
  var res = ['RESOLUSI TABEL MASTER'];
  for (var t = 0; t < tables.length; t++) {
    var alias = (RSC_DB_PARAMETERS.tables[tables[t]] || []).join(' / ');
    try {
      var idx = rscGetIndex_(tables[t]);
      if (idx && idx.available) {
        res.push('OK  ' + tables[t] + ' -> tab "' + (idx.sheet || '?') + '"' +
          (idx.source ? (' di ' + idx.source) : '') +
          '\n    key=' + Object.keys(idx.map || {}).length + ', baris=' + (idx.rows || 0) +
          (idx.mode ? (', mode=' + idx.mode) : ''));
      } else {
        res.push('--  ' + tables[t] + ' TIDAK DITEMUKAN (' + ((idx && idx.reason) || '-') + ')' +
          '\n    alias tabel dicari: ' + alias +
          (idx && idx.sheet ? ('\n    tab ditemukan   : ' + idx.sheet) : '') +
          (idx && idx.wantedAliases ? ('\n    kolom dicari    : ' + idx.wantedAliases.join(', ')) : '') +
          (idx && idx.actualHeaders ? ('\n    header asli     : ' + idx.actualHeaders.join(' | ')) : '') +
          '\n    rule terkait akan DILEWATI, bukan dijadikan error.');
      }
    } catch (eT) {
      res.push('ERR ' + tables[t] + ': ' + rscClassify_(eT).message);
    }
  }
  lines.push(res.join('\n'));

  var text = lines.join('\n\n');
  rscAlert_('Diagnose DB Access / Identity', text);
  return text;
}

function RSC_PERF15_DIAGNOSE_BULK_ACCESS_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var checked = 0, ok = 0, denied = 0, other = 0, samples = [];
  for (var i = 0; i < vals.length && checked < 10; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    var fid = vals[i][RSC_M.FILE_ID];
    if (!fid) continue;
    checked++;
    try { SpreadsheetApp.openById(fid); ok++; }
    catch (e) {
      var c = rscClassify_(e);
      if (c.kind === RSC_ERR.ACCESS) denied++; else other++;
      samples.push(fid + ' [' + c.kind + ']');
    }
  }
  var text = 'Akun efektif : ' + rscWhoAmI_() +
    '\nRun ID       : ' + (runId || '-') +
    '\n\nSample diperiksa : ' + checked +
    '\nDapat dibuka     : ' + ok +
    '\nDitolak akses    : ' + denied +
    '\nLain-lain        : ' + other +
    (samples.length ? ('\n\nContoh bermasalah:\n' + samples.join('\n')) : '');
  rscAlert_('Diagnose Bulk DB Access / Identity', text);
  return text;
}

function RSC_PERF18_AUDIT_CHILD_LINK_ACCESS_20260819() {
  var ss = rscActiveSs_();
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var lastRow = master.getLastRow();
  var ok = 0, fail = 0, rows = [];
  if (lastRow >= L.firstDataRow) {
    var n = lastRow - L.firstDataRow + 1;
    var width = Math.max(master.getLastColumn(), L.linkCol);
    var vals = master.getRange(L.firstDataRow, 1, n, width).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var id = rscFileId_(vals[r][L.linkCol - 1]);
      if (!id) continue;
      try { SpreadsheetApp.openById(id); ok++; }
      catch (e) {
        fail++;
        rows.push('row ' + (L.firstDataRow + r) + ' ' + rscText_(vals[r][L.officeCol - 1]) +
          ' [' + rscClassify_(e).kind + ']');
      }
    }
  }
  var text = 'Dapat dibuka : ' + ok + '\nBermasalah   : ' + fail +
    (rows.length ? ('\n\n' + rows.slice(0, 40).join('\n')) : '');
  rscAlert_('Audit Child Link Access (Col E)', text);
  return { ok: ok, fail: fail, detail: rows };
}

function RSC_PERF18_AUTHORIZE_AND_BIND_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var me = rscWhoAmI_();
  var lines = ['Akun pengikat: ' + me, ''];

  var ids = rscDbSources_();
  for (var i = 0; i < ids.length; i++) {
    try { SpreadsheetApp.openById(ids[i]).getSheets().length; lines.push('OK  DB ' + ids[i]); }
    catch (e) { lines.push('ERR DB ' + ids[i] + ' — ' + rscClassify_(e).message); }
  }
  try { DriveApp.getRootFolder().getName(); lines.push('OK  Drive scope'); }
  catch (e2) { lines.push('ERR Drive scope — ' + e2); }

  rscSetProp_(V.pOwner, me);
  rscSetProp_(V.pBlocked, '');
  rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, ss.getId());

  var armed = 0;
  if (rscGetProp_(V.pRunState, '') === 'RUNNING') { armed = rscArmAllLanes_(); rscArmWatchdog_(); }
  lines.push('');
  lines.push('Binding disimpan. Lane dijadwalkan ulang: ' + armed);
  var text = lines.join('\n');
  rscAlert_('Authorize External DB + Bind Workers', text);
  return text;
}

function RSC_PERF18_SHOW_AUTH_STATUS_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var blocked = rscGetProp_(V.pBlocked, '');
  var text = 'Pemilik run  : ' + (rscGetProp_(V.pOwner, '') || '(belum di-bind)') +
    '\nAkun efektif : ' + rscWhoAmI_() +
    '\nStatus       : ' + (blocked ? 'BLOCKED' : 'OK') +
    (blocked ? ('\n\nAlasan:\n' + blocked) : '') +
    '\n\nWatchdog memeriksa binding SEKALI. Bila mismatch, watchdog berhenti dan\n' +
    'tidak mengulang pesan tiap beberapa menit seperti versi lama.';
  rscAlert_('Authorization Binding Status', text);
  return { owner: rscGetProp_(V.pOwner, ''), me: rscWhoAmI_(), blocked: blocked };
}

function RSC_PERF19_CLEAR_DB_CACHE_20260819() {
  RSC_MEM_INDEX = {};
  var tag = rscDbSources_().join(',');
  if (tag) {
    rscSetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag, '');
    rscSetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag + '_AT', '');
  }
  var invalidated = 0;
  var store = rscIndexStore_(false);
  if (store) {
    var sheets = store.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getName().indexOf('IDX_') === 0) {
        try { sheets[i].getRange(1, 1).setValue('stale'); invalidated++; } catch (e) { /* abaikan */ }
      }
    }
  }
  rscAlert_('Clear Fast DB Lookup Cache',
    'Cache memori dan versi index dibersihkan.\nSheet index ditandai basi: ' + invalidated +
    '\n\nIndex akan dibangun ulang otomatis saat dibutuhkan.');
  return { invalidated: invalidated };
}

function RSC_PERF21_SHOW_TRANSPORT_STATUS_20260819() {
  var lines = [], tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  var ver = rscIndexVersion_();
  for (var i = 0; i < tables.length; i++) {
    var mem = RSC_MEM_INDEX[tables[i] + ':' + ver];
    lines.push(tables[i] + ' : ' + (mem
      ? ('siap di memori (' + (mem.storedIn || '-') + ')')
      : 'belum dimuat di execution ini'));
  }
  var text = 'Versi index  : ' + ver +
    '\nPenyimpanan  : memori -> CacheService (< ' + RSC_DB_PARAMETERS.cacheMaxBytes + ' byte) -> sheet index' +
    '\nSheet index  : ' + (rscGetProp_(RSC_DB_PARAMETERS.pIndexStoreId, '') || '(belum dibuat)') +
    '\n\n' + lines.join('\n');
  rscAlert_('PERF21 DB Transport Status', text);
  return text;
}

function RSC_PERF22_SCOPE_AUDIT_20260819_() {
  var checks = [];
  function probe(name, fn) {
    try { fn(); checks.push('OK  ' + name); }
    catch (e) { checks.push('ERR ' + name + ' — ' + e); }
  }
  probe('SpreadsheetApp', function () { rscActiveSs_().getName(); });
  probe('PropertiesService', function () { rscGetProp_('RSC_PROBE', ''); });
  probe('CacheService', function () { rscCache_().get('RSC_PROBE'); });
  probe('LockService', function () { rscAtomic_(function () { return 1; }, 1000); });
  probe('ScriptApp triggers', function () { ScriptApp.getProjectTriggers(); });
  probe('DriveApp', function () { DriveApp.getRootFolder().getName(); });
  probe('Session', function () { rscWhoAmI_(); });
  probe('Utilities', function () { rscUuid_(); });
  var text = checks.join('\n');
  rscAlert_('PERF22 Scope Completeness Audit', text);
  return text;
}

function RSC_PERF24_DIAGNOSE_RUN_GUARDS_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var stale = 0, tokened = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) { stale++; continue; }
    if (vals[i][RSC_M.CLAIM_TOKEN]) tokened++;
  }
  var text = 'Run ID aktif        : ' + (runId || '-') +
    '\nState               : ' + rscGetProp_(V.pRunState, '-') +
    '\nBaris run lain      : ' + stale + ' (tidak akan diambil worker)' +
    '\nTask sedang di-claim: ' + tokened +
    '\n\nPenjaga aktif:' +
    '\n- Worker hanya mengambil baris dengan Run ID yang sama.' +
    '\n- Commit memverifikasi claimToken; hasil dibuang bila token berubah.' +
    '\n- Lease kedaluwarsa dibebaskan tanpa menambah Attempts.' +
    '\n- Lane berhenti di ' + Math.round(V.workerSoftDeadlineMs / 1000) +
    ' detik dan melepas sisa task tanpa penalti.';
  rscAlert_('PERF24 Diagnose Run Guards', text);
  return text;
}

function RSC_PERF10_SHOW_TELEMETRY_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var n = 0, open = 0, norm = 0, rules = 0, write = 0, total = 0, errRows = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    if (!Number(vals[i][RSC_M.TOTAL_SEC] || 0)) continue;
    n++;
    open += Number(vals[i][RSC_M.OPEN_SEC] || 0);
    norm += Number(vals[i][RSC_M.NORM_SEC] || 0);
    rules += Number(vals[i][RSC_M.RULES_SEC] || 0);
    write += Number(vals[i][RSC_M.WRITE_SEC] || 0);
    total += Number(vals[i][RSC_M.TOTAL_SEC] || 0);
    errRows += Number(vals[i][RSC_M.ERROR_ROWS] || 0);
  }
  function avg(x) { return n ? rscRound_(x / n, 3) : 0; }
  var text = 'File selesai dengan telemetri: ' + n +
    '\n\nRata-rata per file:' +
    '\n  Buka file   : ' + avg(open) + ' s' +
    '\n  Normalisasi : ' + avg(norm) + ' s' +
    '\n  Rule        : ' + avg(rules) + ' s' +
    '\n  Tulis hasil : ' + avg(write) + ' s' +
    '\n  Total       : ' + avg(total) + ' s' +
    '\n\nTotal waktu proses : ' + rscRound_(total, 1) + ' s' +
    '\nTotal baris error  : ' + errRows;
  rscAlert_('PERF Telemetry', text);
  return text;
}

function RSC_PERF10_SHOW_LAST_AUDIT_20260819() {
  var text = rscGetProp_('RSC_LAST_AUDIT', '');
  var at = rscGetProp_('RSC_LAST_AUDIT_AT', '');
  rscAlert_('Last Audit Summary',
    text ? (at + '\n\n' + text) : 'Belum ada audit. Jalankan Scope + Dependency Audit.');
  return text;
}
