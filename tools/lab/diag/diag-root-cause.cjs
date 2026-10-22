/**
 * 根因调查：站点的字形与参考字形之间，**系统性地**差了什么？
 *
 *   node tools/lab/diag-root-cause.cjs <站点字体> [参考字体]
 *
 * 对每个能认出来的字，打印：
 *   - 墨量（总覆盖度）
 *   - 包围盒（左/上/右/下 的墨迹范围）
 *   - 重心（墨量分布的中心）
 *   - 与参考字形的距离
 * 目的：看出站点是不是**统一地**对字形做了某种变换（缩放/平移/变细/重绘），
 *      还是只有个别字特殊。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));

function stats(coverage, size) {
  let ink = 0;
  let minX = size;
  let maxX = -1;
  let minY = size;
  let maxY = -1;
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = coverage[y * size + x];
      if (v <= 0) continue;
      ink += v;
      cx += x * v;
      cy += y * v;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    ink,
    box: [minX, minY, maxX, maxY],
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    cx: ink ? cx / ink : 0,
    cy: ink ? cy / ink : 0,
  };
}

function l1(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function main() {
  const [siteFile, refFile] = process.argv.slice(2);
  if (!siteFile) {
    console.log('用法: node tools/lab/diag-root-cause.cjs <站点字体> [参考字体]');
    return;
  }
  const SIZE = 48;
  const site = opentype.parse(fs.readFileSync(siteFile));
  const ref = opentype.parse(fs.readFileSync(refFile || path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')));

  const cov = (font, ch) => core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);

  // 用字形最像的参考字来配对（取参考库里所有字里最近的那个当"真身"的近似）
  const refChars = [];
  for (const ch of '战略意识产品性质服务方向能力素质创业动机意志抗压人际协调个人成长计划宏观目标细化行动应包括两个方面那么它就成功') {
    refChars.push(ch);
  }

  console.log('站点码位 → 最接近的参考字 | 墨量比 | 包围盒(站点 vs 参考) | 宽高比 | 重心偏移 | 距离');
  const rows = [];
  const pairs = site.tables?.cmap?.glyphIndexMap;
  const entries = pairs instanceof Map ? [...pairs.keys()] : Object.keys(pairs || {});
  for (const cp of entries) {
    if (!cp || cp < 0x20) continue;
    const ch = String.fromCodePoint(cp);
    const sc = cov(site, ch);
    const ss = stats(sc, SIZE);
    if (!ss.ink) continue;
    let best = null;
    for (const rc of refChars) {
      const r = cov(ref, rc);
      const d = l1(sc, r);
      if (!best || d < best.d) best = { rc, d, cov: r, st: stats(r, SIZE) };
    }
    if (!best) continue;
    rows.push({
      ch,
      rc: best.rc,
      d: best.d,
      inkRatio: ss.ink / best.st.ink,
      siteBox: ss.box,
      refBox: best.st.box,
      wRatio: ss.w / best.st.w,
      hRatio: ss.h / best.st.h,
      dcx: ss.cx - best.st.cx,
      dcy: ss.cy - best.st.cy,
    });
  }
  rows.sort((a, b) => a.d - b.d);
  for (const r of rows) {
    console.log(
      `  ${r.ch}→${r.rc}  d=${r.d.toFixed(4)}  墨量比=${r.inkRatio.toFixed(2)}` +
        `  宽比=${r.wRatio.toFixed(2)} 高比=${r.hRatio.toFixed(2)}` +
        `  重心偏移=(${r.dcx.toFixed(1)},${r.dcy.toFixed(1)})` +
        `  框 ${JSON.stringify(r.siteBox)} vs ${JSON.stringify(r.refBox)}`,
    );
  }
  // 汇总：看有没有系统性的比例
  const avg = (k) => (rows.length ? rows.reduce((s, r) => s + r[k], 0) / rows.length : 0);
  console.log('\n平均: 墨量比', avg('inkRatio').toFixed(3), ' 宽比', avg('wRatio').toFixed(3), ' 高比', avg('hRatio').toFixed(3));
  console.log('平均距离', avg('d').toFixed(4), ' 最大距离', Math.max(...rows.map((r) => r.d)).toFixed(4));
}

main();
