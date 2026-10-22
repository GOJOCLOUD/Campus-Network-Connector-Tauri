/**
 * 根因调查（量化）：站点的字形到底被改了什么？改动的量与"认错"的关系。
 *
 *   node tools/lab/diag-thickness.cjs <站点字体> [阈值...]
 *
 * 对每个码位：
 *   1) 用引擎的判定拿到"它应该是哪个字"（没把握的单独标出）
 *   2) 算站点字形 vs 该字的：墨量比、包围盒比、重心偏移
 *   3) 对每个二值化阈值，算"到真身"和"到最佳错配"的距离与 margin
 * 目的：找出**一个**能同时解释所有失败字的因素，并给出阈值该取多少。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));
const { loadReferenceDb } = require('../../../src/features/safari-repair/engine');

const SIZE = 48;

function stats(cov) {
  let ink = 0;
  let minX = SIZE;
  let maxX = -1;
  let minY = SIZE;
  let maxY = -1;
  let cx = 0;
  let cy = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const v = cov[y * SIZE + x];
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
  return { ink, box: [minX, minY, maxX, maxY], w: maxX - minX + 1, h: maxY - minY + 1, cx: ink ? cx / ink : 0, cy: ink ? cy / ink : 0 };
}

/** 库里某码位的覆盖度（4bit 解包 + 反量化） */
function dbCoverage(db, index) {
  const off = index * ((SIZE * SIZE) >> 1);
  const out = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    const byte = db.fine[off + (i >> 1)];
    const nib = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out[i] = nib / 15;
  }
  return out;
}

function binaryDist(a, b, th) {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    if ((a[i] >= th ? 1 : 0) !== (b[i] >= th ? 1 : 0)) d += 1;
  }
  return d / a.length;
}

function main() {
  const siteFile = process.argv[2];
  const thresholds = process.argv.slice(3).map(Number);
  const ths = thresholds.length ? thresholds : [0.3, 0.4, 0.5, 0.6, 0.7];
  if (!siteFile) {
    console.log('用法: node tools/lab/diag-thickness.cjs <站点字体> [阈值...]');
    return;
  }
  const db = loadReferenceDb('glyph-db-48.crdb.gz');
  const site = opentype.parse(fs.readFileSync(siteFile));
  const ref = opentype.parse(fs.readFileSync(path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')));
  const cov = (font, ch) => core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);

  // 参考库里所有字的覆盖度（一次性算好，后面查）
  const refCov = new Map();
  for (const cp of db.codepoints) {
    const ch = String.fromCodePoint(cp);
    try {
      refCov.set(ch, cov(ref, ch));
    } catch (_) {
      /* ignore */
    }
  }

  const pairs = site.tables?.cmap?.glyphIndexMap;
  const entries = pairs instanceof Map ? [...pairs.keys()] : Object.keys(pairs || {});
  const report = [];
  for (const cp of entries) {
    if (!cp || cp < 0x20) continue;
    const ch = String.fromCodePoint(cp);
    const sc = cov(site, ch);
    const ss = stats(sc);
    if (!ss.ink) continue;

    // 用"到参考库所有字"找最佳与次佳（这才是引擎实际做的事）
    const ranked = [];
    for (const [rc, rCov] of refCov) {
      const d = binaryDist(sc, rCov, 0.5);
      ranked.push({ rc, d });
    }
    ranked.sort((a, b) => a.d - b.d);
    if (!ranked.length) continue;
    const best = ranked[0];
    const second = ranked[1];
    const bs = stats(refCov.get(best.rc));
    report.push({
      ch,
      truth: best.rc,
      margin: second.d - best.d,
      inkRatio: ss.ink / (bs.ink || 1),
      wRatio: ss.w / (bs.w || 1),
      hRatio: ss.h / (bs.h || 1),
      dcx: ss.cx - bs.cx,
      dcy: ss.cy - bs.cy,
      perThreshold: ths.map((th) => {
        const rs = [...refCov.entries()]
          .map(([rc, rCov]) => ({ rc, d: binaryDist(sc, rCov, th) }))
          .sort((a, b) => a.d - b.d);
        return { th, best: rs[0].rc, margin: rs.length > 1 ? rs[1].d - rs[0].d : 0 };
      }),
    });
  }
  report.sort((a, b) => a.margin - b.margin);
  console.log('码位  最佳候选  margin  墨量比 宽比 高比  重心偏移');
  for (const r of report) {
    console.log(
      `  ${r.ch}→${r.truth}  m=${r.margin.toFixed(4)}  墨=${r.inkRatio.toFixed(2)}` +
        ` 宽=${r.wRatio.toFixed(2)} 高=${r.hRatio.toFixed(2)} 重心=(${r.dcx.toFixed(1)},${r.dcy.toFixed(1)})`,
    );
  }
  console.log('\n各二值化阈值下的表现（margin 最小的那几个码位）:');
  for (const th of ths) {
    const worst = report
      .map((r) => {
        const t = r.perThreshold.find((x) => x.th === th);
        return { ch: r.ch, best: t.best, margin: t.margin };
      })
      .sort((a, b) => a.margin - b.margin)
      .slice(0, 4);
    console.log(
      `  阈值 ${th}: 最差 4 个 → ` +
        worst.map((w) => `${w.ch}→${w.best}(m=${w.margin.toFixed(4)})`).join('  '),
    );
  }
  const avgInk = report.reduce((s, r) => s + r.inkRatio, 0) / (report.length || 1);
  const minMargin = report.length ? Math.min(...report.map((r) => r.margin)) : 0;
  console.log(`\n平均墨量比 ${avgInk.toFixed(3)}  最小 margin ${minMargin.toFixed(4)}  码位 ${report.length}`);
}

main();
