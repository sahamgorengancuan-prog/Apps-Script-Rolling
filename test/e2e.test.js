'use strict';
/**
 * Uji end-to-end RollingSalesCenter.gs memakai data nyata dari
 * "USE THIS Template Rolling Sales 1 September 2026.xlsx".
 */
const { buildWorld, loadScript, drainTriggers, METRICS } = require('./world');

let PASS = 0;
const FAIL = [];
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  ok   ' + name); }
  else { FAIL.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) { ok(name + ' (' + a + ' == ' + b + ')', String(a) === String(b), 'got ' + a + ' want ' + b); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

function manifestRows(sandbox, master) {
  const sh = master.getSheetByName('_RSC_MANIFEST_V29');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 26).getDisplayValues();
}
const M = { RUN_ID: 0, FILE_ID: 1, MASTER_ROWS: 2, URL: 3, FILE_NAME: 4, STATUS: 5, ATTEMPTS: 6,
            WORKER: 7, LEASE: 8, ERROR_ROWS: 9, SUMMARY: 10, MESSAGE: 14, DEFERS: 22,
            NEXT_AT: 23, TOKEN: 24, ERR_KIND: 25 };

/* ======================================================================= */
section('1. SELF-TEST UNIT (rscSelfTest)');
{
  const { env, master } = buildWorld();
  const sandbox = loadScript(env);
  const r = sandbox.rscSelfTest();
  ok('rscSelfTest lulus semua (' + r.passed + ' assertion)', r.ok, r.failed.join(' | '));
}

/* ======================================================================= */
section('2. PIPELINE END-TO-END 62 LINK E');
let e2e = null;
{
  const world = buildWorld({ brokenLayout: [3], noAccess: [7] });
  const { env, master, db, fileIds } = world;
  const sandbox = loadScript(env);
  sandbox.PropertiesService.getScriptProperties().setProperty('RSC_DB_SPREADSHEET_ID', db.getId());
  sandbox.PropertiesService.getScriptProperties().setProperty('RSC_PERIOD_START', '2026-08-01');

  const readsBefore = METRICS.dbRangeReads;
  const start = sandbox.rscStartBulkValidation();
  eq('task unik dari kolom E', start.stats.tasks, fileIds.length);
  ok('link terbaca >= task', start.stats.links >= start.stats.tasks, 'links=' + start.stats.links);
  ok('link tidak valid ditandai SKIPPED', start.stats.skipped >= 1, 'skipped=' + start.stats.skipped);
  eq('4 lane dijadwalkan', start.armed, 4);

  const drain = drainTriggers(env, sandbox, 400);
  const stats = sandbox.rscQueueStats_(master, start.runId);
  e2e = { sandbox, master, db, stats, drain, start, env, fileIds, readsBefore };

  console.log('  -> iterasi worker: ' + drain.iterations + ', stats: ' + JSON.stringify(stats));
  eq('tidak ada task tersisa', stats.unfinished, 0);
  eq('total task', stats.total, fileIds.length + start.stats.skipped);
  ok('ada file COMPLETE_OK', stats.ok > 0, 'ok=' + stats.ok);
  ok('ada file COMPLETE_WITH_ERRORS', stats.withErrors > 0, 'withErrors=' + stats.withErrors);
  eq('progress 100%', stats.progress, 1);
}

