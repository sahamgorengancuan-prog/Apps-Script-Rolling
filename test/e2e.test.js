'use strict';
/**
 * Uji end-to-end RollingSalesCenter.gs (nama function warisan dipertahankan)
 * memakai data nyata dari workbook induk.
 */
const {
  buildWorld, loadScript, drainTriggers, METRICS,
  WORKER_HANDLERS, PREWARM_HANDLER, WATCHDOG_HANDLER, MANIFEST_SHEET
} = require('./world');

let PASS = 0; const FAIL = [];
function ok(n, c, x) { if (c) { PASS++; console.log('  ok   ' + n); } else { FAIL.push(n + (x ? ' :: ' + x : '')); console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } }
function eq(n, a, b) { ok(n + ' (' + a + ' == ' + b + ')', String(a) === String(b), 'got ' + a + ' want ' + b); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

const M = { RUN_ID: 0, FILE_ID: 1, MASTER_ROWS: 2, URL: 3, FILE_NAME: 4, STATUS: 5, ATTEMPTS: 6,
  WORKER: 7, LEASE: 8, ERROR_ROWS: 9, SUMMARY: 10, MESSAGE: 14, DEFERS: 22,
  NEXT_AT: 23, TOKEN: 24, ERR_KIND: 25 };

function manifest(master) {
  const sh = master.getSheetByName(MANIFEST_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 26).getDisplayValues();
}

/* ===================================================================== */
section('1. KONTRAK PUBLIK — SEMUA MENU HANDLER ADA');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env);
  const legacy = require('fs').readFileSync('/tmp/menu_handlers.txt', 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean);
  const missing = legacy.filter(fn => typeof sandbox[fn] !== 'function');
  eq('86 handler menu lama tersedia', legacy.length - missing.length, legacy.length);
  ok('tidak ada handler yang hilang', missing.length === 0, missing.join(', '));

  const triggers = ['RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611',
    'RSC_CONTINUE_VALIDATE_DATE_IN_TEMPLATE_BG_20260619',
    'RSC_CONTINUE_TOKO_BANGKRUT_DATES_BY_DB_BG_20260622',
    'RSC_CONTINUE_TEMPLATE_REVAMP_INTEGRATED_20260723',
    'RSC_CONTINUE_COPY_ROLLING_TEMPLATE_FILES_20260611',
    'RSC_V28_2_AUTHORIZED_ON_EDIT_20260814',
    'RSC_V28_2_AUTO_VALIDATE_WORKER_20260814',
    'RSC_SCHEDULED_LOCAL_VALIDATION_JOB_20260611',
    'onOpen'].concat(WORKER_HANDLERS).concat([PREWARM_HANDLER, WATCHDOG_HANDLER]);
  const missT = triggers.filter(fn => typeof sandbox[fn] !== 'function');
  ok('semua handler trigger tersedia', missT.length === 0, missT.join(', '));

  eq('parameter DB dapat diatur dari file .gs', typeof sandbox.RSC_DB_PARAMETERS.spreadsheetId, 'string');
  eq('tanggal periode dari parameter', typeof sandbox.VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew, 'string');
}

/* ===================================================================== */
section('2. SELF-TEST BAWAAN (menu Audit & Performance)');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env);
  const r = sandbox.RSC_RUN_SELF_TEST_20260819();
  ok('self-test menyeluruh lulus (' + r.totalPassed + ' assertion)', r.ok, r.allFailed.join(' | '));
}

/* ===================================================================== */
section('3. PIPELINE END-TO-END 62 LINK');
let e2e = null;
{
  const world = buildWorld({ brokenLayout: [3], noAccess: [7] });
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  const start = sandbox.RSC_STANDARD_BULK_START_20260814();
  eq('task unik dari kolom link FINAL', start.stats.tasks, world.fileIds.length);
  ok('link tidak valid ditandai SKIPPED', start.stats.skipped >= 1, 'skipped=' + start.stats.skipped);
  eq('prewarm index dijadwalkan lebih dulu', start.prewarm, 'true');
  eq('lane belum menyala sebelum index siap', start.armed, 0);
  eq('sheet rekap terdeteksi', start.stats.sheet, 'Rekap Approved');

  const drain = drainTriggers(world.env, sandbox, 500);
  const runId = sandbox.rscGetProp_('RSC_STD_V27_RUN_ID', '');
  const stats = sandbox.rscQueueStats_(world.master, runId);
  e2e = { world, sandbox, stats, runId, start };

  console.log('  -> iterasi worker: ' + drain.iterations + ', stats: ' + JSON.stringify(stats));
  eq('tidak ada task tersisa', stats.unfinished, 0);
  ok('ada file COMPLETE_OK', stats.ok > 0, 'ok=' + stats.ok);
  ok('ada file COMPLETE_WITH_ERRORS', stats.withErrors > 0, 'withErrors=' + stats.withErrors);
  eq('progress 100%', stats.progress, 1);
}

