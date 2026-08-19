
/* =============================================================
 * 10. MANIFEST / ANTREAN — inti perbaikan [F2] dan [F4]
 * ============================================================= */

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

function rscIsTerminal_(status) {
  return status === RSC_STATUS.DONE_OK || status === RSC_STATUS.DONE_ERRORS ||
         status === RSC_STATUS.HARD_ERROR || status === RSC_STATUS.SKIPPED;
}

var RSC_MANIFEST_MEMO = null;

function rscManifestSheet_(ss) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  if (RSC_MANIFEST_MEMO && RSC_MANIFEST_MEMO.ssId === ss.getId()) return RSC_MANIFEST_MEMO.sheet;
  var sh = ss.getSheetByName(V.manifestSheetName);
  if (!sh) { sh = ss.insertSheet(V.manifestSheetName); sh.hideSheet(); }
  var cur = sh.getRange(1, 1, 1, V.manifestHeaders.length).getDisplayValues()[0];
  if (rscKey_(cur[0]) !== rscKey_(V.manifestHeaders[0]) ||
      rscKey_(cur[RSC_M.ERR_KIND]) !== rscKey_(V.manifestHeaders[RSC_M.ERR_KIND])) {
    sh.getRange(1, 1, 1, V.manifestHeaders.length).setValues([V.manifestHeaders]);
    sh.setFrozenRows(1);
  }
  RSC_MANIFEST_MEMO = { ssId: ss.getId(), sheet: sh };
  return sh;
}

function rscManifestRead_(sh) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, V.manifestHeaders.length).getDisplayValues();
}

function rscManifestWriteRows_(sh, rows) {
  if (!rows.length) return;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  rows.sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < rows.length) {
    var start = i;
    while (i + 1 < rows.length && rows[i + 1].row === rows[i].row + 1) i++;
    var block = [];
    for (var k = start; k <= i; k++) block.push(rows[k].values);
    sh.getRange(rows[start].row, 1, block.length, V.manifestHeaders.length).setValues(block);
    i++;
  }
}

/** Sheet rekap master: "Rekap All" lebih dulu, lalu "Rekap Approved". */
function rscMasterSheet_(ss) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  for (var i = 0; i < V.masterSheetCandidates.length; i++) {
    var sh = ss.getSheetByName(V.masterSheetCandidates[i]);
    if (sh) return sh;
  }
  var found = rscFindSheet_(ss, V.masterSheetCandidates);
  if (found) return found;
  throw new RscDataError('Sheet rekap tidak ditemukan. Dicari: ' + V.masterSheetCandidates.join(' / ') + '.');
}

/** Cari baris header rekap serta kolom link FINAL, Sales Office, dan Feedback. */
function rscMasterLayout_(sh) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var fallback = {
    headerRow: 1, firstDataRow: V.firstDataRow, linkCol: V.masterLinkCol,
    officeCol: 1, descCol: 2, feedbackCol: 8
  };
  var scan = Math.min(V.masterHeaderScanRows, sh.getLastRow());
  if (scan < 1) return fallback;
  var width = Math.max(sh.getLastColumn(), V.masterLinkCol);
  var grid = sh.getRange(1, 1, scan, width).getDisplayValues();
  for (var r = 0; r < grid.length; r++) {
    var hmap = rscHeaderMap_(grid[r]);
    var link = rscPickCol_(hmap, [
      'Template Rolling Sales FINAL (GUNAKAN LINK DISINI)', 'Template Rolling Sales FINAL'
    ]);
    var office = rscPickCol_(hmap, ['Sales Office']);
    if (link >= 0 && office >= 0) {
      var desc = rscPickCol_(hmap, ['Description']);
      var fb = rscPickCol_(hmap, ['Feedback']);
      return {
        headerRow: r + 1, firstDataRow: r + 2, linkCol: link + 1, officeCol: office + 1,
        descCol: desc >= 0 ? desc + 1 : 2, feedbackCol: fb >= 0 ? fb + 1 : 8
      };
    }
  }
  return fallback;
}

/**
 * Bangun antrean dari kolom link FINAL. File yang sama pada beberapa baris
 * digabung menjadi satu task sehingga satu file hanya divalidasi sekali.
 */
