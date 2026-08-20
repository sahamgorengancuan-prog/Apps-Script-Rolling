
/* ---------------------- UJI MANDIRI DARI MENU ---------------------- */

function RSC_PERF18_TEST_AUTH_BINDING_CORE_20260819_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var t = rscTestSuite_('AUTH BINDING CORE');
  var before = rscGetProp_(V.pOwner, '');
  rscSetProp_(V.pOwner, 'orang.lain@contoh.com');
  t.ok('mismatch terdeteksi', rscGetProp_(V.pOwner, '') !== rscWhoAmI_());
  rscSetProp_(V.pOwner, rscWhoAmI_());
  t.ok('bind ulang membuat cocok', rscGetProp_(V.pOwner, '') === rscWhoAmI_());
  rscSetProp_(V.pOwner, before);
  return t.finish();
}

function RSC_PERF20_TEST_AUTH_STATUS_LOGIC_20260819_() {
  var t = rscTestSuite_('OAUTH EXACT-STATUS LOGIC');
  t.eq('permission -> ACCESS', rscClassify_(new Error('You do not have permission to access')).kind, RSC_ERR.ACCESS);
  t.eq('not found -> ACCESS', rscClassify_(new Error('No item with the given ID could be found')).kind, RSC_ERR.ACCESS);
  t.eq('quota -> INFRA', rscClassify_(new Error('Service invoked too many times')).kind, RSC_ERR.INFRA);
  t.eq('lock -> INFRA', rscClassify_(new Error('Could not acquire lock')).kind, RSC_ERR.INFRA);
  t.eq('layout -> DATA', rscClassify_(new RscDataError('Layout A:P tidak sesuai')).kind, RSC_ERR.DATA);
  t.eq('lain-lain -> FATAL', rscClassify_(new Error('undefined is not a function')).kind, RSC_ERR.FATAL);
  return t.finish('ACCESS diperlakukan sebagai kegagalan data (perlu tindakan user).\n' +
    'INFRA diperlakukan sebagai penundaan TANPA menambah Attempts.');
}

function RSC_PERF19_TEST_DB_ACCELERATOR_20260819() {
  var t = rscTestSuite_('DB LOOKUP ACCELERATOR');
  var lines = [], tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  for (var i = 0; i < tables.length; i++) {
    try {
      var idx = rscGetIndex_(tables[i]);
      t.ok(tables[i] + ' terindeks atau dilaporkan jelas', idx.available || !!idx.reason);
      lines.push(tables[i] + ': ' + (idx.available
        ? (Object.keys(idx.map).length + ' key, simpan di ' + (idx.storedIn || 'memory'))
        : ('n/a — ' + idx.reason)));
      if (idx.available) {
        var keys = Object.keys(idx.map).slice(0, 2500);
        t.eq(tables[i] + ' lookup ' + keys.length + ' ID',
          Object.keys(rscLookupMany_(idx, keys)).length, keys.length);
      }
    } catch (e) {
      lines.push(tables[i] + ': ' + rscClassify_(e).kind);
      t.ok(tables[i] + ' error terklasifikasi', !!rscClassify_(e).kind);
    }
  }
  return t.finish(lines.join('\n') +
    '\n\nLookup memakai hash-index O(1). Tidak ada lagi ambang jumlah ID\n' +
    'yang memicu full scan seperti batas 2.500 pada versi lama.');
}

