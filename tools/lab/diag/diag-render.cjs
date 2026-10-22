/**
 * 诊断：把字形画成 ASCII,肉眼比一比站点画的是哪个字。
 *
 *   node tools/lab/diag-render.cjs <字体文件> <字> [参考字...]
 *
 * 例：node tools/lab/diag-render.cjs /tmp/font.ttf 坉 略 赂
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));

const RAMP = ' .:-=+*#%@';

function render(coverage, size, cols) {
  const rows = size;
  const step = size / cols;
  const lines = [];
  for (let r = 0; r < cols; r += 1) {
    let line = '';
    for (let c = 0; c < cols; c += 1) {
      // 取这一格的平均覆盖度
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(r * step); y < Math.floor((r + 1) * step); y += 1) {
        for (let x = Math.floor(c * step); x < Math.floor((c + 1) * step); x += 1) {
          sum += coverage[y * size + x];
          n += 1;
        }
      }
      const v = n ? sum / n : 0;
      line += RAMP[Math.min(RAMP.length - 1, Math.floor(v * RAMP.length))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function main() {
  const [fontFile, key, ...refs] = process.argv.slice(2);
  if (!fontFile || !key) {
    console.log('用法: node tools/lab/diag-render.cjs <字体> <字> [参考字...]');
    return;
  }
  const SIZE = 48;
  const COLS = 30;
  const site = opentype.parse(fs.readFileSync(fontFile));
  const ref = opentype.parse(fs.readFileSync(path.join(ROOT, 'tools/reference-fonts/NotoSansSC-Regular.otf')));

  const blocks = [];
  const cov = (font, ch) => core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);
  blocks.push({ title: `站点字体里的「${key}」`, art: render(cov(site, key), SIZE, COLS) });
  for (const r of refs) {
    blocks.push({ title: `参考字体的「${r}」`, art: render(cov(ref, r), SIZE, COLS) });
  }
  const width = Math.max(...blocks.map((b) => b.title.length));
  blocks.forEach((b, i) => {
    if (i) console.log('');
    console.log(b.title);
    console.log(b.art);
  });
  void width;
}

main();
