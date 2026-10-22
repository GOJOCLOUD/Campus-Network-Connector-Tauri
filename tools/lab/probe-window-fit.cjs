/**
 * 窗口贴合内容 —— 真跑一遍回归探针。
 *
 * 背景:上一版界面里,窗口"贴合内容"的触发压根没挂上 ——
 * 桥接层在 `main.jsx` 的 import 阶段就执行,那时 React 还没渲染,
 * `document.querySelector('.rounded-4xl')` 拿到 null,
 * `observer.observe(card)` 从未执行 → 窗口只在启动时被动过一次,
 * 之后换页窗口再也不动,内容超出窗口就被根容器 overflow-hidden 一刀切掉。
 *
 * 这里不靠"读代码觉得对",而是**让真实的桥接代码跑起来**:
 *   - 桩里的 `window_fit_to_content` 真的去改浏览器窗口高度(等价于原生窗口变高)
 *   - 点页码换页 → 看窗口高度有没有跟着卡片走
 *   - 灌长内容 → 看内容区是不是自己滚动、底部那条(按钮行)还在不在窗口里
 *
 *   node tools/lab/probe-window-fit.cjs
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serveDist() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(DIST, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const roots = [
    path.join(process.env.HOME || '', '.cache', 'puppeteer'),
    path.join(process.env.HOME || '', 'Library', 'Caches', 'puppeteer'),
  ];
  const names = ['Google Chrome for Testing', 'chrome-headless-shell', 'Chromium'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith('chrome')) continue;
      const stack = [path.join(root, dir)];
      while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entries) {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (names.includes(e.name) && fs.statSync(full).size > 0) return full;
        }
      }
    }
  }
  return undefined;
}

/** 桩:提供 __TAURI__.core.invoke;窗口贴合命令真的去改窗口高度 */
const STUB = `(function () {
  window.__curH = 640;
  // 无头浏览器的"屏幕"默认很小(headless 里 screen 高度 = 视口高度),
  // 这里换成一个常见笔记本屏幕,免得把"窗口不许超过屏幕"这条测歪。
  try {
    Object.defineProperty(window, 'screen', {
      configurable: true,
      value: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400 },
    });
  } catch (e) {}
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (cmd === 'window_fit_to_content') {
          let h = Math.round(args && args.height);
          // 原生侧会把窗口钳在屏幕可用高度内(见 lib.rs 的 window_fit_to_content)
          h = Math.min(h, window.screen.availHeight);
          // 原生侧有 2px 死区,这里照做,免得来回抖
          if (Math.abs(h - window.__curH) >= 2) {
            window.__curH = h;
            await window.__setViewport(h);
          }
          return null;
        }
        if (cmd === 'get_native_status') return { ok: true, platform: 'darwin', accessibilityTrusted: false };
        if (cmd === 'get_activation_snapshot') {
          return { deviceUuid: 'probe', trialUsed: true, trialExpiresAt: Date.now() + 86400000, licenseValid: true, license: '' };
        }
        if (cmd === 'get_features') return [];
        if (cmd === 'get_feature_status') return null;
        if (cmd === 'safari_repair_get_status') return { enabled: false, running: false };
        if (cmd === 'keepalive_get_status') return false;
        if (cmd === 'get_input_source_config') return {};
        return {};
      },
    },
  };
})();`;

async function measure(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.rounded-4xl');
    if (!card) return null;
    const cr = card.getBoundingClientRect();
    const scroller = [...card.querySelectorAll('div')].find((d) => getComputedStyle(d).overflowY === 'auto');
    const footers = [...card.querySelectorAll('div')].filter((d) => (d.className || '').includes('pb-8'));
    const footer = footers[footers.length - 1];
    const fr = footer ? footer.getBoundingClientRect() : null;
    return {
      winH: window.innerHeight,
      cardTop: Math.round(cr.top),
      cardBottom: Math.round(cr.bottom),
      cardH: Math.round(cr.height),
      scrollClient: scroller ? scroller.clientHeight : 0,
      scrollContent: scroller ? scroller.scrollHeight : 0,
      footerBottom: fr ? Math.round(fr.bottom) : null,
      footerVisible: fr ? fr.bottom <= window.innerHeight + 1 : null,
      // 卡片底边超出窗口 = 被根容器一刀切
      cardCut: cr.bottom > window.innerHeight + 1,
    };
  });
}

