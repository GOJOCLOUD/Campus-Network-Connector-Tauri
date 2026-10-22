/**
 * 阶段一可行性验证①：字形匹配精度实测。
 *
 * 链路：混淆字体文件 → 浏览器 canvas 渲染底层字符 → 32x32 覆盖度 → 参考字形库最近邻
 *      → 还原出的"显示字符"是否等于真实显示字符。
 *
 * 用法：node tools/proto-accuracy.mjs [--font <ttf>] [--family <name>] [--pairs <json>]
 */
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, join } from 'node:path';
import puppeteer from 'puppeteer';

import { GlyphDb } from '../packages/core/src/glyph-matching/db.ts';
import { blur } from '../packages/core/src/glyph-matching/raster.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.crdb': 'application/octet-stream',
};

function startServer(rootDir) {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const path = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = join(rootDir, path === '/' ? '/index.html' : path);
      if (!file.startsWith(rootDir) || !existsSync(file)) {
        resp.writeHead(404);
        resp.end('not found');
        return;
      }
      resp.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      resp.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style id="face"></style>
<style>body{margin:0}</style></head><body><script>
window.__renderAll = async (chars, family, weight, style, grid) => {
  const size = grid * 4;              // 4x 超采样渲染，再降采样到 DB 栅格
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = [];
  for (const ch of chars) {
    const draw = (fam) => {
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0,0,size,size);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.font = (style ? style + ' ' : '') + (weight ? weight + ' ' : '') + size + 'px ' + fam;
      ctx.fillText(ch, 0, size * 0.85);
      const data = ctx.getImageData(0,0,size,size).data;
      const alpha = new Float32Array(size*size);
      for (let i=0;i<size*size;i+=1) alpha[i] = data[i*4+3] / 255;
      return alpha;
    };
    const target = draw(family);
    const control = draw('"__copyrepair_missing_family__"');
    let same = true;
    for (let i=0;i<target.length;i+=1){ if (Math.abs(target[i]-control[i]) > 0.02) { same = false; break; } }
    // 面积平均降采样到 DB 栅格
    const small = new Float32Array(grid*grid);
    for (let y=0;y<grid;y+=1){
      for (let x=0;x<grid;x+=1){
        let sum=0;
        for (let dy=0;dy<4;dy+=1){
          for (let dx=0;dx<4;dx+=1){
            sum += target[(y*4+dy)*size + (x*4+dx)];
          }
        }
        small[y*grid+x] = sum/16;
      }
    }
    out.push({ ch, alpha: Array.from(small), fallback: same });
  }
  return out;
};
</script></body></html>`;

async function main() {
  const fontPath = resolve(arg('font', resolve(root, 'tests/fixtures/fonts/obf-same-style.ttf')));
  const family = arg('family', 'ObfSameStyle');
  const pairsPath = resolve(arg('pairs', resolve(root, 'tests/fixtures/pairs-same-style.json')));
  const dbPath = resolve(arg('db', resolve(root, 'vendor/glyph-db-48.crdb.gz')));

  const pairs = JSON.parse(readFileSync(pairsPath, 'utf8'));
  const db = GlyphDb.deserialize(new Uint8Array(loadDbBytes(dbPath)));
  console.log(`[proto] db = ${db.header.count} glyphs, grid ${db.header.gridSize}`);

  const { server, port } = await startServer(root);
  const fontUrl = `http://127.0.0.1:${port}/${fontPath.slice(root.length + 1)}`;
  console.log(`[proto] font = ${fontUrl}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--font-render-hinting=none', '--disable-lcd-text'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('  [page]', m.text()));
  await page.setContent(PAGE, { waitUntil: 'load' });
  await page.addStyleTag({
    content: `@font-face{font-family:"${family}";src:url("${fontUrl}") format("truetype");}`,
  });
  await page.evaluate(async (fam) => {
    await document.fonts.load(`32px "${fam}"`, '天地玄黄');
    await document.fonts.ready;
  }, family);

  const chars = Object.keys(pairs);
  const renders = await page.evaluate(
    (cs, fam, grid) => window.__renderAll(cs, `"${fam}"`, '400', 'normal', grid),
    chars,
    family,
    db.header.gridSize,
  );

  let correct = 0;
  let fallbackHits = 0;
  const misses = [];
  const records = [];
  for (const render of renders) {
    if (render.fallback) {
      fallbackHits += 1;
      continue;
    }
    const coverage = blur(Float32Array.from(render.alpha), db.header.gridSize);
    const match = db.lookup(coverage);
    const expected = pairs[render.ch].codePointAt(0);
    records.push({ match, expected });
    if (match.codepoint === expected) correct += 1;
    else misses.push({ underlying: render.ch, expected: pairs[render.ch], got: match.codepoint ? String.fromCodePoint(match.codepoint) : null, score: match.score.toFixed(3), margin: match.margin.toFixed(3) });
  }
  const evaluated = correct + misses.length;
  const avgScore = records.reduce((s, x) => s + x.match.score, 0) / (records.length || 1);
  const avgMargin = records.reduce((s, x) => s + x.match.margin, 0) / (records.length || 1);

  console.log('\n===== 结果 =====');
  console.log(`字符总数        : ${chars.length}`);
  console.log(`字体回退(跳过)  : ${fallbackHits}`);
  console.log(`参与评估        : ${evaluated}`);
  console.log(`还原正确        : ${correct} (${((correct / (evaluated || 1)) * 100).toFixed(1)}%)`);
  console.log(`平均相似度      : ${avgScore.toFixed(4)}`);
  console.log(`平均次优差距    : ${avgMargin.toFixed(4)}`);

  console.log('\n===== 置信度门限下的 精度 / 覆盖率 =====');
  console.log('margin |  接受数 | 正确率(精度) | 覆盖率(还原比例)');
  for (const threshold of [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2]) {
    const accepted = records.filter((r) => r.match.margin >= threshold);
    const ok = accepted.filter((r) => r.match.codepoint === r.expected).length;
    const precision = accepted.length ? ok / accepted.length : 0;
    const coverage = accepted.length / (records.length || 1);
    console.log(
      `  ${threshold.toFixed(3)} |   ${String(accepted.length).padStart(4)}  |    ${(precision * 100).toFixed(1).padStart(5)}%      |    ${(coverage * 100).toFixed(1).padStart(5)}%`,
    );
  }
  if (misses.length) {
    console.log('\n错误样例（前 10 条）:');
    for (const m of misses.slice(0, 10)) console.log('  ', JSON.stringify(m));
  }

  await browser.close();
  server.close();
  process.exit(correct / (evaluated || 1) >= 0.95 ? 0 : 1);
}

main();