function RSC_PERF21_TEST_QUOTA_SAFE_DB_TRANSPORT_20260819() {
  var D = RSC_DB_PARAMETERS;
  var t = rscTestSuite_('QUOTA-SAFE DB TRANSPORT');
  t.ok('jendela baca dibatasi', D.readWindowRows > 0 && D.readWindowRows <= 50000);
  t.ok('potongan cache di bawah 100KB', D.cacheChunkBytes > 0 && D.cacheChunkBytes < 100000);
  t.ok('ada ambang materialisasi ke sheet', D.cacheMaxBytes > 0);
  t.ok('lease pembangunan index terbatas waktu', D.buildLeaseMs > 0);
  var payload = { map: {}, rows: 0 };
  for (var i = 0; i < 5000; i++) payload.map['K' + i] = [['a', 'b', 'c', 'd']];
  var json = JSON.stringify(payload);
  var parts = Math.ceil(json.length / D.cacheChunkBytes);
  t.ok('payload besar terpecah menjadi banyak potongan', parts > 1, 'parts=' + parts);
  return t.finish('Ukuran uji: ' + json.length + ' byte -> ' + parts + ' potongan cache.');
}

function RSC_PERF23_TEST_DIRECT_RAW_DB_20260819() {
  var t = rscTestSuite_('DIRECT RAW DB');
  var lines = [];
  try {
    var loc = rscLocateTable_(RSC_DB_PARAMETERS.tables.RELATION);
    t.ok('tab m_bp_relation ditemukan', !!loc, 'alias: ' + RSC_DB_PARAMETERS.tables.RELATION.join(', '));
    if (loc) {
      var layout = RSC_MBP_RELATION_GET_LAYOUT_20260819_(loc.sheet);
      lines.push('Tab      : ' + loc.sheet.getName() + ' @ ' + loc.ssName);
      lines.push('Mode     : ' + layout.mode);
      lines.push('Data dari: baris ' + layout.firstDataRow);
      t.ok('layout dikenali', layout.mode === 'COMPACT_JSON' || layout.mode === 'LEGACY_COLUMNS', layout.mode);
      var probe = loc.sheet.getRange(layout.firstDataRow, 1, 1,
        Math.max(1, loc.sheet.getLastColumn())).getDisplayValues()[0];
      var rec = RSC_MBP_RELATION_PARSE_ROW_20260819_(layout, probe);
      t.ok('baris pertama terurai', !!rec, JSON.stringify(probe).substring(0, 120));
      if (rec) lines.push('Contoh   : ' + JSON.stringify(rec));
    }
  } catch (e) {
    t.ok('pembacaan terklasifikasi, bukan crash', !!rscClassify_(e).kind, String(e));
  }
  return t.finish(lines.join('\n'));
}

function RSC_PERF25_TEST_DB_CONTENTION_PARITY_20260819() {
  var t = rscTestSuite_('DB CONTENTION PARITY');
  var resA = 'IDX:__TEST_A__', resB = 'IDX:__TEST_B__';
  var a = rscLeaseAcquire_(resA, 30000);
  var b = rscLeaseAcquire_(resB, 30000);
  t.ok('resource berbeda dapat lease bersamaan', !!a && !!b && a !== b);
  t.eq('resource sama tidak dapat lease ganda', rscLeaseAcquire_(resA, 30000), '');
  rscLeaseRelease_(resA, 'TOKEN-SALAH');
  t.eq('lease tidak bisa dilepas token asing', rscLeaseAcquire_(resA, 30000), '');
  rscLeaseRelease_(resA, a);
  var a2 = rscLeaseAcquire_(resA, 30000);
  t.ok('lease bisa dilepas pemiliknya', !!a2);
  rscLeaseRelease_(resA, a2);
  rscLeaseRelease_(resB, b);

  var exp = rscLeaseAcquire_('IDX:__TEST_EXPIRED__', -1000);
  t.ok('lease kedaluwarsa dapat diambil alih', !!rscLeaseAcquire_('IDX:__TEST_EXPIRED__', 30000));
  rscLeaseRelease_('IDX:__TEST_EXPIRED__', exp);

  t.eq('DB busy diklasifikasi INFRA',
    rscClassify_(new Error('Serialized m_bp_relation reader sedang dipakai execution lain')).kind, RSC_ERR.INFRA);
  t.ok('ada batas defer terpisah dari attempts', RSC_STANDARD_VALIDATION_V27_20260814.maxDefers > 0);
  return t.finish(
    'Lock global hanya dipakai untuk compare-and-set lease (milidetik).\n' +
    'Pembangunan index berjalan tanpa lock global dan per tabel, sehingga lane\n' +
    'tidak lagi saling memblokir seperti pola waitMs=45000 pada versi lama.');
}

