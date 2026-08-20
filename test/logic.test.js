'use strict';
/**
 * PERF26 — Business Logic Conformance.
 * Setiap bagian dokumen "PERF26 Business Logic Validation (Detailed)"
 * diuji satu per satu terhadap engine di RollingSalesCenter.gs.
 */
const { FakeSpreadsheet, METRICS } = require('./gas_stubs');
const { buildWorld, loadScript, drainTriggers, MANIFEST_SHEET } = require('./world');

let PASS = 0; const FAIL = [];
function ok(n, c, x) { if (c) { PASS++; console.log('  ok   ' + n); } else { FAIL.push(n + (x ? ' :: ' + x : '')); console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } }
function eq(n, a, b) { ok(n + ' (' + a + ' == ' + b + ')', String(a) === String(b), 'got ' + a + ' want ' + b); }
function has(n, detail, code) { ok(n, String(detail).indexOf('[' + code + ']') >= 0, String(detail).slice(0, 220)); }
function hasNot(n, detail, code) { ok(n, String(detail).indexOf('[' + code + ']') < 0, String(detail).slice(0, 220)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

const DB_ID = 'PERF26_DB';
const DATE_NEW = '2026-09-01';
const DATE_CLOSE = '2026-08-31';
const OPEN = '9999-12-31';

/* m_bp_relation (COMPACT_JSON): [customer, relationship, salesman, valid_from, valid_to] */
const REL = [
  ['110223729', 'ZWS006', 'S091210238', '2026-03-01', OPEN],   // CASE 1 + pair
  ['110221303', 'ZWS015', 'S091120232', '2026-03-01', DATE_CLOSE],
  ['110625404', 'ZWS014', 'S091110370', '2026-05-01', OPEN],   // Toko Bangkrut open-ended
  ['110625404', 'ZWS014', 'S091110370', '2026-01-01', '2026-04-30'],
  ['110000001', 'ZWS003', 'S091010486', '2026-02-01', '2026-07-31']  // hanya histori tertutup
];

function buildDb() {
  const db = new FakeSpreadsheet(DB_ID, 'PERF26 Database', { isDb: true });

  db.addSheet('m_bp_general_view', [
    ['bp_id', 'sls_office', 'bp_type_id', 'bp_name'],
    ['110094788', '2BA0', 'ZD01', 'Toko A'],
    ['110223729', '2BA0', 'ZD01', 'Toko B'],
    ['110221303', '2BA0', 'ZD01', 'Toko C'],
    ['110625404', '2BA0', 'ZD01', 'Toko D'],
    ['110000001', '2BA0', 'ZD01', 'Toko E'],
    ['S091010486', '2BA0', 'ZD01', 'Salesman Normal'],
    ['S091210238', '2BA0', 'ZD01', 'Salesman CSO'],
    ['S091120232', '2BA0', 'ZD01', 'Salesman TB'],
    ['S091110370', '2BA0', 'ZD01', 'Salesman TB2'],
    ['S091999999', '2BA0', 'ZD01', 'Salesman Tanpa Sales Info'],
    ['S0000M2AA0', '2BA0', 'ZD01', 'Dummy Motoris'],
    ['S000002AA0', '2BA0', 'ZD01', 'Dummy Nol'],
    ['S0000T2AA0', '2BA0', 'ZD01', 'Dummy T'],
    ['S0000S5AW0', '2BA0', 'ZD01', 'Dummy S'],
    ['S099887766', '2BA0', 'ZD01', 'Customer berformat S'],
    ['S091040638', '2BA0', 'ZD02', 'Salesman BP Type lain']
  ]);

  db.addSheet('m_sales_info', [
    ['id', 'sls_org', 'sls_office', 'salesman_id', 'salesman_name', 'sales_type', 'coverage', 'valid_from', 'valid_to'],
    ['1', 'STA1', '2BA0', 'S091010486', 'Normal', '11', 'DK', '1772323200000', '253402214400000'],
    ['2', 'STA1', '2BA0', 'S091210238', 'CSO', '11', 'DK', '1772323200000', '253402214400000'],
    ['3', 'STA1', '2BA0', 'S091120232', 'TB', '11', 'DK', '1772323200000', '253402214400000'],
    ['4', 'STA1', '2BA0', 'S091110370', 'TB2', '11', 'DK', '1772323200000', '253402214400000'],
    ['5', 'STA1', '2BA0', 'S091040638', 'Lain', '11', 'DK', '1772323200000', '253402214400000'],
    ['6', 'STA1', '2BA0', 'S099887766', 'Cust S', '11', 'DK', '1772323200000', '253402214400000']
  ]);

  db.addSheet('m_bp_relation',
    [['https://docs.google.com/spreadsheets/d/' + DB_ID + '/edit?gid=1379118174']]
      .concat(REL.map(r => [JSON.stringify(r)])));

  // m_visit_schedule: beberapa effective start date untuk satu key.
  db.addSheet('m_visit_schedule', [
    ['cust_id', 'salesman_id', 'visit_category', 'visit_type', 'visit_schedule', 'visit_valid_from', 'visit_valid_to'],
    ['110625404', 'S091110370', 'F1', '03', 'W1M', '2026-01-01', OPEN],
    ['110625404', 'S091110370', 'F1', '03', 'W1M', '2026-06-01', OPEN],
    ['110625404', 'S091110370', 'F1', '03', 'W1M', '2027-01-01', OPEN],
    ['110221303', 'S091120232', 'F2', '04', 'W1M,W3M', '2029-05-01', OPEN]
  ]);

  db.addSheet('m_rel_salesman_type_rlt', [
    ['rlt_id', 'rlt_desc'],
    ['ZWS003', 'Sales Rep. Food'],
    ['ZWS006', 'Sales Rep. Cosmetic'],
    ['ZWS014', 'Collector Frozen'],
    ['ZWS015', 'Collector Cosmetic'],
    ['ZWS040', 'Kode master tambahan']
  ]);
  return db;
}

function world() {
  const w = buildWorld({ dbPadding: 0 });
  w.env.files.delete('DB_MASTER_ID');
  w.env.setClock('2026-08-20T00:00:00Z');
  w.env.addFile(buildDb());
  const g = loadScript(w.env, { dbId: DB_ID, dateNew: DATE_NEW, dateClose: DATE_CLOSE });
  const spec = g.rscPrimarySpec_();
  const masters = g.rscLoadMasters_(w.master);
  return { w, g, spec, masters };
}

/** Baris Rolling standar yang lolos semua rule; `over` menimpa kolom by index. */
function baseRow(over) {
  const r = ['2BA0', '2BA0', '110094788', 'ZWS003', 'S091010486', 'ZD01', DATE_NEW, OPEN,
    'F2', '03', 'W1W,W3W', DATE_NEW, OPEN, 'Rolling', '', ''];
  Object.keys(over || {}).forEach(k => { r[k] = over[k]; });
  return r;
}

const C = { OFFICE: 0, PLANT: 1, CUST: 2, REL: 3, SLS: 4, BPTYPE: 5, VF: 6, VT: 7,
            CAT: 8, TYPE: 9, SCH: 10, VVF: 11, VVT: 12, REASON: 13 };

const ENV = world();
function run(rows) { return ENV.g.rscValidateValues_(ENV.spec, rows, ENV.masters); }
function one(over) { const r = run([baseRow(over)]); return { detail: r.detail[0], status: r.status[0], row: r.ctx.rows[0], res: r }; }

/* ===================================================================== */
section('L0. PRASYARAT — MASTER TERBACA');
{
  eq('DB terkonfigurasi', ENV.masters.dbConfigured, 'true');
  ok('index BP tersedia', ENV.masters.idx.BP.available, JSON.stringify(ENV.masters.idx.BP.reason));
  ok('index RELATION tersedia', ENV.masters.idx.RELATION.available, JSON.stringify(ENV.masters.idx.RELATION.reason));
  ok('index SALESMAN tersedia', ENV.masters.idx.SALESMAN.available, JSON.stringify(ENV.masters.idx.SALESMAN.reason));
  ok('index VISIT (m_visit_schedule) tersedia', ENV.masters.idx.VISIT.available, JSON.stringify(ENV.masters.idx.VISIT.reason));
  ok('master em tersedia', ENV.masters.office.available);
  eq('master Relationship dari m_rel_salesman_type_rlt', ENV.masters.relationship.source, 'm_rel_salesman_type_rlt');
  const base = one({});
  eq('baris standar OK', base.status, 'OK');
  eq('detail kosong', base.detail, '');
}

/* ===================================================================== */
section('L1. LAYOUT A:P (§2)');
{
  const H = ENV.spec.header;
  eq('16 kolom A:P', H.length, 16);
  eq('$A Sales Office', H[0], 'Sales Office');
  eq('$N Reason', H[13], 'Reason');
  eq('$O Validation Status', H[14], 'Validation Status');
  eq('$P Error Detail', H[15], 'Error Detail');
  eq('kolom status = 15', ENV.spec.statusCol, 15);
  eq('kolom error = 16', ENV.spec.errorCol, 16);
  const bad = H.slice(); bad[3] = '';
  const err = ENV.g.rscCheckLayout_(ENV.spec, bad);
  ok('header hilang = system error, bukan business error', /\$D: expected "Relationship"/.test(err), err);
  ok('layout benar tidak melapor', ENV.g.rscCheckLayout_(ENV.spec, H) === null);
}

/* ===================================================================== */
section('L2. CANONICALIZATION (§3)');
{
  const g = ENV.g;
  eq('label dropdown -> kode', g.RSC_STD_CANON_CODE_20260814_('ZWS001 - Sales Rep'), 'ZWS001');
  eq('apostrof di depan dibuang', g.RSC_STD_CANON_CODE_20260814_("'110094788"), '110094788');
  eq('NBSP dan zero-width dibuang', g.RSC_STD_CANON_CODE_20260814_(' ZWS0​03 '), 'ZWS003');
  eq('numeric .0', g.RSC_STD_CANON_CODE_20260814_('110094788.0'), '110094788');
  eq('scientific notation', g.RSC_STD_CANON_CODE_20260814_('1.10094788E8'), '110094788');
  eq('uppercase', g.RSC_STD_CANON_CODE_20260814_('zws003'), 'ZWS003');

  eq('Visit Type 1 -> 01', g.RSC_STD_CANON_VISIT_TYPE_20260814_('1'), '01');
  eq('Visit Type 01 tetap', g.RSC_STD_CANON_VISIT_TYPE_20260814_('01'), '01');
  eq('Visit Type 1.0 -> 01', g.RSC_STD_CANON_VISIT_TYPE_20260814_('1.0'), '01');
  eq('Visit Type 12 tetap', g.RSC_STD_CANON_VISIT_TYPE_20260814_('12'), '12');

  eq('schedule koma full-width', g.RSC_STD_CANON_SCHEDULE_20260814_('W1M，W3M'), 'W1M,W3M');
  eq('schedule whitespace dibuang', g.RSC_STD_CANON_SCHEDULE_20260814_('W1M, W3M'), 'W1M,W3M');
  eq('schedule uppercase', g.RSC_STD_CANON_SCHEDULE_20260814_('w1th,w3th'), 'W1TH,W3TH');

  const d1 = g.RSC_STD_CANON_DATE_20260814_('01/09/2026');
  eq('DD/MM/YYYY', d1.value, '2026-09-01');
  eq('DD-MM-YYYY', g.RSC_STD_CANON_DATE_20260814_('01-09-2026').value, '2026-09-01');
  eq('DD.MM.YYYY', g.RSC_STD_CANON_DATE_20260814_('01.09.2026').value, '2026-09-01');
  eq('YYYY/MM/DD', g.RSC_STD_CANON_DATE_20260814_('2026/09/01').value, '2026-09-01');
  eq('YYYY.MM.DD', g.RSC_STD_CANON_DATE_20260814_('2026.09.01').value, '2026-09-01');
  eq('ISO datetime', g.RSC_STD_CANON_DATE_20260814_('2026-09-01T00:00:00.000Z').value, '2026-09-01');
  eq('objek Date', g.RSC_STD_CANON_DATE_20260814_(new Date(2026, 8, 1)).value, '2026-09-01');
  const bad = g.RSC_STD_CANON_DATE_20260814_('31/02/2026');
  eq('tanggal kalender tidak valid tetap dibaca mentah', bad.value, '2026-02-31');
  ok('R4 yang menangkapnya', !g.rscIsValidDateStr_(bad.value));
  const junk = g.RSC_STD_CANON_DATE_20260814_('bukan tanggal');
  ok('teks acak terdeteksi terisi tapi tidak terbaca', junk.hadInput && !junk.parsed);

  // Whitespace pada Schedule dinormalisasi, jadi bukan ERROR (§3 catatan).
  const r = one({ [C.SCH]: 'W1W, W3W' });
  eq('W1W, W3W lolos setelah normalisasi', r.status, 'OK');
  eq('nilai canonical tersimpan', r.row.f['Schedule Visit'], 'W1W,W3W');

  const rDate = one({ [C.VVT]: '31/12/9999' });
  eq('tanggal DD/MM/YYYY dikanonikalkan', rDate.row.f['Visit Valid To'], OPEN);
}

/* ===================================================================== */
section('L3. SALESMAN ID LOGIC (§6)');
{
  const g = ENV.g;
  ok('S091160257 = normal', g.RSC_STD_IS_NORMAL_SALESMAN_20260814_('S091160257'));
  ok('S000002AA0 = dummy', g.RSC_STD_IS_DUMMY_SALESMAN_20260814_('S000002AA0'));
  ok('S0000T2AA0 = dummy', g.RSC_STD_IS_DUMMY_SALESMAN_20260814_('S0000T2AA0'));
  ok('S0000S5AW0 = dummy', g.RSC_STD_IS_DUMMY_SALESMAN_20260814_('S0000S5AW0'));
  ok('S0000M2AA0 = dummy', g.RSC_STD_IS_DUMMY_SALESMAN_20260814_('S0000M2AA0'));
  ok('S0000X2AA0 bukan dummy', !g.RSC_STD_IS_DUMMY_SALESMAN_20260814_('S0000X2AA0'));
  ok('dummy bukan normal', !g.RSC_STD_IS_NORMAL_SALESMAN_20260814_('S000002AA0'));

  has('R1 format salesman salah', one({ [C.SLS]: 'X123' }).detail, 'R1');
  has('R1 salesman tidak ada di BP', one({ [C.SLS]: 'S091888888' }).detail, 'R1');
  has('R1A salesman normal tidak ada di m_sales_info', one({ [C.SLS]: 'S091999999' }).detail, 'R1A');
  hasNot('Dummy dikecualikan dari m_sales_info', one({ [C.SLS]: 'S0000M2AA0' }).detail, 'R1A');
  has('Dummy tetap wajib ada di BP', one({ [C.SLS]: 'S0000M9ZZ9' }).detail, 'R1');
}

/* ===================================================================== */
section('L4. S* CUSTOMER + S* SALESMAN (§7)');
{
  const ss = { [C.CUST]: 'S099887766', [C.SLS]: 'S091010486' };
  const r = one(ss);
  ok('pasangan S*+S* terdeteksi', r.row.ssPair);
  hasNot('rule numerik Customer dikecualikan', r.detail, 'R1');

  const noVisit = one(Object.assign({}, ss, {
    [C.CAT]: '', [C.TYPE]: '', [C.SCH]: '', [C.VVF]: '', [C.VVT]: ''
  }));
  eq('seluruh visit section optional', noVisit.status, 'OK');

  const custMissing = one({ [C.CUST]: 'S000000001', [C.SLS]: 'S091010486' });
  has('Customer S* tetap wajib ada di BP master', custMissing.detail, 'R1');

  const relMissing = one(Object.assign({}, ss, { [C.REL]: '' }));
  has('Relationship tetap wajib (bukan PAIR_NO_RELATION)', relMissing.detail, 'R2');

  const dateMissing = one(Object.assign({}, ss, { [C.VF]: '', [C.VT]: '' }));
  has('Valid From/To tetap wajib', dateMissing.detail, 'R4');

  const badVisit = one(Object.assign({}, ss, { [C.CAT]: 'F9', [C.SCH]: 'XX', [C.VVT]: '2020-01-01' }));
  hasNot('R6 dilewati pada S*+S*', badVisit.detail, 'R6');
  hasNot('R10 dilewati pada S*+S*', badVisit.detail, 'R10');
  hasNot('R11 dilewati pada S*+S*', badVisit.detail, 'R11');
}

/* ===================================================================== */
section('L5. CHANGE SCHEDULE ONLY — 2 MODE (§8)');
{
  const case1 = one({ [C.CUST]: '110223729', [C.REL]: 'ZWS006', [C.SLS]: 'S091210238', [C.VT]: OPEN });
  eq('CASE 1 EXACT_REL_VALID_TO', case1.row.cso && case1.row.cso.mode, 'EXACT_REL_VALID_TO');

  const case2 = one({ [C.CUST]: '110223729', [C.REL]: '', [C.SLS]: 'S091210238' });
  eq('CASE 2 PAIR_NO_RELATION', case2.row.cso && case2.row.cso.mode, 'PAIR_NO_RELATION');
  hasNot('Relationship optional pada CASE 2', case2.detail, 'R2');

  const case2b = one({ [C.CUST]: '110223729', [C.REL]: '', [C.SLS]: 'S091210238', [C.VF]: '', [C.VT]: '' });
  eq('Valid From/To optional pada CASE 2', case2b.status, 'OK');
  eq('Relationship tidak di-backfill', case2b.row.f['Relationship'], '');
  eq('Valid From tidak di-backfill', case2b.row.f['Valid From'], '');
  eq('Valid To tidak di-backfill', case2b.row.f['Valid To'], '');

  const noPair = one({ [C.CUST]: '110094788', [C.REL]: '', [C.SLS]: 'S091010486' });
  ok('pasangan tidak ada di DB = bukan CSO', !noPair.row.cso);
  has('Relationship kembali wajib', noPair.detail, 'R2');

  const tbExact = one({ [C.CUST]: '110223729', [C.REL]: 'ZWS006', [C.SLS]: 'S091210238',
    [C.VT]: OPEN, [C.REASON]: 'Toko Bangkrut' });
  ok('Toko Bangkrut TIDAK diperlakukan CSO exact', !tbExact.row.cso);
  eq('penekanan tercatat', tbExact.row.csoSuppressed, 'EXACT_REL_VALID_TO');
}

/* ===================================================================== */
section('L6. ROLLING DATE LOGIC (§9)');
{
  const g = ENV.g;
  const p1 = g.RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', '', '2026-01-01', DATE_NEW);
  eq('normal Rolling -> ROLLING_HARDCODED', p1.policy, 'ROLLING_HARDCODED');
  eq('Valid From = dateNew', p1.validFrom, DATE_NEW);
  eq('Visit Valid From = dateNew', p1.visitValidFrom, DATE_NEW);

  const p2 = g.RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', 'EXACT_REL_VALID_TO', '2026-03-01', DATE_NEW);
  eq('CASE 1 tetap dateNew', p2.validFrom, DATE_NEW);
  ok('histori DB tidak menarik mundur', p2.validFrom > '2026-03-01');

  const p3 = g.RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', 'PAIR_NO_RELATION', '2026-03-01', DATE_NEW);
  eq('CASE 2 hanya visit', p3.policy, 'VISIT_ONLY');
  eq('Valid From apa adanya', p3.validFrom, '2026-03-01');
  eq('Visit Valid From = dateNew', p3.visitValidFrom, DATE_NEW);

  const p4 = g.RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Toko Bangkrut', '', '2026-03-01', DATE_NEW);
  eq('non-Rolling AS_IS', p4.policy, 'AS_IS');

  const r1 = one({ [C.VF]: '2026-01-01', [C.VVF]: '2026-01-01' });
  eq('mutasi Valid From ke dateNew', r1.row.f['Valid From'], DATE_NEW);
  eq('mutasi Visit Valid From ke dateNew', r1.row.f['Visit Valid From'], DATE_NEW);
  eq('baris ditandai berubah', r1.res.mutatedRows, 1);

  const r2 = one({ [C.CUST]: '110223729', [C.REL]: 'ZWS006', [C.SLS]: 'S091210238', [C.VT]: OPEN, [C.VF]: '2026-01-01' });
  eq('CASE 1: Valid From tetap dipaksa dateNew', r2.row.f['Valid From'], DATE_NEW);

  const r3 = one({ [C.CUST]: '110223729', [C.REL]: '', [C.SLS]: 'S091210238', [C.VF]: '2026-01-01', [C.VVF]: '2026-01-01' });
  eq('CASE 2: Valid From tidak diubah', r3.row.f['Valid From'], '2026-01-01');
  eq('CASE 2: Visit Valid From = dateNew', r3.row.f['Visit Valid From'], DATE_NEW);
}

/* ===================================================================== */
section('L7. TOKO BANGKRUT (§10)');
{
  const g = ENV.g;
  eq('deteksi Reason mengandung TOKO BANGKRUT', g.rscIsTokoBangkrutReason_('toko bangkrut permanen'), 'true');
  eq('Reason Rolling terdeteksi contains', g.rscIsRollingReason_('Change Rolling'), 'true');

  const tb = one({ [C.CUST]: '110625404', [C.REL]: 'ZWS014', [C.SLS]: 'S091110370',
    [C.CAT]: 'F1', [C.TYPE]: '03', [C.SCH]: 'W1M',
    [C.VF]: '', [C.VT]: '', [C.VVF]: '', [C.VVT]: '', [C.REASON]: 'Toko Bangkrut' });
  eq('Valid From dari record open-ended (prioritas)', tb.row.f['Valid From'], '2026-05-01');
  eq('sumber Valid From', tb.row.tbValidFromSource, 'EXACT_OPEN');
  eq('Valid To = dateClose', tb.row.f['Valid To'], DATE_CLOSE);
  eq('Visit Valid To = dateClose', tb.row.f['Visit Valid To'], DATE_CLOSE);
  eq('Visit Valid From = effective date terakhir <= dateClose', tb.row.f['Visit Valid From'], '2026-06-01');
  eq('baris Toko Bangkrut lulus', tb.status, 'OK');

  eq('pemilihan effective date', g.RSC_MVS_PICK_EFFECTIVE_DATE_20260819_(
    ['2026-01-01', '2026-06-01', '2027-01-01'], DATE_CLOSE), '2026-06-01');
  eq('bila semua > dateClose ambil paling awal', g.RSC_MVS_PICK_EFFECTIVE_DATE_20260819_(
    ['2029-05-01', '2030-01-01'], DATE_CLOSE), '2029-05-01');

  const tb2 = one({ [C.CUST]: '110221303', [C.REL]: 'ZWS015', [C.SLS]: 'S091120232',
    [C.CAT]: 'F2', [C.TYPE]: '04', [C.SCH]: 'W1M,W3M',
    [C.VF]: '', [C.VT]: '', [C.VVF]: '', [C.VVT]: '', [C.REASON]: 'Toko Bangkrut' });
  eq('semua tanggal MVS > dateClose -> ambil paling awal', tb2.row.f['Visit Valid From'], '2029-05-01');

  const tbClosed = one({ [C.CUST]: '110000001', [C.REL]: 'ZWS003', [C.SLS]: 'S091010486',
    [C.CAT]: 'F1', [C.TYPE]: '03', [C.SCH]: 'W1M',
    [C.VF]: '', [C.VT]: '', [C.VVF]: '', [C.VVT]: '', [C.REASON]: 'Toko Bangkrut' });
  eq('histori tertutup tetap dipakai', tbClosed.row.f['Valid From'], '2026-02-01');
  has('key MVS tidak ada -> TB ERROR', tbClosed.detail, 'TB');

  const tbBadTo = one({ [C.CUST]: '110625404', [C.REL]: 'ZWS014', [C.SLS]: 'S091110370',
    [C.CAT]: 'F1', [C.TYPE]: '03', [C.SCH]: 'W1M',
    [C.VF]: '2026-05-01', [C.VT]: OPEN, [C.VVF]: '2026-06-01', [C.VVT]: OPEN, [C.REASON]: 'Toko Bangkrut' });
  ok('TB menolak Valid To bukan dateClose', /Valid To harus 2026-08-31/.test(tbBadTo.detail), tbBadTo.detail);
  ok('TB menolak Visit Valid To bukan dateClose', /Visit Valid To harus 2026-08-31/.test(tbBadTo.detail), tbBadTo.detail);

  const tbBadFrom = one({ [C.CUST]: '110625404', [C.REL]: 'ZWS014', [C.SLS]: 'S091110370',
    [C.CAT]: 'F1', [C.TYPE]: '03', [C.SCH]: 'W1M',
    [C.VF]: '2026-05-01', [C.VT]: DATE_CLOSE, [C.VVF]: '2026-01-01', [C.VVT]: DATE_CLOSE, [C.REASON]: 'Toko Bangkrut' });
  ok('TB menolak Visit Valid From di luar effective date',
     /Visit Valid From tidak sesuai m_visit_schedule. Expected=2026-06-01/.test(tbBadFrom.detail), tbBadFrom.detail);

  const tbIncomplete = one({ [C.CUST]: '110625404', [C.REL]: 'ZWS014', [C.SLS]: 'S091110370',
    [C.CAT]: '', [C.TYPE]: '', [C.SCH]: '', [C.VF]: '', [C.VT]: '', [C.VVF]: '', [C.VVT]: '',
    [C.REASON]: 'Toko Bangkrut' });
  ok('TB melapor key tidak lengkap', /key m_visit_schedule wajib lengkap/.test(tbIncomplete.detail), tbIncomplete.detail);

  const tbSS = one({ [C.CUST]: 'S099887766', [C.SLS]: 'S091010486', [C.REL]: 'ZWS003',
    [C.CAT]: '', [C.TYPE]: '', [C.SCH]: '', [C.VVF]: '', [C.VVT]: '',
    [C.VF]: '2026-01-01', [C.VT]: DATE_CLOSE, [C.REASON]: 'Toko Bangkrut' });
  ok('Toko Bangkrut + S*+S*: MVS dilewati',
     tbSS.detail.indexOf('m_visit_schedule') < 0, tbSS.detail);
  ok('sisi relasi tetap berlaku pada S*+S*', /Valid From tidak dapat ditentukan/.test(tbSS.detail), tbSS.detail);

  const tbPair = one({ [C.CUST]: '110223729', [C.REL]: '', [C.SLS]: 'S091210238',
    [C.CAT]: 'F1', [C.TYPE]: '03', [C.SCH]: 'W1M', [C.VF]: '', [C.VT]: '',
    [C.VVF]: '', [C.VVT]: '', [C.REASON]: 'Toko Bangkrut' });
  eq('Toko Bangkrut + PAIR_NO_RELATION: relasi tidak di-backfill', tbPair.row.f['Valid From'], '');
  eq('visit tetap mengikuti dateClose', tbPair.row.f['Visit Valid To'], DATE_CLOSE);
}

/* ===================================================================== */
section('L8. SCHEDULE VISIT — MATRIKS FREKUENSI (§11)');
{
  const g = ENV.g;
  const S = (cat, sch) => g.RSC_STD_VALIDATE_SCHEDULE_RULES_20260814_(cat, sch);
  eq('F1 tepat 1 token', S('F1', 'W1M').length, 0);
  ok('F1 tolak 2 token', /tepat 1 token/.test(S('F1', 'W1M,W2M')[0]), S('F1', 'W1M,W2M')[0]);
  eq('F2 W1+W3 hari sama', S('F2', 'W1M,W3M').length, 0);
  eq('F2 W2+W4 hari sama', S('F2', 'W2TH,W4TH').length, 0);
  ok('F2 tolak hari berbeda', S('F2', 'W1M,W3TH').some(m => /hari yang sama/.test(m)), JSON.stringify(S('F2', 'W1M,W3TH')));
  ok('F2 tolak minggu 1+2', S('F2', 'W1M,W2M').some(m => /W1\+W3 atau W2\+W4/.test(m)), JSON.stringify(S('F2', 'W1M,W2M')));
  eq('F4 W1..W4 hari sama', S('F4', 'W1M,W2M,W3M,W4M').length, 0);
  ok('F4 tolak minggu tidak lengkap', S('F4', 'W1M,W2M,W3M,W3M').length > 0);
  eq('F8 2 hari x 4 minggu', S('F8', 'W1M,W2M,W3M,W4M,W1TH,W2TH,W3TH,W4TH').length, 0);
  ok('F8 tolak 1 hari', S('F8', 'W1M,W2M,W3M,W4M,W1M,W2M,W3M,W4M').some(m => /2 hari berbeda|duplikat/.test(m)));
  ok('token tidak valid dilaporkan', /Token Schedule Visit tidak valid: W5M/.test(S('F1', 'W5M')[0]), S('F1', 'W5M')[0]);
  ok('token kosong dilaporkan', S('F2', 'W1M,,W3M').some(m => /token kosong/.test(m)));
  ok('token duplikat dilaporkan', S('F2', 'W1M,W1M').some(m => /token duplikat/.test(m)));
  eq('hari SU dan TH dikenali', S('F2', 'W1SU,W3SU').length, 0);

  has('R6 pada baris nyata', one({ [C.CAT]: 'F2', [C.SCH]: 'W1M,W2M' }).detail, 'R6');
  has('R6 Schedule wajib', one({ [C.SCH]: '' }).detail, 'R6');
}

/* ===================================================================== */
section('L9. CROSS-ROW (§12)');
{
  const r7 = run([
    baseRow({ [C.REL]: 'ZWS003', [C.SCH]: 'W1W,W3W' }),
    baseRow({ [C.REL]: 'ZWS006', [C.SCH]: 'W2W,W4W' })
  ]);
  has('R7 baris 1', r7.detail[0], 'R7');
  has('R7 baris 2', r7.detail[1], 'R7');
  ok('R7 menyebut nomor row', /row 2/.test(r7.detail[0]) && /row 3/.test(r7.detail[0]), r7.detail[0]);

  const r8a = run([baseRow({}), baseRow({ [C.TYPE]: '04' })]);
  ok('R8a duplikat key', /R8a: key/.test(r8a.detail[0]) && /R8a: key/.test(r8a.detail[1]), r8a.detail[0]);

  const csoDup = run([
    baseRow({ [C.CUST]: '110223729', [C.REL]: 'ZWS006', [C.SLS]: 'S091210238', [C.VT]: OPEN }),
    baseRow({ [C.CUST]: '110223729', [C.REL]: 'ZWS006', [C.SLS]: 'S091210238', [C.VT]: OPEN })
  ]);
  ok('Change Schedule Only dikecualikan dari R8a', csoDup.detail[0].indexOf('R8a') < 0, csoDup.detail[0]);

  const r8b = one({ [C.CUST]: '110221303', [C.REL]: 'ZWS015', [C.SLS]: 'S091120232',
    [C.VF]: '2026-01-01', [C.VT]: DATE_CLOSE, [C.VVF]: '2026-01-01', [C.VVT]: DATE_CLOSE,
    [C.CAT]: 'F2', [C.TYPE]: '04', [C.SCH]: 'W1M,W3M', [C.REASON]: 'Toko Bangkrut' });
  ok('R8b key sudah ada di m_bp_relation', /R8b: key/.test(r8b.detail), r8b.detail);
}

/* ===================================================================== */
section('L10. MATRIKS RULE §5 — SETIAP RULE DAPAT MENYALA');
{
  has('S0 Sales Office wajib', one({ [C.OFFICE]: '' }).detail, 'S0');
  has('S0 Sales Office tidak ada di em', one({ [C.OFFICE]: 'ZZZZ' }).detail, 'S0');
  has('S0 Delivering Plant bukan 4 karakter', one({ [C.PLANT]: 'ABC' }).detail, 'S0');
  eq('Delivering Plant kosong tidak wajib', one({ [C.PLANT]: '' }).status, 'OK');

  has('R1 Customer wajib', one({ [C.CUST]: '' }).detail, 'R1');
  has('R1 Customer non-numerik', one({ [C.CUST]: 'ABC123456' }).detail, 'R1');
  has('R1 Customer tidak ada di BP', one({ [C.CUST]: '119999999' }).detail, 'R1');
  has('R1 Salesman wajib', one({ [C.SLS]: '' }).detail, 'R1');

  has('R2 Relationship wajib', one({ [C.REL]: '' }).detail, 'R2');
  has('R2 format salah', one({ [C.REL]: 'ZW03' }).detail, 'R2');
  has('R2 tidak terdaftar', one({ [C.REL]: 'ZWS999' }).detail, 'R2');
  eq('kode master tambahan diterima', one({ [C.REL]: 'ZWS040' }).status, 'OK');
  eq('BUR001 diterima built-in', one({ [C.REL]: 'BUR001' }).status, 'OK');

  has('R3 BP Type wajib', one({ [C.BPTYPE]: '', [C.SLS]: 'S091888881' }).detail, 'R3');
  has('R3 format salah', one({ [C.BPTYPE]: 'XX01', [C.SLS]: 'S091888881' }).detail, 'R3');
  const r3auto = one({ [C.BPTYPE]: 'ZD09', [C.SLS]: 'S091040638' });
  eq('R3 auto-replace dari master', r3auto.row.f['Salesman BP Type'], 'ZD02');
  hasNot('R3 tidak ERROR setelah auto-replace', r3auto.detail, 'R3');

  // Baris Rolling: Valid From / Visit Valid From di-auto-replace, jadi rule
  // "wajib diisi" hanya dapat menyala pada baris non-Rolling (Reason kosong).
  const NR = { [C.REASON]: '' };
  has('R4 Valid From wajib', one(Object.assign({}, NR, { [C.VF]: '' })).detail, 'R4');
  has('R4 Valid To wajib', one({ [C.VT]: '' }).detail, 'R4');
  has('R4 Visit Valid From wajib', one(Object.assign({}, NR, { [C.VVF]: '' })).detail, 'R4');
  has('R4 Visit Valid To wajib', one({ [C.VVT]: '' }).detail, 'R4');
  has('R4 format tidak valid', one({ [C.VVT]: '31/02/2026' }).detail, 'R4');
  eq('Rolling: Valid From kosong diisi otomatis, bukan ERROR',
     one({ [C.VF]: '' }).row.f['Valid From'], DATE_NEW);

  has('R5 Visit Category wajib', one({ [C.CAT]: '' }).detail, 'R5');
  has('R5 Visit Category tidak dikenal', one({ [C.CAT]: 'F3' }).detail, 'R5');

  has('R9 Valid To <= Valid From', one({ [C.VT]: '2026-08-01' }).detail, 'R9');
  has('R9A Rolling wajib open-ended', one({ [C.VT]: '2026-12-31', [C.VVT]: '2026-12-01' }).detail, 'R9A');
  has('R10 Visit To <= Visit From', one({ [C.VVT]: '2026-08-01' }).detail, 'R10');
  has('R11 visit di luar periode relasi',
      one({ [C.REASON]: '', [C.VVF]: '2026-08-01', [C.VF]: DATE_NEW }).detail, 'R11');
  has('R12 Visit Type wajib', one({ [C.TYPE]: '' }).detail, 'R12');
  has('R12 Visit Type di luar 01-12', one({ [C.TYPE]: '13' }).detail, 'R12');
  eq('Visit Type 1 dinormalisasi jadi 01', one({ [C.TYPE]: '1' }).row.f['Visit Type'], '01');
}

/* ===================================================================== */
section('L11. OUTPUT O:P (§14)');
{
  const r = run([baseRow({}), baseRow({ [C.CUST]: '110221303', [C.CAT]: 'F3' }),
                 ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']]);
  eq('baris data tanpa error -> OK', r.status[0], 'OK');
  eq('detail OK kosong', r.detail[0], '');
  eq('baris error -> ERROR', r.status[1], 'ERROR');
  ok('detail berformat [RULE] pesan', /^\[[A-Z0-9]+\] /.test(r.detail[1]), r.detail[1]);
  eq('baris kosong tidak masuk hasil', r.rowCount, 2);

  const dup = run([baseRow({ [C.CAT]: 'F3', [C.TYPE]: '13' })]);
  ok('pemisah antar error " | "', dup.detail[0].indexOf(' | ') > 0, dup.detail[0]);
  const codes = dup.detail[0].match(/\[[A-Z0-9]+\]/g);
  eq('error dideduplikasi per baris', new Set(dup.detail[0].split(' | ')).size, dup.detail[0].split(' | ').length);
  ok('ada lebih dari satu rule', codes.length >= 2, JSON.stringify(codes));
}

/* ===================================================================== */
section('L12. WARNA STATUS (§14 + dashboard)');
{
  const g = ENV.g;
  const col = s => g.RSC_UI_STATUS_COLOR_20260820_(s);
  const GREEN = g.RSC_UI_STATUS_COLORS_20260820.GREEN.bg;
  const RED = g.RSC_UI_STATUS_COLORS_20260820.RED.bg;
  const YELLOW = g.RSC_UI_STATUS_COLORS_20260820.YELLOW.bg;
  const ORANGE = g.RSC_UI_STATUS_COLORS_20260820.ORANGE.bg;

  eq('OK -> HIJAU', col('OK').bg, GREEN);
  eq('ALL OK -> HIJAU', col('ALL OK').bg, GREEN);
  eq('COMPLETE_OK -> HIJAU', col('COMPLETE_OK').bg, GREEN);
  eq('DONE -> HIJAU', col('DONE').bg, GREEN);
  eq('ERROR -> MERAH', col('ERROR').bg, RED);
  eq('HARD_ERROR -> MERAH', col('HARD_ERROR').bg, RED);
  eq('COMPLETE_WITH_ERRORS -> MERAH', col('COMPLETE_WITH_ERRORS').bg, RED);
  eq('IN PROGRESS -> KUNING', col('IN PROGRESS').bg, YELLOW);
  eq('WORKER -> KUNING', col('WORKER').bg, YELLOW);
  eq('ACTIVE -> KUNING', col('ACTIVE').bg, YELLOW);
  eq('VALIDATING -> KUNING', col('VALIDATING').bg, YELLOW);
  eq('QUEUE -> ORANGE', col('QUEUE').bg, ORANGE);
  eq('QUEUED -> ORANGE', col('QUEUED').bg, ORANGE);
  eq('RETRY -> KUNING TUA', col('RETRY').bg, g.RSC_UI_STATUS_COLORS_20260820.AMBER.bg);
  eq('DEFERRED -> KUNING TUA', col('DEFERRED').bg, g.RSC_UI_STATUS_COLORS_20260820.AMBER.bg);
  eq('BLOCKED_INFRA -> BIRU', col('BLOCKED_INFRA').bg, g.RSC_UI_STATUS_COLORS_20260820.BLUE.bg);
  eq('SKIPPED_INVALID -> ABU', col('SKIPPED_INVALID').bg, g.RSC_UI_STATUS_COLORS_20260820.GREY.bg);
  eq('kosong tanpa warna', String(col('').bg), 'null');
  eq('OK dicetak tebal', col('OK').bold, 'true');
  eq('ERROR dicetak tebal', col('ERROR').bold, 'true');

  // Kalimat panjang pada kolom Feedback rekap.
  eq('VALIDASI OK (0 error) -> HIJAU', col('VALIDASI OK (0 error) - 2026-08-20 10:00:00').bg, GREEN);
  eq('PERLU REVISI -> MERAH', col('PERLU REVISI: 12 baris error.').bg, RED);
  eq('TERTUNDA -> KUNING TUA', col('TERTUNDA (infrastruktur): DB sibuk').bg, g.RSC_UI_STATUS_COLORS_20260820.AMBER.bg);
  eq('DILEWATI -> ABU', col('DILEWATI: link tidak valid').bg, g.RSC_UI_STATUS_COLORS_20260820.GREY.bg);
  eq('GAGAL -> MERAH', col('GAGAL: layout tidak sesuai').bg, RED);

  // Pewarnaan nyata pada sheet hasil validasi.
  const child = ENV.w.env.files.get(ENV.w.fileIds[0].id);
  const sh = child.getSheetByName('Change Rolling & Change Schedule');
  const rowOk = baseRow({});
  const rowErr = baseRow({ [C.CUST]: '110221303', [C.CAT]: 'F3' });
  const res = run([rowOk, rowErr]);
  sh.getRange(2, 1, 2, 14).setValues([rowOk.slice(0, 14), rowErr.slice(0, 14)]);
  ENV.g.rscWriteResults_(sh, ENV.spec, res, 2);
  const bg = sh.getRange(2, 15, 2, 2).getBackgrounds();
  eq('baris OK berlatar hijau', bg[0][0], GREEN);
  eq('kolom detail ikut hijau', bg[0][1], GREEN);
  eq('baris ERROR berlatar merah', bg[1][0], RED);
  eq('status OK tertulis', sh.getRange(2, 15).getDisplayValue(), 'OK');
  eq('status ERROR tertulis', sh.getRange(3, 15).getDisplayValue(), 'ERROR');
}

/* ===================================================================== */
section('L13. MUTATION DITULIS KEMBALI KE A:N (§13)');
{
  const child = ENV.w.env.files.get(ENV.w.fileIds[1].id);
  const sh = child.getSheetByName('Change Rolling & Change Schedule');
  const rows = [
    baseRow({ [C.VF]: '01/01/2026', [C.VVF]: '01/01/2026', [C.TYPE]: '3' }),
    baseRow({ [C.CUST]: '110223729', [C.REL]: 'ZWS006', [C.SLS]: 'S091210238', [C.VT]: OPEN })
  ];
  sh.getRange(2, 1, 2, 14).setValues(rows.map(r => r.slice(0, 14)));
  const res = ENV.g.rscValidateValues_(ENV.spec, rows, ENV.masters);
  ENV.g.rscWriteResults_(sh, ENV.spec, res, 2);
  eq('Valid From ditulis canonical', sh.getRange(2, 7).getDisplayValue(), DATE_NEW);
  eq('Visit Valid From ditulis canonical', sh.getRange(2, 12).getDisplayValue(), DATE_NEW);
  eq('Visit Type ditulis 2 digit', sh.getRange(2, 10).getDisplayValue(), '03');
  eq('jumlah baris termutasi', res.mutatedRows, 1);
  eq('baris kedua tidak berubah', sh.getRange(3, 3).getDisplayValue(), '110223729');
}

/* ===================================================================== */
section('L14. VALIDATOR TAMBAHAN (§17 & §18)');
{
  const so = ENV.g.rscSpecFor_('Change Sales Office');
  eq('spec Change Sales Office ada', so && so.validator, 'SALES_OFFICE');
  const emKeys = Object.keys(ENV.masters.office.map);
  const hier = Object.keys(ENV.masters.office.full)[0].split('|');
  const soRow = (over) => {
    const r = ['110094788', hier[3], hier[1], hier[2], hier[0], hier[3], '', ''];
    Object.keys(over || {}).forEach(k => { r[k] = over[k]; });
    return r;
  };
  const rs = ENV.g.rscValidateValues_(so, [soRow({})], ENV.masters);
  eq('kombinasi hirarki valid lolos', rs.status[0], 'OK');
  has('BP Number Source wajib', ENV.g.rscValidateValues_(so, [soRow({ 0: '' })], ENV.masters).detail[0], 'SO1');
  has('BP Number Source harus numerik', ENV.g.rscValidateValues_(so, [soRow({ 0: 'ABC' })], ENV.masters).detail[0], 'SO1');
  has('Delivering Plant 4 karakter', ENV.g.rscValidateValues_(so, [soRow({ 1: 'AB' })], ENV.masters).detail[0], 'SO2');
  has('Sales Org tidak terdaftar', ENV.g.rscValidateValues_(so, [soRow({ 4: 'ZZZZ' })], ENV.masters).detail[0], 'SO3');
  has('Dist Channel tidak relevan', ENV.g.rscValidateValues_(so, [soRow({ 2: '99' })], ENV.masters).detail[0], 'SO4');
  has('Division tidak relevan', ENV.g.rscValidateValues_(so, [soRow({ 3: '99' })], ENV.masters).detail[0], 'SO5');
  has('Sales Office tidak relevan', ENV.g.rscValidateValues_(so, [soRow({ 5: 'ZZZZ' })], ENV.masters).detail[0], 'SO6');
  const soDup = ENV.g.rscValidateValues_(so, [soRow({}), soRow({})], ENV.masters);
  has('duplicate key Change Sales Office', soDup.detail[0], 'SO7');

  const st = ENV.g.rscSpecFor_('Change Salesman Type');
  eq('spec Change Salesman Type ada', st && st.validator, 'SALESMAN_TYPE');
  const office = emKeys[0];
  const org = ENV.masters.office.map[office].org;
  const stRow = (over) => {
    const r = ['S091010486', org, office, '11', 'DK', '2026-09-01', '9999-12-31', '', ''];
    Object.keys(over || {}).forEach(k => { r[k] = over[k]; });
    return r;
  };
  eq('baris Change Salesman Type valid', ENV.g.rscValidateValues_(st, [stRow({})], ENV.masters).status[0], 'OK');
  has('Salesman ID wajib', ENV.g.rscValidateValues_(st, [stRow({ 0: '' })], ENV.masters).detail[0], 'ST1');
  has('format Salesman ID', ENV.g.rscValidateValues_(st, [stRow({ 0: 'XYZ' })], ENV.masters).detail[0], 'ST1');
  has('Sales Org tidak valid', ENV.g.rscValidateValues_(st, [stRow({ 1: 'ZZZZ' })], ENV.masters).detail[0], 'ST2');
  has('Sales Office tidak valid', ENV.g.rscValidateValues_(st, [stRow({ 2: 'ZZZZ' })], ENV.masters).detail[0], 'ST3');
  has('Sales Type di luar LOV', ENV.g.rscValidateValues_(st, [stRow({ 3: 'ZZ' })], ENV.masters).detail[0], 'ST4');
  eq('Sales Type A1 dari LOV diterima',
     ENV.g.rscValidateValues_(st, [stRow({ 3: 'A1' })], ENV.masters).status[0], 'OK');
  has('Valid From wajib', ENV.g.rscValidateValues_(st, [stRow({ 5: '' })], ENV.masters).detail[0], 'ST5');
  has('Valid To harus > Valid From', ENV.g.rscValidateValues_(st, [stRow({ 6: '2026-01-01' })], ENV.masters).detail[0], 'ST6');
  const stDup = ENV.g.rscValidateValues_(st, [stRow({}), stRow({})], ENV.masters);
  has('duplicate key Change Salesman Type', stDup.detail[0], 'ST7');
}

/* ===================================================================== */
section('L15. PARITAS ACTIVE vs BULK (§15) & FUNGSI INTI (§21)');
{
  const names = [
    'RSC_STD_VALIDATE_ONE_SHEET_20260814_',
    'RSC_STD_VALIDATE_ROLLING_20260814_',
    'RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_20260814_',
    'RSC_V28_3_CREATE_ROLLING_SNAPSHOT_20260814_',
    'RSC_V28_3_LOAD_ROLLING_MASTERS_20260814_',
    'RSC_V28_3_APPLY_ROLLING_MUTATIONS_20260814_',
    'RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_RULES_20260814_',
    'RSC_STD_DETECT_CHANGE_SCHEDULE_ONLY_20260819_',
    'RSC_STD_VALIDATE_SCHEDULE_RULES_20260814_',
    'RSC_STD_LOAD_RELATION_CONTEXT_20260814_',
    'RSC_MVS_getIndexSubset_20260819_',
    'RSC_V28_3_WRITE_ROLLING_SNAPSHOT_20260814_',
    'RSC_PERF12_AUTO_REVAMP_ACTIVE_AFTER_VALIDATION_20260819_'
  ];
  names.forEach(n => ok('fungsi inti ' + n, typeof ENV.g[n] === 'function'));

  const rows = [baseRow({ [C.CAT]: 'F3' }), baseRow({ [C.TYPE]: '99' })];
  const viaRouter = ENV.g.RSC_STD_VALIDATE_ONE_SHEET_20260814_(ENV.spec, rows, ENV.masters);
  const viaRolling = ENV.g.RSC_STD_VALIDATE_ROLLING_20260814_(ENV.spec, rows, ENV.masters);
  const viaSnapshot = ENV.g.RSC_V28_3_VALIDATE_ROLLING_SNAPSHOT_20260814_(ENV.spec, rows, ENV.masters);
  eq('router == rolling', JSON.stringify(viaRouter.detail), JSON.stringify(viaRolling.detail));
  eq('rolling == snapshot', JSON.stringify(viaRolling.detail), JSON.stringify(viaSnapshot.detail));
  eq('status identik', JSON.stringify(viaRouter.status), JSON.stringify(viaSnapshot.status));
}

/* ===================================================================== */
section('L16. TECHNICAL FAILURE TIDAK MENGUBAH OK/ERROR (§19)');
{
  const w2 = buildWorld({ dbPadding: 0 });
  w2.env.files.delete('DB_MASTER_ID');
  const g2 = loadScript(w2.env, { dbId: '', dateNew: DATE_NEW, dateClose: DATE_CLOSE });
  const spec2 = g2.rscPrimarySpec_();
  const m2 = g2.rscLoadMasters_(w2.master);
  eq('DB tidak dikonfigurasi', m2.dbConfigured, 'false');
  const r = g2.rscValidateValues_(spec2, [baseRow({})], m2);
  eq('baris tetap OK tanpa DB', r.status[0], 'OK');
  ok('rule DB dicatat sebagai skipped', Object.keys(r.skipped).length > 0, JSON.stringify(r.skipped));
  const rBad = g2.rscValidateValues_(spec2, [baseRow({ [C.CAT]: 'F3' })], m2);
  eq('rule non-DB tetap jalan', rBad.status[0], 'ERROR');
}

/* ===================================================================== */
section('L17. WARNA PADA MANIFEST, DASHBOARD, DAN REKAP (jalur bulk nyata)');
{
  // Dunia default: DB sintetis yang menurunkan sebagian file menjadi COMPLETE_OK
  // dan sebagian COMPLETE_WITH_ERRORS, sehingga kedua warna dapat diperiksa.
  const w3 = buildWorld({});
  w3.env.setClock('2026-08-20T00:00:00Z');
  const g3 = loadScript(w3.env, { dbId: w3.db.getId(), dateNew: DATE_NEW, dateClose: DATE_CLOSE });
  const GREEN = g3.RSC_UI_STATUS_COLORS_20260820.GREEN.bg;
  const RED = g3.RSC_UI_STATUS_COLORS_20260820.RED.bg;
  const YELLOW = g3.RSC_UI_STATUS_COLORS_20260820.YELLOW.bg;
  const ORANGE = g3.RSC_UI_STATUS_COLORS_20260820.ORANGE.bg;

  g3.RSC_STANDARD_BULK_START_20260814();
  const man = w3.master.getSheetByName(MANIFEST_SHEET);
  const M = g3.RSC_M;

  // Segera setelah start, seluruh task masih QUEUED -> ORANGE.
  const queuedBg = man.getRange(2, M.STATUS + 1, Math.min(5, man.getLastRow() - 1), 1).getBackgrounds();
  ok('status QUEUED berlatar orange', queuedBg.every(r => r[0] === ORANGE), JSON.stringify(queuedBg));

  // Dashboard: slot yang sedang bekerja berwarna kuning.
  const jl = w3.master.getSheetByName('Job Logging Details');
  g3.rscJobLogSet_(w3.master, 'WORKER_1',
    { job: 'BULK VALIDATION', state: 'RUNNING', stage: 'Validasi file' }, { force: true });
  const wRow = g3.rscSlotRow_('WORKER_1');
  eq('slot WORKER_1 RUNNING berlatar kuning', jl.getRange(wRow, 3).getBackground(), YELLOW);
  g3.rscJobLogSet_(w3.master, 'WORKER_1', { job: 'BULK VALIDATION', state: 'QUEUED' }, { force: true });
  eq('slot WORKER_1 QUEUED berlatar orange', jl.getRange(wRow, 3).getBackground(), ORANGE);
  g3.rscJobLogSet_(w3.master, 'WORKER_1', { job: 'BULK VALIDATION', state: 'DONE' }, { force: true });
  eq('slot WORKER_1 DONE berlatar hijau', jl.getRange(wRow, 3).getBackground(), GREEN);

  drainTriggers(w3.env, g3, 500);

  const rows = man.getRange(2, 1, man.getLastRow() - 1, g3.RSC_STANDARD_VALIDATION_V27_20260814.manifestHeaders.length)
    .getDisplayValues();
  const bgs = man.getRange(2, M.STATUS + 1, rows.length, 1).getBackgrounds();
  let okGreen = 0, errRed = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][M.STATUS] === 'COMPLETE_OK') { if (bgs[i][0] === GREEN) okGreen++; }
    if (rows[i][M.STATUS] === 'COMPLETE_WITH_ERRORS') { if (bgs[i][0] === RED) errRed++; }
  }
  ok('COMPLETE_OK berlatar hijau di manifest', okGreen > 0, 'hijau=' + okGreen);
  ok('COMPLETE_WITH_ERRORS berlatar merah di manifest', errRed > 0, 'merah=' + errRed);

  // Kolom Feedback pada sheet Rekap.
  const rek = w3.master.getSheetByName('Rekap Approved');
  const L = g3.rscMasterLayout_(rek);
  const fb = rek.getRange(L.firstDataRow, L.feedbackCol, rek.getLastRow() - L.firstDataRow + 1, 1);
  const fbTxt = fb.getDisplayValues(), fbBg = fb.getBackgrounds();
  let fbGreen = 0, fbRed = 0;
  for (let i = 0; i < fbTxt.length; i++) {
    if (/VALIDASI OK/.test(fbTxt[i][0]) && fbBg[i][0] === GREEN) fbGreen++;
    if (/PERLU REVISI/.test(fbTxt[i][0]) && fbBg[i][0] === RED) fbRed++;
  }
  ok('Feedback "VALIDASI OK" berlatar hijau', fbGreen > 0, 'hijau=' + fbGreen);
  ok('Feedback "PERLU REVISI" berlatar merah', fbRed > 0, 'merah=' + fbRed);

  // Ringkasan dashboard.
  const J = g3.RSC_PERF16_JOBLOG_20260819;
  const counter = jl.getRange(J.counterRow, 1, 1, 12).getDisplayValues()[0];
  eq('label QUEUED pada baris hitung', counter[0], 'QUEUED');
  eq('QUEUED di dashboard berlatar orange', jl.getRange(J.counterRow, 1).getBackground(), ORANGE);
  eq('ACTIVE di dashboard berlatar kuning', jl.getRange(J.counterRow, 3).getBackground(), YELLOW);
  eq('COMPLETE OK di dashboard berlatar hijau', jl.getRange(J.counterRow, 7).getBackground(), GREEN);
  eq('ERROR/HARD di dashboard berlatar merah', jl.getRange(J.counterRow, 11).getBackground(), RED);
  eq('ringkasan akhir ALL OK berlatar hijau', jl.getRange(J.summaryRow, 1).getBackground(), GREEN);
}

/* ===================================================================== */
console.log('\n' + '='.repeat(70));
console.log('HASIL LOGIC PERF26: ' + PASS + ' lulus, ' + FAIL.length + ' gagal');
if (FAIL.length) { FAIL.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('SEMUA UJI BUSINESS LOGIC LULUS');