/* ======================================================================= */
section('3. KEBENARAN HASIL VALIDASI DI FILE ANAK');
{
  const { sandbox, env, fileIds } = e2e;
  let okFiles = 0, errFiles = 0, blankStatus = 0;
  fileIds.forEach((f, idx) => {
    if (idx === 7) return;                       // file sengaja tanpa akses
    const child = env.files.get(f.id);
    const sh = child.getSheetByName('Change Rolling & Change Schedule');
    const last = sh.getLastRow();
    if (last < 2) return;
    const vals = sh.getRange(2, 15, last - 1, 2).getDisplayValues();
    let hasErr = false, hasOk = false;
    vals.forEach(v => {
      if (v[0] === 'ERROR') { hasErr = true; if (!v[1]) blankStatus++; }
      else if (v[0] === 'OK') hasOk = true;
    });
    if (hasErr) errFiles++; else if (hasOk) okFiles++;
  });
  ok('file bersih menghasilkan status OK', okFiles > 0, 'okFiles=' + okFiles);
  ok('file bermasalah menghasilkan status ERROR', errFiles > 0, 'errFiles=' + errFiles);
  eq('setiap ERROR punya Error Detail', blankStatus, 0);

  // Cek isi detail pada dataset error yang asli (27 baris dari xlsx).
  const errChild = env.files.get(fileIds[2].id);
  const esh = errChild.getSheetByName('Change Rolling & Change Schedule');
  const detail = esh.getRange(2, 16, Math.min(10, esh.getLastRow() - 1), 1).getDisplayValues().map(r => r[0]).join(' ');
  ok('R7 konflik schedule terdeteksi pada data asli', detail.indexOf('[R7]') >= 0, detail.slice(0, 160));
  ok('R8 duplikat terdeteksi pada data asli', detail.indexOf('[R8]') >= 0, detail.slice(0, 160));
}

/* ======================================================================= */
section('4. [F4] SATU FILE HANYA DIPROSES SATU LANE');
{
  const { sandbox, master, start, fileIds } = e2e;
  const rows = manifestRows(sandbox, master);
  const seen = {};
  let dup = 0;
  rows.forEach(r => { if (r[M.FILE_ID]) { seen[r[M.FILE_ID]] = (seen[r[M.FILE_ID]] || 0) + 1; if (seen[r[M.FILE_ID]] > 1) dup++; } });
  eq('tidak ada fileId duplikat di manifest', dup, 0);

  // claim dua kali berturut-turut tanpa commit harus disjoint
  const world2 = buildWorld();
  const sb2 = loadScript(world2.env);
  sb2.rscStartBulkValidation();
  const a = sb2.rscClaimBatch_(world2.master, sb2.rscGetProp_('RSC_RUN_ID', ''), 'WORKER_1', 4);
  const b = sb2.rscClaimBatch_(world2.master, sb2.rscGetProp_('RSC_RUN_ID', ''), 'WORKER_2', 4);
  const ids = new Set(a.map(t => t.fileId));
  const overlap = b.filter(t => ids.has(t.fileId)).length;
  eq('claim lane-1 dan lane-2 disjoint', overlap, 0);
  eq('lane 1 mendapat 4 task', a.length, 4);
  eq('lane 2 mendapat 4 task', b.length, 4);

  // commit dengan token basi harus ditolak, bukan menimpa
  const stale = { row: a[0].row, token: 'TOKEN-PALSU', attempts: 0, defers: 0 };
  const res = sb2.rscCommitOk_(world2.master, stale, { errorRows: 0 });
  eq('commit token basi ditolak', res.applied, 'false');
  eq('alasan penolakan', res.reason, 'CLAIM_TOKEN_MISMATCH');
}