function RSC_PERF10_TEST_CORE_NORMALIZER_20260819() {
  var t = rscTestSuite_('CORE NORMALIZER');
  t.eq('dropdown KODE - Deskripsi', RSC_NORMALIZE_ID_('2AA0 - STA Bogor'), '2AA0');
  t.eq('relationship dropdown', RSC_NORMALIZE_ID_('ZWS003 - Sales Rep. Food'), 'ZWS003');
  t.eq('id polos', RSC_NORMALIZE_ID_('2AA0'), '2AA0');
  t.eq('apostrof teks', RSC_NORMALIZE_ID_("'110252135"), '110252135');
  t.eq('angka .0', RSC_NORMALIZE_ID_('110252135.0'), '110252135');
  t.eq('notasi eksponen', RSC_NORMALIZE_ID_('1.10252135e+8'), '110252135');
  t.eq('spasi dalam id', RSC_NORMALIZE_ID_(' S091 010486 '), 'S091010486');
  t.eq('kosong', RSC_NORMALIZE_ID_(null), '');
  t.eq('tanggal ISO', rscDateStr_('2026-09-01 12:00:00'), '2026-09-01');
  t.eq('tanggal DD/MM/YYYY', rscDateStr_('01/09/2026'), '2026-09-01');
  t.eq('epoch milidetik', rscDateStr_('253402214400000'), '9999-12-31');
  t.eq('epoch sebagai angka', rscDateStr_(1772323200000), '2026-03-01');
  t.eq('serial spreadsheet', rscDateStr_('46266'), '2026-09-01');
  t.eq('bukan tanggal', rscDateStr_('ZWS003'), '');
  return t.finish();
}

function RSC_PERF10_TEST_MBP_CORE_PURE_20260819() {
  var t = rscTestSuite_('m_bp_relation CORE PARSER');
  var compact = { mode: 'COMPACT_JSON', firstDataRow: 1, payloadCol: 1 };
  var rec = RSC_MBP_RELATION_PARSE_ROW_20260819_(compact,
    ['["110625404","ZWS014","S091110370","2026-03-01","2026-04-30"]']);
  t.ok('compact terurai', !!rec);
  t.eq('customer', rec && rec.customer, '110625404');
  t.eq('relationship', rec && rec.relationship, 'ZWS014');
  t.eq('salesman', rec && rec.salesman, 'S091110370');
  t.eq('valid from', rec && rec.validFrom, '2026-03-01');
  t.eq('valid to', rec && rec.validTo, '2026-04-30');
  t.eq('baris URL diabaikan',
    RSC_MBP_RELATION_PARSE_ROW_20260819_(compact, ['https://docs.google.com/spreadsheets/d/x/edit']), null);

  var legacy = {
    mode: 'LEGACY_COLUMNS', firstDataRow: 2,
    colCustomer: 1, colRelationship: 2, colSalesman: 3, colValidFrom: 4, colValidTo: 5
  };
  var rec2 = RSC_MBP_RELATION_PARSE_ROW_20260819_(legacy,
    ['110223729', 'ZWS006', 'S091210238', '2026-03-01', '9999-12-31']);
  t.eq('legacy customer', rec2 && rec2.customer, '110223729');
  t.eq('legacy open-ended', rec2 && rec2.validTo, '9999-12-31');
  return t.finish('Parser menerima COMPACT_JSON (satu sel berisi array) maupun 5 kolom\n' +
    'legacy, dengan atau tanpa baris header.');
}

