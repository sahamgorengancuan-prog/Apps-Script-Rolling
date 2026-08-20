
/* =============================================================
 * 5. SNAPSHOT + PENYIMPANAN INDEX BERTINGKAT — perbaikan [F6]
 * -------------------------------------------------------------
 * CacheService dibatasi ~100KB per entry. Snapshot m_bp_relation jauh
 * melewati batas itu, sehingga penulisan cache gagal dan SETIAP execution
 * membangun ulang index dari sumber. Karena itu snapshot besar
 * dimaterialisasi ke spreadsheet index tersendiri.
 * ============================================================= */

var RSC_MEM_INDEX = {};

function rscSnapKey_(name, ver, part) { return 'RSCSNAP:' + name + ':' + ver + ':' + part; }

function rscSnapWrite_(name, ver, obj) {
  var json = JSON.stringify(obj);
  var parts = [];
  for (var i = 0; i < json.length; i += RSC_DB_PARAMETERS.cacheChunkBytes) {
    parts.push(json.substring(i, i + RSC_DB_PARAMETERS.cacheChunkBytes));
  }
  var map = {};
  for (var p = 0; p < parts.length; p++) map[rscSnapKey_(name, ver, p)] = parts[p];
  map[rscSnapKey_(name, ver, 'meta')] = JSON.stringify({ n: parts.length, bytes: json.length, at: rscStamp_() });
  try {
    var cache = rscCache_();
    var groups = rscChunk_(Object.keys(map), 50);
    for (var g = 0; g < groups.length; g++) {
      var sub = {};
      for (var k = 0; k < groups[g].length; k++) sub[groups[g][k]] = map[groups[g][k]];
      cache.putAll(sub, RSC_DB_PARAMETERS.cacheTtlSec);
    }
    return { ok: true, parts: parts.length, bytes: json.length };
  } catch (e) {
    return { ok: false, parts: parts.length, bytes: json.length, error: String(e) };
  }
}

function rscSnapRead_(name, ver) {
  var cache;
  try { cache = rscCache_(); } catch (e) { return null; }
  var metaRaw = cache.get(rscSnapKey_(name, ver, 'meta'));
  if (!metaRaw) return null;
  var meta;
  try { meta = JSON.parse(metaRaw); } catch (e) { return null; }
  var keys = [];
  for (var i = 0; i < meta.n; i++) keys.push(rscSnapKey_(name, ver, i));
  var got = cache.getAll(keys);
  var buf = '';
  for (var j = 0; j < keys.length; j++) {
    var piece = got[keys[j]];
    if (piece === null || piece === undefined) return null;
    buf += piece;
  }
  try { return JSON.parse(buf); } catch (e) { return null; }
}

/** Spreadsheet penampung index besar. Dibuat sekali, lalu dipakai ulang. */
function rscIndexStore_(createIfMissing) {
  var id = rscGetProp_(RSC_DB_PARAMETERS.pIndexStoreId, '');
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) { rscSetProp_(RSC_DB_PARAMETERS.pIndexStoreId, ''); }
  }
  if (!createIfMissing) return null;
  try {
    var ss = SpreadsheetApp.create('_RSC_INDEX_CACHE (jangan dihapus)');
    rscSetProp_(RSC_DB_PARAMETERS.pIndexStoreId, ss.getId());
    return ss;
  } catch (e2) { return null; }
}

function rscIdxSheetName_(tableName) { return 'IDX_' + tableName; }

// Prefix key agregat bantu pada sheet index. Key asli selalu numerik / kode,
// jadi prefix ini dijamin tidak pernah bentrok.
var RSC_IDX_AUX_EARLIEST = '~E|';
var RSC_IDX_AUX_CLOSED = '~C|';

