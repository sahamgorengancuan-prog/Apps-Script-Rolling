'use strict';
/**
 * Uji terhadap bentuk nyata dua spreadsheet DB:
 *  - "Database m_bp_relation" : satu tab, TANPA header, baris 1 berisi URL,
 *                               kolom posisional cust|rel|salesman|from|to.
 *  - "Database"               : tab m_sales_info dengan header CSV dan
 *                               tanggal dalam epoch milidetik.
 */
const { FakeSpreadsheet } = require('./gas_stubs');
const { buildWorld, loadScript } = require('./world');

let PASS = 0; const FAIL = [];
function ok(n, c, x) { if (c) { PASS++; console.log('  ok   ' + n); } else { FAIL.push(n + (x ? ' :: ' + x : '')); console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } }
function eq(n, a, b) { ok(n + ' (' + a + ' == ' + b + ')', String(a) === String(b), 'got ' + a + ' want ' + b); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

const REL_ID = '1JGo50yPN-Sei56O6eUc-QWONrlDxlWcV2cRhlsME7Cg';
const DB_ID = '1psDMLLr98FuHjKhhfBTwg8p0kBA3w26xrdXb6_tu7CU';

/** Baris asli dari kedua spreadsheet (disalin apa adanya dari isi file). */
const REL_ROWS = [
  ['https://docs.google.com/spreadsheets/d/' + DB_ID + '/edit?gid=1379118174#gid=1379118174', '', '', '', ''],
  ['110625404', 'ZWS014', 'S091110370', '2026-03-01', '2026-04-30'],
  ['110223729', 'ZWS006', 'S091210238', '2026-03-01', '9999-12-31'],
  ['110221303', 'ZWS015', 'S091120232', '2026-08-01', '9999-12-31'],
  ['110323831', 'ZWS003', 'S0000M5BE0', '2026-08-01', '9999-12-31'],
  ['110027974', 'ZWS003', 'S091040638', '2026-03-01', '2026-04-30'],
  ['110027974', 'ZWS015', 'S091040962', '2026-05-01', '2026-06-30'],
  ['110111548', 'ZWS013', 'S091050150', '2026-03-01', '2026-05-31'],
  ['110111548', 'ZWS004', 'S091050182', '2026-06-01', '9999-12-31'],
  ['110094788', 'ZWS003', 'S099999999', '2026-03-01', '9999-12-31']
];

const SALES_HEADER = ['id', 'sls_org', 'sls_office', 'salesman_id', 'salesman_name', 'sales_type',
  'sales_type_desc', 'coverage', 'coverage_desc', 'valid_from', 'valid_to',
  'created_by', 'created_at', 'updated_by', 'updated_at'];
const SALES_ROWS = [
  ['24765', 'STA1', '2BZ0', 'S091230101', '', '14', 'CORPORATE RETAIL', 'DK', 'Dalam Kota', '1787097600000', '253402214400000', '11825', '1787106513767', '', ''],
  ['21291', 'STA1', '2CF0', 'S092250070', 'Pidi Pirmansyah', '11', 'CORPORATE FOOD', 'DK', 'Dalam Kota', '1772323200000', '253402214400000', '', '1762168166982', '', '1762168166982'],
  ['21320', 'STA1', '2AH0', 'S091190021', 'Riki Isnendar', '17', 'KEY ACCOUNT FOOD', 'DK', 'Dalam Kota', '1772323200000', '1780185600000', '', '1762168166982', '', '1762168166982'],
  ['99001', 'STA1', '2BA0', 'S091010486', 'Salesman Uji', '11', 'CORPORATE FOOD', 'DK', 'Dalam Kota', '1772323200000', '253402214400000', '', '', '', '']
];

function withRealDb() {
  const world = buildWorld({ dbPadding: 0 });
  // buang DB sintetis, ganti dengan bentuk nyata
  world.env.files.delete('DB_MASTER_ID');

  const relDb = new FakeSpreadsheet(REL_ID, 'Database m_bp_relation', { isDb: true });
  relDb.addSheet('m_bp_relation', REL_ROWS);
  world.env.addFile(relDb);

  const mainDb = new FakeSpreadsheet(DB_ID, 'Database', { isDb: true });
  mainDb.addSheet('m_sales_info', [SALES_HEADER].concat(SALES_ROWS));
  mainDb.addSheet('m_bp_general', [['bp_number', 'sls_office', 'bp_name'],
    ['110094788', '2BA0', 'Toko Uji'], ['110625404', '2AA0', 'Toko Lain']]);
  mainDb.addSheet('catatan', [['ini tab bebas', 'bukan master']]);
  world.env.addFile(mainDb);

  world.env.setClock('2026-08-19T00:00:00Z');   // jam dipatok agar uji deterministik
  const sandbox = loadScript(world.env);
  sandbox.rscSetDbSources_(
    'https://docs.google.com/spreadsheets/d/' + DB_ID + '/edit?usp=drive_link\n' +
    'https://docs.google.com/spreadsheets/d/' + REL_ID + '/edit?usp=drive_link');
  return { world, sandbox };
}

/* ===================================================================== */
section('D1. DUA SUMBER DB DARI SATU KALI TEMPEL');
{
  const { sandbox } = withRealDb();
  const ids = sandbox.rscDbSources_();
  eq('dua spreadsheet terdaftar', ids.length, 2);
  eq('sumber utama = Database', ids[0], DB_ID);
  eq('sumber kedua = Database m_bp_relation', ids[1], REL_ID);
}

/* ===================================================================== */
section('D2. m_bp_relation TANPA HEADER (mode posisional)');
{
  const { sandbox } = withRealDb();
  const idx = sandbox.rscGetIndex_('BP_RELATION');
  eq('index tersedia', idx.available, 'true');
  eq('terdeteksi mode posisional', idx.mode, 'positional');
  eq('diambil dari spreadsheet yang benar', idx.source, 'Database m_bp_relation');
  eq('baris URL di baris 1 dilewati', idx.skippedRows, 1);

  // Pruning: patokan 2026-08-19 dengan grace 60 hari -> ambang 2026-06-20.
  // Tiga baris (2x 2026-04-30, 1x 2026-05-31) dibuang; 2026-06-30 dipertahankan.
  eq('baris kedaluwarsa dibuang', idx.expiredRows, 3);
  eq('baris aktif terindeks', idx.rows, REL_ROWS.length - 1 - 3);
  ok('URL tidak masuk sebagai key', !Object.keys(idx.map).some(k => k.indexOf('HTTPS') === 0));

  const rec = idx.map['110027974'];
  ok('hanya relasi dalam masa grace yang tersimpan', rec && rec.length === 1, JSON.stringify(rec));
  eq('kolom Relationship terbaca', rec[0]['Relationship'], 'ZWS015');
  eq('kolom Salesman ID terbaca', rec[0]['Salesman ID'], 'S091040962');
  eq('kolom Valid To terbaca', rec[0]['Valid To'], '2026-06-30');

  const open = idx.map['110223729'];
  eq('relasi open-ended tersimpan', open[0]['Valid To'], '9999-12-31');
}

/* ===================================================================== */
section('D3. m_sales_info: HEADER CSV + TANGGAL EPOCH MILIDETIK');
{
  const { sandbox } = withRealDb();
  const idx = sandbox.rscGetIndex_('SALESMAN');
  eq('index tersedia', idx.available, 'true');
  eq('terdeteksi mode header', idx.mode, 'header');
  eq('tab yang dipakai', idx.sheet, 'm_sales_info');
  eq('jumlah baris', idx.rows, SALES_ROWS.length);

  const s1 = idx.map['S091230101'][0];
  eq('sls_office -> Sales Office', s1['Sales Office'], '2BZ0');
  eq('sls_org -> Sales Organization', s1['Sales Organization'], 'STA1');
  eq('sales_type terbaca', s1['Sales Type'], '14');

  // epoch milidetik harus jadi tanggal yang benar
  eq('epoch 253402214400000 -> 9999-12-31', sandbox.rscDateStr_('253402214400000'), '9999-12-31');
  eq('epoch 1772323200000 -> 2026-03-01', sandbox.rscDateStr_('1772323200000'), '2026-03-01');
  eq('epoch 1780185600000 -> 2026-05-31', sandbox.rscDateStr_('1780185600000'), '2026-05-31');
  eq('epoch sebagai angka (bukan teks)', sandbox.rscDateStr_(253402214400000), '9999-12-31');
  eq('serial spreadsheet tetap benar', sandbox.rscDateStr_('46235'), '2026-08-01');
  eq('teks tanggal tetap benar', sandbox.rscDateStr_('2026-08-01'), '2026-08-01');
}

/* ===================================================================== */
section('D4. RULE MEMAKAI DB NYATA (R8b, R9, R10)');
{
  const { world, sandbox } = withRealDb();
  const spec = sandbox.rscPrimarySpec_();
  const masters = sandbox.rscLoadMasters_(world.master);
  ok('DB terdeteksi terkonfigurasi', masters.dbConfigured);
  ok('index BP_RELATION termuat', masters.idx.BP_RELATION.available);
  ok('index SALESMAN termuat', masters.idx.SALESMAN.available);
  ok('index BP_GENERAL termuat', masters.idx.BP_GENERAL.available);

  function row(over) {
    const base = ['2BA0', '2BA0', '110094788', 'ZWS003', 'S091010486', 'ZD01', '2026-08-01',
      '9999-12-31', 'F2', '03', 'W1W,W3W', '2026-08-01', '9999-12-31', 'Rolling', '', ''];
    Object.keys(over || {}).forEach(k => { base[k] = over[k]; });
    return base;
  }

  // R8b: 110094788/ZWS003 di master masih dipegang S099999999 sampai 9999-12-31
  const r1 = sandbox.rscValidateValues_(spec, [row({})], masters);
  ok('R8b mendeteksi relasi aktif di master', r1.detail[0].indexOf('[R8]') >= 0 && /S099999999/.test(r1.detail[0]),
     r1.detail[0]);

  // R9: salesman tidak ada di m_sales_info
  const r2 = sandbox.rscValidateValues_(spec, [row({ 4: 'S091999999' })], masters);
  ok('R9 mendeteksi salesman di luar m_sales_info', /\[R9\][^|]*tidak ditemukan/.test(r2.detail[0]), r2.detail[0]);

  // R10: customer tidak ada di m_bp_general
  const r3 = sandbox.rscValidateValues_(spec, [row({ 2: '110000000' })], masters);
  ok('R10 mendeteksi customer di luar m_bp_general', /\[R10\][^|]*tidak ditemukan/.test(r3.detail[0]), r3.detail[0]);

  // R10: customer ada tetapi Sales Office tidak cocok
  const r4 = sandbox.rscValidateValues_(spec, [row({ 2: '110625404', 0: '2BA0', 1: '2BA0' })], masters);
  ok('R10 mendeteksi Sales Office tidak cocok', /\[R10\][^|]*2AA0/.test(r4.detail[0]), r4.detail[0]);

  // salesman & customer yang benar -> tidak ada error R9/R10
  const r5 = sandbox.rscValidateValues_(spec, [row({ 2: '110625404', 0: '2AA0', 1: '2AA0', 3: 'ZWS012' })], masters);
  ok('kombinasi valid lolos R9 & R10',
     r5.detail[0].indexOf('[R9]') < 0 && r5.detail[0].indexOf('[R10]') < 0, r5.detail[0]);
}

/* ===================================================================== */
section('D5. INVENTARISASI TAB (rscDiscoverDb)');
{
  const { world, sandbox } = withRealDb();
  const rows = sandbox.rscDiscoverDb();
  const sheet = world.master.getSheetByName('_RSC_DB_DISCOVERY');
  ok('sheet laporan dibuat', !!sheet);
  const body = rows.slice(1);
  const rel = body.find(r => r[2] === 'm_bp_relation');
  const sal = body.find(r => r[2] === 'm_sales_info');
  const bebas = body.find(r => r[2] === 'catatan');
  eq('m_bp_relation dipetakan', rel[6], 'BP_RELATION');
  eq('m_bp_relation mode posisional', rel[5], 'positional');
  eq('m_sales_info dipetakan', sal[6], 'SALESMAN');
  eq('m_sales_info mode header', sal[5], 'header');
  eq('tab bebas tidak dipetakan', bebas[6], '');
  const belum = body.filter(r => r[0] === '(belum ditemukan)').map(r => r[6]);
  ok('tabel yang belum ada tab-nya dilaporkan', belum.indexOf('VISIT_SCHEDULE') >= 0, JSON.stringify(belum));
  ok('laporan menampilkan header asli m_sales_info', /salesman_id/.test(sal[7]), sal[7]);
}

/* ===================================================================== */
section('D6. TABEL HILANG -> DILEWATI, BUKAN HARD_ERROR');
{
  const { world, sandbox } = withRealDb();
  const idx = sandbox.rscGetIndex_('VISIT_SCHEDULE');   // tab ini memang tidak ada
  eq('index ditandai tidak tersedia', idx.available, 'false');
  eq('alasan jelas', idx.reason, 'TABLE_NOT_FOUND');
  const masters = sandbox.rscLoadMasters_(world.master);
  ok('dicatat sebagai catatan, bukan error',
     masters.notes.some(n => /VISIT_SCHEDULE/.test(n) && /dilewati/.test(n)), JSON.stringify(masters.notes));

  const spec = sandbox.rscPrimarySpec_();
  const tb = ['2BA0', '2BA0', '110094788', 'ZWS003', 'S091010486', 'ZD01', '2026-08-01',
    '2026-08-31', 'F2', '03', 'W1W,W3W', '2026-08-01', '2026-08-31', 'Toko Bangkrut', '', ''];
  const res = sandbox.rscValidateValues_(spec, [tb], masters);
  ok('rule TB tidak menuduh key hilang saat master tidak ada',
     res.detail[0].indexOf('m_visit_schedule') < 0, res.detail[0]);
  ok('TB dicatat sebagai skipped', !!res.skipped['TB'], JSON.stringify(res.skipped));
}

/* ===================================================================== */
section('D7. REGRESI: ALIAS PENDEK TIDAK BOLEH MENYAMBAR TAB LAIN');
{
  const { world, sandbox } = withRealDb();
  // "Database" hanya punya m_sales_info, m_bp_general, catatan.
  // "Database m_bp_relation" hanya punya m_bp_relation.
  const rel = sandbox.rscGetIndex_('BP_RELATION');
  const gen = sandbox.rscGetIndex_('BP_GENERAL');
  const rt = sandbox.rscGetIndex_('RELATION_TYPE');
  eq('BP_RELATION -> m_bp_relation', rel.sheet, 'm_bp_relation');
  eq('BP_GENERAL -> m_bp_general', gen.sheet, 'm_bp_general');
  eq('RELATION_TYPE tidak menyambar m_bp_relation', rt.available, 'false');
  eq('RELATION_TYPE alasan', rt.reason, 'TABLE_NOT_FOUND');

  // master Relationship jatuh ke daftar bawaan, bukan data relasi customer
  const rm = sandbox.rscRelationshipMaster_();
  eq('master Relationship pakai daftar bawaan', rm.source, 'builtin');
  eq('jumlah tipe relationship', Object.keys(rm.map).length, 12);
  ok('tidak tercemar customer id', !Object.keys(rm.map).some(k => /^\d+$/.test(k)));

  // toleransi nama tab terpotong 31 karakter tetap berjalan
  const { FakeSpreadsheet } = require('./gas_stubs');
  const trunc = new FakeSpreadsheet('TRUNC_ID', 'DB Terpotong', { isDb: true });
  trunc.addSheet('Change Rolling & Change Schedul', [['a']]);
  const spec = sandbox.rscSpecFor_('Change Rolling & Change Schedul');
  eq('nama tab terpotong tetap dikenali', spec && spec.key, 'ROLLING');
}

/* ===================================================================== */
section('D8. INDEX BESAR DIMATERIALISASI KE SHEET, BUKAN GAGAL DI CACHE');
{
  const { world, sandbox } = withRealDb();
  const METRICS = require('./gas_stubs').METRICS;

  // Paksa jalur "terlalu besar untuk CacheService".
  sandbox.RSC_CFG.INDEX.CACHE_MAX_BYTES = 10;

  const before = METRICS.dbRangeReads;
  const idx1 = sandbox.rscGetIndex_('BP_RELATION');
  ok('index terbangun dari sumber', idx1.available && METRICS.dbRangeReads > before);
  eq('disimpan ke sheet index', idx1.storedIn, 'sheet');

  const storeId = sandbox.rscGetProp_('RSC_INDEX_STORE_ID', '');
  ok('spreadsheet penampung dibuat', !!storeId, storeId);
  const store = world.env.files.get(storeId);
  const idxSheet = store.getSheetByName('IDX_BP_RELATION');
  ok('sheet IDX_BP_RELATION ada', !!idxSheet);
  eq('baris index = jumlah key', idxSheet.getLastRow() - 1, Object.keys(idx1.map).length);

  // Execution baru: tidak boleh menyentuh sumber lagi.
  const sandbox2 = loadScript(world.env);
  sandbox2.RSC_CFG.INDEX.CACHE_MAX_BYTES = 10;
  const beforeCold = METRICS.dbRangeReads;
  const idx2 = sandbox2.rscGetIndex_('BP_RELATION');
  eq('execution baru membaca dari sheet index', idx2.storedIn, 'sheet');
  eq('sumber DB tidak dibaca ulang', METRICS.dbRangeReads - beforeCold, 0);
  eq('isi index identik', Object.keys(idx2.map).length, Object.keys(idx1.map).length);
  eq('nilai identik', JSON.stringify(idx2.map['110027974']), JSON.stringify(idx1.map['110027974']));

  // Versi DB berubah -> index lama harus diabaikan dan dibangun ulang.
  // Versi sengaja distabilkan 5 menit agar DriveApp tidak dipanggil terus-menerus,
  // jadi jam dimajukan melewati jendela itu terlebih dahulu.
  world.env.files.get(REL_ID).lastUpdated = new Date(2026, 8, 1);
  world.env.files.get(DB_ID).lastUpdated = new Date(2026, 8, 1);
  world.env.advance(6 * 60 * 1000);
  const sandbox3 = loadScript(world.env);
  sandbox3.RSC_CFG.INDEX.CACHE_MAX_BYTES = 10;
  sandbox3.rscSetDbSources_(DB_ID + ',' + REL_ID);
  const beforeStale = METRICS.dbRangeReads;
  const idx3 = sandbox3.rscGetIndex_('BP_RELATION');
  ok('versi baru memicu pembangunan ulang', METRICS.dbRangeReads > beforeStale);
  eq('hasil tetap benar', Object.keys(idx3.map).length, Object.keys(idx1.map).length);
}

/* ===================================================================== */
section('D9. SNAPSHOT KECIL TETAP LEWAT CACHE');
{
  const { world, sandbox } = withRealDb();
  const METRICS = require('./gas_stubs').METRICS;
  const idx = sandbox.rscGetIndex_('SALESMAN');
  eq('index kecil disimpan di cache', idx.storedIn, 'cache');
  const sandbox2 = loadScript(world.env);
  const before = METRICS.dbRangeReads;
  const idx2 = sandbox2.rscGetIndex_('SALESMAN');
  eq('execution baru dilayani cache', idx2.storedIn, 'cache');
  eq('tanpa baca sumber', METRICS.dbRangeReads - before, 0);
}

/* ===================================================================== */
console.log('\n' + '='.repeat(70));
console.log('HASIL DB: ' + PASS + ' lulus, ' + FAIL.length + ' gagal');
if (FAIL.length) { FAIL.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('SEMUA UJI DB LULUS');