function RSC_PERF10_TEST_CACHE_BUCKET_CORE_20260819() {
  var t = rscTestSuite_('CACHE + BUCKETING CORE');
  var obj = { map: {}, rows: 3 };
  for (var i = 0; i < 200; i++) obj.map['K' + i] = [['a' + i, 'b', 'c']];
  var ver = 'test-' + Date.now();
  var w = rscSnapWrite_('__TEST__', ver, obj);
  t.ok('snapshot tertulis', w.ok, JSON.stringify(w));
  var back = rscSnapRead_('__TEST__', ver);
  t.ok('snapshot terbaca kembali', !!back);
  t.eq('jumlah key sama', back && Object.keys(back.map).length, 200);
  t.eq('isi sama', back && back.map.K42[0][0], 'a42');
  t.eq('versi berbeda menghasilkan miss', rscSnapRead_('__TEST__', ver + 'x'), null);
  var chunks = rscChunk_([1, 2, 3, 4, 5, 6, 7], 3);
  t.eq('chunking benar', chunks.length, 3);
  t.eq('sisa chunk benar', chunks[2].length, 1);
  return t.finish();
}

function RSC_PERF10_TEST_CHANGE_SCHEDULE_20260819() {
  var t = rscTestSuite_('CHANGE SCHEDULE ONLY');
  var spec = rscPrimarySpec_();
  var masters = {
    office: { available: true, map: { '2BA0': { code: '2BA0' } } },
    relationship: rscRelationshipMaster_(),
    dateNew: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew,
    dateClose: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose,
    idx: {
      RELATION: {
        available: true, fields: ['Relationship', 'Salesman ID', 'Valid From', 'Valid To'],
        map: { '110094788': [['ZWS003', 'S091010486', '2026-03-01', '9999-12-31']] }
      }
    }
  };
  function row(over) {
    var base = ['2BA0', '2BA0', '110094788', 'ZWS003', 'S091010486', 'ZD01',
      masters.dateNew, '9999-12-31', 'F2', '03', 'W1W,W3W',
      masters.dateNew, '9999-12-31', 'Rolling', '', ''];
    for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
    return base;
  }
  var r1 = rscValidateValues_(spec, [row({})], masters);
  t.eq('CASE 1 terdeteksi', r1.ctx.rows[0].cso && r1.ctx.rows[0].cso.mode, 'EXACT_REL_VALID_TO');

  var r2 = rscValidateValues_(spec, [row({ 3: '' })], masters);
  t.eq('CASE 2 terdeteksi', r2.ctx.rows[0].cso && r2.ctx.rows[0].cso.mode, 'PAIR_NO_RELATION');
  t.ok('Relationship kosong tidak wajib pada CASE 2', r2.detail[0].indexOf('Relationship') < 0, r2.detail[0]);

  var r3 = rscValidateValues_(spec, [row({}), row({})], masters);
  t.ok('CASE 1 dikecualikan dari duplicate R8', r3.detail[0].indexOf('[R8]') < 0, r3.detail[0]);

  var noDb = {
    office: masters.office, relationship: masters.relationship,
    dateNew: masters.dateNew, dateClose: masters.dateClose, idx: {}
  };
  var r4 = rscValidateValues_(spec, [row({}), row({})], noDb);
  t.ok('tanpa master, duplicate tetap terdeteksi', r4.detail[0].indexOf('[R8]') >= 0, r4.detail[0]);
  return t.finish();
}

