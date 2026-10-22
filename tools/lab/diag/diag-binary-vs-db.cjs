/**
 * 诊断：二值化(比形状不比粗细)对**库里的字形**(模糊过)是否有效。
 *
 *   node tools/lab/diag-binary-vs-db.cjs <字体> <字> [候选字...]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));
const { loadReferenceDb } = require('../../../src/features/safari-repair/engine');

function main() {
  const [fontFile, key, ...cands] = process.argv.slice(2);
  if (!fontFile || !key || !cands.length) {
    // 候选字是必需的：没有候选就没法比"谁更近"，以前会空数组越界崩掉
    console.log('用法: node tools/lab/diag-binary-vs-db.cjs <字体> <字> <候选字...>');
    return;
  }
  const db = loadReferenceDb('glyph-db-48.crdb.gz');
  const SIZE = db.header.gridSize;
  const site = opentype.parse(fs.readFileSync(fontFile));
  const q = core.rasterizeContours(core.flattenPath(site.getPath(key, 0, 0, 1).commands), SIZE);

  // 查询侧：按库同样的 4bit 量化 + 阈值二值化
  const qnib = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    qnib[i] = Math.round(Math.min(1, Math.max(0, q[i])) * 15);
  }
  const qbin = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i += 1) qbin[i] = qnib[i] >= 8 ? 1 : 0;

  const rows = cands.map((c) => {
    const idx = db.indexOfCodepoint(c.codePointAt(0));
    if (idx < 0) return { c, raw: 1, bin: 1 };
    const off = idx * ((SIZE * SIZE) >> 1);
    let rawSum = 0;
    let binDiff = 0;
    for (let i = 0; i < SIZE * SIZE; i += 1) {
      const byte = db.fine[off + (i >> 1)];
      const nib = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
      rawSum += Math.abs(nib / 15 - q[i]);
      if ((nib >= 8 ? 1 : 0) !== qbin[i]) binDiff += 1;
    }
    return { c, raw: rawSum / (SIZE * SIZE), bin: binDiff / (SIZE * SIZE) };
  });

  for (const [label, k] of [['原始 L1(现状)', 'raw'], ['二值化(比形状)', 'bin']]) {
    const sorted = [...rows].sort((a, b) => a[k] - b[k]);
    const margin = sorted.length > 1 ? sorted[1][k] - sorted[0][k] : 0;
    console.log(`\n${label}:`);
    console.log('  ' + sorted.map((r) => `${r.c} ${r[k].toFixed(4)}`).join('  '));
    console.log(`  → 最优 ${sorted[0].c}，margin ${margin.toFixed(4)}`);
  }
}

main();