/* ===================================================================== */
section('4. HASIL DI FILE ANAK + FORMAT PESAN WARISAN');
{
  const { world, sandbox } = e2e;
  let okFiles = 0, errFiles = 0, blank = 0;
  world.fileIds.forEach((f, idx) => {
    if (idx === 7) return;
    const child = world.env.files.get(f.id);
    const sh = child.getSheetByName('Change Rolling & Change Schedule');
    const last = sh.getLastRow();
    if (last < 2) return;
    const vals = sh.getRange(2, 15, last - 1, 2).getDisplayValues();
    let hasErr = false, hasOk = false;
    vals.forEach(v => {
      if (v[0] === 'ERROR') { hasErr = true; if (!v[1]) blank++; }
      else if (v[0] === 'OK') hasOk = true;
    });
    if (hasErr) errFiles++; else if (hasOk) okFiles++;
  });
  ok('file bersih menghasilkan OK', okFiles > 0, 'okFiles=' + okFiles);
  ok('file bermasalah menghasilkan ERROR', errFiles > 0, 'errFiles=' + errFiles);
  eq('setiap ERROR punya Error Detail', blank, 0);

  const errChild = world.env.files.get(world.fileIds[2].id);
  const detail = errChild.getSheetByName('Change Rolling & Change Schedule')
    .getRange(2, 16, 10, 1).getDisplayValues().map(r => r[0]).join(' ');
  ok('R7 konflik schedule terdeteksi', detail.indexOf('[R7]') >= 0, detail.slice(0, 160));
  ok('R8 duplikat terdeteksi', detail.indexOf('[R8]') >= 0, detail.slice(0, 160));

  const rows = manifest(world.master);
  const hard = rows.filter(r => r[M.STATUS] === 'HARD_ERROR');
  ok('layout rusak / tanpa akses -> HARD_ERROR', hard.length >= 1, 'n=' + hard.length);
  ok('HARD_ERROR bukan dari INFRA', hard.every(r => r[M.ERR_KIND] !== 'INFRA'));
  const lay = hard.find(r => /Layout A:P/.test(r[M.SUMMARY]));
  ok('pesan layout memakai format FSD lama', !!lay,
     hard.map(r => r[M.SUMMARY].slice(0, 60)).join(' | '));
  ok('pesan layout menunjuk kolom $D', !!lay && /\$D: expected "Relationship", got ""/.test(lay[M.SUMMARY]));
}

/* ===================================================================== */
section('5. [F2] DB_BUSY TIDAK MENAMBAH ATTEMPTS');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  sandbox.RSC_STANDARD_BULK_START_20260814();

  const real = sandbox.rscGetIndex_;
  sandbox.rscGetIndex_ = function () {
    throw new sandbox.RscInfraError(
      '[PERF19 DB BUSY] Serialized m_bp_relation reader sedang dipakai execution lain. purpose=RELATION_LEGACY');
  };

  const r1 = sandbox.RSC_STANDARD_BULK_WORKER_1_20260814();
  ok('bundle di-defer karena INFRA', r1.reason === 'MASTER_INFRA', JSON.stringify(r1));

  let rows = manifest(world.master).filter(r => r[M.STATUS] === 'DEFERRED');
  ok('ada task DEFERRED', rows.length > 0, 'n=' + rows.length);
  eq('Attempts tetap 0', rows[0][M.ATTEMPTS], '0');
  eq('Defers bertambah', rows[0][M.DEFERS], '1');
  eq('jenis error INFRA', rows[0][M.ERR_KIND], 'INFRA');
  ok('pesan menyebut tanpa menambah Attempts', /tanpa menambah Attempts/i.test(rows[0][M.MESSAGE]), rows[0][M.MESSAGE]);

  for (let i = 0; i < 6; i++) {
    manifest(world.master).forEach((r, idx) => {
      if (r[M.STATUS] === 'DEFERRED') {
        world.master.getSheetByName(MANIFEST_SHEET).getRange(idx + 2, M.NEXT_AT + 1).setValue('');
      }
    });
    sandbox.RSC_STANDARD_BULK_WORKER_1_20260814();
  }
  const after = manifest(world.master);
  eq('nol HARD_ERROR setelah 7x DB busy', after.filter(r => r[M.STATUS] === 'HARD_ERROR').length, 0);
  eq('Attempts tetap 0 setelah 7x DB busy', after.filter(r => Number(r[M.ATTEMPTS] || 0) > 0).length, 0);
  ok('defer berlebih -> BLOCKED_INFRA, bukan HARD_ERROR',
     after.some(r => r[M.STATUS] === 'BLOCKED_INFRA' || r[M.STATUS] === 'DEFERRED'));

  // Menu "Requeue Technical DB Failures" harus mereset Attempts & Defers.
  sandbox.rscGetIndex_ = real;
  const rq = sandbox.RSC_PERF23_REQUEUE_TECHNICAL_FAILURES_20260819();
  ok('requeue teknis memproses task', rq.requeued > 0, 'n=' + rq.requeued);
  const afterRq = manifest(world.master);
  eq('Defers direset', afterRq.filter(r => Number(r[M.DEFERS] || 0) > 0).length, 0);

  drainTriggers(world.env, sandbox, 500);
  const runId = sandbox.rscGetProp_('RSC_STD_V27_RUN_ID', '');
  const finalStats = sandbox.rscQueueStats_(world.master, runId);
  eq('pulih: antrean selesai', finalStats.unfinished, 0);
  eq('pulih: tidak ada HARD_ERROR', finalStats.hard, 0);
}

