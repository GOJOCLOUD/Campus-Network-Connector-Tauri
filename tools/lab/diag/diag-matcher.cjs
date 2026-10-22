/**
 * 诊断：快速匹配器在某个字形上到底返回了什么？正确答案有没有进候选？
 *
 *   node tools/lab/diag-matcher.cjs <字体文件> <字> <正确答案>
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));
const { FastGlyphMatcher } = require(path.join(ROOT, 'src', 'features', 'safari-repair', 'fast-matcher'));
const { loadReferenceDb } = require('../../../src/features/safari-repair/engine');

function main() {
  const [fontFile, key, want] = process.argv.slice(2);
  if (!fontFile || !key) {
    console.log('用法: node tools/lab/diag-matcher.cjs <字体> <字> [正确答案]');
    return;
  }
  const db = loadReferenceDb('glyph-db-48.crdb.gz');
  const matcher = new FastGlyphMatcher(db);
  const site = opentype.parse(fs.readFileSync(fontFile));
  const size = db.header.gridSize;
  const cov = core.rasterizeContours(core.flattenPath(site.getPath(key, 0, 0, 1).commands), size);

  const result = matcher.lookup(cov, { maxCandidates: 512 });
  console.log(`字形「${key}」:`);
  console.log(
    `  匹配器返回 ${String.fromCodePoint(result.codepoint)}(U+${result.codepoint.toString(16).toUpperCase()})` +
      `  分数 ${result.score.toFixed(4)}  margin ${result.margin.toFixed(4)}`,
  );
  console.log('  候选前 8: ' + result.candidates.slice(0, 8)
    .map((c) => `${String.fromCodePoint(c.codepoint)}(U+${c.codepoint.toString(16).toUpperCase()}) ${c.score.toFixed(4)}`)
    .join('  '));

  if (want) {
    const cp = want.codePointAt(0);
    const inList = result.candidates.some((c) => c.codepoint === cp);
    console.log(`  正确答案「${want}」在候选里: ${inList ? '是' : '否 ← 被筛掉了'}`);
    // 直接算它在精细阶段的分数
    const idx = db.indexOfCodepoint(cp);
    if (idx >= 0) {
      const off = idx * ((size * size) >> 1);
      const q = new Uint8Array((size * size) >> 1);
      for (let i = 0; i < size * size; i += 2) {
        const hi = Math.round(Math.min(1, Math.max(0, cov[i])) * 15);
        const lo = Math.round(Math.min(1, Math.max(0, cov[i + 1] ?? 0)) * 15);
        q[i >> 1] = (hi << 4) | lo;
      }
      let sum = 0;
      for (let i = 0; i < q.length; i += 1) {
        const rb = db.fine[off + i];
        sum += Math.abs((rb >> 4) - (q[i] >> 4)) + Math.abs((rb & 15) - (q[i] & 15));
      }
      const fineScore = 1 - sum / (15 * size * size);
      console.log(`  它的精细分数: ${fineScore.toFixed(4)}`);
    }
  }
}

main();