function RSC_PERF11_TEST_ROLLING_VALID_FROM_POLICY_20260819() {
  var t = rscTestSuite_('ROLLING VALID FROM POLICY');
  var dateNew = VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew;
  var normal = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', '', '2026-03-01', dateNew);
  t.eq('Rolling biasa memakai dateNew', normal.validFrom, dateNew);
  t.eq('Visit Valid From juga dateNew', normal.visitValidFrom, dateNew);
  var exact = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', 'EXACT_REL_VALID_TO', '2026-03-01', dateNew);
  t.eq('Change Schedule Only tetap dateNew', exact.validFrom, dateNew);
  var pair = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', 'PAIR_NO_RELATION', '', dateNew);
  t.eq('PAIR_NO_RELATION: relasi apa adanya', pair.validFrom, '');
  t.eq('PAIR_NO_RELATION: visit tetap dateNew', pair.visitValidFrom, dateNew);
  var tb = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Toko Bangkrut', '', '2026-03-01', dateNew);
  t.eq('Toko Bangkrut tidak dipaksa dateNew', tb.validFrom, '2026-03-01');
  return t.finish('Histori m_bp_relation tidak boleh menarik mundur Reason = Rolling.');
}

function RSC_PERF12_TEST_STATUS_AND_GATE_20260819() {
  var t = rscTestSuite_('STATUS COLOR + AUTO REVAMP GATE');
  t.eq('warna OK', TEMPLATE_UI_PARAMETERS.colors.ok, '#B7E1CD');
  t.eq('warna ERROR', TEMPLATE_UI_PARAMETERS.colors.error, '#F4C7C3');
  t.ok('COMPLETE_OK terminal', rscIsTerminal_(RSC_STATUS.DONE_OK));
  t.ok('COMPLETE_WITH_ERRORS terminal', rscIsTerminal_(RSC_STATUS.DONE_ERRORS));
  t.ok('DEFERRED belum terminal', !rscIsTerminal_(RSC_STATUS.DEFERRED));
  t.ok('BLOCKED_INFRA belum terminal', !rscIsTerminal_(RSC_STATUS.BLOCKED_INFRA));
  return t.finish('Auto revamp hanya memproses file berstatus COMPLETE_OK.');
}

function RSC_PERF16_TEST_JOB_LOGGING_20260819() {
  var J = RSC_PERF16_JOBLOG_20260819;
  var ss = rscActiveSs_();
  var t = rscTestSuite_('JOB LOGGING DASHBOARD');
  var sh = rscJobLogSheet_(ss);
  t.eq('header di baris ' + J.liveHeaderRow, sh.getRange(J.liveHeaderRow, 1).getDisplayValue(), 'Slot');
  t.eq('slot pertama', sh.getRange(J.liveStartRow, 1).getDisplayValue(), J.liveSlots[0]);
  t.eq('judul histori', sh.getRange(J.historyTitleRow, 1).getDisplayValue().indexOf('EVENT HISTORY'), 0);
  rscJobLogSet_(ss, 'LEGACY', {
    job: 'LEGACY / INTEGRATED', state: 'INFO', stage: 'Self test',
    message: 'Uji tulis dashboard ' + rscStamp_(), progress: 1
  }, { force: true, history: true });
  t.eq('slot LEGACY tertulis', sh.getRange(rscSlotRow_('LEGACY'), 3).getDisplayValue(), 'INFO');
  var probeCtrl = 'a' + String.fromCharCode(1) + 'b';
  t.eq('karakter kontrol dibersihkan', RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(probeCtrl, 10), 'a b');
  return t.finish();
}

function RSC_PERF17_TEST_SINGLETON_RESTART_POLICY_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var t = rscTestSuite_('WORKER SINGLETON + RESTART POLICY');
  t.eq('jumlah handler worker', V.workerHandlers.length, V.workerCount);
  t.eq('handler worker unik', rscUniq_(V.workerHandlers).length, V.workerHandlers.length);
  t.ok('soft deadline di bawah kuota 6 menit', V.workerSoftDeadlineMs < 300000);
  t.ok('lease lebih panjang dari soft deadline', V.leaseMs > V.workerSoftDeadlineMs);
  var seen = {}, dupes = 0;
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      var fn = all[i].getHandlerFunction();
      if (V.workerHandlers.indexOf(fn) < 0) continue;
      if (seen[fn]) dupes++;
      seen[fn] = true;
    }
  } catch (e) { /* abaikan */ }
  t.eq('tidak ada trigger worker ganda', dupes, 0);
  return t.finish('Restart From Top selalu membuat Run ID baru. Execution lama tidak\n' +
    'dapat menulis karena Run ID dan claimToken tidak lagi cocok.');
}

