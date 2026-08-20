'use strict';
/**
 * Stub layanan Google Apps Script untuk pengujian end-to-end di Node.
 * Meniru semantik SpreadsheetApp / PropertiesService / CacheService /
 * LockService / ScriptApp / DriveApp / Session / Utilities secukupnya agar
 * RollingSalesCenter.gs berjalan apa adanya tanpa modifikasi.
 */

const METRICS = {
  dbRangeReads: 0,
  dbRowsRead: 0,
  childOpens: 0,
  lockAcquires: 0,
  lockBusy: 0,
  setValuesCalls: 0
};

/** ID Google Drive asli panjangnya 40+ karakter; stub harus setia. */
function fakeDriveId() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let s = '1';
  for (let i = 0; i < 43; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  _read() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      const src = this.sheet.data[this.row - 1 + r] || [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined || v === null ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  getValues() { return this._read(); }
  getDisplayValues() { return this._read().map(r => r.map(v => (v === null || v === undefined) ? '' : String(v))); }
  getValue() { return this._read()[0][0]; }
  getDisplayValue() { const v = this._read()[0][0]; return v === null || v === undefined ? '' : String(v); }
  setValues(vals) {
    METRICS.setValuesCalls++;
    if (vals.length !== this.numRows) throw new Error('setValues row mismatch: got ' + vals.length + ' want ' + this.numRows);
    for (let r = 0; r < vals.length; r++) {
      if (vals[r].length !== this.numCols) throw new Error('setValues col mismatch at row ' + r + ': got ' + vals[r].length + ' want ' + this.numCols);
      this.sheet._ensureRow(this.row - 1 + r);
      for (let c = 0; c < vals[r].length; c++) this.sheet.data[this.row - 1 + r][this.col - 1 + c] = vals[r][c];
    }
    this.sheet._recalcBounds();
    return this;
  }
  setValue(v) {
    this.sheet._ensureRow(this.row - 1);
    this.sheet.data[this.row - 1][this.col - 1] = v;
    this.sheet._recalcBounds();
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      if (!this.sheet.data[this.row - 1 + r]) continue;
      for (let c = 0; c < this.numCols; c++) this.sheet.data[this.row - 1 + r][this.col - 1 + c] = '';
    }
    this.sheet._recalcBounds();
    return this;
  }
  getFormulas() {
    return this._read().map(r => r.map(v => (typeof v === 'string' && v.charAt(0) === '=') ? v : ''));
  }
  setDataValidation() { return this; }
  // Format disimpan supaya pewarnaan status bisa diperiksa oleh test.
  _fmt(kind, r, c) {
    const key = kind + ':' + (this.row + r) + ':' + (this.col + c);
    return this.sheet.formats[key] === undefined ? null : this.sheet.formats[key];
  }
  _setFmt(kind, r, c, v) { this.sheet.formats[kind + ':' + (this.row + r) + ':' + (this.col + c)] = v; }
  _fill(kind, v) {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this._setFmt(kind, r, c, v);
    return this;
  }
  _grid(kind, vals) {
    for (let r = 0; r < vals.length; r++) {
      for (let c = 0; c < vals[r].length; c++) this._setFmt(kind, r, c, vals[r][c]);
    }
    return this;
  }
  _readFmt(kind) {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this._fmt(kind, r, c));
      out.push(line);
    }
    return out;
  }
  setBackground(v) { return this._fill('bg', v); }
  setBackgrounds(v) { return this._grid('bg', v); }
  getBackgrounds() { return this._readFmt('bg'); }
  getBackground() { return this._fmt('bg', 0, 0); }
  setFontColor(v) { return this._fill('fc', v); }
  setFontColors(v) { return this._grid('fc', v); }
  getFontColors() { return this._readFmt('fc'); }
  setFontWeight(v) { return this._fill('fw', v); }
  setFontWeights(v) { return this._grid('fw', v); }
  getFontWeights() { return this._readFmt('fw'); }
  setWrap(v) { return this._fill('wrap', v); }
  getWraps() { return this._readFmt('wrap'); }
  setNumberFormat() { return this; }
  clear() { return this.clearContent(); }
  setNote() { return this; }
  getA1Notation() { return colLetter(this.col) + this.row; }
}

