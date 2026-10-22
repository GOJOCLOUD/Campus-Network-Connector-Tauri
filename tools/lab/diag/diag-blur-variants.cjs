/**
 * 诊断：查询侧与参考侧的三种口径，对区分度(margin)的影响。
 *
 *   node tools/lab/diag-blur-variants.cjs <字体文件> <字...>
 *
 * 背景：建库时参考字形做了 blur(模糊)，查询侧没做 → 两边不对称，
 *       分数被系统性压低、相似字之间的 margin 被抹掉（实测 0.0024）。
 * 三种口径：
 *   A 原始查询 vs 模糊参考（现状）
 *   B 模糊查询 vs 模糊参考（对称）
 *   C 原始查询 vs 原始参考（对称，但要重建库）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function main() {
  const [fontFile, ...keys] = process.argv.slice(2);
  if (!fontFile || !keys.length) {
    console.log('用法: node tools/lab/diag-blur-variants.cjs <字体> <字...>');
    return;
  }
  const ref = opentype.parse(fs.readFileSync(path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')));
  const site = opentype.parse(fs.readFileSync(fontFile));
  const SIZE = 48;

  const cov = (font, ch) => core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);
  const blur = (c) => core.blur(c, SIZE);

  // 参考字库里挑一批容易混的常用字当候选
  const candidates = '格挌袼恪烙悋棓佫咯略赂峈峂辂貉峪'.split('');

  for (const key of keys) {
    const q = cov(site, key);
    const qb = blur(q);
    const rows = [];
    for (const c of candidates) {
      const rc = cov(ref, c);
      const rcb = blur(rc);
      rows.push({
        c,
        A: dist(q, rcb),
        B: dist(qb, rcb),
        C: dist(q, rc),
      });
    }
    console.log(`\n=== 站点字形「${key}」 ===`);
    for (const tag of ['A', 'B', 'C']) {
      const sorted = [...rows].sort((x, y) => x[tag] - y[tag]).slice(0, 4);
      const margin = sorted[1][tag] - sorted[0][tag];
      const label = { A: 'A 原始查询 vs 模糊参考(现状)', B: 'B 模糊查询 vs 模糊参考(对称)', C: 'C 原始查询 vs 原始参考(对称)' }[tag];
      console.log(`  ${label}`);
      console.log(
        `    最优 ${sorted[0].c}(${sorted[0][tag].toFixed(4)})  次优 ${sorted[1].c}(${sorted[1][tag].toFixed(4)})` +
          `  → margin ${margin.toFixed(4)}`,
      );
    }
  }
}

main();