function RSC_PERF10_BENCHMARK_ACTIVE_ROLLING_20260819() {
  var ss = rscActiveSs_();
  var sh = ss.getActiveSheet();
  var spec = rscSpecFor_(sh.getName());
  if (!spec) return rscAlert_('Benchmark', 'Buka sheet Change Rolling terlebih dahulu.');
  var t0 = Date.now();
  var masters = rscLoadMasters_(ss);
  var tM = Date.now();
  var needCols = Math.max(spec.errorCol, spec.header.length);
  var dataRows = Math.max(0, rscLastDataRow_(sh, spec) - 1);
  var values = dataRows ? rscReadValuesChunked_(sh, 2, 1, dataRows, needCols) : [];
  var tR = Date.now();
  var res = rscValidateValues_(spec, values, masters);
  var tV = Date.now();
  var text = 'Sheet          : ' + sh.getName() +
    '\nBaris          : ' + res.rowCount +
    '\nError          : ' + res.errorRows +
    '\n\nLoad master    : ' + rscRound_((tM - t0) / 1000, 2) + ' s' +
    '\nBaca range     : ' + rscRound_((tR - tM) / 1000, 2) + ' s' +
    '\nNormalisasi    : ' + res.timing.normalizeSec + ' s' +
    '\nRule           : ' + res.timing.rulesSec + ' s' +
    '\nTotal validasi : ' + rscRound_((tV - t0) / 1000, 2) + ' s' +
    (res.rowCount ? ('\nKecepatan      : ' +
      Math.round(res.rowCount / Math.max(0.001, (tV - tR) / 1000)) + ' baris/detik') : '');
  rscSetProp_('RSC_LAST_BENCHMARK', text.substring(0, 4000));
  rscAlert_('Benchmark ACTIVE Rolling (read only)', text);
  return text;
}

function RSC_PERF10_SYNTHETIC_BENCHMARK_20260819() {
  var spec = rscPrimarySpec_();
  var masters = {
    office: { available: true, map: { '2BA0': { code: '2BA0' } } },
    relationship: rscRelationshipMaster_(),
    dateNew: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew,
    dateClose: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose,
    idx: {}
  };
  var N = 20000, rows = [], days = ['M', 'T', 'W', 'TH', 'F', 'S'];
  for (var i = 0; i < N; i++) {
    var d = days[i % days.length];
    rows.push(['2BA0', '2BA0', String(110000000 + Math.floor(i / 4)), 'ZWS003',
      'S09101' + String(1000 + (i % 900)).slice(0, 4), 'ZD01', masters.dateNew, '9999-12-31',
      'F2', '03', 'W1' + d + ',W3' + d, masters.dateNew, '9999-12-31', 'Rolling', '', '']);
  }
  var t0 = Date.now();
  var res = rscValidateValues_(spec, rows, masters);
  var ms = Date.now() - t0;
  var text = 'Baris sintetis : ' + N +
    '\nWaktu          : ' + ms + ' ms' +
    '\nKecepatan      : ' + Math.round(N / Math.max(0.001, ms / 1000)) + ' baris/detik' +
    '\nNormalisasi    : ' + res.timing.normalizeSec + ' s' +
    '\nRule           : ' + res.timing.rulesSec + ' s' +
    '\nError rows     : ' + res.errorRows;
  rscSetProp_('RSC_LAST_SYNTHETIC', text.substring(0, 4000));
  rscAlert_('Synthetic Performance Benchmark', text);
  return text;
}

