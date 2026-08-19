
/* =============================================================
 * 9. JOB LOGGING DETAILS — layout dipertahankan persis
 * ============================================================= */

function RSC_PERF16_JOBLOG_NOW_20260819_() { return rscStamp_(); }

/** Buang karakter kontrol agar sel dashboard tidak rusak. */
function RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(v, maxLen) {
  var s = String(v === null || v === undefined ? '' : v);
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, Number(maxLen || 5000));
}

function RSC_PERF16_JOBLOG_EFFECTIVE_USER_20260819_() { return rscWhoAmI_(); }

function rscJobLogSheet_(ss) {
  var J = RSC_PERF16_JOBLOG_20260819;
  var sh = ss.getSheetByName(J.sheetName);
  if (!sh) sh = ss.insertSheet(J.sheetName);
  var minRows = J.historyStartRow + 50;
  if (sh.getMaxRows() < minRows) sh.insertRowsAfter(sh.getMaxRows(), minRows - sh.getMaxRows());
  if (rscKey_(sh.getRange(J.liveHeaderRow, 1).getDisplayValue()) !== 'SLOT') {
    sh.getRange(J.titleRow, 1).setValue('ROLLING SALES CENTER — LIVE JOB LOGGING (' +
      ROLLING_SALES_CENTER_PARAMETERS.version + ')');
    sh.getRange(J.liveHeaderRow, 1, 1, J.columns.length).setValues([J.columns]);
    sh.getRange(J.historyTitleRow, 1).setValue('EVENT HISTORY — newest first');
    sh.getRange(J.historyHeaderRow, 1, 1, J.columns.length).setValues([J.columns]);
    for (var s = 0; s < J.liveSlots.length; s++) {
      sh.getRange(J.liveStartRow + s, 1).setValue(J.liveSlots[s]);
    }
  }
  return sh;
}

function rscSlotRow_(slot) {
  var J = RSC_PERF16_JOBLOG_20260819;
  var i = J.liveSlots.indexOf(slot);
  return i < 0 ? -1 : J.liveStartRow + i;
}

function rscJobLogRow_(slot, e) {
  return [
    slot,
    e.job || '',
    e.state || '',
    e.stage || '',
    e.progress === undefined ? '' : e.progress,
    e.currentTotal || '',
    RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(e.fileName || '', 300),
    e.fileId || '',
    e.sheet || '',
    e.rows === undefined ? '' : e.rows,
    RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(e.message || '', 2000),
    RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(e.lastError || '', 2000),
    e.startedAt || '',
    rscStamp_(),
    e.elapsedSec === undefined ? '' : e.elapsedSec,
    e.lane || slot,
    e.runId || rscGetProp_(RSC_STANDARD_VALIDATION_V27_20260814.pRunId, ''),
    e.user || rscWhoAmI_()
  ];
}

/**
 * Perbarui satu slot live. Throttled: hanya menulis bila state berubah atau
 * interval minimum terlewati. Ini menghilangkan banjir ribuan baris log yang
 * terjadi pada versi lama.
 */
function rscJobLogSet_(ss, slot, e, opts) {
  opts = opts || {};
  var J = RSC_PERF16_JOBLOG_20260819;
  var row = rscSlotRow_(slot);
  if (row < 0) return;
  var key = J.pStatePrefix + slot;
  var last = rscGetProp_(key, '');
  var sig = (e.state || '') + '|' + (e.stage || '') + '|' + (e.fileId || '');
  var parts = last.split('@@');
  var changed = sig !== (parts[0] || '');
  if (!changed && !opts.force && (Date.now() - Number(parts[1] || 0)) < J.throttleMs) return;
  try {
    var sh = rscJobLogSheet_(ss);
    var values = rscJobLogRow_(slot, e);
    sh.getRange(row, 1, 1, J.columns.length).setValues([values]);
    if (changed || opts.history) rscJobLogPushHistory_(sh, values);
    rscSetProp_(key, sig + '@@' + Date.now());
  } catch (err) { /* dashboard tidak boleh menggagalkan pipeline */ }
}

function rscJobLogPushHistory_(sh, values) {
  var J = RSC_PERF16_JOBLOG_20260819;
  try {
    sh.insertRowsBefore(J.historyStartRow, 1);
    sh.getRange(J.historyStartRow, 1, 1, J.columns.length).setValues([values]);
    var maxRow = J.historyStartRow + J.maxHistoryRows;
    if (sh.getMaxRows() > maxRow) sh.deleteRows(maxRow + 1, sh.getMaxRows() - maxRow);
  } catch (e) { /* histori best-effort */ }
}

function rscJobLogSummary_(ss, runId, stats) {
  var J = RSC_PERF16_JOBLOG_20260819;
  try {
    var sh = rscJobLogSheet_(ss);
    sh.getRange(J.summaryRow, 1, 1, 10).setValues([[
      'Last Dashboard Update', rscStamp_(), 'Run ID', runId,
      'Overall Progress', stats.progress, 'Total Tasks', stats.total, 'Unfinished', stats.unfinished
    ]]);
    sh.getRange(J.counterRow, 1, 1, 12).setValues([[
      'QUEUED', stats.queued, 'ACTIVE', stats.active, 'RETRY', stats.retry + stats.deferred,
      'COMPLETE OK', stats.ok, 'WITH ERRORS', stats.withErrors, 'ERROR/HARD', stats.hard + stats.blocked
    ]]);
  } catch (e) { /* best-effort */ }
}
