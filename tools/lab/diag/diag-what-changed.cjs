/**
 * 诊断：站点到底改了什么？
 *
 *   node tools/lab/diag-what-changed.cjs
 *
 * 两个可能的改法：
 *   A 只改「字库」：DOM 里还是明文字，靠字体把它们画成别的样子
 *     → 复制出来应该是明文（不成立）
 *   B 改「字库 + DOM 文本」：把明文字的字形搬到别的码位上，
 *     同时把 DOM 里的字换成那些新码位
 *     → 显示正确、复制出来是码位 ✔
 *
 * 判据：看**字体的 cmap 里到底有哪些码位**。
 *   - 只有密文码位 → 明文字不在字体里 → 站点必须改了 DOM 文本
 *   - 密文码位 + 明文字都有 → 只改字库就够
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));

const CASES = [
  {
    label: '真实站点 · 大学生与创业(二)',
    ttf: path.join(ROOT, 'src/features/safari-repair/test/fixtures/live/live-quiz-2.ttf'),
    truthFile: path.join(ROOT, 'src/features/safari-repair/test/fixtures/live/live-quiz-2.truth.json'),
  },
  {
    label: '真实站点 · TRIZ理论(十一)',
    ttf: path.join(ROOT, 'src/features/safari-repair/test/fixtures/live/live-triz-11.ttf'),
    truthFile: path.join(ROOT, 'src/features/safari-repair/test/fixtures/live/live-triz-11.truth.json'),
  },
];

function main() {
  for (const c of CASES) {
    if (!fs.existsSync(c.ttf)) continue;
    const font = opentype.parse(fs.readFileSync(c.ttf));
    const truth = JSON.parse(fs.readFileSync(c.truthFile, 'utf8')).truth;
    const pairs = font.tables?.cmap?.glyphIndexMap;
    const cps = (pairs instanceof Map ? [...pairs.keys()] : Object.keys(pairs || {}))
      .map(Number)
      .filter((cp) => cp > 0x20)
      .sort((a, b) => a - b);

    const cipherSet = new Set(Object.keys(truth).map((ch) => ch.codePointAt(0)));
    const plainSet = new Set(Object.values(truth).map((ch) => ch.codePointAt(0)));

    const cipherInFont = cps.filter((cp) => cipherSet.has(cp));
    const plainInFont = cps.filter((cp) => plainSet.has(cp));
    const other = cps.filter((cp) => !cipherSet.has(cp) && !plainSet.has(cp));

    console.log(`=== ${c.label} ===`);
    console.log(`  字体 cmap 里的码位总数     : ${cps.length}`);
    console.log(`  ├─ 密文码位（DOM 里那些字）: ${cipherInFont.length}`);
    console.log(`  ├─ 明文字（题面真正���字）  : ${plainInFont.length}` +
      (plainInFont.length ? '  ← ' + plainInFont.map((cp) => String.fromCodePoint(cp)).join('') : ''));
    console.log(`  └─ 其它                     : ${other.length}` +
      (other.length ? '  ← ' + other.map((cp) => String.fromCodePoint(cp)).join('') : ''));
    console.log(
      `  结论: ${plainInFont.length === 0 ? '明文字**不在字体里** → 站点必须把 DOM 文本也换成了密文码位' : '明文字也在字体里 → 只换字库就够'}`,
    );
    console.log('');
  }
}

main();
