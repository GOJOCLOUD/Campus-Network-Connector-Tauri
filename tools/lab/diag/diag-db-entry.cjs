/**
 * 诊断：参考库里的某个字形，和用参考字体现算出来的字形一致吗？
 *
 *   node tools/lab/diag-db-entry.cjs <字> [库文件]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));
const { loadReferenceDb } = require('../../../src/features/safari-repair/engine');

function main() {
  const key = process.argv[2] || '格';
  // 默认读随包分发的那一份；传绝对路径可换别的库
  const dbFile = process.argv[3] || 'glyph-db-48.crdb.gz';
  const db = loadReferenceDb(dbFile);
  const size = db.header.gridSize;
  const ref = opentype.parse(fs.readFileSync(path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')));

  const idx = db.indexOfCodepoint(key.codePointAt(0));
  console.log(`库: ${dbFile}  ${db.header.count} 字  栅格 ${size}`);
  console.log(`「${key}」在库中的下标: ${idx}`);

  const pathObj = ref.getPath(key, 0, 0, 1);
  const contours = core.flattenPath(pathObj.commands);
  const coverage = core.rasterizeContours(contours, size);

  // 库里存的（4bit 打包）
  const off = idx * ((size * size) >> 1);
  let maxDiff = 0;
  let sumDiff = 0;
  for (let i = 0; i < size * size; i += 1) {
    const byte = db.fine[off + (i >> 1)];
    const nib = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    const live = Math.round(Math.min(1, Math.max(0, coverage[i])) * 15);
    const d = Math.abs(nib - live);
    if (d > maxDiff) maxDiff = d;
    sumDiff += d;
  }
  console.log(`  库里(4bit) vs 现算(4bit)：最大差 ${maxDiff}，平均差 ${(sumDiff / (size * size)).toFixed(4)}`);

  // 库里的粗筛
  const cells = db.header.coarseSize * db.header.coarseSize;
  const coff = idx * (cells >> 1);
  const coarse = core.downsample(coverage, size, db.header.coarseSize);
  let cmax = 0;
  for (let c = 0; c < cells; c += 1) {
    const byte = db.coarse[coff + (c >> 1)];
    const nib = c % 2 === 0 ? byte >> 4 : byte & 0x0f;
    const live = Math.round(Math.min(1, Math.max(0, coarse[c])) * 15);
    cmax = Math.max(cmax, Math.abs(nib - live));
  }
  console.log(`  粗筛：最大差 ${cmax}`);
}

main();
