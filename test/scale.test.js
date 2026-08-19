'use strict';
/** Uji skala besar dan kasus tepi yang terlihat pada log produksi. */
const { FakeSpreadsheet, Environment, METRICS } = require('./gas_stubs');
const { buildWorld, loadScript, drainTriggers, MANIFEST_SHEET } = require('./world');

let PASS = 0; const FAIL = [];
function ok(n, c, x) { if (c) { PASS++; console.log('  ok   ' + n); } else { FAIL.push(n + (x ? ' :: ' + x : '')); console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } }
function eq(n, a, b) { ok(n + ' (' + a + ' == ' + b + ')', String(a) === String(b), 'got ' + a + ' want ' + b); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

const HEADER = ['Sales Office', 'Delivering Plant', 'Customer ID', 'Relationship', 'Salesman ID',
  'Salesman BP Type', 'Valid From', 'Valid To', 'Visit Category', 'Visit Type', 'Schedule Visit',
  'Visit Valid From', 'Visit Valid To', 'Reason', 'Validation Status', 'Error Detail'];

/* ===================================================================== */
section('S1. FILE 50.000 BARIS (setara STA Marunda 49.968 baris)');
{
  const world = buildWorld({ dbPadding: 0 });
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  
  const N = 50000;
  const rows = [HEADER.slice()];
  const days = ['M', 'T', 'W', 'TH', 'F', 'S'];
  for (let i = 0; i < N; i++) {
    const cust = 110000000 + Math.floor(i / 4);
    const d = days[i % days.length];
    rows.push(['2BA0', '2BA0', String(cust), ['ZWS003', 'ZWS004', 'ZWS006', 'ZWS013'][i % 4],
      'S09101' + String(1000 + (i % 900)).slice(0, 4), 'ZD01', '2026-08-01', '9999-12-31',
      'F2', '03', 'W1' + d + ',W3' + d, '2026-08-01', '9999-12-31', 'Rolling', '', '']);
  }
  const big = new FakeSpreadsheet('BIG_FILE_ID', 'Template Rolling Sales STA Marunda');
  big.addSheet('Change Rolling & Change Schedule', rows);
  world.env.addFile(big);

  const spec = sandbox.rscPrimarySpec_();
  const masters = {
    office: { available: true, map: { '2BA0': { code: '2BA0', desc: 'STA Kranggan Hub' } } },
    relationship: { available: true, map: { ZWS003: 'a', ZWS004: 'b', ZWS006: 'c', ZWS013: 'd' } },
    dateNew: '2026-08-01', dateClose: '2026-07-31', idx: {}
  };
  const t0 = Date.now();
  const res = sandbox.rscValidateValues_(spec, rows.slice(1), masters);
  const ms = Date.now() - t0;
  console.log('  -> ' + N + ' baris divalidasi dalam ' + ms + ' ms (' + Math.round(N / (ms / 1000)) + ' baris/detik)');
  eq('semua baris terbaca', res.rowCount, N);
  ok('waktu validasi wajar (< 10 detik untuk 50k baris)', ms < 10000, ms + 'ms');
  ok('tidak ada ledakan memori pesan',
     res.detail.every(d => d.length <= 4000), 'maks=' + Math.max.apply(null, res.detail.map(d => d.length)));
}

/* ===================================================================== */
section('S2. KONFLIK MASIF -> PESAN TETAP RINGKAS');
{
  const world = buildWorld({ dbPadding: 0 });
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  const spec = sandbox.rscPrimarySpec_();
  const masters = {
    office: { available: true, map: { '2BA0': { code: '2BA0' } } },
    relationship: { available: true, map: { ZWS003: 'a' } },
    dateNew: '2026-08-01', dateClose: '2026-07-31', idx: {}
  };
  // 3.000 baris: customer+salesman sama, schedule berbeda-beda -> R7 meledak
  const rows = [];
  const days = ['M', 'T', 'W', 'TH', 'F', 'S'];
  for (let i = 0; i < 3000; i++) {
    const d = days[i % days.length];
    rows.push(['2BA0', '2BA0', '110000001', 'ZWS003', 'S091010486', 'ZD01', '2026-08-01', '9999-12-31',
      'F2', '03', 'W1' + d + ',W3' + d, '2026-08-01', '9999-12-31', 'Rolling', '', '']);
  }
  const t0 = Date.now();
  const res = sandbox.rscValidateValues_(spec, rows, masters);
  const ms = Date.now() - t0;
  console.log('  -> 3.000 baris konflik total dalam ' + ms + ' ms');
  eq('semua baris ditandai error', res.errorRows, 3000);
  ok('R7 terdeteksi', res.detail[0].indexOf('[R7]') >= 0);
  ok('pesan dipotong, tidak menuliskan 3.000 nomor baris', res.detail[0].length <= 4000, 'len=' + res.detail[0].length);
  ok('pesan menyebut jumlah baris tersisa', /\+\d+ baris/.test(res.detail[0]) || /variasi lain/.test(res.detail[0]), res.detail[0].slice(0, 200));
  ok('waktu wajar', ms < 5000, ms + 'ms');
}

/* ===================================================================== */
section('S3. SEL TANGGAL ASLI (Date), ANGKA, DAN BOOLEAN');
{
  const world = buildWorld({ dbPadding: 0 });
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  const spec = sandbox.rscPrimarySpec_();
  const masters = {
    office: { available: true, map: { '2BA0': { code: '2BA0' } } },
    relationship: { available: true, map: { ZWS003: 'a' } },
    dateNew: '2026-08-01', dateClose: '2026-07-31', idx: {}
  };
  const row = ['2BA0', '2BA0', 110094788, 'ZWS003 - Sales Rep. Food', 'S091010486', 'ZD01',
    new Date(2026, 7, 1), new Date(9999, 11, 31), 'F2', '03', 'W1W,W3W',
    new Date(2026, 7, 1), new Date(9999, 11, 31), 'Rolling', '', ''];
  const res = sandbox.rscValidateValues_(spec, [row], masters);
  eq('baris dengan Date object valid', res.status[0], 'OK', res.detail[0]);
  eq('Customer ID numerik dinormalisasi', res.ctx.rows[0].f['Customer ID'], '110094788');
  eq('Relationship dropdown "KODE - Desc" dinormalisasi', res.ctx.rows[0].f['Relationship'], 'ZWS003');
  eq('Valid From dari Date object', res.ctx.rows[0].f['Valid From'], '2026-08-01');
  eq('Valid To open-ended dari Date object', res.ctx.rows[0].f['Valid To'], '9999-12-31');

  // Tanggal ambigu gaya lokal: 01/08/2026 harus dibaca 1 Agustus, bukan 8 Januari.
  const row2 = row.slice(); row2[6] = '01/08/2026';
  const res2 = sandbox.rscValidateValues_(spec, [row2], masters);
  eq('teks DD/MM/YYYY dibaca benar', res2.ctx.rows[0].f['Valid From'], '2026-08-01');
}

/* ===================================================================== */
section('S4. LINK =HYPERLINK PADA KOLOM E');
{
  const world = buildWorld({ dbPadding: 0 });
  const rekap = world.master.getSheetByName('Rekap Approved');
  const targetId = world.fileIds[0].id;
  // baris 5 (data pertama) diganti menjadi formula HYPERLINK
  rekap.getRange(5, 1).setValue('2AA0');
  rekap.getRange(5, 2).setValue('STA Bogor');
  rekap.getRange(5, 5).setValue('=HYPERLINK("https://docs.google.com/spreadsheets/d/' + targetId + '/edit","Buka Template")');
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  const start = sandbox.RSC_STANDARD_BULK_START_20260814();
  const rows = world.master.getSheetByName(MANIFEST_SHEET)
    .getRange(2, 1, 80, 26).getDisplayValues().filter(r => r[1]);
  ok('link dalam formula HYPERLINK tetap dikenali', rows.some(r => r[1] === targetId),
     'tidak menemukan ' + targetId);
}

/* ===================================================================== */
section('S5. FILE TANPA SHEET DIKENALI / SHEET KOSONG');
{
  const world = buildWorld({ dbPadding: 0 });
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  const empty = new FakeSpreadsheet(world.fileIds[0].id + 'X', 'Template Kosong');
  empty.addSheet('Sheet1', [['a', 'b']]);
  world.env.addFile(empty);
  let kind = null, msg = '';
  try {
    sandbox.rscProcessTask_({ fileId: empty.getId(), name: 'kosong' },
      { office: { available: false, map: {} }, relationship: { available: true, map: {} }, idx: {} });
  } catch (e) { kind = sandbox.rscClassify_(e).kind; msg = e.message; }
  eq('file tanpa sheet dikenali -> kegagalan DATA', kind, 'DATA');
  ok('pesan menjelaskan sheet yang dicari', /Change Rolling/.test(msg), msg);

  // sheet dikenali tetapi tanpa baris data
  const onlyHeader = new FakeSpreadsheet('ONLY_HEADER_ID', 'Template Header Saja');
  onlyHeader.addSheet('Change Rolling & Change Schedule', [HEADER.slice()]);
  world.env.addFile(onlyHeader);
  const r = sandbox.rscProcessTask_({ fileId: 'ONLY_HEADER_ID', name: 'header' },
    { office: { available: false, map: {} }, relationship: { available: true, map: {} }, idx: {} });
  eq('sheet kosong -> 0 baris, 0 error', r.rowCount + '/' + r.errorRows, '0/0');
}

/* ===================================================================== */
section('S6. LOCK GLOBAL SIBUK -> DEFER, BUKAN GAGAL');
{
  const world = buildWorld({ dbPadding: 0 });
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  sandbox.RSC_STANDARD_BULK_START_20260814();
  world.env.lockBusy = true;
  let kind = null;
  try { sandbox.rscClaimBatch_(world.master, sandbox.rscGetProp_('RSC_STD_V27_RUN_ID', ''), 'WORKER_1', 4); }
  catch (e) { kind = sandbox.rscClassify_(e).kind; }
  eq('lock global sibuk diklasifikasi INFRA', kind, 'INFRA');
  world.env.lockBusy = false;
  const got = sandbox.rscClaimBatch_(world.master, sandbox.rscGetProp_('RSC_STD_V27_RUN_ID', ''), 'WORKER_1', 4);
  eq('setelah lock bebas, claim berhasil', got.length, 4);
}

/* ===================================================================== */
section('S7. LANE MENGHORMATI BATAS WAKTU EKSEKUSI');
{
  const world = buildWorld({ dbPadding: 0 });
  const sandbox = loadScript(world.env, { dbId: world.db.getId() });
  sandbox.RSC_STANDARD_BULK_START_20260814();
  // Percepat deadline agar lane menyerah setelah 1 file.
  sandbox.RSC_STANDARD_VALIDATION_V27_20260814.workerSoftDeadlineMs = 1;
  const r = sandbox.RSC_STANDARD_BULK_WORKER_1_20260814();
  ok('lane berhenti sebelum kuota habis', r.claimed >= 1 && r.committed < r.claimed,
     JSON.stringify({ claimed: r.claimed, committed: r.committed }));
  const rows = world.master.getSheetByName(MANIFEST_SHEET).getRange(2, 1, 70, 26).getDisplayValues();
  const released = rows.filter(x => /tanpa penalti/.test(x[14]));
  ok('task yang belum dikerjakan dikembalikan tanpa penalti', released.length > 0, 'n=' + released.length);
  eq('task yang dilepas tidak menambah Attempts', released.filter(x => Number(x[6] || 0) > 0).length, 0);
  eq('task yang dilepas kembali QUEUED', released.filter(x => x[5] !== 'QUEUED').length, 0);
}

/* ===================================================================== */
console.log('\n' + '='.repeat(70));
console.log('HASIL SKALA: ' + PASS + ' lulus, ' + FAIL.length + ' gagal');
if (FAIL.length) { FAIL.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('SEMUA UJI SKALA LULUS');