async function gotoStep(page, index) {
  await page.evaluate((i) => {
    const circles = [...document.querySelectorAll('div')].filter((d) => typeof d.className === 'string'
      && d.className.includes('h-8') && d.className.includes('w-8') && d.className.includes('rounded-full'));
    const target = circles[i];
    if (target && target.parentElement) target.parentElement.click();
  }, index);
  await new Promise((r) => setTimeout(r, 900));
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('✖ 没有 dist/index.html,先跑: npm run build');
    process.exit(1);
  }
  const server = await serveDist();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveExecutablePath(),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 520, height: 640, deviceScaleFactor: 1 });
  await page.exposeFunction('__setViewport', async (h) => {
    await page.setViewport({ width: 520, height: Math.max(200, Math.round(h)), deviceScaleFactor: 1 });
  });
  await page.evaluateOnNewDocument(STUB);
  await page.goto(base, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1200));

  let failed = 0;
  const check = (name, ok, detail = '') => {
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`);
  };

  console.log('\n── 换页时窗口跟不跟内容 ──');
  for (let i = 0; i < 4; i += 1) {
    await gotoStep(page, i);
    const m = await measure(page);
    if (!m) { check(`第${i + 1}页`, false, '没找到卡片'); continue; }
    const want = m.cardBottom + 16;
    check(
      `第${i + 1}页 窗口高度 = 卡片底边 + 16`,
      Math.abs(m.winH - want) <= 3,
      `窗口 ${m.winH} / 期望 ${want}(卡片 ${m.cardTop}~${m.cardBottom})`,
    );
    check(`第${i + 1}页 卡片没被切`, !m.cardCut, `卡片底 ${m.cardBottom} vs 窗口 ${m.winH}`);
    check(`第${i + 1}页 底部那条(按钮行)可见`, m.footerVisible === true, `footer 底 ${m.footerBottom}`);
  }

  console.log('\n── 内容很长时:中间自己滚,底部那条不能被切掉 ──');
  await page.evaluate(() => {
    const card = document.querySelector('.rounded-4xl');
    const scroller = [...card.querySelectorAll('div')].find((d) => getComputedStyle(d).overflowY === 'auto');
    const inner = scroller.firstElementChild;
    for (let i = 0; i < 30; i += 1) {
      const row = document.createElement('div');
      row.textContent = `第 ${i + 1} 行 —— 模拟真实使用中内容变多`;
      row.style.cssText = 'padding:6px 4px;border-bottom:1px solid #eee;font-size:13px';
      inner.appendChild(row);
    }
  });
  await new Promise((r) => setTimeout(r, 1500));
  const long = await measure(page);
  check('长内容时内容区自己滚动(不是被切)', long.scrollContent > long.scrollClient,
    `可视 ${long.scrollClient} / 内容 ${long.scrollContent}`);
  check('长内容时底部那条(按钮行)仍在窗口里', long.footerVisible === true,
    `footer 底 ${long.footerBottom} vs 窗口 ${long.winH}`);
  check('长内容时卡片没被切', !long.cardCut, `卡片底 ${long.cardBottom} vs 窗口 ${long.winH}`);
  check('长内容时窗口不超过屏幕可用高度', long.winH <= 1400, `窗口 ${long.winH}`);

  await browser.close();
  server.close();
  console.log(`\n${failed ? `✖ ${failed} 项不通过` : '✔ 全部通过'}`);
  process.exit(failed ? 1 : 0);
})();