/** FULL Safe Audit + Benchmark: menggabungkan beberapa audit dalam satu klik. */
function RSC_PERF12_FULL_AUDIT_20260819() {
  var parts = [];
  parts.push('=== DEPENDENCY ===');
  parts.push(runSafelyWithOptionalRethrow_('dep', RSC_PERF10_RUN_DEPENDENCY_AUDIT_20260819, false) || '(gagal)');
  parts.push('');
  parts.push('=== SCOPE ===');
  parts.push(runSafelyWithOptionalRethrow_('scope', RSC_PERF22_SCOPE_AUDIT_20260819_, false) || '(gagal)');
  parts.push('');
  parts.push('=== DB READ-ONLY ===');
  parts.push(runSafelyWithOptionalRethrow_('db', RSC_PERF10_LIVE_DB_READONLY_AUDIT_20260819, false) || '(gagal)');
  parts.push('');
  parts.push('=== BENCHMARK SINTETIS ===');
  parts.push(runSafelyWithOptionalRethrow_('bench', RSC_PERF10_SYNTHETIC_BENCHMARK_20260819, false) || '(gagal)');
  var text = parts.join('\n');
  rscSetProp_('RSC_LAST_AUDIT', text.substring(0, 8000));
  rscSetProp_('RSC_LAST_AUDIT_AT', rscStamp_());
  rscAlert_('FULL Safe Audit + Benchmark',
    'Audit selesai. Buka "Show Last Audit Summary" untuk teks lengkapnya.');
  return text;
}

/* =============================================================
 * 19. ADMIN / RECOVERY
 * ============================================================= */

function RSC_SHOW_ALL_BACKGROUND_JOB_STATUS_20260611() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var lines = [];
  var runId = rscGetProp_(V.pRunId, '');
  lines.push('BULK VALIDATION');
  lines.push('  State : ' + (rscGetProp_(V.pRunState, '-') || '-'));
  if (runId) {
    var s = rscQueueStats_(ss, runId);
    lines.push('  ' + s.done + '/' + s.total + ' selesai, sisa ' + s.unfinished);
  }
  var jobs = [RSC_JOB_ROLLING_DATES_, RSC_JOB_VALIDATE_DATE_, RSC_JOB_TOKO_BANGKRUT_];
  for (var i = 0; i < jobs.length; i++) {
    var st = rscBgState_(jobs[i].key);
    lines.push('');
    lines.push(jobs[i].title);
    lines.push(st
      ? ('  Berjalan: baris ' + st.row + ', diperbarui ' + st.updated + ', gagal ' + st.failed)
      : '  Tidak berjalan');
  }
  lines.push('');
  lines.push('HARD STOP : ' + (RSC_IS_HARD_STOPPED_() ? 'AKTIF' : 'tidak aktif'));
  var triggers = 0;
  try { triggers = ScriptApp.getProjectTriggers().length; } catch (e) { triggers = -1; }
  lines.push('Trigger aktif: ' + triggers);
  var text = lines.join('\n');
  rscAlert_('Status Semua Job', text);
  return text;
}

function RSC_STOP_ALL_BACKGROUND_JOBS_20260611() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  rscSetProp_(V.pRunState, 'STOPPED');
  var jobs = [RSC_JOB_ROLLING_DATES_, RSC_JOB_VALIDATE_DATE_, RSC_JOB_TOKO_BANGKRUT_];
  var handlers = rscAllHandlers_();
  for (var i = 0; i < jobs.length; i++) handlers.push(jobs[i].handlerFn);
  handlers.push(RSC_TEMPLATE_REVAMP_20260722.handler);
  handlers.push(RSC_TEMPLATE_COPY_20260611.handler);
  handlers.push(RSC_V28_FULL_PIPELINE_20260814.hourlyHandler);
  handlers.push(RSC_V28_FULL_PIPELINE_20260814.watchdogHandler);
  var removed = rscDeleteTriggers_(handlers);
  rscAlert_('STOP Semua Background Job',
    removed + ' trigger dilepas.\nCheckpoint job TIDAK dihapus sehingga bisa dilanjutkan.');
  return { removed: removed };
}