function rscIdxSheetWrite_(tableName, ver, built) {
  var ss = rscIndexStore_(true);
  if (!ss) return { ok: false, reason: 'NO_STORE' };
  var name = rscIdxSheetName_(tableName);
  var sh = ss.getSheetByName(name);
  try {
    if (sh) ss.deleteSheet(sh);
    sh = ss.insertSheet(name);
  } catch (e) { return { ok: false, reason: String(e) }; }

  var keys = Object.keys(built.map);
  sh.getRange(1, 1, 1, 2).setValues([[ver, JSON.stringify({
    rows: built.rows, sheet: built.sheet, source: built.source, mode: built.mode, keys: keys.length,
    fieldPresent: built.fieldPresent || null, fields: built.fields || null
  })]]);

  // Agregat bantu (histori Toko Bangkrut) ikut dimaterialisasi dengan prefix
  // yang tidak mungkin bentrok dengan key asli (key asli selalu numerik).
  var pairs = [];
  for (var kk = 0; kk < keys.length; kk++) pairs.push([keys[kk], JSON.stringify(built.map[keys[kk]])]);
  if (built.earliest) {
    var ek = Object.keys(built.earliest);
    for (var e = 0; e < ek.length; e++) pairs.push([RSC_IDX_AUX_EARLIEST + ek[e], built.earliest[ek[e]]]);
  }
  if (built.closed) {
    var ck = Object.keys(built.closed);
    for (var c = 0; c < ck.length; c++) pairs.push([RSC_IDX_AUX_CLOSED + ck[c], built.closed[ck[c]]]);
  }

  var row = 2, i = 0, block = RSC_DB_PARAMETERS.indexSheetWriteRows;
  while (i < pairs.length) {
    var n = Math.min(block, pairs.length - i);
    var out = [];
    for (var k = 0; k < n; k++) out.push(pairs[i + k]);
    sh.getRange(row, 1, n, 2).setValues(out);
    row += n; i += n;
  }
  return { ok: true, keys: keys.length, rows: pairs.length };
}

function rscIdxSheetRead_(tableName, ver) {
  var ss = rscIndexStore_(false);
  if (!ss) return null;
  var sh = ss.getSheetByName(rscIdxSheetName_(tableName));
  if (!sh) return null;
  var head = sh.getRange(1, 1, 1, 2).getDisplayValues()[0];
  if (rscText_(head[0]) !== ver) return null;
  var meta = {};
  try { meta = JSON.parse(head[1] || '{}'); } catch (e) { meta = {}; }

  var last = sh.getLastRow(), map = {}, row = 2;
  var closed = {}, closedKeys = {}, earliest = {};
  var win = RSC_DB_PARAMETERS.indexSheetReadRows;
  while (row <= last) {
    var n = Math.min(win, last - row + 1);
    var vals = sh.getRange(row, 1, n, 2).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var key = vals[r][0];
      if (!key) continue;
      if (key.indexOf(RSC_IDX_AUX_EARLIEST) === 0) {
        earliest[key.substring(RSC_IDX_AUX_EARLIEST.length)] = rscText_(vals[r][1]);
        continue;
      }
      if (key.indexOf(RSC_IDX_AUX_CLOSED) === 0) {
        var triple = key.substring(RSC_IDX_AUX_CLOSED.length);
        closed[triple] = rscText_(vals[r][1]);
        var cut = triple.indexOf('|');
        if (cut > 0) {
          var cust = triple.substring(0, cut), suffix = triple.substring(cut + 1);
          if (!closedKeys[cust]) closedKeys[cust] = [];
          closedKeys[cust].push(suffix);
        }
        continue;
      }
      try { map[key] = JSON.parse(vals[r][1]); } catch (e2) { /* baris rusak dilewati */ }
    }
    row += n;
  }
  return {
    available: true, map: map, rows: meta.rows || 0, sheet: meta.sheet || '',
    source: meta.source || '', mode: meta.mode || '', storedIn: 'sheet',
    fields: meta.fields || null, fieldPresent: meta.fieldPresent || null,
    closed: closed, closedKeys: closedKeys, earliest: earliest
  };
}

function rscIndexPersist_(tableName, ver, built) {
  var json = JSON.stringify(built);
  if (json.length <= RSC_DB_PARAMETERS.cacheMaxBytes) {
    var w = rscSnapWrite_(tableName, ver, built);
    if (w.ok) { built.storedIn = 'cache'; return built; }
  }
  var r = rscIdxSheetWrite_(tableName, ver, built);
  built.storedIn = r.ok ? 'sheet' : 'memory-only';
  if (!r.ok) built.persistNote = 'gagal materialisasi index: ' + (r.reason || '-');
  return built;
}