/* ===================================================================== */
section('6. [F4] SATU FILE HANYA SATU LANE');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  sandbox.RSC_STANDARD_BULK_START_20260814();
  const runId = sandbox.rscGetProp_('RSC_STD_V27_RUN_ID', '');
  const a = sandbox.rscClaimBatch_(world.master, runId, 'WORKER_1', 4);
  const b = sandbox.rscClaimBatch_(world.master, runId, 'WORKER_2', 4);
  const ids = new Set(a.map(t => t.fileId));
  eq('claim lane-1 dan lane-2 disjoint', b.filter(t => ids.has(t.fileId)).length, 0);
  eq('lane 1 dapat 4 task', a.length, 4);

  const stale = { row: a[0].row, token: 'TOKEN-PALSU', attempts: 0, defers: 0 };
  const res = sandbox.rscCommitOk_(world.master, stale, { errorRows: 0 });
  eq('commit token basi ditolak', res.applied, 'false');
  eq('alasan penolakan', res.reason, 'CLAIM_TOKEN_MISMATCH');

  const rows = manifest(world.master);
  const seen = {}; let dup = 0;
  rows.forEach(r => { if (r[M.FILE_ID]) { if (seen[r[M.FILE_ID]]) dup++; seen[r[M.FILE_ID]] = 1; } });
  eq('tidak ada fileId duplikat di manifest', dup, 0);
}

/* ===================================================================== */
section('7. [F5] WATCHDOG TIDAK LOOP SAAT AUTH MISMATCH');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  sandbox.RSC_STANDARD_BULK_START_20260814();
  eq('watchdog terpasang', world.env.triggers.filter(t => t.fn === WATCHDOG_HANDLER).length, 1);

  world.env.effectiveUser = 'orang.lain@wingscorp.com';
  const w1 = sandbox.RSC_STANDARD_BULK_WATCHDOG_20260814();
  eq('watchdog memblok sekali', w1.reason, 'AUTH_MISMATCH');
  eq('trigger watchdog dilepas', world.env.triggers.filter(t => t.fn === WATCHDOG_HANDLER).length, 0);
  ok('alasan blokir tersimpan',
     /Authorize External DB/.test(sandbox.rscGetProp_('RSC_STD_V27_BLOCKED_REASON', '')));

  world.env.effectiveUser = 'paskalis.glennardo@wingscorp.com';
  sandbox.RSC_PERF18_AUTHORIZE_AND_BIND_20260819();
  eq('bind ulang membersihkan blokir', sandbox.rscGetProp_('RSC_STD_V27_BLOCKED_REASON', ''), '');
  eq('bind ulang memasang watchdog', world.env.triggers.filter(t => t.fn === WATCHDOG_HANDLER).length, 1);
}

