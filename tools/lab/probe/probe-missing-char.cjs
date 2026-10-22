/**
 * 探针：参考库里**缺**某个字时，最近邻会给出什么？会不会写出错字？
 *
 *   node tools/lab/probe-missing-char.cjs
 *
 * 做法：拿参考字体(Noto Sans SC)里某个 GB2312 之外的生僻字，
 * 用**与参考库同一个栅格化器**栅格化，再去查 GB2312 库。
 * 若最近邻的分数过了闸门(相似度≥0.8、margin≥0.01)，
 * 说明**没有生僻字参考就会写出错字**；被闸门挡住才算安全。
 */
const fs = require('fs');
const path = require('path');
const opentype = require(path.join(__dirname, '..', '..', '..', 'vendor', 'opentype.js'));
const core = require(path.join(__dirname, '..', '..', '..', 'vendor', 'copy-repair-core.cjs'));
const { loadReferenceDb } = require('../../../src/features/safari-repair/engine');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FONT = path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf');

/** GB2312 之外、但字体里有的生僻字（挑几个常见的） */
const RARE = ['龘', '犇', '龗', '昶', '淼', '燚', '垚', '㸃', '㵘', '鿕', '齾', '靐', '飝', '㶿'];

function quantize(coverage) {
  const out = new Float32Array(coverage.length);
  for (let i = 0; i < coverage.length; i += 1) {
    out[i] = Math.round(Math.min(1, Math.max(0, coverage[i])) * 15) / 15;
  }
  return out;
}

function main() {
  const font = opentype.parse(fs.readFileSync(FONT));
  // 默认读随包分发的那一份（vendor/glyph-db-48.crdb.gz）；
  // 传绝对路径可换别的库来对比。
  const dbFile = process.argv[2] || 'glyph-db-48.crdb.gz';
  const db = loadReferenceDb(dbFile);
  console.log(`参考库 ${dbFile}：${db.header.count} 字，栅格 ${db.header.gridSize}\n`);

  const size = db.header.gridSize;
  for (const ch of RARE) {
    const pathObj = font.getPath(ch, 0, 0, 1);
    const contours = core.flattenPath(pathObj.commands);
    if (!contours.some((c) => c.length >= 6)) {
      console.log(`${ch}  参考字体里没有这个字形，跳过`);
      continue;
    }
    const coverage = quantize(core.rasterizeContours(contours, size));
    const ownIndex = db.indexOfCodepoint(ch.codePointAt(0));
    // 最近邻 + 次优（算 margin：引擎用它判断"分不清就别改"）
    let best = { index: -1, distance: 1 };
    let second = 1;
    for (let i = 0; i < db.header.count; i += 1) {
      const d = db.distanceToIndex(i, coverage);
      if (d < best.distance) {
        second = best.distance;
        best = { index: i, distance: d };
      } else if (d < second) {
        second = d;
      }
    }
    const score = 1 - best.distance;
    const margin = Math.max(0, (1 - best.distance) - (1 - second));
    const near = db.codepoints ? String.fromCodePoint(db.codepoints[best.index]) : '?';
    const gates = score >= 0.8 && margin >= 0.01;
    const verdict =
      ownIndex >= 0
        ? '库里有 → 正常'
        : gates
          ? `✖ 会写出错字：认成「${near}」(相似度 ${score.toFixed(3)}, margin ${margin.toFixed(4)})`
          : `安全：相似度 ${score.toFixed(3)} margin ${margin.toFixed(4)} → 闸门挡住`;
    console.log(`${ch}  ${verdict}`);
  }
}

main();
