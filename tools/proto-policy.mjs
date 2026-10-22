/**
 * 阶段一可行性验证①c：判定策略标定。
 *
 * 同时渲染多套字体，统计每个字符的：
 *   - best（参考库最近邻）是否等于自身
 *   - score / margin（置信度）
 *   - selfDistance（与自身参考字形的距离）
 *
 * 目标：为"这个作用域是不是混淆字体"和"这个字符要不要换"定出有数据支撑的阈值。
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer';

import { startServer } from '../tests/e2e/server.mjs';
import { GlyphDb } from '../packages/core/src/glyph-matching/db.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const FONTS = [
  { name: 'ObfA', label: '混淆(同风格)', file: 'tests/fixtures/fonts/obf-same-style.ttf', obfuscated: true },
  { name: 'ObfB', label: '混淆(跨风格)', file: 'tests/fixtures/fonts/obf-cross-style.ttf', obfuscated: true },
  { name: 'NotoTest', label: '正常(与参考库同款)', file: 'tools/reference-fonts/NotoSansSC-Regular.otf', obfuscated: false },
  // 「不同字型的正常字体不被误判」这一档用系统黑体(PingFang SC)即可代表。
  // 宋体对照曾用 NotoSerifSC-Regular.otf，随宋体库弃用一并移除（省 11.6MB）。
  { name: 'SysSans', label: '正常(macOS 系统黑体)', file: null, obfuscated: false, css: '"PingFang SC"' },
];

async function main() {
  const pairs = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/pairs-same-style.json'), 'utf8'));
  const underlying = Object.keys(pairs);
  const display = Object.values(pairs);
  const chars = [...new Set([...underlying, ...display])];

  // 参考库：读随包分发的那一份（vendor/glyph-db-48.crdb.gz，GBK 全集）。
  // GB2312 版缺字 → 阈值标定会被"缺字错配"带偏，见 ADR-0007。
  const dbPath = resolve(root, 'vendor/glyph-db-48.crdb.gz');
  const raw = readFileSync(dbPath);
  const db = GlyphDb.deserialize(new Uint8Array(dbPath.endsWith('.gz') ? gunzipSync(raw) : raw));
  const size = db.header.gridSize;

  const site = await startServer(root);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');

  const faces = FONTS.filter((f) => f.file).map(
    (f) => `@font-face{font-family:"${f.name}";src:url("${site.origin}/${f.file}") format("${f.file.endsWith('.otf') ? 'opentype' : 'truetype'}");}`,
  );
  await page.addStyleTag({ content: faces.join('\n') });
  await page.evaluate(async (names) => {
    for (const n of names) {
      await document.fonts.load(`128px "${n}"`, '天地玄黄');
    }
    await document.fonts.ready;
  }, FONTS.filter((f) => f.file).map((f) => f.name));

  const render = async (fontCss, list) =>
    page.evaluate(
      (fam, cs, grid) => {
        const size = grid * 4;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const out = [];
        for (const ch of cs) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, size, size);
          ctx.fillStyle = '#000';
          ctx.textBaseline = 'alphabetic';
          ctx.textAlign = 'left';
          ctx.font = `${size}px ${fam}`;
          ctx.fillText(ch, 0, size * 0.85);
          const data = ctx.getImageData(0, 0, size, size).data;
          const small = new Float32Array(grid * grid);
          for (let y = 0; y < grid; y += 1) {
            for (let x = 0; x < grid; x += 1) {
              let sum = 0;
              for (let dy = 0; dy < 4; dy += 1) {
                for (let dx = 0; dx < 4; dx += 1) {
                  sum += data[((y * 4 + dy) * size + (x * 4 + dx)) * 4 + 3] / 255;
                }
              }
              small[y * grid + x] = sum / 16;
            }
          }
          out.push(Array.from(small));
        }
        return out;
      },
      fontCss,
      list,
      size,
    );

  const results = {};
  for (const font of FONTS) {
    const fam = font.css ?? `"${font.name}"`;
    const bitmaps = await render(fam, chars);
    const rows = [];
    for (let i = 0; i < chars.length; i += 1) {
      const cov = Float32Array.from(bitmaps[i]);
      const blurred = blurLocal(cov, size);
      const match = db.lookup(blurred);
      const ownIndex = db.indexOfCodepoint(chars[i].codePointAt(0));
      const selfDistance = ownIndex >= 0 ? distanceTo(db, ownIndex, blurred) : null;
      rows.push({
        char: chars[i],
        best: match.codepoint !== null ? String.fromCodePoint(match.codepoint) : null,
        score: match.score,
        margin: match.margin,
        selfDistance,
      });
    }
    results[font.label] = rows;
  }

  await browser.close();
  await site.close();

  console.log('\n================ 判定策略标定 ================\n');
  for (const font of FONTS) {
    const rows = results[font.label];
    const wrongBest = rows.filter((r) => r.best !== r.char);
    const rate = (wrongBest.length / rows.length) * 100;
    const selfDist = rows.map((r) => r.selfDistance).filter((v) => v !== null);
    const avgSelf = selfDist.reduce((s, v) => s + v, 0) / (selfDist.length || 1);
    console.log(`■ ${font.label}（${font.name}）  混淆=${font.obfuscated ? '是' : '否'}`);
    console.log(`   最近邻≠自身的比例 : ${rate.toFixed(1)}%  (${wrongBest.length}/${rows.length})`);
    console.log(`   平均自身距离      : ${avgSelf.toFixed(3)}`);
    if (font.obfuscated) {
      const correct = rows.filter((r) => r.best !== r.char).length;
      console.log(`   → 混淆可检出率(最近邻≠自身): ${((correct / rows.length) * 100).toFixed(1)}%`);
    } else {
      const bad = wrongBest.slice(0, 8).map((r) => `${r.char}→${r.best}(s=${r.score.toFixed(2)},m=${r.margin.toFixed(3)},self=${r.selfDistance?.toFixed(3)})`);
      console.log(`   → 正常字体误判样例: ${bad.join('  ')}`);
    }
    console.log('');
  }

  // 阈值扫描：对混淆字体，取"margin 门限"下的还原率；对正常字体，取同一门限下的误判率
  // 自身距离分布
  console.log('---- selfDistance 分布 ----');
  for (const font of FONTS) {
    const rows = results[font.label];
    const inFont = font.obfuscated ? rows.filter((r) => pairs[r.char]) : rows;
    const dist = inFont.map((r) => r.selfDistance).filter((v) => v !== null).sort((a, b) => a - b);
    const pct = (p) => dist[Math.min(dist.length - 1, Math.floor(dist.length * p))];
    const errs = rows.filter((r) => r.best !== r.char).map((r) => r.selfDistance);
    console.log(
      `${font.label.padEnd(22)} min=${dist[0].toFixed(3)} p25=${pct(0.25).toFixed(3)} 中位=${pct(0.5).toFixed(3)} p75=${pct(0.75).toFixed(3)} max=${dist[dist.length-1].toFixed(3)}` +
        (errs.length ? `  误判字符self最大=${Math.max(...errs).toFixed(3)}` : ''),
    );
  }

  console.log('---- 门限扫描（margin ≥ M 且 score ≥ S 才允许替换）----');
  console.log('S     M     | 混淆同风格 混淆跨风格 | 正常同款 正常衬线 正常系统');
  for (const S of [0.6, 0.8, 0.9]) {
    for (const M of [0.01, 0.02, 0.05]) {
      const cells = FONTS.map((font) => {
        const rows = results[font.label];
        let hits = 0;
        for (const r of rows) {
          if (r.best && r.best !== r.char && r.score >= S && r.margin >= M) hits += 1;
        }
        return `${((hits / rows.length) * 100).toFixed(0)}%`.padStart(8);
      });
      console.log(`${S.toFixed(2)}  ${M.toFixed(3)} | ${cells.join(' ')}`);
    }
  }
}

function blurLocal(cov, size) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= size) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= size) continue;
          sum += cov[ny * size + nx];
          count += 1;
        }
      }
      out[y * size + x] = sum / count;
    }
  }
  return out;
}

function distanceTo(db, index, coverage) {
  const size = db.header.gridSize;
  const offset = index * ((size * size) >> 1);
  const bytes = db.fine;
  let sum = 0;
  for (let i = 0; i < size * size; i += 1) {
    const byte = bytes[offset + (i >> 1)];
    const nib = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    sum += Math.abs(nib / 15 - coverage[i]);
  }
  return sum / (size * size);
}

main();
