/**
 * 诊断：站点的字体到底是「同一字型改了轮廓」还是「**换了个更细的字重**」？
 *
 *   node tools/lab/diag-font-meta.cjs
 *
 * 看三样：
 *   ① name 表：家族名 / 子族名 / 全名（"Light" 就说明是换字重）
 *   ② OS/2 usWeightClass：400=Regular 300=Light 200=ExtraLight 100=Thin
 *   ③ 与参考字体的墨量比（实测）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));

const SIZE = 48;
const FONTS = [
  ['参考库(我用的)', path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')],
  ['真实站点 · 大学生与创业(二)', path.join(ROOT, 'src/features/safari-repair/test/fixtures/live/live-quiz-2.ttf')],
  ['真实站点 · TRIZ理论(十一)', path.join(ROOT, 'src/features/safari-repair/test/fixtures/live/live-triz-11.ttf')],
  ['仓库夹具 A', path.join(ROOT, 'src/features/safari-repair/test/fixtures/fonts/obf-same-style.ttf')],
  ['仓库夹具 B', path.join(ROOT, 'src/features/safari-repair/test/fixtures/fonts/obf-second-style.ttf')],
];

function nameRecord(font, id) {
  const names = font.names || {};
  for (const platform of ['windows', 'macintosh']) {
    const rec = names[platform] && names[platform][id];
    if (!rec) continue;
    const v = rec.en || rec['zh-CN'] || Object.values(rec)[0];
    if (v) return String(v);
  }
  return '';
}

function cov(font, ch) {
  return core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);
}
function ink(c) {
  let s = 0;
  for (let i = 0; i < c.length; i += 1) s += c[i];
  return s;
}

function main() {
  console.log('字体元数据一览\n');
  for (const [label, file] of FONTS) {
    if (!fs.existsSync(file)) continue;
    const font = opentype.parse(fs.readFileSync(file));
    const family = nameRecord(font, 1) || '(无)';
    const subfamily = nameRecord(font, 2) || '(无)';
    const full = nameRecord(font, 4) || '(无)';
    const typoFamily = nameRecord(font, 16) || '';
    const typoSub = nameRecord(font, 17) || '';
    const os2 = font.tables && font.tables.os2;
    const weightClass = os2 ? os2.usWeightClass : '?';
    const widthClass = os2 ? os2.usWidthClass : '?';
    console.log(`${label}`);
    console.log(`  家族名 nameID1   : ${family}`);
    console.log(`  子族名 nameID2   : ${subfamily}`);
    console.log(`  全名   nameID4   : ${full}`);
    if (typoFamily || typoSub) {
      console.log(`  排版家族 16/17  : ${typoFamily || '(无)'} / ${typoSub || '(无)'}`);
    }
    console.log(`  OS/2 字重等级    : ${weightClass}  (100 Thin / 200 ExtraLight / 300 Light / 400 Regular / 500 Medium / 700 Bold)`);
    console.log(`  OS/2 宽度等级    : ${widthClass}`);
    console.log('');
  }

  // 墨量比（与参考库比）
  const ref = opentype.parse(fs.readFileSync(FONTS[0][1]));
  console.log('与参考库(Regular)的墨量比:');
  for (const [label, file] of FONTS.slice(1)) {
    if (!fs.existsSync(file)) continue;
    const site = opentype.parse(fs.readFileSync(file));
    const pairs = site.tables?.cmap?.glyphIndexMap;
    const entries = pairs instanceof Map ? [...pairs.keys()] : Object.keys(pairs || {});
    const ratios = [];
    for (const cp of entries) {
      if (!cp || cp < 0x20) continue;
      const ch = String.fromCodePoint(cp);
      const sc = cov(site, ch);
      // 找参考库里最接近的（用参考库里真实存在的字作基准太慢，这里用站点自己的码位在参考库里的同码位字形，
      // 混字体时该码位在参考库里多半没有 → 跳过）
      const rc = cov(ref, ch);
      if (!ink(rc)) continue;
      ratios.push(ink(sc) / ink(rc));
    }
    if (!ratios.length) {
      console.log(`  ${label.padEnd(28)} (码位在参考库里不存在，无法按同码位比)`);
      continue;
    }
    const avg = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    console.log(`  ${label.padEnd(28)} ${avg.toFixed(3)}`);
  }
}

main();