/* =============================================================
 * 6. LAYER INDEX DATABASE — inti perbaikan [F3]
 * ============================================================= */

function rscDbSources_() {
  var out = [];
  var main = rscFileId_(RSC_DB_PARAMETERS.spreadsheetId) || rscText_(RSC_DB_PARAMETERS.spreadsheetId);
  if (main) out.push(main);
  var extra = RSC_DB_PARAMETERS.extraSpreadsheetIds || [];
  for (var i = 0; i < extra.length; i++) {
    var id = rscFileId_(extra[i]) || rscText_(extra[i]);
    if (id && out.indexOf(id) < 0) out.push(id);
  }
  return out;
}

/** Versi index = sidik jari seluruh spreadsheet DB. Stabil 5 menit. */
function rscIndexVersion_() {
  var ids = rscDbSources_();
  if (!ids.length) return 'nodb';
  var tag = ids.join(',');
  var cached = rscGetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag, '');
  var at = Number(rscGetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag + '_AT', '0'));
  if (cached && (Date.now() - at) < 300000) return cached;
  var stamps = [];
  for (var i = 0; i < ids.length; i++) {
    try { stamps.push(DriveApp.getFileById(ids[i]).getLastUpdated().getTime()); }
    catch (e) { stamps.push(Math.floor(Date.now() / 3600000)); }
  }
  var ver = 'v' + stamps.join('-');
  rscSetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag, ver);
  rscSetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag + '_AT', String(Date.now()));
  return ver;
}

var RSC_SHEET_NAME_LIMIT = 31;

/**
 * Cari sheet dari daftar alias. Pencocokan sengaja KETAT: toleransi prefix
 * hanya untuk nama tab yang mentok batas 31 karakter. Tanpa itu alias pendek
 * seperti "m_bp" akan menyambar tab "m_bp_relation".
 */
function rscFindSheet_(ss, aliases) {
  var sheets = ss.getSheets(), byKey = {};
  for (var i = 0; i < sheets.length; i++) {
    var k = rscKey_(sheets[i].getName());
    if (!(k in byKey)) byKey[k] = sheets[i];
  }
  for (var a = 0; a < aliases.length; a++) {
    var hit = byKey[rscKey_(aliases[a])];
    if (hit) return hit;
  }
  for (var b = 0; b < aliases.length; b++) {
    var want = rscKey_(aliases[b]);
    for (var key in byKey) {
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) continue;
      if (byKey[key].getName().length >= RSC_SHEET_NAME_LIMIT &&
          want.length > key.length && want.indexOf(key) === 0) return byKey[key];
    }
  }
  return null;
}

function rscHeaderMap_(headerRow) {
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    var k = rscKey_(headerRow[i]);
    if (k && !(k in map)) map[k] = i;
  }
  return map;
}

function rscPickCol_(hmap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var k = rscKey_(candidates[i]);
    if (k in hmap) return hmap[k];
  }
  return -1;
}

/** Cari tabel di seluruh spreadsheet DB yang dikonfigurasi. */
function rscLocateTable_(aliases) {
  var ids = rscDbSources_();
  for (var i = 0; i < ids.length; i++) {
    var ss;
    try { ss = SpreadsheetApp.openById(ids[i]); }
    catch (e) {
      if (rscClassify_(e).kind === RSC_ERR.INFRA) throw new RscInfraError('Gagal membuka spreadsheet DB: ' + e);
      continue;
    }
    var sh = rscFindSheet_(ss, aliases);
    if (sh) return { sheet: sh, ssId: ids[i], ssName: ss.getName() };
  }
  return null;
}

/**
 * Deteksi layout m_bp_relation. Mendukung empat bentuk yang pernah dipakai:
 *  COMPACT_JSON dengan header 'relation_payload'
 *  COMPACT_JSON tanpa header (baris pertama sudah berupa array JSON)
 *  LEGACY 5 kolom dengan header bp_id_rlt1 dst
 *  LEGACY 5 kolom tanpa header (fallback A..E)
 * Baris pembuka yang berisi URL atau catatan otomatis dilewati.
 */
