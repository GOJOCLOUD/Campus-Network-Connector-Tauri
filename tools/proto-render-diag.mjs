/**
 * 诊断：把浏览器 canvas 渲染出的位图与参考库位图并排打印成 ASCII。
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

function art(bits, size) {
  const ramp = ' .:-=+*#%@';
  const lines = [];
  for (let y = 0; y < size; y += 1) {
    let line = '';
    for (let x = 0; x < size; x += 1) {
      const v = bits[y * size + x];
      line += ramp[Math.min(ramp.length - 1, Math.round(v * (ramp.length - 1)))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

async function main() {
  const site = await startServer(root);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`${site.origin}/tests/fixtures/c-font-obfuscation.html`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const info = await page.evaluate(() => {
    const loaded = [];
    document.fonts.forEach((f) => loaded.push(`${f.family}/${f.style}/${f.weight}/${f.status}`));
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const render = (char, font) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.font = font;
      ctx.fillText(char, 0, 128 * 0.85);
      const data = ctx.getImageData(0, 0, 128, 128).data;
      const out = [];
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          let sum = 0;
          for (let dy = 0; dy < 4; dy += 1) {
            for (let dx = 0; dx < 4; dx += 1) {
              sum += data[((y * 4 + dy) * 128 + (x * 4 + dx)) * 4 + 3] / 255;
            }
          }
          out.push(sum / 16);
        }
      }
      return out;
    };
    return {
      loaded,
      checkObf: document.fonts.check('16px "ObfA"', '天'),
      obfTian: render('天', '128px "ObfA"'),
      obfRen: render('人', '128px "ObfA"'),
      pingTian: render('天', '128px "PingFang SC"'),
      notoTian: render('天', '128px "Noto Sans SC"'),
    };
  });

  console.log('[diag] 已加载字体:', info.loaded.join(' | '));
  console.log('[diag] document.fonts.check(16px ObfA, 天) =', info.checkObf);

  const dbPath = resolve(root, 'vendor/glyph-db-48.crdb.gz');
  const raw = readFileSync(dbPath);
  const db = GlyphDb.deserialize(new Uint8Array(dbPath.endsWith('.gz') ? gunzipSync(raw) : raw));
  const size = db.header.gridSize;
  const show = (label, bits) => {
    console.log(`\n--- ${label} ---`);
    console.log(art(bits, size));
  };
  const dbArt = (char) => {
    const idx = db.indexOfCodepoint(char.codePointAt(0));
    return idx >= 0 ? db.coverageAt(idx) : null;
  };

  const tian = dbArt('天');
  const ren = dbArt('人');
  if (tian) show('参考库 · 天', tian);
  if (ren) show('参考库 · 人', ren);
  show('浏览器 · ObfA 渲染 天', info.obfTian);
  show('浏览器 · ObfA 渲染 人', info.obfRen);
  show('浏览器 · PingFang 渲染 天', info.pingTian);

  const l1 = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };
  if (tian && ren) {
    console.log('\n[diag] 参考库内部 天 vs 人 距离 =', l1(tian, ren).toFixed(3));
  }
  console.log('[diag] ObfA渲染天 vs 参考库天 =', tian ? l1(info.obfTian, tian).toFixed(3) : 'n/a');
  console.log('[diag] ObfA渲染天 vs 参考库人 =', ren ? l1(info.obfTian, ren).toFixed(3) : 'n/a');

  await browser.close();
  await site.close();
}

main();
