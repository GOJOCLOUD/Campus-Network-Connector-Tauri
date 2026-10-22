/**
 * 阶段一可行性验证①b：匹配度量对比。
 *
 * 同一批"混淆字体渲染结果"，分别用三种度量与参考字形库比对：
 *   L1    —— 覆盖度平均绝对差（当前实现）
 *   IoU   —— 二值化后的交并比（对笔画粗细不敏感）
 *   HOG   —— 梯度方向直方图余弦（对字体风格差异最不敏感）
 *
 * 输出每种度量在置信度门限下的 精度 / 覆盖率 曲线。
 */
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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
  '.json': 'application/json',
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.__renderAll = async (chars, family, weight, style, grid) => {
  const size = grid * 4;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = [];
  for (const ch of chars) {
    const draw = (fam) => {
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0,0,size,size);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      ctx.font = (style ? style + ' ' : '') + (weight ? weight + ' ' : '') + size + 'px ' + fam;
      ctx.fillText(ch, 0, size * 0.85);
      const data = ctx.getImageData(0,0,size,size).data;
      const a = new Float32Array(size*size);
      for (let i=0;i<size*size;i+=1) a[i] = data[i*4+3] / 255;
      return a;
    };
    const target = draw(family);
    const control = draw('"__missing__"');
    let same = true;
    for (let i=0;i<target.length;i+=1){ if (Math.abs(target[i]-control[i])>0.02){same=false;break;} }
    const small = new Float32Array(grid*grid);
    for (let y=0;y<grid;y+=1) for (let x=0;x<grid;x+=1){
      let s=0; for(let dy=0;dy<4;dy+=1) for(let dx=0;dx<4;dx+=1) s+=target[(y*4+dy)*size+(x*4+dx)];
      small[y*grid+x]=s/16;
    }
    out.push({ch, alpha: Array.from(small), fallback: same});
  }
  return out;
};
</script></body></html>`;

/* ---------------- 度量实现 ---------------- */

function l1(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return 1 - s / a.length;
}

function iou(a, b) {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ba = a[i] > 0.5 ? 1 : 0;
    const bb = b[i] > 0.5 ? 1 : 0;
    if (ba & bb) inter += 1;
    if (ba | bb) uni += 1;
  }
  return uni === 0 ? 0 : inter / uni;
}

const HOG_BINS = 8;
const HOG_CELL = 8;

function hog(cov, size) {
  const cells = size / HOG_CELL;
  const hist = new Float32Array(cells * cells * HOG_BINS);
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const gx = cov[(y + 1) * size + x] - cov[(y - 1) * size + x];
      const gy = cov[y * size + x + 1] - cov[y * size + x - 1];
      const mag = Math.hypot(gx, gy);
      if (mag < 0.08) continue;
      let ang = Math.atan2(gy, gx);
      if (ang < 0) ang += Math.PI;
      const bin = Math.min(HOG_BINS - 1, Math.floor((ang / Math.PI) * HOG_BINS));
      const cx = Math.min(cells - 1, Math.floor(x / HOG_CELL));
      const cy = Math.min(cells - 1, Math.floor(y / HOG_CELL));
      hist[(cy * cells + cx) * HOG_BINS + bin] += mag;
    }
  }
  // 每个 cell L2 归一化
  for (let c = 0; c < cells * cells; c += 1) {
    let n = 0;
    for (let b = 0; b < HOG_BINS; b += 1) {
      const v = hist[c * HOG_BINS + b];
      n += v * v;
    }
    n = Math.sqrt(n) || 1;
    for (let b = 0; b < HOG_BINS; b += 1) hist[c * HOG_BINS + b] /= n;
  }
  return hist;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

async function main() {
  const fontPath = resolve(arg('font', resolve(root, 'tests/fixtures/fonts/obf-cross-style.ttf')));
  const family = arg('family', 'ObfCrossStyle');
  const pairsPath = resolve(arg('pairs', resolve(root, 'tests/fixtures/pairs-same-style.json')));
  const dbPath = resolve(arg('db', resolve(root, 'vendor/glyph-db-48.crdb.gz')));
  const grid = Number(arg('grid', '32'));

  const pairs = JSON.parse(readFileSync(pairsPath, 'utf8'));
  const db = GlyphDb.deserialize(new Uint8Array(loadDbBytes(dbPath)));
  const { server, port } = await startServer(root);
  const fontUrl = `http://127.0.0.1:${port}/${fontPath.slice(root.length + 1)}`;

  const browser = await puppeteer.launch({ headless: true, args: ['--font-render-hinting=none'] });
  const page = await browser.newPage();
  await page.setContent(PAGE, { waitUntil: 'load' });
  await page.addStyleTag({ content: `@font-face{font-family:"${family}";src:url("${fontUrl}") format("truetype");}` });
  await page.evaluate(async (fam) => {
    await document.fonts.load(`32px "${fam}"`, '天地玄黄');
    await document.fonts.ready;
  }, family);

  const chars = Object.keys(pairs);
  const renders = await page.evaluate(
    (cs, fam, g) => window.__renderAll(cs, `"${fam}"`, '400', 'normal', g),
    chars, family, grid,
  );
  await browser.close();
  server.close();

  // 参考库描述子（缓存）
  const dbCov = [];
  const dbHog = [];
  for (let i = 0; i < db.header.count; i += 1) {
    const cov = blur(db.coverageAt(i), grid);
    dbCov.push(cov);
    dbHog.push(hog(cov, grid));
  }

  const metrics = {
    L1: (t, i) => l1(t, dbCov[i]),
    IoU: (t, i) => iou(t, dbCov[i]),
    HOG: (t, i) => cosine(t.hog, dbHog[i]),
  };

  for (const [name, metric] of Object.entries(metrics)) {
    const records = [];
    for (const render of renders) {
      if (render.fallback) continue;
      const cov = blur(Float32Array.from(render.alpha), grid);
      const target = name === 'HOG' ? { hog: hog(cov, grid) } : cov;
      const scores = new Float32Array(db.header.count);
      for (let i = 0; i < db.header.count; i += 1) scores[i] = metric(target, i);
      // 取 top-2
      let b1 = -2;
      let b2 = -2;
      let i1 = -1;
      let i2 = -1;
      for (let i = 0; i < scores.length; i += 1) {
        if (scores[i] > b1) {
          b2 = b1; i2 = i1; b1 = scores[i]; i1 = i;
        } else if (scores[i] > b2) {
          b2 = scores[i]; i2 = i;
        }
      }
      const expected = pairs[render.ch].codePointAt(0);
      records.push({
        hit: db.codepoints[i1] === expected,
        score: b1,
        margin: b1 - Math.max(0, b2),
      });
    }
    const raw = (records.filter((r) => r.hit).length / records.length) * 100;
    console.log(`\n### ${name}  原始 top-1 = ${raw.toFixed(1)}%`);
    for (const t of [0.01, 0.02, 0.03, 0.05, 0.08]) {
      const acc = records.filter((r) => r.margin >= t);
      const prec = acc.length ? (acc.filter((r) => r.hit).length / acc.length) * 100 : 0;
      console.log(
        `   margin>=${t.toFixed(2)}  接受 ${String(acc.length).padStart(3)}  精度 ${prec.toFixed(1).padStart(5)}%  覆盖率 ${((acc.length / records.length) * 100).toFixed(1).padStart(5)}%`,
      );
    }
  }
}

main();