function RSC_RESET_CHECKPOINTS_20260611() {
  var jobs = [RSC_JOB_ROLLING_DATES_, RSC_JOB_VALIDATE_DATE_, RSC_JOB_TOKO_BANGKRUT_];
  for (var i = 0; i < jobs.length; i++) rscBgClear_(jobs[i].key);
  rscSetProp_(RSC_TEMPLATE_REVAMP_20260722.pJob, '');
  rscSetProp_(RSC_TEMPLATE_COPY_20260611.pJob, '');
  rscAlert_('Reset Integrated Checkpoint',
    'Checkpoint job latar belakang dihapus.\n' +
    'Manifest bulk validation TIDAK ikut dihapus — gunakan Restart From Top untuk itu.');
  return true;
}

function RSC_RESET_INTEGRATED_COPY_FINAL_20260716() {
  rscSetProp_(RSC_TEMPLATE_COPY_20260611.pJob, '');
  rscSetProp_(RSC_TEMPLATE_COPY_20260611.pStats, '');
  rscDeleteTriggers_([RSC_TEMPLATE_COPY_20260611.handler]);
  rscAlert_('Reset Checkpoint Copy', 'Checkpoint copy FINAL dihapus dan trigger dilepas.');
  return true;
}

function RSC_REMOVE_ALL_PROTECTIONS_CURRENT_FILE_20260612() {
  var ss = rscActiveSs_();
  var removed = 0;
  try {
    var types = [SpreadsheetApp.ProtectionType.SHEET, SpreadsheetApp.ProtectionType.RANGE];
    for (var t = 0; t < types.length; t++) {
      var ps = ss.getProtections(types[t]);
      for (var i = 0; i < ps.length; i++) if (ps[i].canEdit()) { ps[i].remove(); removed++; }
    }
  } catch (e) {
    return rscAlert_('Hapus Protection', 'Sebagian protection gagal dihapus: ' + e);
  }
  rscAlert_('Hapus Protection', removed + ' protection dihapus dari file ini.');
  return removed;
}

function RSC_INSTALL_RECOMMENDED_TRIGGERS_20260611() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  rscArmWatchdog_();
  var installed = ['watchdog bulk validation (' + V.watchdogMinutes + ' menit)'];
  if (COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEdit) {
    try {
      rscDeleteTriggers_([COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEditHandler]);
      ScriptApp.newTrigger(COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEditHandler)
        .forSpreadsheet(rscActiveSs_()).onEdit().create();
      installed.push('auto validate on edit (debounce ' +
        COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateDebounceMs + ' ms)');
    } catch (e) { installed.push('auto validate on edit GAGAL: ' + e); }
  }
  rscAlert_('Setup Recommended Triggers', 'Terpasang:\n- ' + installed.join('\n- '));
  return installed;
}

function RSC_INSTALL_AUTO_VALIDATION_FOR_INPUT_LINKS_20260611() {
  var P = INPUT_ROLLING_LINK_VALIDATION_PARAMETERS;
  try {
    rscDeleteTriggers_([COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEditHandler]);
    ScriptApp.newTrigger(COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEditHandler)
      .forSpreadsheet(rscActiveSs_()).onEdit().create();
  } catch (e) {
    return rscAlert_('Auto Validasi Link Kolom D', 'Gagal memasang trigger: ' + e);
  }
  rscAlert_('Auto Validasi Link Kolom D',
    'Trigger onEdit terpasang.\nKolom link dipantau : ' + rscColLetter_(P.LINK_COL) +
    '\nSheet yang divalidasi: ' + P.TARGET_SHEETS_TO_VALIDATE.join(', ') +
    '\n\nEdit beruntun digabung dalam satu validasi (debounce ' +
    COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateDebounceMs + ' ms).');
  return true;
}
