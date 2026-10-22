/**
 * 构建参考字形库（CRDB）。
 *
 * 输入：参考字体（默认 Noto Sans SC，OFL 授权，可随扩展分发）。
 * 输出：tools/reference-fonts/glyph-db-<size>.crdb（默认 48×48 GBK 全集 → glyph-db-48-gbk.crdb）
 *
 * 用法：
 *   node tools/build-reference-db.mjs [--font <path>] [--out <path>] [--size 32] [--coarse 8]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import opentype from 'opentype.js';

import { buildGlyphDb } from '../packages/core/src/glyph-matching/db.ts';
import { flattenPath, rasterizeContours } from '../packages/core/src/glyph-matching/raster.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

/** 生成参考字符集：ASCII + 拉丁补充 + 中文标点 + 全角符号 + GB2312 全部汉字。 */
export function buildCharset() {
  const chars = new Set();
  for (let cp = 0x20; cp <= 0x7e; cp += 1) chars.add(cp);
  for (let cp = 0xa0; cp <= 0xff; cp += 1) chars.add(cp);
  for (let cp = 0x2000; cp <= 0x206f; cp += 1) chars.add(cp);
  for (let cp = 0x2190; cp <= 0x21ff; cp += 1) chars.add(cp);
  for (let cp = 0x2200; cp <= 0x22ff; cp += 1) chars.add(cp);
  for (let cp = 0x2460; cp <= 0x24ff; cp += 1) chars.add(cp);
  for (let cp = 0x25a0; cp <= 0x25ff; cp += 1) chars.add(cp);
  for (let cp = 0x3000; cp <= 0x303f; cp += 1) chars.add(cp);
  for (let cp = 0xfe10; cp <= 0xfe6f; cp += 1) chars.add(cp);
  for (let cp = 0xff01; cp <= 0xff60; cp += 1) chars.add(cp);
  for (let cp = 0xffe0; cp <= 0xffe6; cp += 1) chars.add(cp);

  const decoder = new TextDecoder('gb18030');
  const buffer = new Uint8Array(2);
  // GB2312 区（B0A1–F7FE）
  for (let high = 0xb0; high <= 0xf7; high += 1) {
    for (let low = 0xa1; low <= 0xfe; low += 1) {
      buffer[0] = high;
      buffer[1] = low;
      const text = decoder.decode(buffer);
      if (text.length !== 1) continue;
      const cp = text.codePointAt(0);
      if (cp && cp >= 0x3400) chars.add(cp);
    }
  }
  // GBK 扩展区（8140–F7FE），覆盖大量生僻字
  if (process.env.CR_INCLUDE_GBK === '1') {
    for (let high = 0x81; high <= 0xf7; high += 1) {
      for (let low = 0x40; low <= 0xfe; low += 1) {
        if (low === 0x7f) continue;
        buffer[0] = high;
        buffer[1] = low;
        const text = decoder.decode(buffer);
        if (text.length !== 1) continue;
        const cp = text.codePointAt(0);
        if (cp && cp >= 0x3400 && cp <= 0x9fff) chars.add(cp);
      }
    }
  }
  return [...chars].sort((a, b) => a - b);
}

function main() {
  const fontPath = resolve(arg('font', resolve(root, 'tools/reference-fonts/NotoSansSC-Regular.otf')));
  const size = Number(arg('size', '32'));
  // 默认产物名带栅格尺寸，避免出现"48×48 的库却叫 glyph-db.crdb"
  const outPath = resolve(arg('out', resolve(root, `tools/reference-fonts/glyph-db-${size}.crdb`)));
  const coarse = Number(arg('coarse', '8'));

  console.log(`[db] font   = ${fontPath}`);
  console.log(`[db] grid   = ${size}x${size}, coarse = ${coarse}x${coarse}`);

  const font = opentype.parse(readFileSync(fontPath));
  console.log(
    `[db] family = ${JSON.stringify(font.names?.fontFamily ?? '?')}, ` +
      `unitsPerEm=${font.unitsPerEm}, glyphs=${font.glyphs.length}`,
  );

  const charset = buildCharset();
  console.log(`[db] charset size = ${charset.length}`);
  if (process.env.CR_INCLUDE_GBK !== '1') {
    console.warn(
      '[db] ⚠️ 未开 CR_INCLUDE_GBK=1 → 只有 GB2312 字集。\n' +
        '     GB2312 库缺生僻字时，最近邻会给出"形近但不是它"的字并写出错字\n' +
        '     （实测 燚→焱、垚→寺，见 ADR-0007）。\n' +
        '     给 build-vendor.mjs 用的库必须是 GBK 全集：\n' +
        '       CR_INCLUDE_GBK=1 node tools/build-reference-db.mjs --size 48 \\\n' +
        '         --out tools/reference-fonts/glyph-db-48-gbk.crdb',
    );
  }

  const entries = [];
  let missing = 0;
  for (const cp of charset) {
    const char = String.fromCodePoint(cp);
    const path = font.getPath(char, 0, 0, 1);
    const contours = flattenPath(path.commands);
    const hasInk = contours.some((c) => c.length >= 6);
    if (!hasInk) {
      missing += 1;
      continue;
    }
    const coverage = rasterizeContours(contours, size);
    let ink = 0;
    for (let i = 0; i < coverage.length; i += 1) ink += coverage[i];
    if (ink < 0.05) {
      missing += 1;
      continue;
    }
    entries.push({ codepoint: cp, coverage });
  }
  console.log(`[db] rendered ${entries.length} glyphs (skipped ${missing} empty)`);

  const db = buildGlyphDb(size, coarse, entries);
  const bytes = db.serialize();
  writeFileSync(outPath, bytes);
  console.log(`[db] wrote ${outPath} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);
}

if (process.argv[1] && process.argv[1].endsWith('build-reference-db.mjs')) {
  main();
}
