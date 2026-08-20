'use strict';
/**
 * Uji terhadap bentuk NYATA database master:
 *  - m_bp_relation : COMPACT_JSON (satu sel berisi array JSON), tanpa header,
 *                    baris pertama berupa URL.
 *  - m_sales_info  : header CSV asli, tanggal epoch milidetik.
 *  - m_bp_general_view / m_visit_schedule : header biasa.
 */
const { FakeSpreadsheet } = require('./gas_stubs');
const { buildWorld, loadScript } = require('./world');

let PASS = 0; const FAIL = [];
function ok(n, c, x) { if (c) { PASS++; console.log('  ok   ' + n); } else { FAIL.push(n + (x ? ' :: ' + x : '')); console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } }
function eq(n, a, b) { ok(n + ' (' + a + ' == ' + b + ')', String(a) === String(b), 'got ' + a + ' want ' + b); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

const DB_ID = '1psDMLLr98FuHjKhhfBTwg8p0kBA3w26xrdXb6_tu7CU';
const REL_ID = '1JGo50yPN-Sei56O6eUc-QWONrlDxlWcV2cRhlsME7Cg';

/** Baris m_bp_relation disalin apa adanya dari isi file (format COMPACT_JSON). */
const REL_PAYLOAD = [
  ['110625404', 'ZWS014', 'S091110370', '2026-03-01', '2026-04-30'],
  ['110223729', 'ZWS006', 'S091210238', '2026-03-01', '9999-12-31'],
  ['110221303', 'ZWS015', 'S091120232', '2026-08-01', '9999-12-31'],
  ['110323831', 'ZWS003', 'S0000M5BE0', '2026-08-01', '9999-12-31'],
  ['110027974', 'ZWS003', 'S091040638', '2026-03-01', '2026-04-30'],
  ['110027974', 'ZWS015', 'S091040962', '2026-05-01', '2026-06-30'],
  ['110111548', 'ZWS013', 'S091050150', '2026-03-01', '2026-05-31'],
  ['110111548', 'ZWS004', 'S091050182', '2026-06-01', '9999-12-31'],
  ['110094788', 'ZWS003', 'S099999999', '2026-03-01', '9999-12-31'],
  ['110221303', 'ZWS015', 'S091120232', '2026-03-01', '2026-08-31']
];

/** Header dan baris m_sales_info persis seperti ekspor CSV aslinya. */
const SALES_HEADER = ['id', 'sls_org', 'sls_office', 'salesman_id', 'salesman_name', 'sales_type',
  'sales_type_desc', 'coverage', 'coverage_desc', 'valid_from', 'valid_to',
  'created_by', 'created_at', 'updated_by', 'updated_at'];
const SALES_ROWS = [
  ['24765', 'STA1', '2BZ0', 'S091230101', '', '14', 'CORPORATE RETAIL', 'DK', 'Dalam Kota', '1787097600000', '253402214400000', '11825', '1787106513767', '', ''],
  ['21291', 'STA1', '2CF0', 'S092250070', 'Pidi Pirmansyah', '11', 'CORPORATE FOOD', 'DK', 'Dalam Kota', '1772323200000', '253402214400000', '', '1762168166982', '', '1762168166982'],
  ['21320', 'STA1', '2AH0', 'S091190021', 'Riki Isnendar', '17', 'KEY ACCOUNT FOOD', 'DK', 'Dalam Kota', '1772323200000', '1780185600000', '', '1762168166982', '', '1762168166982'],
  ['99001', 'STA1', '2BA0', 'S091010486', 'Salesman Uji', '11', 'CORPORATE FOOD', 'DK', 'Dalam Kota', '1772323200000', '253402214400000', '', '', '', '']
];

/** Dunia uji dengan dua spreadsheet DB, sesuai kondisi produksi. */
function withRealDb(relInSeparateFile) {
  const world = buildWorld({ dbPadding: 0 });
  world.env.files.delete('DB_MASTER_ID');
  world.env.setClock('2026-08-19T00:00:00Z');   // jam dipatok agar uji deterministik

  const mainDb = new FakeSpreadsheet(DB_ID, 'Database', { isDb: true });
  mainDb.addSheet('m_sales_info', [SALES_HEADER].concat(SALES_ROWS));
  mainDb.addSheet('m_bp_general_view', [
    ['bp_id', 'sls_office', 'bp_type_id', 'bp_name'],
    ['110094788', '2BA0', 'ZD01', 'Toko Uji'],
    ['110625404', '2AA0', 'ZD01', 'Toko Lain'],
    ['110223729', '2BA0', 'ZD01', 'Toko CSO'],
    // m_bp_general_view memuat seluruh business partner, termasuk salesman.
    ['S091010486', '2BA0', 'ZD01', 'Salesman Uji'],
    ['S092250070', '2CF0', 'ZD01', 'Pidi Pirmansyah'],
    ['S091999999', '2BA0', 'ZD01', 'Salesman Tanpa Sales Info'],
    ['S091210238', '2BA0', 'ZD01', 'Salesman CSO'],
    ['S0000M2AA0', '2AA0', 'ZD01', 'Dummy Motoris']
  ]);
  mainDb.addSheet('catatan', [['ini tab bebas', 'bukan master']]);

  const relRows = [['https://docs.google.com/spreadsheets/d/' + DB_ID + '/edit?gid=1379118174']]
    .concat(REL_PAYLOAD.map(r => [JSON.stringify(r)]));

  let extra = [];
  if (relInSeparateFile) {
    const relDb = new FakeSpreadsheet(REL_ID, 'Database m_bp_relation', { isDb: true });
    relDb.addSheet('m_bp_relation', relRows);
    world.env.addFile(relDb);
    extra = [REL_ID];
  } else {
    mainDb.addSheet('m_bp_relation', relRows);
  }
  world.env.addFile(mainDb);

  const sandbox = loadScript(world.env, { dbId: DB_ID, extraDbIds: extra, dateNew: '2026-09-01', dateClose: '2026-08-31' });
  return { world, sandbox };
}

/* ===================================================================== */
section('D1. DUA SUMBER DB DARI PARAMETER .gs');
{
  const { sandbox } = withRealDb(true);
  const ids = sandbox.rscDbSources_();
  eq('dua spreadsheet terdaftar', ids.length, 2);
  eq('sumber utama = Database', ids[0], DB_ID);
  eq('sumber kedua = Database m_bp_relation', ids[1], REL_ID);
  eq('parameter dapat diubah tanpa menu', typeof sandbox.RSC_DB_PARAMETERS.spreadsheetId, 'string');
}

/* ===================================================================== */
section('D2. m_bp_relation COMPACT_JSON TANPA HEADER');
{
  const { sandbox } = withRealDb(false);
  const idx = sandbox.rscGetIndex_('RELATION');
  eq('index tersedia', idx.available, 'true');
  eq('mode COMPACT_JSON terdeteksi', idx.mode, 'COMPACT_JSON');
  eq('tab yang dipakai', idx.sheet, 'm_bp_relation');
  // Baris URL dikecualikan oleh deteksi layout (data mulai baris 2), bukan
  // disaring per baris, sehingga tidak pernah dibaca sebagai data sama sekali.
  eq('baris URL tidak ikut terbaca', idx.skippedRows, 0);

  // Patokan 2026-08-19 dengan grace 60 hari -> ambang 2026-06-20.
  // 2026-04-30 (2x) dan 2026-05-31 dibuang; 2026-06-30 dipertahankan.
  eq('baris kedaluwarsa dibuang', idx.expiredRows, 3);
  eq('baris aktif terindeks', idx.rows, REL_PAYLOAD.length - 3);
  ok('URL tidak menjadi key', !Object.keys(idx.map).some(k => k.indexOf('HTTPS') === 0));

  const rec = idx.map['110027974'];
  ok('hanya relasi dalam masa grace tersimpan', rec && rec.length === 1, JSON.stringify(rec));
  eq('kolom Relationship', rec[0][0], 'ZWS015');
  eq('kolom Salesman ID', rec[0][1], 'S091040962');
  eq('kolom Valid To', rec[0][3], '2026-06-30');
  eq('relasi open-ended tersimpan', idx.map['110223729'][0][3], '9999-12-31');
}

/* ===================================================================== */
section('D3. m_bp_relation DI SPREADSHEET TERPISAH');
{
  const { sandbox } = withRealDb(true);
  const idx = sandbox.rscGetIndex_('RELATION');
  eq('index tersedia dari sumber kedua', idx.available, 'true');
  eq('diambil dari file yang benar', idx.source, 'Database m_bp_relation');
  eq('jumlah baris sama', idx.rows, REL_PAYLOAD.length - 3);
}

/* ===================================================================== */
section('D4. m_sales_info: HEADER CSV + EPOCH MILIDETIK');
{
  const { sandbox } = withRealDb(false);
  const idx = sandbox.rscGetIndex_('SALESMAN');
  eq('index tersedia', idx.available, 'true');
  eq('mode header', idx.mode, 'header');
  eq('tab yang dipakai', idx.sheet, 'm_sales_info');

  // valid_to 1780185600000 = 2026-05-31, di luar grace -> dibuang.
  eq('baris kedaluwarsa dibuang', idx.expiredRows, 1);
  eq('baris aktif terindeks', idx.rows, SALES_ROWS.length - 1);

  const rec = sandbox.rscRecObj_(idx, idx.map['S091230101'][0]);
  eq('sls_office -> Sales Office', rec['Sales Office'], '2BZ0');
  eq('sls_org -> Sales Organization', rec['Sales Organization'], 'STA1');
  eq('sales_type terbaca', rec['Sales Type'], '14');
  eq('coverage terbaca', rec['Coverage'], 'DK');

  eq('epoch 253402214400000 -> 9999-12-31', sandbox.rscDateStr_('253402214400000'), '9999-12-31');
  eq('epoch 1772323200000 -> 2026-03-01', sandbox.rscDateStr_('1772323200000'), '2026-03-01');
  eq('epoch 1780185600000 -> 2026-05-31', sandbox.rscDateStr_('1780185600000'), '2026-05-31');
  eq('epoch sebagai angka', sandbox.rscDateStr_(253402214400000), '9999-12-31');
  eq('serial spreadsheet tetap benar', sandbox.rscDateStr_('46266'), '2026-09-01');
  eq('teks tanggal tetap benar', sandbox.rscDateStr_('2026-09-01'), '2026-09-01');
}

/* ===================================================================== */
section('D5. RULE MEMAKAI DB NYATA');
{
  const { world, sandbox } = withRealDb(true);
  const spec = sandbox.rscPrimarySpec_();
  const masters = sandbox.rscLoadMasters_(world.master);
  ok('DB terdeteksi terkonfigurasi', masters.dbConfigured);
  ok('index RELATION termuat', masters.idx.RELATION.available);
  ok('index SALESMAN termuat', masters.idx.SALESMAN.available);
  ok('index BP termuat', masters.idx.BP.available);

  function row(over) {
    const base = ['2BA0', '2BA0', '110094788', 'ZWS004', 'S091010486', 'ZD01', '2026-09-01',
      '9999-12-31', 'F2', '03', 'W1W,W3W', '2026-09-01', '9999-12-31', 'Rolling', '', ''];
    Object.keys(over || {}).forEach(k => { base[k] = over[k]; });
    return base;
  }

  // R8b: key Customer+Relationship+Salesman+Valid To yang sudah ada di DB.
  // Baris Toko Bangkrut tidak pernah diperlakukan sebagai Change Schedule Only,
  // jadi hanya di situ R8b dapat menyala (baris non-TB dengan key sama justru
  // adalah definisi Change Schedule Only CASE 1).
  const r1 = sandbox.rscValidateValues_(spec, [row({
    2: '110221303', 3: 'ZWS015', 4: 'S091120232', 7: '2026-08-31', 12: '2026-08-31',
    11: '2026-01-01', 6: '2026-01-01', 13: 'Toko Bangkrut'
  })], masters);
  ok('R8b menyala saat key sudah ada di m_bp_relation',
     /\[R8\][^|]*R8b/.test(r1.detail[0]), r1.detail[0]);

  const r1b = sandbox.rscValidateValues_(spec, [row({ 2: '110223729', 3: 'ZWS006', 4: 'S091210238' })], masters);
  ok('key sama tanpa Toko Bangkrut = Change Schedule Only, bukan R8b',
     r1b.detail[0].indexOf('R8b') < 0 && r1b.ctx.rows[0].cso.mode === 'EXACT_REL_VALID_TO', r1b.detail[0]);

  const r2 = sandbox.rscValidateValues_(spec, [row({ 4: 'S091999999' })], masters);
  ok('R1A mendeteksi salesman normal di luar m_sales_info',
     /\[R1A\][^|]*m_sales_info/.test(r2.detail[0]), r2.detail[0]);

  const r3 = sandbox.rscValidateValues_(spec, [row({ 2: '110000000' })], masters);
  ok('R1 mendeteksi customer di luar m_bp_general_view',
     /\[R1\][^|]*Customer ID tidak ditemukan/.test(r3.detail[0]), r3.detail[0]);

  const r4 = sandbox.rscValidateValues_(spec, [row({ 4: 'S0000M2AA0' })], masters);
  ok('Dummy Salesman dikecualikan dari m_sales_info',
     r4.detail[0].indexOf('[R1A]') < 0, r4.detail[0]);

  const r5 = sandbox.rscValidateValues_(spec, [row({ 2: '110625404', 0: '2AA0', 1: '2AA0' })], masters);
  ok('kombinasi valid lolos R1 & R1A',
     r5.detail[0].indexOf('[R1]') < 0 && r5.detail[0].indexOf('[R1A]') < 0, r5.detail[0]);

  // Kebijakan tanggal periode: Rolling di-auto-replace, bukan dijadikan ERROR.
  const r6 = sandbox.rscValidateValues_(spec, [row({ 6: '2026-08-01' })], masters);
  eq('Rolling Valid From di-auto-replace ke dateNew', r6.ctx.rows[0].f['Valid From'], '2026-09-01');
  eq('mutasi tercatat', r6.mutatedRows, 1);
  ok('bukan ERROR karena sudah dibetulkan', r6.detail[0].indexOf('[R4]') < 0, r6.detail[0]);

  const r7 = sandbox.rscValidateValues_(spec, [row({ 13: 'Toko Bangkrut', 7: '9999-12-31' })], masters);
  ok('TB menolak Valid To open-ended', /\[TB\][^|]*Valid To harus 2026-08-31/.test(r7.detail[0]), r7.detail[0]);

  const r7b = sandbox.rscValidateValues_(spec, [row({ 13: 'Toko Bangkrut', 7: '', 12: '' })], masters);
  eq('Valid To Toko Bangkrut diisi otomatis saat kosong', r7b.ctx.rows[0].f['Valid To'], '2026-08-31');
  eq('Visit Valid To Toko Bangkrut diisi otomatis saat kosong',
     r7b.ctx.rows[0].f['Visit Valid To'], '2026-08-31');

  const r8 = sandbox.rscValidateValues_(spec, [row({ 7: '2026-12-31' })], masters);
  ok('R9A menuntut open-ended untuk Rolling normal',
     /\[R9A\][^|]*9999-12-31/.test(r8.detail[0]), r8.detail[0]);
}

/* ===================================================================== */
section('D6. CHANGE SCHEDULE ONLY DARI DB NYATA');
{
  const { world, sandbox } = withRealDb(true);
  const spec = sandbox.rscPrimarySpec_();
  const masters = sandbox.rscLoadMasters_(world.master);
  function row(over) {
    const base = ['2BA0', '2BA0', '110223729', 'ZWS006', 'S091210238', 'ZD01', '2026-09-01',
      '9999-12-31', 'F2', '03', 'W1W,W3W', '2026-09-01', '9999-12-31', 'Rolling', '', ''];
    Object.keys(over || {}).forEach(k => { base[k] = over[k]; });
    return base;
  }
  const r1 = sandbox.rscValidateValues_(spec, [row({})], masters);
  eq('CASE 1 terdeteksi dari m_bp_relation',
     r1.ctx.rows[0].cso && r1.ctx.rows[0].cso.mode, 'EXACT_REL_VALID_TO');
  const r2 = sandbox.rscValidateValues_(spec, [row({ 3: '' })], masters);
  eq('CASE 2 terdeteksi', r2.ctx.rows[0].cso && r2.ctx.rows[0].cso.mode, 'PAIR_NO_RELATION');
  ok('Relationship kosong tidak wajib pada CASE 2', r2.detail[0].indexOf('Relationship') < 0, r2.detail[0]);
  const r3 = sandbox.rscValidateValues_(spec, [row({}), row({})], masters);
  ok('CASE 1 dikecualikan dari duplicate R8', r3.detail[0].indexOf('[R8]') < 0, r3.detail[0]);
}

/* ===================================================================== */
section('D7. REGRESI: ALIAS PENDEK TIDAK MENYAMBAR TAB LAIN');
{
  const { sandbox } = withRealDb(false);
  eq('RELATION -> m_bp_relation', sandbox.rscGetIndex_('RELATION').sheet, 'm_bp_relation');
  eq('BP -> m_bp_general_view', sandbox.rscGetIndex_('BP').sheet, 'm_bp_general_view');
  const vs = sandbox.rscGetIndex_('VISIT');
  eq('VISIT tidak menyambar tab lain', vs.available, 'false');
  eq('alasan jelas', vs.reason, 'TABLE_NOT_FOUND');
  const rm = sandbox.rscRelationshipMaster_();
  eq('master Relationship dari parameter', rm.source, 'parameters');
  eq('jumlah tipe relationship', Object.keys(rm.map).length, 12);
  ok('tidak tercemar customer id', !Object.keys(rm.map).some(k => /^\d+$/.test(k)));
  eq('nama tab terpotong 31 karakter tetap dikenali',
     sandbox.rscSpecFor_('Change Rolling & Change Schedul').key, 'ROLLING');
}

/* ===================================================================== */
section('D8. INDEX BESAR DIMATERIALISASI KE SHEET');
{
  const { world, sandbox } = withRealDb(false);
  const METRICS = require('./gas_stubs').METRICS;
  sandbox.RSC_DB_PARAMETERS.cacheMaxBytes = 10;   // paksa jalur "terlalu besar untuk cache"

  const before = METRICS.dbRangeReads;
  const idx1 = sandbox.rscGetIndex_('RELATION');
  ok('index terbangun dari sumber', idx1.available && METRICS.dbRangeReads > before);
  eq('disimpan ke sheet index', idx1.storedIn, 'sheet');

  const storeId = sandbox.rscGetProp_('RSC_V29_INDEX_STORE_ID', '');
  ok('spreadsheet penampung dibuat', !!storeId, storeId);
  const idxSheet = world.env.files.get(storeId).getSheetByName('IDX_RELATION');
  ok('sheet IDX_RELATION ada', !!idxSheet);
  const idxRows = idxSheet.getRange(2, 1, idxSheet.getLastRow() - 1, 1).getDisplayValues()
    .map(r => String(r[0])).filter(k => k && k.charAt(0) !== '~');
  eq('baris index = jumlah key', idxRows.length, Object.keys(idx1.map).length);
  ok('agregat histori Toko Bangkrut ikut dimaterialisasi',
     idxSheet.getLastRow() - 1 > idxRows.length);

  const sandbox2 = loadScript(world.env, { dbId: DB_ID, dateNew: '2026-09-01' });
  sandbox2.RSC_DB_PARAMETERS.cacheMaxBytes = 10;
  const beforeCold = METRICS.dbRangeReads;
  const idx2 = sandbox2.rscGetIndex_('RELATION');
  eq('execution baru membaca dari sheet index', idx2.storedIn, 'sheet');
  eq('sumber DB tidak dibaca ulang', METRICS.dbRangeReads - beforeCold, 0);
  eq('isi index identik', Object.keys(idx2.map).length, Object.keys(idx1.map).length);

  world.env.files.get(DB_ID).lastUpdated = new Date(2026, 8, 1);
  world.env.advance(6 * 60 * 1000);              // lewati jendela stabil versi 5 menit
  const sandbox3 = loadScript(world.env, { dbId: DB_ID, dateNew: '2026-09-01' });
  sandbox3.RSC_DB_PARAMETERS.cacheMaxBytes = 10;
  const beforeStale = METRICS.dbRangeReads;
  const idx3 = sandbox3.rscGetIndex_('RELATION');
  ok('versi baru memicu pembangunan ulang', METRICS.dbRangeReads > beforeStale);
  eq('hasil tetap benar', Object.keys(idx3.map).length, Object.keys(idx1.map).length);
}

/* ===================================================================== */
section('D9. SNAPSHOT KECIL LEWAT CACHE + LOOKUP O(1)');
{
  const { sandbox } = withRealDb(false);
  const METRICS = require('./gas_stubs').METRICS;
  const idx = sandbox.rscGetIndex_('SALESMAN');
  eq('index kecil disimpan di cache', idx.storedIn, 'cache');

  const beforeLookup = METRICS.dbRangeReads;
  const keys = Object.keys(idx.map);
  eq('lookup tanpa baca sheet tambahan',
     Object.keys(sandbox.rscLookupMany_(idx, keys)).length, keys.length);
  eq('tidak ada pembacaan sheet saat lookup', METRICS.dbRangeReads - beforeLookup, 0);

  const beforeSecond = METRICS.dbRangeReads;
  sandbox.rscGetIndex_('SALESMAN');
  eq('pemanggilan index ke-2 tidak membaca sheet', METRICS.dbRangeReads - beforeSecond, 0);
}

/* ===================================================================== */
console.log('\n' + '='.repeat(70));
console.log('HASIL DB: ' + PASS + ' lulus, ' + FAIL.length + ' gagal');
if (FAIL.length) { FAIL.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('SEMUA UJI DB LULUS');