function RSC_MBP_RELATION_GET_LAYOUT_20260819_(sh) {
  if (!sh) throw new RscDataError('Sheet m_bp_relation tidak tersedia.');
  var lastRow = sh.getLastRow();
  var lastCol = Math.max(1, sh.getLastColumn());
  if (lastRow < 1) return { mode: 'EMPTY', firstDataRow: 1 };

  var scanRows = Math.min(8, lastRow);
  var grid = sh.getRange(1, 1, scanRows, Math.min(200, lastCol)).getDisplayValues();
  var H = RSC_DB_PARAMETERS.relationLegacyHeaders;

  for (var r = 0; r < grid.length; r++) {
    var hmap = rscHeaderMap_(grid[r]);
    var payload = rscPickCol_(hmap, [RSC_DB_PARAMETERS.relationCompactHeader]);
    if (payload >= 0) {
      return { mode: 'COMPACT_JSON', firstDataRow: r + 2, payloadCol: payload + 1, hasHeader: true };
    }
    var cCust = rscPickCol_(hmap, [H.customer]);
    var cRel = rscPickCol_(hmap, [H.relationship]);
    var cSls = rscPickCol_(hmap, [H.salesman]);
    if (cCust >= 0 && cRel >= 0 && cSls >= 0) {
      return {
        mode: 'LEGACY_COLUMNS', firstDataRow: r + 2, hasHeader: true,
        colCustomer: cCust + 1, colRelationship: cRel + 1, colSalesman: cSls + 1,
        colValidFrom: rscPickCol_(hmap, [H.validFrom]) + 1,
        colValidTo: rscPickCol_(hmap, [H.validTo]) + 1
      };
    }
  }

  for (var r2 = 0; r2 < grid.length; r2++) {
    for (var c = 0; c < grid[r2].length; c++) {
      var raw = rscText_(grid[r2][c]);
      if (!raw || raw.charAt(0) !== '[') continue;
      try {
        var parsed = JSON.parse(raw);
        if (Object.prototype.toString.call(parsed) === '[object Array]' && parsed.length >= 3) {
          return { mode: 'COMPACT_JSON', firstDataRow: r2 + 1, payloadCol: c + 1, hasHeader: false };
        }
      } catch (e) { /* bukan payload */ }
    }
  }

  for (var r3 = 0; r3 < grid.length; r3++) {
    if (/^\d{6,12}$/.test(rscText_(grid[r3][0]))) {
      return {
        mode: 'LEGACY_COLUMNS', firstDataRow: r3 + 1, hasHeader: false,
        colCustomer: 1, colRelationship: 2, colSalesman: 3, colValidFrom: 4, colValidTo: 5
      };
    }
  }
  return { mode: 'UNKNOWN', firstDataRow: 1 };
}

/** Ubah satu baris m_bp_relation menjadi bentuk kanonik. */
function RSC_MBP_RELATION_PARSE_ROW_20260819_(layout, row) {
  if (layout.mode === 'COMPACT_JSON') {
    var raw = rscText_(row[layout.payloadCol - 1]);
    if (!raw || raw.charAt(0) !== '[') return null;
    var a;
    try { a = JSON.parse(raw); } catch (e) { return null; }
    if (Object.prototype.toString.call(a) !== '[object Array]' || a.length < 3) return null;
    return {
      customer: RSC_NORMALIZE_ID_(a[0]),
      relationship: RSC_NORMALIZE_ID_(a[1]),
      salesman: RSC_NORMALIZE_ID_(a[2]),
      validFrom: rscDateStr_(a[3]),
      validTo: rscDateStr_(a[4])
    };
  }
  if (layout.mode === 'LEGACY_COLUMNS') {
    return {
      customer: RSC_NORMALIZE_ID_(row[layout.colCustomer - 1]),
      relationship: RSC_NORMALIZE_ID_(row[layout.colRelationship - 1]),
      salesman: RSC_NORMALIZE_ID_(row[layout.colSalesman - 1]),
      validFrom: layout.colValidFrom > 0 ? rscDateStr_(row[layout.colValidFrom - 1]) : '',
      validTo: layout.colValidTo > 0 ? rscDateStr_(row[layout.colValidTo - 1]) : ''
    };
  }
  return null;
}

