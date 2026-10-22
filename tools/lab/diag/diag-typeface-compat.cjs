/**
 * 诊断：站点字体与参考库**是不是同一种字型**？"画细"的比例稳不稳定？
 *
 *   node tools/lab/diag-typeface-compat.cjs
 *
 * 三个问题：
 *   ① 同一种字型吗？ → 比对站点字形与**真身**参考字形的
 *      包围盒 / 重心 / 二值形状距离。形状几乎一致 ⇒ 轮廓同源，只有粗细不同。
 *   ② "画细"的比例稳不稳？ → 每个字型的墨量比（站点 ÷ 参考）分布。
 *   ③ 万一下次画得更细（15%、20%…）还认得出吗？
 *      → 把站点字形按不同系数"变细"，跑完整识别，看准确率。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));
const { GlyphEngine } = require(path.join(ROOT, 'src/features/safari-repair/engine'));

const SIZE = 48;
const FIXTURES = [
  {
    dir: path.join(ROOT, 'src/features/safari-repair/test/fixtures/live'),
    name: '真实站点 · 大学生与创业(二)',
    files: ['live-quiz-2'],
  },
  {
    dir: path.join(ROOT, 'src/features/safari-repair/test/fixtures/live'),
    name: '真实站点 · TRIZ理论(十一)',
    files: ['live-triz-11'],
  },
  {
    dir: path.join(ROOT, 'src/features/safari-repair/test/fixtures/fonts'),
    name: '仓库夹具 · 混淆字体 A',
    files: ['obf-same-style'],
  },
  {
    dir: path.join(ROOT, 'src/features/safari-repair/test/fixtures/fonts'),
    name: '仓库夹具 · 混淆字体 B',
    files: ['obf-second-style'],
  },
];

function cov(font, ch) {
  return core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);
}
function stats(c) {
  let ink = 0;
  let minX = SIZE;
  let maxX = -1;
  let minY = SIZE;
  let maxY = -1;
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const v = c[y * SIZE + x];
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
function binDist(a, b, th = 0.5) {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i] >= th ? 1 : 0) !== (b[i] >= th ? 1 : 0)) d += 1;
  }
  return d / a.length;
}
function scale(c, f) {
  const o = new Float32Array(c.length);
  for (let i = 0; i < c.length; i += 1) o[i] = c[i] * f;
  return o;
}

async function main() {
  const ref = opentype.parse(fs.readFileSync(path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')));
  console.log('参考库字体:Noto Sans SC(= 思源黑体 Source Han Sans CN)\n');

  for (const group of FIXTURES) {
    for (const base of group.files) {
      const ttf = path.join(group.dir, `${base}.ttf`);
      const truthFile = path.join(group.dir, `${base}.truth.json`);
      const mapFile = path.join(group.dir, `${base}.map.json`);
      if (!fs.existsSync(ttf)) continue;
      const truth = fs.existsSync(truthFile)
        ? JSON.parse(fs.readFileSync(truthFile, 'utf8')).truth
        : JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      const site = opentype.parse(fs.readFileSync(ttf));

      // ① 同一种字型吗？② 墨量比分布
      const inkRatios = [];
      const binDists = [];
      const grayDists = [];
      const boxDeltas = [];
      const centroidDeltas = [];
      for (const [cipher, plain] of Object.entries(truth)) {
        const sc = cov(site, cipher);
        const rc = cov(ref, plain);
        const ss = stats(sc);
        const rs = stats(rc);
        inkRatios.push(ss.ink / (rs.ink || 1));
        binDists.push(binDist(sc, rc));
        grayDists.push(l1(sc, rc));
        boxDeltas.push(Math.max(Math.abs(ss.w - rs.w), Math.abs(ss.h - rs.h)));
        centroidDeltas.push(Math.hypot(ss.cx - rs.cx, ss.cy - rs.cy));
      }
      const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
      const rng = (a) => `${Math.min(...a).toFixed(3)}~${Math.max(...a).toFixed(3)}`;

      console.log(`=== ${group.name}（${Object.keys(truth).length} 个码位）===`);
      console.log(
        `  墨量比(站点÷参考)      ${avg(inkRatios).toFixed(3)}  范围 ${rng(inkRatios)}`,
      );
      console.log(`  包围盒差(格)          平均 ${avg(boxDeltas).toFixed(2)}  最大 ${Math.max(...boxDeltas)}`);
      console.log(`  重心偏移(格)          平均 ${avg(centroidDeltas).toFixed(2)}  最大 ${Math.max(...centroidDeltas).toFixed(2)}`);
      console.log(`  与真身的灰度距离      平均 ${avg(grayDists).toFixed(4)}`);
      console.log(`  与真身的**二值形状**距离 平均 ${avg(binDists).toFixed(4)}  ← 同字型的关键证据`);
      console.log('');
    }
  }

  // ③ 变细多少还认得出
  console.log('=== ③ 站点字形再"画细"多少，识别还准吗？（每个因子下重新跑完整识别）===');
  for (const group of FIXTURES) {
    for (const base of group.files) {
      const ttf = path.join(group.dir, `${base}.ttf`);
      const truthFile = path.join(group.dir, `${base}.truth.json`);
      const mapFile = path.join(group.dir, `${base}.map.json`);
      if (!fs.existsSync(ttf)) continue;
      const truth = fs.existsSync(truthFile)
        ? JSON.parse(fs.readFileSync(truthFile, 'utf8')).truth
        : JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      const site = opentype.parse(fs.readFileSync(ttf));
      const out = [];
      for (const factor of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
        // 把字形按系数变细 → 重新识别
        const engine = new GlyphEngine({ log: () => {} });
        const thinned = {};
        for (const ch of Object.keys(truth)) {
          thinned[ch] = scale(cov(site, ch), factor);
        }
        // 直接用引擎的匹配路径：把变细后的覆盖度当查询
        const matcher = engine.matchers.get('glyph-db-48.crdb.gz') || (engine.loadDb('glyph-db-48.crdb.gz'), engine.matchers.get('glyph-db-48.crdb.gz'));
        let ok = 0;
        const bad = [];
        for (const [cipher, plain] of Object.entries(truth)) {
          const r = matcher.lookup(thinned[cipher], { maxCandidates: 512 });
          const got = r.codepoint ? String.fromCodePoint(r.codepoint) : '';
          if (got === plain) ok += 1;
          else if (bad.length < 3) bad.push(`${cipher}→${got || '?'}`);
        }
        out.push(`×${factor}: ${ok}/${Object.keys(truth).length}${bad.length ? ' (' + bad.join(' ') + ')' : ''}`);
      }
      console.log(`  ${group.name.padEnd(28, ' ')} ${out.join('   ')}`);
    }
  }
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