function rscBuildManifest_(ss, runId) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var lastRow = master.getLastRow();
  var stats = { links: 0, valid: 0, skipped: 0, tasks: 0, total: 0, layout: L, sheet: master.getName() };
  var byFile = {}, order = [], skippedRows = [];

  if (lastRow >= L.firstDataRow) {
    var n = lastRow - L.firstDataRow + 1;
    var width = Math.max(master.getLastColumn(), L.linkCol);
    var range = master.getRange(L.firstDataRow, 1, n, width);
    var vals = range.getDisplayValues();
    var formulas = null;

    // Sebagian admin memakai =HYPERLINK(...) sehingga teks tampilannya judul file.
    for (var pre = 0; pre < vals.length; pre++) {
      var probe = rscText_(vals[pre][L.linkCol - 1]);
      if (probe && !rscFileId_(probe)) {
        try { formulas = range.getFormulas(); } catch (eF) { formulas = null; }
        break;
      }
    }

    for (var r = 0; r < vals.length; r++) {
      var sheetRow = L.firstDataRow + r;
      var linkRaw = rscText_(vals[r][L.linkCol - 1]);
      if (!linkRaw) continue;
      stats.links++;
      var fileId = rscFileId_(linkRaw);
      if (!fileId && formulas) {
        var fx = rscText_(formulas[r][L.linkCol - 1]);
        var fromFx = rscFileId_(fx);
        if (fromFx) { fileId = fromFx; linkRaw = fx; }
      }
      if (!fileId) {
        stats.skipped++;
        skippedRows.push({ row: sheetRow, url: linkRaw, office: rscText_(vals[r][L.officeCol - 1]) });
        continue;
      }
      stats.valid++;
      if (!byFile[fileId]) {
        byFile[fileId] = {
          fileId: fileId, url: linkRaw, rows: [],
          office: rscText_(vals[r][L.officeCol - 1]),
          name: rscText_(vals[r][L.descCol - 1])
        };
        order.push(fileId);
      }
      byFile[fileId].rows.push(sheetRow);
    }
  }

  var now = rscStamp_();
  var out = [];
  function blankRow() {
    var row = new Array(V.manifestHeaders.length);
    for (var z = 0; z < row.length; z++) row[z] = '';
    return row;
  }
  for (var o = 0; o < order.length; o++) {
    var t = byFile[order[o]];
    var row = blankRow();
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
    var srow = blankRow();
    srow[RSC_M.RUN_ID] = runId;
    srow[RSC_M.MASTER_ROWS] = JSON.stringify([skippedRows[s].row]);
    srow[RSC_M.URL] = skippedRows[s].url;
    srow[RSC_M.FILE_NAME] = skippedRows[s].office;
    srow[RSC_M.STATUS] = RSC_STATUS.SKIPPED;
    srow[RSC_M.ATTEMPTS] = 0;
    srow[RSC_M.DEFERS] = 0;
    srow[RSC_M.STARTED_AT] = now;
    srow[RSC_M.UPDATED_AT] = now;
    srow[RSC_M.MESSAGE] = 'Link bukan URL/ID Google Sheets yang valid.';
    out.push(srow);
  }

  var sh = rscManifestSheet_(ss);
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, V.manifestHeaders.length).clearContent();
  }
  if (out.length) sh.getRange(2, 1, out.length, V.manifestHeaders.length).setValues(out);
  stats.total = out.length;
  return stats;
}

/**
 * Claim atomik. Hanya bagian ini yang memegang lock global, dan hanya sebentar.
 * claimToken diverifikasi ulang saat commit sehingga satu file mustahil
 * diproses dua lane sekaligus.
 */