/* ======================================================================= */
section('5. [F2] DB_BUSY TIDAK MENAMBAH ATTEMPTS');
{
  const world = buildWorld();
  const { env, master, db } = world;
  const sandbox = loadScript(env);
  sandbox.PropertiesService.getScriptProperties().setProperty('RSC_DB_SPREADSHEET_ID', db.getId());

  const start = sandbox.rscStartBulkValidation();

  // Paksa seluruh pembacaan index gagal dengan error INFRA (meniru DB BUSY).
  const realGetIndex = sandbox.rscGetIndex_;
  let busyCalls = 0;
  sandbox.rscGetIndex_ = function (t) {
    busyCalls++;
    throw new sandbox.RscInfraError(
      '[PERF19 DB BUSY] Serialized m_bp_relation reader sedang dipakai execution lain. purpose=RELATION_LEGACY');
  };

  const r1 = sandbox.rscWorker1();
  ok('bundle di-defer karena INFRA', r1.reason === 'MASTER_INFRA', JSON.stringify(r1));

  let rows = manifestRows(sandbox, master).filter(r => r[M.STATUS] === 'DEFERRED');
  ok('ada task berstatus DEFERRED', rows.length > 0, 'n=' + rows.length);
  eq('Attempts tetap 0 saat DB busy', rows[0][M.ATTEMPTS], '0');
  eq('Defers bertambah', rows[0][M.DEFERS], '1');
  eq('jenis error tercatat INFRA', rows[0][M.ERR_KIND], 'INFRA');
  ok('pesan menyebut tanpa menambah Attempts', /tanpa menambah Attempts/i.test(rows[0][M.MESSAGE]), rows[0][M.MESSAGE]);
  ok('tidak ada HARD_ERROR dari DB busy',
     manifestRows(sandbox, master).every(r => r[M.STATUS] !== 'HARD_ERROR'));

  // Ulangi berkali-kali: tetap tidak boleh menjadi HARD_ERROR.
  for (let i = 0; i < 6; i++) {
    manifestRows(sandbox, master).forEach((r, idx) => {
      if (r[M.STATUS] === 'DEFERRED') {
        master.getSheetByName('_RSC_MANIFEST_V29').getRange(idx + 2, M.NEXT_AT + 1).setValue('');
      }
    });
    sandbox.rscWorker1();
  }
  const after = manifestRows(sandbox, master);
  eq('masih nol HARD_ERROR setelah 7x DB busy', after.filter(r => r[M.STATUS] === 'HARD_ERROR').length, 0);
  eq('Attempts tetap 0 setelah 7x DB busy',
     after.filter(r => Number(r[M.ATTEMPTS] || 0) > 0).length, 0);
  ok('defer berlebih menjadi BLOCKED_INFRA, bukan HARD_ERROR',
     after.some(r => r[M.STATUS] === 'BLOCKED_INFRA' || r[M.STATUS] === 'DEFERRED'));

  // Setelah DB pulih, task yang sama harus selesai normal tanpa penalti attempt.
  sandbox.rscGetIndex_ = realGetIndex;
  manifestRows(sandbox, master).forEach((r, idx) => {
    const sh = master.getSheetByName('_RSC_MANIFEST_V29');
    if (r[M.STATUS] === 'DEFERRED' || r[M.STATUS] === 'BLOCKED_INFRA') {
      sh.getRange(idx + 2, M.STATUS + 1).setValue('QUEUED');
      sh.getRange(idx + 2, M.NEXT_AT + 1).setValue('');
    }
  });
  drainTriggers(env, sandbox, 400);
  const finalStats = sandbox.rscQueueStats_(master, start.runId);
  eq('pulih: tidak ada sisa antrean', finalStats.unfinished, 0);
  eq('pulih: tidak ada HARD_ERROR', finalStats.hard, 0);
}

/* ======================================================================= */
section('6. [F1] LEASE PER-RESOURCE TIDAK SALING BLOK');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env);
  sandbox.PropertiesService.getScriptProperties().setProperty('RSC_DB_SPREADSHEET_ID', world.db.getId());

  const tokA = sandbox.rscLeaseAcquire_('IDX:BP_GENERAL:v1', 60000);
  const tokB = sandbox.rscLeaseAcquire_('IDX:VISIT_SCHEDULE:v1', 60000);
  ok('resource berbeda dapat lease bersamaan', !!tokA && !!tokB && tokA !== tokB);

  const tokDup = sandbox.rscLeaseAcquire_('IDX:BP_GENERAL:v1', 60000);
  eq('resource sama tidak dapat lease ganda', tokDup, '');

  sandbox.rscLeaseRelease_('IDX:BP_GENERAL:v1', 'TOKEN-SALAH');
  eq('lease tidak bisa dilepas token asing', sandbox.rscLeaseAcquire_('IDX:BP_GENERAL:v1', 60000), '');

  sandbox.rscLeaseRelease_('IDX:BP_GENERAL:v1', tokA);
  ok('lease bisa dilepas token pemilik', !!sandbox.rscLeaseAcquire_('IDX:BP_GENERAL:v1', 60000));

  // lease kedaluwarsa otomatis (execution mati)
  sandbox.rscLeaseAcquire_('IDX:EXPIRE:v1', -1000);
  ok('lease kedaluwarsa dapat diambil alih', !!sandbox.rscLeaseAcquire_('IDX:EXPIRE:v1', 60000));
}