/** Ambang tanggal aktif. Baris yang lewat lebih lama dari grace tidak diindeks. */
function rscActiveCutoff_() {
  return rscDateStr_(new Date(Date.now() - Number(RSC_DB_PARAMETERS.activeGraceDays || 0) * 86400000));
}

/** Bangun index m_bp_relation: customer -> daftar relasi aktif. */
function rscBuildRelationIndex_() {
  var loc = rscLocateTable_(RSC_DB_PARAMETERS.tables.RELATION);
  if (!loc) return { available: false, reason: 'TABLE_NOT_FOUND', map: {}, rows: 0 };
  var sh = loc.sheet;
  var layout = RSC_MBP_RELATION_GET_LAYOUT_20260819_(sh);
  if (layout.mode === 'EMPTY') return { available: true, map: {}, rows: 0, sheet: sh.getName(), mode: layout.mode };
  if (layout.mode === 'UNKNOWN') return { available: false, reason: 'LAYOUT_UNKNOWN', map: {}, rows: 0, sheet: sh.getName() };

  var lastRow = sh.getLastRow(), lastCol = Math.max(1, sh.getLastColumn());
  var cutoff = rscActiveCutoff_();
  var map = {}, total = 0, skipped = 0, expired = 0;
  var closed = {}, closedKeys = {}, earliest = {};
  var openEnded = OPEN_ENDED_DATE_TEXT;
  var row = layout.firstDataRow, win = RSC_DB_PARAMETERS.readWindowRows;

  while (row <= lastRow) {
    var n = Math.min(win, lastRow - row + 1);
    var block = sh.getRange(row, 1, n, lastCol).getDisplayValues();
    for (var r = 0; r < block.length; r++) {
      var rec = RSC_MBP_RELATION_PARSE_ROW_20260819_(layout, block[r]);
      if (!rec || !rec.customer || !/^\d{6,12}$/.test(rec.customer)) { skipped++; continue; }

      // Agregat ringan yang tetap disimpan walau barisnya sudah kedaluwarsa.
      // Toko Bangkrut membutuhkan histori ini untuk menentukan Valid From.
      if (rec.validFrom) {
        if (!earliest[rec.customer] || rec.validFrom < earliest[rec.customer]) {
          earliest[rec.customer] = rec.validFrom;
        }
        if (rec.relationship && rec.salesman && rec.validTo !== openEnded) {
          var tkey = rec.customer + '|' + rec.relationship + '|' + rec.salesman;
          if (!closed[tkey] || rec.validFrom > closed[tkey]) {
            closed[tkey] = rec.validFrom;
            if (!closedKeys[rec.customer]) closedKeys[rec.customer] = [];
            var suffix = rec.relationship + '|' + rec.salesman;
            if (closedKeys[rec.customer].indexOf(suffix) < 0) closedKeys[rec.customer].push(suffix);
          }
        }
      }

      if (rec.validTo && rec.validTo < cutoff) { expired++; continue; }
      if (!map[rec.customer]) map[rec.customer] = [];
      if (map[rec.customer].length < 24) {
        map[rec.customer].push([rec.relationship, rec.salesman, rec.validFrom, rec.validTo]);
      }
      total++;
    }
    row += n;
  }
  return {
    available: true, map: map, rows: total, skippedRows: skipped, expiredRows: expired,
    closed: closed, closedKeys: closedKeys, earliest: earliest,
    sheet: sh.getName(), source: loc.ssName, sourceId: loc.ssId, mode: layout.mode,
    fields: ['Relationship', 'Salesman ID', 'Valid From', 'Valid To']
  };
}

