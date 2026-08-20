// Menggabungkan build/*.gs menjadi satu file RollingSalesCenter.gs.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'build');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort();
const out = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
fs.writeFileSync(path.join(__dirname, 'RollingSalesCenter.gs'), out);
const funcs = (out.match(/^function\s+[A-Za-z0-9_$]+/gm) || []).length;
console.log('RollingSalesCenter.gs:', out.split('\n').length, 'baris,', funcs, 'function, dari', files.length, 'chunk');