function rscClaimBatch_(ss, runId, worker, maxN) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  return rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var now = Date.now(), nowStamp = rscStamp_();
    var picked = [], writes = [];

    for (var i = 0; i < vals.length && picked.length < maxN; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      var st = v[RSC_M.STATUS];
      if (rscIsTerminal_(st)) continue;
      if (st === RSC_STATUS.ACTIVE) {
        var lease = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
        if (isFinite(lease) && lease > now) continue;
      }
      if (st === RSC_STATUS.DEFERRED || st === RSC_STATUS.RETRY) {
        var next = Date.parse(v[RSC_M.NEXT_AT] || '');
        if (isFinite(next) && next > now) continue;
      }
      var token = rscUuid_();
      v[RSC_M.STATUS] = RSC_STATUS.ACTIVE;
      v[RSC_M.WORKER] = worker;
      v[RSC_M.LEASE_UNTIL] = new Date(now + V.leaseMs).toISOString();
      v[RSC_M.CLAIM_TOKEN] = token;
      v[RSC_M.UPDATED_AT] = nowStamp;
      v[RSC_M.MESSAGE] = 'Di-claim oleh ' + worker + '.';
      writes.push({ row: i + 2, values: v });
      picked.push({
        row: i + 2, fileId: v[RSC_M.FILE_ID], url: v[RSC_M.URL], name: v[RSC_M.FILE_NAME],
        masterRows: v[RSC_M.MASTER_ROWS], attempts: Number(v[RSC_M.ATTEMPTS] || 0),
        defers: Number(v[RSC_M.DEFERS] || 0), token: token
      });
    }
    rscManifestWriteRows_(sh, writes);
    return picked;
  }, V.claimLockWaitMs);
}

function rscUpdateTask_(ss, task, mutate) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  return rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var v = sh.getRange(task.row, 1, 1, V.manifestHeaders.length).getDisplayValues()[0];
    if (task.token && v[RSC_M.CLAIM_TOKEN] && v[RSC_M.CLAIM_TOKEN] !== task.token) {
      return { applied: false, reason: 'CLAIM_TOKEN_MISMATCH' };
    }
    mutate(v);
    v[RSC_M.UPDATED_AT] = rscStamp_();
    sh.getRange(task.row, 1, 1, V.manifestHeaders.length).setValues([v]);
    return { applied: true };
  }, V.commitLockWaitMs);
}

function rscCommitOk_(ss, task, res) {
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.STATUS] = res.errorRows > 0 ? RSC_STATUS.DONE_ERRORS : RSC_STATUS.DONE_OK;
    v[RSC_M.ERROR_ROWS] = res.errorRows;
    v[RSC_M.SHEET_SUMMARY] = res.summary || '';
    v[RSC_M.MESSAGE] = 'File selesai. Error rows=' + res.errorRows + '.';
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

/** INFRA -> DEFER. Attempts TIDAK bertambah. Inti perbaikan [F2]. */
function rscDeferTask_(ss, task, message) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var defers = Number(task.defers || 0) + 1;
  var waitMs = rscBackoffMs_(defers);
  var blocked = defers >= V.maxDefers;
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.DEFERS] = defers;
    v[RSC_M.STATUS] = blocked ? RSC_STATUS.BLOCKED_INFRA : RSC_STATUS.DEFERRED;
    v[RSC_M.NEXT_AT] = new Date(Date.now() + waitMs).toISOString();
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.WORKER] = '';
    v[RSC_M.ERR_KIND] = RSC_ERR.INFRA;
    v[RSC_M.MESSAGE] = blocked
      ? ('Ditunda ' + defers + 'x karena kontensi infrastruktur. Attempts tetap ' + (task.attempts || 0) + '.')
      : ('Ditunda tanpa menambah Attempts (defer ke-' + defers + '), retry dalam ' +
         Math.round(waitMs / 1000) + ' detik.');
    v[RSC_M.SHEET_SUMMARY] = String(message || '').substring(0, 500);
  });
}

/** DATA/ACCESS/FATAL -> Attempts++ ; HARD_ERROR bila melewati batas. */
function rscFailTask_(ss, task, message, kind) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var attempts = Number(task.attempts || 0) + 1;
  var hard = attempts >= V.maxAttempts;
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

/** Lepas task yang belum sempat dikerjakan. Netral, tanpa penalti. */
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

function rscEarliestEligibleMs_(ss, runId) {
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var now = Date.now(), best = -1;
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
  return best;
}

function rscQueueStats_(ss, runId) {
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var st = {
    total: 0, queued: 0, active: 0, retry: 0, deferred: 0, ok: 0, withErrors: 0,
    hard: 0, blocked: 0, skipped: 0, unfinished: 0, errorRows: 0
  };
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
    st.errorRows += Number(vals[i][RSC_M.ERROR_ROWS] || 0);
    if (!rscIsTerminal_(s)) st.unfinished++;
  }
  st.done = st.ok + st.withErrors + st.hard + st.skipped;
  st.progress = st.total ? rscRound_(st.done / st.total, 4) : 0;
  return st;
}
