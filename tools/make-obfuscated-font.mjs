/**
 * 生成"字体混淆"测试字体：真实 TTF 文件，cmap 把底层字符映射到另一个字符的字形轮廓。
 *
 * 这不是字符替换表 —— 生成的是带真实 glyf 轮廓的字体文件，
 * 浏览器只有真正加载并渲染这个字体，才会看到"显示字符"。
 *
 * 用法：
 *   node tools/make-obfuscated-font.mjs \
 *     --source tools/reference-fonts/NotoSansSC-Regular.otf \
 *     --out tests/fixtures/fonts/obf-same-style.ttf \
 *     --family ObfSameStyle --pairs tools/fixtures/pairs-same-style.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import opentype from 'opentype.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

/** 把源字体的屏幕坐标路径（y 向下）转回字体坐标（y 向上，字体单位）。 */
function toFontUnits(commands, unitsPerEm) {
  return commands.map((cmd) => {
    switch (cmd.type) {
      case 'M':
        return { type: 'M', x: cmd.x * unitsPerEm, y: -cmd.y * unitsPerEm };
      case 'L':
        return { type: 'L', x: cmd.x * unitsPerEm, y: -cmd.y * unitsPerEm };
      case 'Q':
        return {
          type: 'Q',
          x1: cmd.x1 * unitsPerEm,
          y1: -cmd.y1 * unitsPerEm,
          x: cmd.x * unitsPerEm,
          y: -cmd.y * unitsPerEm,
        };
      case 'C':
        return {
          type: 'C',
          x1: cmd.x1 * unitsPerEm,
          y1: -cmd.y1 * unitsPerEm,
          x2: cmd.x2 * unitsPerEm,
          y2: -cmd.y2 * unitsPerEm,
          x: cmd.x * unitsPerEm,
          y: -cmd.y * unitsPerEm,
        };
      case 'Z':
        return { type: 'Z' };
      default:
        return cmd;
    }
  });
}

export function buildObfuscatedFont(sourcePath, pairs, familyName, styleName = 'Regular') {
  const source = opentype.parse(readFileSync(sourcePath));
  const upem = source.unitsPerEm;

  const glyphs = [];
  // index 0 必须保留给 .notdef
  const notdef = new opentype.Glyph({
    name: '.notdef',
    unicode: 0,
    advanceWidth: upem,
    path: new opentype.Path(),
  });
  glyphs.push(notdef);

  const manifest = {};
  for (const [underlying, display] of Object.entries(pairs)) {
    const uCp = underlying.codePointAt(0);
    const dCp = display.codePointAt(0);
    const srcPath = source.getPath(display, 0, 0, upem);
    const srcGlyph = source.charToGlyphIndex(display);
    const advance = source.glyphs.get(srcGlyph)?.advanceWidth ?? upem;
    const path = new opentype.Path();
    path.commands = toFontUnits(srcPath.commands, 1);
    const glyph = new opentype.Glyph({
      name: `uni${uCp.toString(16).toUpperCase().padStart(4, '0')}`,
      unicode: uCp,
      advanceWidth: advance,
      path,
    });
    glyphs.push(glyph);
    manifest[underlying] = display;
  }

  const font = new opentype.Font({
    familyName,
    styleName,
    unitsPerEm: upem,
    ascender: source.ascender ?? upem * 0.88,
    descender: source.descender ?? -upem * 0.12,
    glyphs,
  });
  return { buffer: Buffer.from(font.toArrayBuffer()), manifest };
}

function main() {
  const sourcePath = resolve(arg('source', resolve(root, 'tools/reference-fonts/NotoSansSC-Regular.otf')));
  const outPath = resolve(arg('out', resolve(root, 'tests/fixtures/fonts/obf-test.ttf')));
  const family = arg('family', 'ObfTest');
  const pairsPath = resolve(arg('pairs', ''));

  let pairs;
  if (pairsPath) {
    pairs = JSON.parse(readFileSync(pairsPath, 'utf8'));
  } else {
    // 默认演示：底层字符与显示字符一一错位
    const underlying = '天地玄黄宇宙洪荒日月';
    const display = '人工智能正在改变世界科技';
    pairs = {};
    for (let i = 0; i < underlying.length; i += 1) {
      pairs[underlying[i]] = display[i];
    }
  }

  const { buffer, manifest } = buildObfuscatedFont(sourcePath, pairs, family);
  writeFileSync(outPath, buffer);
  writeFileSync(outPath.replace(/\.ttf$/, '.map.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[font] wrote ${outPath} (${(buffer.length / 1024).toFixed(1)} KB), ${Object.keys(pairs).length} glyphs`);
  console.log(`[font] map  ${JSON.stringify(manifest)}`);
}

if (process.argv[1] && process.argv[1].endsWith('make-obfuscated-font.mjs')) {
  main();
}