class FakeSheet {
  constructor(ss, name, data) {
    this.ss = ss; this.name = name;
    this.data = (data || []).map(r => r.slice());
    this.hidden = false; this.frozen = 0;
    this.formats = Object.create(null);   // 'bg:row:col' -> nilai
    this._recalcBounds();
  }
  _ensureRow(i) { while (this.data.length <= i) this.data.push([]); if (!this.data[i]) this.data[i] = []; }
  _recalcBounds() {
    let lr = 0, lc = 0;
    for (let r = 0; r < this.data.length; r++) {
      const row = this.data[r] || [];
      let rowHas = false;
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { rowHas = true; if (c + 1 > lc) lc = c + 1; }
      }
      if (rowHas) lr = r + 1;
    }
    this._lastRow = lr; this._lastCol = lc;
  }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getSheetId() { if (this._id === undefined) this._id = Math.floor(Math.random() * 1e9); return this._id; }
  setFrozenColumns(n) { this.frozenCols = n; return this; }
  getLastRow() { return this._lastRow; }
  getLastColumn() { return this._lastCol; }
  getMaxRows() { return Math.max(this.data.length, this._lastRow); }
  getMaxColumns() { return Math.max(this._lastCol, 30); }
  getRange(row, col, numRows, numCols) {
    if (typeof numRows !== 'number') numRows = 1;
    if (typeof numCols !== 'number') numCols = 1;
    if (row < 1 || col < 1) throw new Error('Range out of bounds: row=' + row + ' col=' + col);
    if (this.ss.isDb) { METRICS.dbRangeReads++; METRICS.dbRowsRead += numRows; }
    return new FakeRange(this, row, col, numRows, numCols);
  }
  insertRowsBefore(row, n) {
    for (let i = 0; i < n; i++) this.data.splice(row - 1, 0, []);
    this._recalcBounds(); return this;
  }
  insertRowsAfter(row, n) {
    for (let i = 0; i < n; i++) this.data.splice(row, 0, []);
    this._recalcBounds(); return this;
  }
  deleteRows(row, n) { this.data.splice(row - 1, n); this._recalcBounds(); return this; }
  hideSheet() { this.hidden = true; return this; }
  showSheet() { this.hidden = false; return this; }
  setFrozenRows(n) { this.frozen = n; return this; }
  clear() { this.data = []; this._recalcBounds(); return this; }
}

class FakeSpreadsheet {
  constructor(id, name, opts) {
    this.id = id; this.name = name; this.sheets = [];
    this.isDb = !!(opts && opts.isDb);
    this.lastUpdated = new Date(2026, 7, 1);
  }
  addSheet(name, data) { const s = new FakeSheet(this, name, data); this.sheets.push(s); return s; }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.find(s => s.getName() === n) || null; }
  insertSheet(n) { return this.addSheet(n, []); }
  getActiveSheet() { return this._active || this.sheets[0]; }
  setActiveSheet(s) { this._active = s; return s; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getProtections() { return []; }
  toast() { return this; }
  deleteSheet(sh) { const i = this.sheets.indexOf(sh); if (i >= 0) this.sheets.splice(i, 1); return this; }
}

class Environment {
  constructor() {
    this.files = new Map();
    this.props = new Map();
    this.cache = new Map();
    this.triggers = [];
    this.lockBusy = false;
    this.effectiveUser = 'paskalis.glennardo@wingscorp.com';
    this.activeId = null;
    this.openFail = new Map();   // fileId -> Error to throw
    this.clockOffsetMs = 0;      // jam virtual: memajukan waktu tanpa sleep nyata
  }
  advance(ms) { this.clockOffsetMs += ms; return this.clockOffsetMs; }
  /** Kunci jam virtual ke tanggal tertentu agar uji tidak bergantung wall-clock. */
  setClock(iso) { this.clockOffsetMs = Date.parse(iso) - Date.now(); return this.clockOffsetMs; }
  addFile(ss) { this.files.set(ss.getId(), ss); return ss; }
  setActive(id) { this.activeId = id; }
}