/* ======================================================================= */
section('7. [F3] TIDAK ADA FULL-SCAN ULANG UNTUK RIBUAN ID');
{
  const before = METRICS.dbRangeReads;
  const world = buildWorld({ dbPadding: 12000 });   // master BP > 12.000 baris
  const sandbox = loadScript(world.env);
  sandbox.PropertiesService.getScriptProperties().setProperty('RSC_DB_SPREADSHEET_ID', world.db.getId());
  sandbox.PropertiesService.getScriptProperties().setProperty('RSC_PERIOD_START', '2026-08-01');

  const mid = METRICS.dbRangeReads;
  const idx1 = sandbox.rscGetIndex_('BP_GENERAL');
  const readsBuild = METRICS.dbRangeReads - mid;
  ok('index BP_GENERAL terbangun', idx1.available && idx1.rows > 12000, 'rows=' + idx1.rows);

  const beforeLookup = METRICS.dbRangeReads;
  const keys = Object.keys(idx1.map).slice(0, 5000);
  const hits = sandbox.rscLookupMany_(idx1, keys);
  eq('lookup 5.000 ID tanpa pembacaan sheet tambahan', METRICS.dbRangeReads - beforeLookup, 0);
  eq('semua ID ditemukan', Object.keys(hits).length, keys.length);

  // panggilan berikutnya harus dilayani cache/memori
  const beforeSecond = METRICS.dbRangeReads;
  sandbox.rscGetIndex_('BP_GENERAL');
  eq('pemanggilan index ke-2 tidak membaca sheet', METRICS.dbRangeReads - beforeSecond, 0);

  // simulasi execution baru: memori kosong, cache tetap dipakai
  const sandbox2 = loadScript(world.env);
  sandbox2.PropertiesService.getScriptProperties().setProperty('RSC_DB_SPREADSHEET_ID', world.db.getId());
  const beforeCold = METRICS.dbRangeReads;
  const idx2 = sandbox2.rscGetIndex_('BP_GENERAL');
  eq('execution baru memakai snapshot cache (0 baca sheet)', METRICS.dbRangeReads - beforeCold, 0);
  eq('isi index identik', idx2.rows, idx1.rows);
  ok('pembangunan awal memakai jendela baca terbatas', readsBuild <= 5, 'reads=' + readsBuild);
}

/* ======================================================================= */
section('8. [F5] WATCHDOG TIDAK LOOP SAAT AUTH MISMATCH');
{
  const world = buildWorld();
  const { env, master } = world;
  const sandbox = loadScript(env);
  sandbox.rscStartBulkValidation();
  eq('watchdog terpasang', env.triggers.filter(t => t.fn === 'rscWatchdog').length, 1);

  env.effectiveUser = 'orang.lain@wingscorp.com';
  const w1 = sandbox.rscWatchdog();
  eq('watchdog memblok sekali', w1.reason, 'AUTH_MISMATCH');
  eq('trigger watchdog dilepas', env.triggers.filter(t => t.fn === 'rscWatchdog').length, 0);
  ok('alasan blokir tersimpan untuk operator',
     /Bind Ulang Otorisasi/.test(sandbox.rscGetProp_('RSC_BLOCKED_REASON', '')));

  env.effectiveUser = 'paskalis.glennardo@wingscorp.com';
  sandbox.rscRebindAuthorization();
  eq('rebind memasang ulang watchdog', env.triggers.filter(t => t.fn === 'rscWatchdog').length, 1);
  eq('blokir dibersihkan', sandbox.rscGetProp_('RSC_BLOCKED_REASON', ''), '');
}

/* ======================================================================= */
section('9. ERROR AKSES & LAYOUT DIPERLAKUKAN SEBAGAI KEGAGALAN DATA');
{
  const { sandbox, master } = e2e;
  const rows = manifestRows(sandbox, master);
  const hard = rows.filter(r => r[M.STATUS] === 'HARD_ERROR');
  ok('file tanpa akses / layout rusak berakhir HARD_ERROR', hard.length >= 1, 'n=' + hard.length);
  ok('semua HARD_ERROR bukan berasal dari INFRA',
     hard.every(r => r[M.ERR_KIND] !== 'INFRA'), JSON.stringify(hard.map(r => r[M.ERR_KIND])));
  const layoutHard = hard.find(r => /Layout A:P/.test(r[M.SUMMARY]));
  ok('pesan layout memakai format FSD lama', !!layoutHard, hard.map(r => r[M.SUMMARY].slice(0, 80)).join(' | '));
  ok('pesan layout menunjuk kolom $D',
     !!layoutHard && /\$D: expected "Relationship", got ""/.test(layoutHard[M.SUMMARY]));
}