/** Builder generik berbasis header untuk m_sales_info / m_bp_general_view / m_visit_schedule. */
function rscBuildHeaderIndex_(aliases, keySpecs, valSpecs, opts) {
  opts = opts || {};
  var loc = rscLocateTable_(aliases);
  if (!loc) return { available: false, reason: 'TABLE_NOT_FOUND', map: {}, rows: 0 };
  var sh = loc.sheet;
  var lastRow = sh.getLastRow(), lastCol = Math.max(1, sh.getLastColumn());
  if (lastRow < 2) return { available: true, map: {}, rows: 0, sheet: sh.getName(), mode: 'header' };

  var header = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var hmap = rscHeaderMap_(header);
  var keyIdx = [];
  for (var k = 0; k < keySpecs.length; k++) {
    var ci = rscPickCol_(hmap, keySpecs[k]);
    if (ci < 0) return { available: false, reason: 'KEY_COLUMN_MISSING', map: {}, rows: 0, sheet: sh.getName() };
    keyIdx.push(ci);
  }
  var valIdx = [], fields = [], fieldPresent = {};
  for (var v = 0; v < valSpecs.length; v++) {
    var ci2 = rscPickCol_(hmap, valSpecs[v].aliases);
    valIdx.push(ci2);
    fields.push(valSpecs[v].name);
    fieldPresent[valSpecs[v].name] = ci2 >= 0;
  }
  var activeAt = -1;
  if (opts.activeField) {
    for (var a = 0; a < valSpecs.length; a++) if (valSpecs[a].name === opts.activeField) activeAt = a;
  }
  var cutoff = activeAt >= 0 ? rscActiveCutoff_() : '';

  var map = {}, total = 0, expired = 0, row = 2;
  var win = RSC_DB_PARAMETERS.readWindowRows;
  var maxPerKey = opts.maxPerKey || 8;

  while (row <= lastRow) {
    var n = Math.min(win, lastRow - row + 1);
    var block = sh.getRange(row, 1, n, lastCol).getDisplayValues();
    for (var r = 0; r < block.length; r++) {
      var parts = [], blank = true;
      for (var kk = 0; kk < keyIdx.length; kk++) {
        var kv = RSC_NORMALIZE_ID_(block[r][keyIdx[kk]]);
        if (kv) blank = false;
        parts.push(kv);
      }
      if (blank) continue;
      var rec = [];
      for (var vv = 0; vv < valIdx.length; vv++) {
        rec.push(valIdx[vv] >= 0 ? rscText_(block[r][valIdx[vv]]) : '');
      }
      if (activeAt >= 0) {
        var vt = rscDateStr_(rec[activeAt]);
        if (vt && vt < cutoff) { expired++; continue; }
      }
      var key = parts.join('|');
      if (!map[key]) map[key] = [];
      if (map[key].length < maxPerKey) map[key].push(rec);
      total++;
    }
    row += n;
  }
  return {
    available: true, map: map, rows: total, expiredRows: expired, fields: fields,
    fieldPresent: fieldPresent,
    sheet: sh.getName(), source: loc.ssName, sourceId: loc.ssId, mode: 'header'
  };
}

function rscBuildIndex_(tableName) {
  var D = RSC_DB_PARAMETERS;
  if (!rscDbSources_().length) return { available: false, reason: 'DB_NOT_CONFIGURED', map: {}, rows: 0 };

  if (tableName === 'RELATION') return rscBuildRelationIndex_();

  if (tableName === 'SALESMAN') {
    return rscBuildHeaderIndex_(D.tables.SALESMAN, [D.salesmanHeaders.salesman], [
      { name: 'Sales Office', aliases: D.salesmanHeaders.salesOffice },
      { name: 'Sales Organization', aliases: D.salesmanHeaders.salesOrg },
      { name: 'Sales Type', aliases: D.salesmanHeaders.salesType },
      { name: 'Coverage', aliases: D.salesmanHeaders.coverage },
      { name: 'Name', aliases: D.salesmanHeaders.name },
      { name: 'Valid From', aliases: D.salesmanHeaders.validFrom },
      { name: 'Valid To', aliases: D.salesmanHeaders.validTo }
    ], { activeField: 'Valid To', maxPerKey: 8 });
  }

  if (tableName === 'BP') {
    return rscBuildHeaderIndex_(D.tables.BP, [D.bpHeaders.customer], [
      { name: 'Salesman BP Type', aliases: D.bpHeaders.bpType },
      { name: 'Sales Office', aliases: D.bpHeaders.salesOffice },
      { name: 'Name', aliases: D.bpHeaders.name }
    ], { maxPerKey: 2 });
  }

  if (tableName === 'VISIT') {
    return rscBuildHeaderIndex_(D.tables.VISIT, [D.visitHeaders.customer, D.visitHeaders.salesman], [
      { name: 'Schedule Visit', aliases: D.visitHeaders.schedule },
      { name: 'Visit Category', aliases: D.visitHeaders.visitCategory },
      { name: 'Visit Type', aliases: D.visitHeaders.visitType },
      { name: 'Valid From', aliases: D.visitHeaders.validFrom },
      { name: 'Valid To', aliases: D.visitHeaders.validTo }
    ], { maxPerKey: 8 });
  }

  if (tableName === 'RELTYPE') {
    if (!D.tables.RELTYPE) return { available: false, reason: 'TABLE_NOT_CONFIGURED', map: {}, rows: 0 };
    return rscBuildHeaderIndex_(D.tables.RELTYPE, [D.relTypeHeaders.id], [
      { name: 'Description', aliases: D.relTypeHeaders.desc }
    ], { maxPerKey: 1 });
  }

  throw new RscDataError('Tabel master tidak dikenal: ' + tableName);
}