function buildGlobals(env) {
  const g = {};
  g.console = console;
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + env.clockOffsetMs);
      else super(...args);
    }
    static now() { return RealDate.now() + env.clockOffsetMs; }
    static parse(v) { return RealDate.parse(v); }
    static UTC(...a) { return RealDate.UTC(...a); }
  }
  g.Math = Math; g.JSON = JSON; g.Date = VirtualDate; g.String = String; g.Number = Number;
  g.Object = Object; g.Array = Array; g.isNaN = isNaN; g.isFinite = isFinite; g.parseInt = parseInt;
  g.Error = Error; g.RegExp = RegExp;

  g.SpreadsheetApp = {
    openById(id) {
      if (env.openFail.has(id)) throw env.openFail.get(id);
      const f = env.files.get(id);
      if (!f) { const e = new Error('No item with the given ID could be found: ' + id); throw e; }
      if (f !== env.files.get(env.activeId)) METRICS.childOpens++;
      return f;
    },
    getActiveSpreadsheet() { return env.files.get(env.activeId) || null; },
    newDataValidation() {
      const b = {
        requireValueInList() { return b; },
        setAllowInvalid() { return b; },
        setHelpText() { return b; },
        build() { return {}; }
      };
      return b;
    },
    create(name) {
      const id = fakeDriveId();
      const ss = new FakeSpreadsheet(id, name);
      ss.addSheet('Sheet1', []);
      env.addFile(ss);
      return ss;
    },
    getUi() { throw new Error('No UI in headless context'); }
  };

  g.PropertiesService = {
    getScriptProperties() {
      return {
        getProperty: k => (env.props.has(k) ? env.props.get(k) : null),
        setProperty: (k, v) => { env.props.set(k, String(v)); },
        deleteProperty: k => { env.props.delete(k); },
        getProperties: () => Object.fromEntries(env.props)
      };
    }
  };

  g.CacheService = {
    getScriptCache() {
      return {
        get: k => (env.cache.has(k) ? env.cache.get(k) : null),
        getAll: keys => { const o = {}; keys.forEach(k => { if (env.cache.has(k)) o[k] = env.cache.get(k); }); return o; },
        put: (k, v) => { env.cache.set(k, v); },
        putAll: (m) => {
          const keys = Object.keys(m);
          if (keys.length > 50) throw new Error('putAll too many entries');
          keys.forEach(k => {
            if (String(m[k]).length > 100000) throw new Error('Argument too large: ' + k);
            env.cache.set(k, m[k]);
          });
        },
        remove: k => { env.cache.delete(k); }
      };
    }
  };

  g.LockService = {
    getScriptLock() {
      return {
        tryLock(ms) {
          METRICS.lockAcquires++;
          if (env.lockBusy) { METRICS.lockBusy++; return false; }
          return true;
        },
        releaseLock() {}
      };
    }
  };

  g.Utilities = {
    getUuid() {
      let s = '';
      for (let i = 0; i < 32; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
      return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
    },
    sleep() {}
  };

  g.Session = {
    getEffectiveUser() { return { getEmail: () => env.effectiveUser }; },
    getActiveUser() { return { getEmail: () => env.effectiveUser }; }
  };

  g.DriveApp = {
    Access: { DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK' },
    Permission: { EDIT: 'EDIT' },
    getRootFolder() { return { getName: () => 'My Drive' }; },
    getFileById(id) {
      const f = env.files.get(id);
      if (!f) throw new Error('No item with the given ID could be found: ' + id);
      return {
        getLastUpdated: () => f.lastUpdated,
        getName: () => f.getName(),
        setTrashed: () => { env.files.delete(id); return true; },
        setSharing: () => true,
        makeCopy(name) {
          const nid = fakeDriveId();
          const ns = new FakeSpreadsheet(nid, name);
          f.getSheets().forEach(sh => ns.addSheet(sh.getName(), sh.data));
          env.addFile(ns);
          return { getId: () => nid, getName: () => name };
        }
      };
    }
  };

  g.ScriptApp = {
    getProjectTriggers() {
      return env.triggers.map((t, i) => ({
        getHandlerFunction: () => t.fn,
        _idx: i
      }));
    },
    deleteTrigger(t) {
      const i = env.triggers.findIndex(x => x.fn === t.getHandlerFunction());
      if (i >= 0) env.triggers.splice(i, 1);
    },
    newTrigger(fn) {
      const b = {
        timeBased() { return b; },
        after(ms) { b._after = ms; return b; },
        everyMinutes(m) { b._every = m; return b; },
        create() { env.triggers.push({ fn, after: b._after || 0, every: b._every || 0 }); return { getHandlerFunction: () => fn }; }
      };
      return b;
    }
  };

  return g;
}

module.exports = { FakeSpreadsheet, FakeSheet, Environment, buildGlobals, METRICS, colLetter };
