/**
 * 量一批真实/仓库字体**逐字**的匹配分数分布，用来定"只认多高置信度"的阈值。
 *
 *   node tools/lab/score-distribution.cjs [字体文件...]
 *
 * 关键问题：参考库里缺某个字时，最近邻会不会"像但不对"（于是写出错字）。
 * 做法：对每个密文码位算出 tier-1（GB2312 库）的最佳分数与 margin。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));
const { loadReferenceDb } = require('../../../src/features/safari-repair/engine');

function quantize(coverage) {
  const out = new Float32Array(coverage.length);
  for (let i = 0; i < coverage.length; i += 1) {
    out[i] = Math.round(Math.min(1, Math.max(0, coverage[i])) * 15) / 15;
  }
  return out;
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('用法: node tools/lab/score-distribution.cjs <字体文件...>');
    return;
  }
  const db = loadReferenceDb('glyph-db-48.crdb.gz');
  const size = db.header.gridSize;
  console.log(`参考库 GBK：${db.header.count} 字\n`);

  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const pairs = font.tables?.cmap?.glyphIndexMap;
    const entries = pairs instanceof Map ? [...pairs.entries()] : Object.entries(pairs || {});
    const scores = [];
    for (const [cp, gid] of entries) {
      if (!cp || cp < 0x20 || !gid) continue;
      const pathObj = font.getPath(String.fromCodePoint(cp), 0, 0, 1);
      const contours = core.flattenPath(pathObj.commands);
      if (!contours.some((c) => c.length >= 6)) continue;
      const coverage = quantize(core.rasterizeContours(contours, size));
      let best = 1;
      let second = 1;
      for (let i = 0; i < db.header.count; i += 1) {
        const d = db.distanceToIndex(i, coverage);
        if (d < best) {
          second = best;
          best = d;
        } else if (d < second) second = d;
      }
      const own = db.indexOfCodepoint(cp);
      const selfDistance = own >= 0 ? db.distanceToIndex(own, coverage) : 1;
      scores.push({
        cp,
        score: 1 - best,
        margin: Math.max(0, (1 - best) - (1 - second)),
        selfDistance,
      });
    }
    scores.sort((a, b) => a.score - b.score);
    console.log(`\n=== ${path.basename(file)} （${scores.length} 个码位）===`);
    console.log('  最低 8 个分数:');
    for (const s of scores.slice(0, 8)) {
      console.log(
        `    U+${s.cp.toString(16).toUpperCase().padStart(4, '0')}  分数 ${s.score.toFixed(4)}  margin ${s.margin.toFixed(4)}  自身距离 ${s.selfDistance.toFixed(4)}`,
      );
    }
    const min = scores[0] ? scores[0].score : 1;
    const minMargin = scores.reduce((m, s) => Math.min(m, s.margin), 1);
    console.log(`  最低分 ${min.toFixed(4)}   最小 margin ${minMargin.toFixed(4)}`);
    for (const th of [0.8, 0.9, 0.95, 0.97]) {
      const below = scores.filter((s) => s.score < th).length;
      console.log(`    阈值 ${th}: 会挡掉 ${below}/${scores.length} 个码位`);
    }
    void crypto;
  }
}

main();
