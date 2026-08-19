'use strict';
const fs = require('fs');
const path = require('path');
const { FakeSpreadsheet, Environment, buildGlobals, METRICS } = require('./gas_stubs');

const FX = path.join(__dirname, 'fixtures');
const load = n => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));

const ROLLING_SHEET = 'Change Rolling & Change Schedule';
const ROLLING_HEADER = [
  'Sales Office', 'Delivering Plant', 'Customer ID', 'Relationship', 'Salesman ID',
  'Salesman BP Type', 'Valid From', 'Valid To', 'Visit Category', 'Visit Type',
  'Schedule Visit', 'Visit Valid From', 'Visit Valid To', 'Reason',
  'Validation Status', 'Error Detail'
];

/** Bangun dunia uji dari data xlsx induk yang asli. */
function buildWorld(opts) {
  opts = opts || {};
  const env = new Environment();

  const rekapFx = load('rekap_approved.json');     // elemen 0 = header (sheet row 4)
  const rollingFx = load('change_rolling.json');   // 27 baris data + header
  const cleanFx = load('template_clean.json');     // ~1399 baris data + header
  const emFx = load('em_master.json');

  /* ---------- spreadsheet induk ---------- */
  const master = new FakeSpreadsheet('MASTER_INDUK_ID', 'USE THIS Template Rolling Sales 1 September 2026');
  const rekapRows = [
    ['TEMPLATE TOP & Credit Limit', '', '', '', '', ''],
    ['TEMPLATE ROLLING', '', '', '', '', ''],
    ['HANYA ATTACH LINK YANG SUDAH APPROVED', '', '', '', '', '']
  ].concat(rekapFx);
  master.addSheet('Read Me', [['No.', 'To Do']]);
  master.addSheet('Job Logging Details', []);
  master.addSheet('Rekap Approved', rekapRows);
  master.addSheet('em', emFx);
  env.addFile(master);
  env.setActive(master.getId());

  /* ---------- file anak ---------- */
  const fileIds = [];
  for (let i = 1; i < rekapFx.length; i++) {
    const link = String(rekapFx[i][4] || '');
    const m = link.match(/\/d\/([A-Za-z0-9_-]{25,})/);
    if (m) fileIds.push({ id: m[1], office: rekapFx[i][0], desc: rekapFx[i][1] });
  }

  const rollingData = rollingFx.slice(1).map(r => r.slice(0, 16));
  const cleanData = cleanFx.slice(1).map(r => r.slice(0, 16));

  const layoutBroken = new Set(opts.brokenLayout || []);
  const noAccess = new Set(opts.noAccess || []);

  fileIds.forEach((f, idx) => {
    const child = new FakeSpreadsheet(f.id, 'Template Rolling Sales ' + (f.desc || f.office));
    let body;
    if (idx % 5 === 0) body = cleanData.slice(0, 400);       // file besar & bersih
    else if (idx % 5 === 1) body = cleanData.slice(400, 900);
    else body = rollingData;                                  // file dengan error nyata
    const header = ROLLING_HEADER.slice();
    if (layoutBroken.has(idx)) header[3] = '';                // rusak layout $D
    child.addSheet('Read Me', [['No.', 'To Do']]);
    child.addSheet(ROLLING_SHEET, [header].concat(body.map(r => {
      const row = r.slice(0, 16);
      while (row.length < 16) row.push('');
      row[14] = ''; row[15] = '';
      return row;
    })));
    env.addFile(child);
    if (noAccess.has(idx)) {
      env.openFail.set(f.id, new Error('You do not have permission to access the requested document.'));
    }
  });

  /* ---------- spreadsheet DB master ---------- */
  const custIds = new Set(), salesIds = new Set();
  const offByCust = new Map();
  [].concat(rollingData, cleanData).forEach(r => {
    const cid = String(r[2] || '').trim();
    const sid = String(r[4] || '').trim();
    if (cid) { custIds.add(cid); if (!offByCust.has(cid)) offByCust.set(cid, String(r[0] || '').trim()); }
    if (sid) salesIds.add(sid);
  });

  const db = new FakeSpreadsheet('DB_MASTER_ID', 'MDM Master Database', { isDb: true });
  const bpRows = [['Customer ID', 'Sales Office', 'Sales Organization', 'Name']];
  Array.from(custIds).forEach(c => bpRows.push([c, offByCust.get(c) || '', 'STA1', 'Cust ' + c]));
  // padding untuk membuktikan lookup tetap O(1) pada master besar
  for (let i = 0; i < (opts.dbPadding === undefined ? 3000 : opts.dbPadding); i++) {
    bpRows.push(['9' + String(100000000 + i), '2AA0', 'STA1', 'Filler ' + i]);
  }
  db.addSheet('m_bp_general', bpRows);

  const smRows = [['Salesman ID', 'Sales Office', 'Salesman BP Type', 'Valid To']];
  Array.from(salesIds).forEach(s => smRows.push([s, '', 'ZD01', '9999-12-31']));
  db.addSheet('m_salesman', smRows);

  const relRows = [['Customer ID', 'Relationship', 'Salesman ID', 'Valid From', 'Valid To']];
  db.addSheet('m_bp_relation', relRows);

  const vsRows = [['Customer ID', 'Salesman ID', 'Schedule Visit', 'Visit Category', 'Valid To']];
  rollingData.forEach(r => {
    if (String(r[13]).trim() === 'Toko Bangkrut') vsRows.push([r[2], r[4], r[10], r[8], '9999-12-31']);
  });
  db.addSheet('m_visit_schedule', vsRows);

  const rtRows = [['Relationship', 'Description']];
  ['ZWS003:Sales Rep. Food', 'ZWS004:Sales Rep. Non-Food', 'ZWS005:Sales Rep. Frozen',
   'ZWS006:Sales Rep. Cosmetic', 'ZWS007:Sales Rep. Reguler', 'ZWS011:Superior',
   'ZWS012:Collector Food', 'ZWS013:Collector Non-Food', 'ZWS014:Collector Frozen',
   'ZWS015:Collector Cosmetic', 'ZWS016:Collector Reguler', 'ZWS022:Collector Industrial Relation']
    .forEach(p => { const [a, b] = p.split(':'); rtRows.push([a, b]); });
  db.addSheet('m_relationship', rtRows);

  env.addFile(db);

  return { env, master, db, fileIds, counts: { customers: custIds.size, salesmen: salesIds.size } };
}

/** Muat RollingSalesCenter.gs ke dalam konteks vm bersama stub. */
function loadScript(env) {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'RollingSalesCenter.gs'), 'utf8');
  const sandbox = buildGlobals(env);
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'RollingSalesCenter.gs' });
  return sandbox;
}

/** Jalankan trigger worker sampai antrean selesai atau batas iterasi tercapai. */
function drainTriggers(env, sandbox, maxIter) {
  let iter = 0;
  const log = [];
  while (iter < (maxIter || 500)) {
    const t = env.triggers.find(x => /^(rscWorker\d|rscPrewarmIndexes)$/.test(x.fn));
    if (!t) break;
    env.triggers.splice(env.triggers.indexOf(t), 1);
    iter++;
    // Majukan jam virtual sesuai jeda trigger agar backoff benar-benar lewat.
    if (t.after) env.advance(t.after);
    const r = sandbox[t.fn]();
    log.push({ iter, fn: t.fn, claimed: r && r.claimed, committed: r && r.committed, reason: r && r.reason });
  }
  return { iterations: iter, log };
}

module.exports = { buildWorld, loadScript, drainTriggers, METRICS, ROLLING_SHEET, ROLLING_HEADER };
