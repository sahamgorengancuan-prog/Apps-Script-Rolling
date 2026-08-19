'use strict';
/**
 * Uji subsistem non-validasi yang ikut diport: job tanggal latar belakang,
 * setup template, Summary - CR, auto revamp, copy FINAL, compile upload ready,
 * auto-validate on edit, dan full pipeline.
 */
const { buildWorld, loadScript, drainTriggers, MANIFEST_SHEET } = require('./world');

let PASS = 0; const FAIL = [];
function ok(n, c, x) { if (c) { PASS++; console.log('  ok   ' + n); } else { FAIL.push(n + (x ? ' :: ' + x : '')); console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } }
function eq(n, a, b) { ok(n + ' (' + a + ' == ' + b + ')', String(a) === String(b), 'got ' + a + ' want ' + b); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

const ROLLING = 'Change Rolling & Change Schedule';

function fresh(cfg) {
  const world = buildWorld({ dbPadding: 0 });
  const sandbox = loadScript(world.env, Object.assign({ dbId: world.db.getId() }, cfg || {}));
  return { world, sandbox };
}

/* ===================================================================== */
section('F1. JOB "Fix G/L Reason Rolling"');
{
  const { world, sandbox } = fresh({ dateNew: '2026-09-01' });
  const child = world.env.files.get(world.fileIds[2].id);
  const sh = child.getSheetByName(ROLLING);
  const beforeVf = sh.getRange(2, 7).getDisplayValue();
  ok('data awal belum memakai dateNew', beforeVf !== '2026-09-01', beforeVf);

  const s = sandbox.RSC_START_FIX_ROLLING_REASON_DATES_BG_20260611();
  ok('job memproses file', s.processed > 0, JSON.stringify(s));
  ok('ada sel diperbarui', s.updated > 0, 'updated=' + s.updated);

  // Semua baris Reason=Rolling di file yang sudah diproses harus memakai dateNew.
  const n = sh.getLastRow() - 1;
  const reason = sh.getRange(2, 14, n, 1).getDisplayValues();
  const vf = sh.getRange(2, 7, n, 1).getDisplayValues();
  const vvf = sh.getRange(2, 12, n, 1).getDisplayValues();
  let bad = 0;
  for (let i = 0; i < n; i++) {
    if (String(reason[i][0]).trim() !== 'Rolling') continue;
    if (vf[i][0] !== '2026-09-01' || vvf[i][0] !== '2026-09-01') bad++;
  }
  eq('semua baris Rolling memakai dateNew', bad, 0);

  const tb = [];
  for (let i = 0; i < n; i++) if (String(reason[i][0]).trim() === 'Toko Bangkrut') tb.push(i);
  ok('ada baris Toko Bangkrut di fixture', tb.length > 0);
  ok('baris Toko Bangkrut tidak ikut diubah', vf[tb[0]][0] !== '2026-09-01', vf[tb[0]][0]);
}

/* ===================================================================== */
section('F2. JOB "Fix / Validate Toko Bangkrut Date"');
{
  const { world, sandbox } = fresh({ dateClose: '2026-08-31' });
  const s = sandbox.RSC_START_TOKO_BANGKRUT_DATES_BY_DB_20260622();
  ok('job memproses file', s.processed > 0, JSON.stringify(s));

  const child = world.env.files.get(world.fileIds[2].id);
  const sh = child.getSheetByName(ROLLING);
  const n = sh.getLastRow() - 1;
  const reason = sh.getRange(2, 14, n, 1).getDisplayValues();
  const vt = sh.getRange(2, 8, n, 1).getDisplayValues();
  const vvt = sh.getRange(2, 13, n, 1).getDisplayValues();
  let checked = 0, bad = 0;
  for (let i = 0; i < n; i++) {
    if (String(reason[i][0]).trim() !== 'Toko Bangkrut') continue;
    checked++;
    if (vt[i][0] !== '2026-08-31' || vvt[i][0] !== '2026-08-31') bad++;
  }
  ok('ada baris Toko Bangkrut diperiksa', checked > 0, 'checked=' + checked);
  eq('semua memakai dateClose', bad, 0);
}

/* ===================================================================== */
section('F3. JOB "Replace Dates by m_bp_relation"');
{
  const { world, sandbox } = fresh({ dateNew: '2026-09-01' });
  const s = sandbox.RSC_START_VALIDATE_DATE_IN_TEMPLATE_20260619();
  ok('job berjalan', s.processed > 0 || s.skipped > 0, JSON.stringify(s));

  const child = world.env.files.get(world.fileIds[2].id);
  const sh = child.getSheetByName(ROLLING);
  const n = sh.getLastRow() - 1;
  const reason = sh.getRange(2, 14, n, 1).getDisplayValues();
  const vf = sh.getRange(2, 7, n, 1).getDisplayValues();
  let bad = 0;
  for (let i = 0; i < n; i++) {
    if (String(reason[i][0]).trim() !== 'Rolling') continue;
    if (vf[i][0] !== '2026-09-01') bad++;
  }
  eq('histori DB tidak menarik mundur Reason=Rolling', bad, 0);
}

/* ===================================================================== */
section('F4. JOB RESUMABLE: CHECKPOINT + TRIGGER LANJUTAN');
{
  const { world, sandbox } = fresh();
  sandbox.RSC_JOB_ROLLING_DATES_.maxFilesPerRun = 3;
  const s1 = sandbox.RSC_START_FIX_ROLLING_REASON_DATES_BG_20260611();
  eq('putaran pertama dibatasi', s1.processed, 3);
  ok('checkpoint tersimpan', !!sandbox.rscBgState_('FIX_ROLLING_REASON_DATES'));
  eq('trigger lanjutan dijadwalkan',
     world.env.triggers.filter(t => t.fn === 'RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611').length, 1);

  const s2 = sandbox.RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611();
  ok('putaran kedua melanjutkan, bukan mengulang', s2.processed > s1.processed,
     s1.processed + ' -> ' + s2.processed);

  let guard = 0;
  while (sandbox.rscBgState_('FIX_ROLLING_REASON_DATES') && guard++ < 60) {
    sandbox.RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611();
  }
  ok('job selesai dan checkpoint dibersihkan', !sandbox.rscBgState_('FIX_ROLLING_REASON_DATES'));
  eq('trigger lanjutan dilepas',
     world.env.triggers.filter(t => t.fn === 'RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611').length, 0);
}

/* ===================================================================== */
section('F5. SETUP TEMPLATE');
{
  const { world, sandbox } = fresh();
  const child = world.env.files.get(world.fileIds[0].id);
  const sh = child.getSheetByName(ROLLING);
  sh.getRange(1, 4).setValue('');                    // rusak header $D
  ok('header sengaja dirusak', sh.getRange(1, 4).getDisplayValue() === '');

  world.env.setActive(child.getId());
  const n = sandbox.RSC_SETUP_ALL_TEMPLATES_20260611();
  ok('setup mengembalikan jumlah sheet', n >= 1, 'n=' + n);
  eq('header $D dipulihkan', sh.getRange(1, 4).getDisplayValue(), 'Relationship');
  eq('header kolom O', sh.getRange(1, 15).getDisplayValue(), 'Validation Status');
  eq('header kolom P', sh.getRange(1, 16).getDisplayValue(), 'Error Detail');
  eq('baris header dibekukan', sh.frozen, 1);
}

/* ===================================================================== */
section('F6. SUMMARY - CR');
{
  const { world, sandbox } = fresh();
  const child = world.env.files.get(world.fileIds[0].id);
  world.env.setActive(child.getId());
  const res = sandbox.RSC_GENERATE_CR_VISIT_SCHEDULE_SUMMARY_20260611();
  ok('summary dibuat', res && res.salesmen > 0, JSON.stringify(res));

  const sum = child.getSheetByName('Summary - CR');
  ok('sheet Summary - CR ada', !!sum);
  eq('kolom pertama', sum.getRange(1, 1).getDisplayValue(), 'Sales Office');
  eq('kolom kedua', sum.getRange(1, 2).getDisplayValue(), 'Salesman ID');
  eq('token pertama W1M', sum.getRange(1, 3).getDisplayValue(), 'W1M');
  eq('jumlah kolom token', sum.getLastColumn(), 2 + 28 + 1);
  eq('kolom terakhir Total', sum.getRange(1, sum.getLastColumn()).getDisplayValue(), 'Total');

  // Total per salesman harus sama dengan jumlah seluruh sel token pada barisnya.
  const row = sum.getRange(2, 3, 1, 28).getDisplayValues()[0].map(Number);
  const sumTokens = row.reduce((a, b) => a + b, 0);
  eq('Total konsisten dengan rincian token', sum.getRange(2, sum.getLastColumn()).getDisplayValue(), String(sumTokens));
}

/* ===================================================================== */
section('F7. AUTO TEMPLATE REVAMP (hanya COMPLETE_OK)');
{
  const { world, sandbox } = fresh();
  sandbox.RSC_STANDARD_BULK_START_20260814();
  drainTriggers(world.env, sandbox, 500);
  const runId = sandbox.rscGetProp_('RSC_STD_V27_RUN_ID', '');
  const stats = sandbox.rscQueueStats_(world.master, runId);
  ok('ada file COMPLETE_OK untuk di-revamp', stats.ok > 0, 'ok=' + stats.ok);

  const gate = sandbox.RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819();
  eq('gate menyalakan revamp', gate.started, 'true');
  eq('jumlah file sesuai COMPLETE_OK', gate.files, stats.ok);
  eq('trigger revamp terpasang',
     world.env.triggers.filter(t => t.fn === 'RSC_CONTINUE_TEMPLATE_REVAMP_INTEGRATED_20260723').length, 1);

  let guard = 0, s = null;
  do { s = sandbox.RSC_CONTINUE_TEMPLATE_REVAMP_INTEGRATED_20260723(); }
  while (s.index < s.files.length && guard++ < 60);
  eq('semua file COMPLETE_OK diproses', s.processed, stats.ok);
  eq('checkpoint dibersihkan', sandbox.rscGetProp_('RSC_TEMPLATE_REVAMP_JOB_JSON_20260722', ''), '');

  const status = sandbox.RSC_SHOW_TEMPLATE_REVAMP_STATUS_20260722();
  ok('status terbaca manusia, bukan JSON mentah',
     /File diproses/.test(status) && status.indexOf('{"index"') < 0, status.slice(0, 200));
  ok('status menyebut jumlah file yang benar',
     status.indexOf('File diproses    : ' + stats.ok) >= 0, status.slice(0, 200));
}

/* ===================================================================== */
section('F8. COPY TEMPLATE FINAL');
{
  const { world, sandbox } = fresh();
  const rekap = world.master.getSheetByName('Rekap Approved');
  // Baris 5 punya sumber di kolom D tetapi kolom E kosong.
  rekap.getRange(5, 1).setValue('2AA0');
  rekap.getRange(5, 2).setValue('STA Bogor');
  rekap.getRange(5, 4).setValue('https://docs.google.com/spreadsheets/d/' + world.fileIds[0].id + '/edit');
  rekap.getRange(5, 5).setValue('');

  const before = world.env.files.size;
  const s = sandbox.RSC_START_COPY_ROLLING_TEMPLATE_FILES_20260611();
  ok('ada file disalin', s.copied >= 1, JSON.stringify(s));
  ok('file baru terbentuk', world.env.files.size > before);
  const newLink = rekap.getRange(5, 5).getDisplayValue();
  ok('link FINAL ditulis kembali ke rekap', /\/d\/[A-Za-z0-9_-]+/.test(newLink), newLink);

  // Baris yang kolom FINAL-nya sudah valid tidak boleh disalin ulang.
  const again = sandbox.RSC_START_COPY_ROLLING_TEMPLATE_FILES_20260611();
  eq('tidak menyalin ulang baris yang sudah punya FINAL', again.copied, 0);
}

/* ===================================================================== */
section('F9. COMPILE UPLOAD READY');
{
  const { world, sandbox } = fresh();
  const rekap = world.master.getSheetByName('Rekap Approved');
  // Pastikan beberapa baris berstatus DONE.
  let done = 0;
  for (let r = 6; r <= 12; r++) {
    if (rekap.getRange(r, 5).getDisplayValue()) { rekap.getRange(r, 6).setValue('DONE'); done++; }
  }
  ok('ada baris DONE di rekap', done > 0, 'done=' + done);

  sandbox.RSC_STANDARD_BULK_START_20260814();
  drainTriggers(world.env, sandbox, 500);

  const rec = sandbox.RSC_UR_START_20260721();
  ok('compile menghasilkan file', !!rec && !!rec.id, JSON.stringify(rec));
  ok('ada baris ikut', rec.rows > 0, 'rows=' + rec.rows);

  const out = world.env.files.get(rec.id);
  ok('file keluaran ada di Drive', !!out);
  const sh = out.getSheets()[0];
  eq('kolom penelusuran pertama', sh.getRange(1, 1).getDisplayValue(), 'Sales Office Source');
  eq('kolom penelusuran kedua', sh.getRange(1, 2).getDisplayValue(), 'Source File');
  eq('header template menyusul', sh.getRange(1, 3).getDisplayValue(), 'Sales Office');
  eq('kolom terakhir sebelum status', sh.getRange(1, 16).getDisplayValue(), 'Reason');

  // Baris ERROR tidak boleh ikut ke hasil compile.
  ok('baris ERROR dilewati', rec.skippedError > 0, 'skipped=' + rec.skippedError);

  const dupBefore = sh.getLastRow();
  sandbox.RSC_UR_CLEANSE_DUPLICATE_OUTPUTS_20260724();
  ok('cleanse duplikat tidak menambah baris', sh.getLastRow() <= dupBefore);

  const st = sandbox.RSC_UR_STATUS_20260721();
  eq('status compile menyimpan id', st.id, rec.id);

  const purge = sandbox.RSC_V28_PURGE_ALL_COMPILE_TARGETS_20260814();
  ok('purge memindahkan file compile ke sampah', purge.trashed >= 1, JSON.stringify(purge));
}

/* ===================================================================== */
section('F10. AUTO VALIDATE ON EDIT (debounce)');
{
  const { world, sandbox } = fresh();
  const child = world.env.files.get(world.fileIds[0].id);
  world.env.setActive(child.getId());
  const sh = child.getSheetByName(ROLLING);

  const evt = { range: { getSheet: () => sh } };
  sandbox.RSC_V28_2_AUTHORIZED_ON_EDIT_20260814(evt);
  sandbox.RSC_V28_2_AUTHORIZED_ON_EDIT_20260814(evt);
  sandbox.RSC_V28_2_AUTHORIZED_ON_EDIT_20260814(evt);
  eq('burst edit hanya menjadwalkan satu worker',
     world.env.triggers.filter(t => t.fn === 'RSC_V28_2_AUTO_VALIDATE_WORKER_20260814').length, 1);

  // Masih dalam jendela debounce -> ditunda sekali lagi.
  const d = sandbox.RSC_V28_2_AUTO_VALIDATE_WORKER_20260814();
  eq('worker menunda saat edit masih baru', d.deferred, 'true');

  world.env.advance(10000);
  const r = sandbox.RSC_V28_2_AUTO_VALIDATE_WORKER_20260814();
  ok('validasi berjalan setelah jeda', r.rows > 0, JSON.stringify(r));
  eq('status tertulis di sheet', sh.getRange(2, 15).getDisplayValue().length > 0, 'true');
}

/* ===================================================================== */
section('F11. FULL PIPELINE (validate -> revamp -> compile)');
{
  const { world, sandbox } = fresh();
  const rekap = world.master.getSheetByName('Rekap Approved');
  for (let r = 6; r <= 12; r++) if (rekap.getRange(r, 5).getDisplayValue()) rekap.getRange(r, 6).setValue('DONE');

  sandbox.RSC_V28_FULL_PIPELINE_RUN_NOW_20260814();
  eq('fase awal VALIDATING', sandbox.rscGetProp_('RSC_V28_FULL_PIPELINE_PHASE', ''), 'VALIDATING');
  eq('watchdog pipeline terpasang',
     world.env.triggers.filter(t => t.fn === 'RSC_V28_FULL_PIPELINE_WATCHDOG_20260814').length, 1);

  drainTriggers(world.env, sandbox, 500);
  let guard = 0, phase = '';
  do {
    sandbox.RSC_V28_FULL_PIPELINE_WATCHDOG_20260814();
    // revamp berjalan lewat trigger tersendiri
    while (sandbox.rscGetProp_('RSC_TEMPLATE_REVAMP_JOB_JSON_20260722', '') && guard < 100) {
      sandbox.RSC_CONTINUE_TEMPLATE_REVAMP_INTEGRATED_20260723(); guard++;
    }
    phase = sandbox.rscGetProp_('RSC_V28_FULL_PIPELINE_PHASE', '');
  } while (phase !== 'DONE' && guard++ < 100);

  eq('pipeline mencapai DONE', phase, 'DONE');
  ok('waktu selesai tercatat', !!sandbox.rscGetProp_('RSC_V28_FULL_PIPELINE_LAST_FINISHED_AT', ''));
  ok('compile dijalankan di akhir pipeline',
     !!sandbox.rscGetProp_('RSC_UR_LAST_STATS_JSON_20260721', ''));

  const stop = sandbox.RSC_V28_FULL_PIPELINE_STOP_20260814();
  ok('stop melepas trigger', stop.removed >= 0);
  eq('automation dinonaktifkan', sandbox.rscGetProp_('RSC_V28_FULL_PIPELINE_ENABLED', ''), '');
}

/* ===================================================================== */
section('F12. HARD STOP MEMBLOKIR WORKER');
{
  const { world, sandbox } = fresh();
  sandbox.RSC_STANDARD_BULK_START_20260814();
  sandbox.RSC_PERF13_HARD_STOP_ALL_20260819();
  eq('flag HARD STOP aktif', sandbox.RSC_IS_HARD_STOPPED_(), 'true');
  const r = sandbox.RSC_STANDARD_BULK_WORKER_1_20260814();
  eq('worker menolak berjalan', r.reason, 'HARD_STOP');
  eq('semua trigger dilepas', world.env.triggers.length, 0);

  sandbox.RSC_PERF13_REARM_AFTER_HARD_STOP_20260819();
  eq('flag dicabut', sandbox.RSC_IS_HARD_STOPPED_(), 'false');
  ok('prewarm dijadwalkan ulang',
     world.env.triggers.filter(t => t.fn === 'RSC_PERF19_PREWARM_DB_INDEXES_20260819').length >= 1);
}

/* ===================================================================== */
console.log('\n' + '='.repeat(70));
console.log('HASIL FITUR: ' + PASS + ' lulus, ' + FAIL.length + ' gagal');
if (FAIL.length) { FAIL.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('SEMUA UJI FITUR LULUS');