/**
 * Ambil index: memori -> cache -> sheet index -> bangun (dengan lease).
 * Tidak pernah memegang lock global selama pembangunan.
 */
function rscGetIndex_(tableName) {
  var ver = rscIndexVersion_();
  var memKey = tableName + ':' + ver;
  if (RSC_MEM_INDEX[memKey]) return RSC_MEM_INDEX[memKey];

  if (!rscDbSources_().length) {
    var none = { available: false, reason: 'DB_NOT_CONFIGURED', map: {}, rows: 0, ver: ver };
    RSC_MEM_INDEX[memKey] = none;
    return none;
  }

  var snap = rscSnapRead_(tableName, ver);
  if (snap) { snap.ver = ver; snap.storedIn = 'cache'; RSC_MEM_INDEX[memKey] = snap; return snap; }

  var fromSheet = rscIdxSheetRead_(tableName, ver);
  if (fromSheet) { fromSheet.ver = ver; RSC_MEM_INDEX[memKey] = fromSheet; return fromSheet; }

  var resource = 'IDX:' + tableName + ':' + ver;
  var token = rscLeaseAcquire_(resource, RSC_DB_PARAMETERS.buildLeaseMs);

  if (!token) {
    var waited = 0;
    while (waited < RSC_DB_PARAMETERS.waitForBuilderMs) {
      rscSleep_(RSC_DB_PARAMETERS.waitStepMs);
      waited += RSC_DB_PARAMETERS.waitStepMs;
      var again = rscSnapRead_(tableName, ver) || rscIdxSheetRead_(tableName, ver);
      if (again) { again.ver = ver; RSC_MEM_INDEX[memKey] = again; return again; }
    }
    throw new RscInfraError(
      'Index master "' + tableName + '" sedang dibangun execution lain. ' +
      'Task dijadwalkan ulang tanpa menambah Attempts.', { resource: resource, waitedMs: waited });
  }

  try {
    var recheck = rscSnapRead_(tableName, ver) || rscIdxSheetRead_(tableName, ver);
    if (recheck) { recheck.ver = ver; RSC_MEM_INDEX[memKey] = recheck; return recheck; }
    var built = rscBuildIndex_(tableName);
    built.ver = ver;
    built.builtAt = rscStamp_();
    if (built.available) rscIndexPersist_(tableName, ver, built);
    RSC_MEM_INDEX[memKey] = built;
    return built;
  } finally {
    rscLeaseRelease_(resource, token);
  }
}

/** Lookup banyak key sekaligus: O(k) murni, tanpa jalur full scan. */
function rscLookupMany_(index, keys) {
  var out = {};
  if (!index || !index.available) return out;
  for (var i = 0; i < keys.length; i++) {
    var k = String(keys[i]).toUpperCase();
    if (index.map[k]) out[k] = index.map[k];
  }
  return out;
}

/** Ubah record array menjadi objek bernama sesuai index.fields. */
function rscRecObj_(index, rec) {
  var o = {};
  var f = (index && index.fields) || [];
  for (var i = 0; i < f.length; i++) o[f[i]] = rec[i] === undefined ? '' : rec[i];
  return o;
}
