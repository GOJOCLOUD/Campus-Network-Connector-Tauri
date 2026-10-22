/**
 * 界面观感对照:把 Electron 版和 Tauri 版各渲染一张透明背景的截图,
 * 用来肉眼比"面板长得像不像"。
 *
 *   node tools/lab/compare-panel-appearance.cjs
 *
 * 只在本地渲染页面截图(不碰用户桌面、不截用户的窗口)。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'tools', 'lab', 'panel-compare');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** 和 verify-ui-platforms.cjs 同一套桩,两个壳都能跑 */
const STUB = `(function () {
  window.cnc = {
    platform: 'darwin',
    quit() {}, minimize() {}, maximize() {},
    getFeatures: async () => [],
    getFeatureStatus: async () => null,
    setFeatureEnabled() {}, setFeatureEnabledSetting() {},
    getNativeStatus: async () => ({ ok: true, platform: 'darwin', accessibilityTrusted: false }),
    getActivationSnapshot: async () => ({
      deviceUuid: 'test-uuid', trialUsed: true,
      trialExpiresAt: Date.now() + 86400000, licenseValid: true, license: ''
    }),
    startTrial: async () => ({}), saveLicense: async () => ({ ok: true }),
    clearLicense: async () => ({}), migrateLegacyActivation: async () => ({}),
    listFiles: async () => [{ name: 'demo.json' }],
    saveFile: async () => ({ status: 'success' }),
    renameFile: async () => ({ status: 'success' }),
    deleteFile: async () => ({ status: 'success' }),
    readFile: async () => '',
    clipboardReadText: async () => '',
    mouseClick: async () => true, mouseGetPosition: async () => ({ x: 0, y: 0 }),
    sendText: async () => true, sendKey: async () => true,
    getInputSource: async () => '', selectInputSource: async () => true,
    getInputSourceConfig: async () => ({}), saveInputSourceConfig: async () => ({}),
    setCurrentAsInputSource: async () => ({ status: 'success' }),
    playFile: async () => ({ status: 'success' }),
    pinyinInput: async () => ({ status: 'success' }),
    startRecording: async () => true, stopRecording: async () => [],
    getRecordingClicks: async () => [], clearRecordingCicks: async () => true,
    settings: { setSelectedJson() {} },
  };
})();`;

function serveDist(dist) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(dist, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
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

async function shoot(browser, dist, tag) {
  const server = await serveDist(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const page = await browser.newPage();
  await page.setViewport({ width: 520, height: 640, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(STUB);
  await page.goto(base, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 900));
  const info = await page.evaluate(() => {
    const card = document.querySelector('[data-panel-probe]') || document.querySelector('.rounded-4xl');
    const r = card ? card.getBoundingClientRect() : null;
    return {
      card: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      shadow: card ? getComputedStyle(card).boxShadow : null,
      radius: card ? getComputedStyle(card).borderRadius : null,
    };
  });
  const file = path.join(OUT, `${tag}.png`);
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
  server.close();
  return { file, info };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const executablePath = resolveExecutablePath();
  if (!executablePath) { console.error('找不到 Chrome'); process.exit(1); }
  const browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  try {
    for (const [tag, dist] of [
      ['electron', path.join(ROOT, '..', 'electron', 'dist')],
      ['tauri', path.join(ROOT, 'dist')],
    ]) {
      if (!fs.existsSync(path.join(dist, 'index.html'))) {
        console.log(`跳过 ${tag}: 没有 ${dist}/index.html`);
        continue;
      }
      const r = await shoot(browser, dist, tag);
      console.log(`${tag}: 卡片 ${JSON.stringify(r.info.card)}  圆角 ${r.info.radius}`);
      console.log(`     阴影 ${r.info.shadow}`);
      console.log(`     截图 ${r.file}`);
    }
  } finally {
    await browser.close();
  }
})();
