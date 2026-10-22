/**
 * 诊断：站点重绘的笔画比参考**细**，导致"笔画少的字"距离反而更近。
 * 试三种归一化口径，看能不能把「略」排到「赂」前面。
 *
 *   node tools/lab/diag-normalize.cjs <字体> <字> [候选字...]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));

function l1(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
/** 归一化到"总墨量一致"：去掉笔画粗细的差异，只比形状 */
function unitInk(c) {
  let sum = 0;
  for (let i = 0; i < c.length; i += 1) sum += c[i];
  if (!sum) return c;
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i += 1) out[i] = c[i] / sum;
  return out;
}
/** 二值化：笔画粗细直接不算数 */
function binary(c, th = 0.5) {
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i += 1) out[i] = c[i] >= th ? 1 : 0;
  return out;
}

function main() {
  const [fontFile, key, ...cands] = process.argv.slice(2);
  if (!fontFile || !key) {
    console.log('用法: node tools/lab/diag-normalize.cjs <字体> <字> [候选字...]');
    return;
  }
  const SIZE = 48;
  const site = opentype.parse(fs.readFileSync(fontFile));
  const ref = opentype.parse(fs.readFileSync(path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')));
  const cov = (font, ch) => core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);

  const q = cov(site, key);
  const ink = (c) => {
    let s = 0;
    for (let i = 0; i < c.length; i += 1) s += c[i];
    return s;
  };
  console.log(`站点字形「${key}」总墨量 ${ink(q).toFixed(1)}`);
  const rows = cands.map((c) => {
    const rc = cov(ref, c);
    return {
      c,
      raw: l1(q, rc),
      unit: l1(unitInk(q), unitInk(rc)),
      bin: l1(binary(q), binary(rc)),
      ink: ink(rc),
    };
  });
  for (const [label, key2] of [['原始 L1', 'raw'], ['总墨量归一化', 'unit'], ['二值化', 'bin']]) {
    const sorted = [...rows].sort((a, b) => a[key2] - b[key2]);
    const margin = sorted.length > 1 ? sorted[1][key2] - sorted[0][key2] : 0;
    console.log(`\n${label}:`);
    console.log('  ' + sorted.map((r) => `${r.c} ${r[key2].toFixed(4)}(墨${r.ink.toFixed(0)})`).join('  '));
    console.log(`  → 最优 ${sorted[0].c}，margin ${margin.toFixed(4)}`);
  }
}

main();