/* ======================================================================= */
section('10. DASHBOARD & WRITE-BACK REKAP');
{
  const { sandbox, master, start } = e2e;
  const dash = master.getSheetByName('Job Logging Details');
  eq('header dashboard di baris 6', dash.getRange(6, 1).getDisplayValue(), 'Slot');
  eq('slot pertama WORKER_1', dash.getRange(8, 1).getDisplayValue(), 'WORKER_1');
  eq('label progres', dash.getRange(2, 5).getDisplayValue(), 'Overall Progress');
  eq('progres akhir 1', dash.getRange(2, 6).getDisplayValue(), '1');
  ok('event history terisi', dash.getRange(20, 1).getDisplayValue().length > 0);
  ok('event history dibatasi', dash.getMaxRows() <= 20 + 400 + 5, 'rows=' + dash.getMaxRows());

  const rekap = master.getSheetByName('Rekap Approved');
  const fb = rekap.getRange(5, 8, 60, 1).getDisplayValues().map(r => r[0]).filter(Boolean);
  ok('feedback ditulis kembali ke Rekap Approved', fb.length > 0, 'n=' + fb.length);
  ok('ada feedback VALIDASI OK', fb.some(t => /VALIDASI OK/.test(t)));
  ok('ada feedback PERLU REVISI', fb.some(t => /PERLU REVISI/.test(t)));
}

/* ======================================================================= */
section('11. TANPA DB EKSTERNAL: RULE DB DILEWATI, BUKAN HARD_ERROR');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env);
  // sengaja TIDAK men-set RSC_DB_SPREADSHEET_ID
  sandbox.PropertiesService.getScriptProperties().setProperty('RSC_PERIOD_START', '2026-08-01');
  const start = sandbox.rscStartBulkValidation();
  drainTriggers(world.env, sandbox, 400);
  const st = sandbox.rscQueueStats_(world.master, start.runId);
  eq('antrean selesai tanpa DB', st.unfinished, 0);
  eq('tidak ada HARD_ERROR "LOOKUP REQUIRED"', st.hard, 0);
  ok('sebagian file tetap COMPLETE_OK', st.ok > 0, 'ok=' + st.ok);
  const masters = sandbox.rscLoadMasters_(world.master);
  ok('tercatat sebagai catatan, bukan kegagalan',
     masters.notes.some(n => /dilewati/.test(n)), JSON.stringify(masters.notes));
}

/* ======================================================================= */
section('12. IDEMPOTENSI & RESTART FROM TOP');
{
  const world = buildWorld();
  const sandbox = loadScript(world.env);
  sandbox.PropertiesService.getScriptProperties().setProperty('RSC_PERIOD_START', '2026-08-01');
  const s1 = sandbox.rscStartBulkValidation();
  drainTriggers(world.env, sandbox, 400);
  const a = sandbox.rscQueueStats_(world.master, s1.runId);

  const s2 = sandbox.rscRestartFromTop();
  ok('run ID berubah setelah restart', s2.runId !== s1.runId);
  const fresh = sandbox.rscQueueStats_(world.master, s2.runId);
  eq('antrean dibangun ulang penuh', fresh.total, a.total);
  eq('semua non-skip kembali belum selesai', fresh.unfinished, fresh.total - fresh.skipped);
  drainTriggers(world.env, sandbox, 400);
  const b = sandbox.rscQueueStats_(world.master, s2.runId);
  eq('hasil run ke-2 identik (OK)', b.ok, a.ok);
  eq('hasil run ke-2 identik (error)', b.withErrors, a.withErrors);
  eq('hasil run ke-2 identik (hard)', b.hard, a.hard);
}

/* ======================================================================= */
console.log('\n' + '='.repeat(70));
console.log('HASIL: ' + PASS + ' lulus, ' + FAIL.length + ' gagal');
console.log('Metrik: ' + JSON.stringify(require('./gas_stubs').METRICS));
if (FAIL.length) { FAIL.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('SEMUA UJI LULUS');