/* ===================================================================== */
section('8. DASHBOARD JOB LOGGING (layout warisan)');
{
  const { world } = e2e;
  const dash = world.master.getSheetByName('Job Logging Details');
  eq('header di baris 6', dash.getRange(6, 1).getDisplayValue(), 'Slot');
  eq('slot pertama ACTIVE di baris 7', dash.getRange(7, 1).getDisplayValue(), 'ACTIVE');
  eq('WORKER_1 di baris 8', dash.getRange(8, 1).getDisplayValue(), 'WORKER_1');
  eq('label progres', dash.getRange(2, 5).getDisplayValue(), 'Overall Progress');
  eq('progres akhir 1', dash.getRange(2, 6).getDisplayValue(), '1');
  eq('judul histori di baris 18', dash.getRange(18, 1).getDisplayValue().indexOf('EVENT HISTORY'), 0);
  eq('header histori di baris 19', dash.getRange(19, 1).getDisplayValue(), 'Slot');
  ok('event history terisi', dash.getRange(20, 1).getDisplayValue().length > 0);
  ok('stempel waktu format yyyy-MM-dd HH:mm:ss',
     /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dash.getRange(2, 2).getDisplayValue()),
     dash.getRange(2, 2).getDisplayValue());
}

/* ===================================================================== */
section('9. WRITE-BACK REKAP + STATUS/STOP/RESTART');
{
  const { world, sandbox, runId } = e2e;
  const rekap = world.master.getSheetByName('Rekap Approved');
  const fb = rekap.getRange(5, 8, 60, 1).getDisplayValues().map(r => r[0]).filter(Boolean);
  ok('feedback ditulis ke Rekap', fb.length > 0, 'n=' + fb.length);
  ok('ada VALIDASI OK', fb.some(t => /VALIDASI OK/.test(t)));
  ok('ada PERLU REVISI', fb.some(t => /PERLU REVISI/.test(t)));

  const st = sandbox.RSC_STANDARD_BULK_STATUS_20260814();
  eq('status melaporkan total yang sama', st.total, e2e.stats.total);

  const stop = sandbox.RSC_STANDARD_BULK_STOP_20260814();
  ok('stop melepas trigger', stop.stopped === true);
  eq('state jadi STOPPED', sandbox.rscGetProp_('RSC_STD_V27_RUN_STATE', ''), 'STOPPED');

  const restart = sandbox.RSC_PERF17_RESTART_BULK_FROM_TOP_20260819();
  ok('restart membuat Run ID baru', restart.runId !== runId);
  const fresh = sandbox.rscQueueStats_(world.master, restart.runId);
  eq('antrean dibangun ulang penuh', fresh.total, e2e.stats.total);
  eq('semua non-skip belum selesai', fresh.unfinished, fresh.total - fresh.skipped);
}

/* ===================================================================== */
section('10. TANPA DB: RULE DB DILEWATI, BUKAN HARD_ERROR');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env, { dbId: '' });
  const start = sandbox.RSC_STANDARD_BULK_START_20260814();
  drainTriggers(world.env, sandbox, 500);
  const runId = sandbox.rscGetProp_('RSC_STD_V27_RUN_ID', '');
  const st = sandbox.rscQueueStats_(world.master, runId);
  eq('antrean selesai tanpa DB', st.unfinished, 0);
  eq('tidak ada HARD_ERROR "LOOKUP REQUIRED"', st.hard, 0);
  ok('sebagian file tetap COMPLETE_OK', st.ok > 0, 'ok=' + st.ok);
  const masters = sandbox.rscLoadMasters_(world.master);
  ok('dicatat sebagai catatan, bukan kegagalan',
     masters.notes.some(n => /dilewati/.test(n)), JSON.stringify(masters.notes));
}

/* ===================================================================== */
section('11. IDEMPOTENSI');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  const s1 = sandbox.RSC_STANDARD_BULK_START_20260814();
  drainTriggers(world.env, sandbox, 500);
  const a = sandbox.rscQueueStats_(world.master, sandbox.rscGetProp_('RSC_STD_V27_RUN_ID', ''));
  const s2 = sandbox.RSC_PERF17_RESTART_BULK_FROM_TOP_20260819();
  drainTriggers(world.env, sandbox, 500);
  const b = sandbox.rscQueueStats_(world.master, s2.runId);
  eq('hasil run ke-2 identik (OK)', b.ok, a.ok);
  eq('hasil run ke-2 identik (error)', b.withErrors, a.withErrors);
  eq('hasil run ke-2 identik (hard)', b.hard, a.hard);
}

/* ===================================================================== */
console.log('\n' + '='.repeat(70));
console.log('HASIL: ' + PASS + ' lulus, ' + FAIL.length + ' gagal');
console.log('Metrik: ' + JSON.stringify(require('./gas_stubs').METRICS));
if (FAIL.length) { FAIL.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('SEMUA UJI LULUS');
