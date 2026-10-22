/**
 * 诊断：能不能靠"按区分度加权的距离"把 略/赂 这类偏旁相同的常用字分开？
 *
 *   node tools/lab/diag-weighted-distance.cjs <字体> <字...>
 *
 * 背景：略(田各) 与 赂(贝各) 只差左边那一小块，48×48 的整体 L1 距离几乎一样
 *      （margin 0.0015）→ 判不出来。想法是：**给"这个格子在库里越有区分度"，
 *      权重越高**（类似 TF-IDF），让差异集中的区域主导距离。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));
const { loadReferenceDb } = require('../../../src/features/safari-repair/engine');

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function main() {
  const [fontFile, ...keys] = process.argv.slice(2);
  if (!fontFile || !keys.length) {
    console.log('用法: node tools/lab/diag-weighted-distance.cjs <字体> <字...>');
    return;
  }
  // 默认读随包分发的那一份；传 .crdb/.crdb.gz 路径可换别的库
  const dbFile = process.argv.find((a) => a.endsWith('.crdb') || a.endsWith('.crdb.gz'));
  const db = loadReferenceDb(dbFile || 'glyph-db-48.crdb.gz');
  const ref = opentype.parse(fs.readFileSync(path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')));
  const site = opentype.parse(fs.readFileSync(fontFile));
  const SIZE = db.header.gridSize;

  // 每格的"区分度"：该格墨量在库里的方差（方差大 = 这格常变 = 有区分力）
  const n = db.header.count;
  const sum = new Float64Array(SIZE * SIZE);
  const sumSq = new Float64Array(SIZE * SIZE);
  const cell = (index, i) => {
    const off = index * ((SIZE * SIZE) >> 1);
    const byte = db.fine[off + (i >> 1)];
    return (i % 2 === 0 ? byte >> 4 : byte & 15) / 15;
  };
  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < SIZE * SIZE; i += 1) {
      const v = cell(k, i);
      sum[i] += v;
      sumSq[i] += v * v;
    }
  }
  const weight = new Float64Array(SIZE * SIZE);
  let wsum = 0;
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    const mean = sum[i] / n;
    const variance = Math.max(0, sumSq[i] / n - mean * mean);
    // 开方 → 标准差；再放大一点让高区分度的格子主导
    weight[i] = Math.sqrt(variance) * Math.sqrt(variance) + 0.02;
    wsum += weight[i];
  }
  for (let i = 0; i < SIZE * SIZE; i += 1) weight[i] /= wsum / (SIZE * SIZE);

  const cov = (font, ch) => core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);
  const wdist = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 1) s += weight[i] * Math.abs(a[i] - b[i]);
    return s;
  };

  const candidates = '格挌袼恪烙悋棓佫咯略赂峈峂辂貉峪各格咯'.split('');
  for (const key of keys) {
    const q = cov(site, key);
    const rows = candidates.map((c) => {
      const rc = cov(ref, c);
      return { c, plain: dist(q, rc), weighted: wdist(q, rc) };
    });
    const byPlain = [...rows].sort((a, b) => a.plain - b.plain);
    const byWeighted = [...rows].sort((a, b) => a.weighted - b.weighted);
    console.log(`\n=== 站点字形「${key}」 ===`);
    console.log('  普通 L1 : ' + byPlain.slice(0, 4).map((r) => `${r.c} ${r.plain.toFixed(4)}`).join('  ') +
      `  → margin ${(byPlain[1].plain - byPlain[0].plain).toFixed(4)}`);
    console.log('  加权距离: ' + byWeighted.slice(0, 4).map((r) => `${r.c} ${r.weighted.toFixed(4)}`).join('  ') +
      `  → margin ${(byWeighted[1].weighted - byWeighted[0].weighted).toFixed(4)}`);
  }
}

main();
