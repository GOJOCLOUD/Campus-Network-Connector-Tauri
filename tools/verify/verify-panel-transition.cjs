/**
 * 面板换页的回归测试：**底下那条横向滚动条不许再出现，画面横滑的动画不许丢**。
 *
 * ## 复现的故障(用户反馈)
 *
 * 界面 1 ↔ 2/3/4 切换时，内容区**底下**有一条横条在「滑动」。
 * 那不是顶上步骤圈之间的紫色进度线，是**横向滚动条**:
 *
 * - 内容容器写的是 `overflowY: 'auto'`，按 CSS 规范,
 *   一个轴是 auto 时另一个轴的 `visible` 会被**算成 auto** → 横向其实也能滚;
 * - 切页时正在退场的那一页往右滑(`x: '50%'`),横向就溢出了;
 * - 于是内容区底部冒出一条横向滚动条,滚块跟着画面一起移动 = 用户看到的「滑条」。
 *
 * 修法:内容容器加 `overflow-x: hidden`(横向不许滚),画面「直接划过去」的动画原样保留。
 *
 * ## 怎么证明「滚动条真的没了」
 *
 * macOS 上滚动条是 overlay 的,**不占地方**,直接量宽度/高度量不出来
 * (headless Chrome 里也一样:横竖都占 0px,换任何 flag 都一样)。
 * 所以这里按**规范**判定:
 *
 * - `overflow-x: auto` + 横向溢出 → 浏览器**一定**画出一条横向滚动条;
 * - `overflow-x: hidden` + 横向溢出 → 浏览器**一定不画**(内容被裁掉)。
 *
 * 于是判据 = 计算样式必须是 `hidden`,同时要证明**溢出确实发生了**
 * (`scrollWidth > clientWidth`)—— 否则这条用例就是恒绿,什么都没测到。
 * 最后再把 `overflow-x` 改回 `auto` 复测一次,证明「同样的溢出在 auto 下
 * 就会冒出滚动条」,即这条断言是**有判别力**的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('http');
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

/** 和 tools/lab/compare-panel-appearance.cjs 同一套桩:两个壳都能跑 */
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
    getRecordingClicks: async () => [], clearRecordingClicks: async () => true,
    removeRecordingClick: async () => true,
    settings: { setSelectedJson() {} },
  };
})();`;

/** 强制渲染「经典滚动条」(有滚动条就占地方) */
const CLASSIC_SCROLLBARS = `
  * { scrollbar-width: auto !important; scrollbar-color: rgba(0,0,255,.85) rgba(255,0,0,.35) !important; }
  ::-webkit-scrollbar { width: 15px !important; height: 15px !important; background: rgba(255,0,0,.35) !important; }
  ::-webkit-scrollbar-thumb { background: rgba(0,0,255,.85) !important; }
`;

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

/** 页面里量一次:内容容器的滚动条占位 + 有没有层在横向移动 */
const PROBE = () => {
  const card = document.querySelector('.rounded-4xl');
  const scroller = card
    ? [...card.querySelectorAll('div')].find((d) => getComputedStyle(d).overflowY === 'auto')
    : null;
  if (!scroller) return null;
  const sliding = [...card.querySelectorAll('div')].filter((d) => {
    const t = getComputedStyle(d).transform;
    if (!t || t === 'none') return false;
    const m = t.match(/matrix\(([^)]+)\)/);
    if (!m) return false;
    const p = m[1].split(',').map(Number);
    return Math.abs(p[4]) > 0.5 || Math.abs(p[5]) > 0.5;
  }).length;
  return {
    overflowX: getComputedStyle(scroller).overflowX,
    overflowY: getComputedStyle(scroller).overflowY,
    // 横向滚动条占的高度(纵向滚动条占的是宽度,不影响这个数)
    hScrollSpace: scroller.offsetHeight - scroller.clientHeight,
    vScrollSpace: scroller.offsetWidth - scroller.clientWidth,
    scrollW: scroller.scrollWidth,
    clientW: scroller.clientWidth,
    sliding,
  };
};

/** 点第 n 个步骤圆圈(1-based) */
const GOTO = (n) => {
  const circles = [...document.querySelectorAll('div')].filter((d) => {
    const c = typeof d.className === 'string' ? d.className : '';
    return c.includes('h-8') && c.includes('w-8') && c.includes('rounded-full');
  });
  const target = circles[n - 1];
  if (target && target.parentElement) target.parentElement.click();
  return !!target;
};

test('换页:底下不许有横向滚动条,画面横滑动画不许丢', async (t) => {
  assert.ok(
    fs.existsSync(path.join(DIST, 'index.html')),
    '没有 ' + DIST + '/index.html —— 先跑 `npm run build` 再跑这条用例'
  );
  const executablePath = resolveExecutablePath();
  assert.ok(executablePath, '找不到 Chrome(puppeteer 没装好?)');

  const server = await serveDist(DIST);
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 520, height: 640 });
  await page.evaluateOnNewDocument(STUB);
  await page.goto(base, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 900));
  // 经典滚动条样式:有滚动条就占地方,量得出来
  await page.addStyleTag({ content: CLASSIC_SCROLLBARS });

  t.after(async () => {
    await browser.close();
    server.close();
  });

  // 激活态 → 初始在第 2 页;先点回第 1 页
  await page.evaluate(GOTO, 1);
  await new Promise((r) => setTimeout(r, 800));

  // ── 静止态:内容容器必须是「横向 hidden / 纵向 auto」 ──
  const rest = await page.evaluate(PROBE);
  assert.ok(rest, '找不到内容容器(面板结构变了?)');
  assert.strictEqual(rest.overflowX, 'hidden', '内容容器横向必须是 hidden,实际 ' + rest.overflowX);
  assert.strictEqual(rest.overflowY, 'auto', '内容容器纵向必须还是 auto(长内容要能滚),实际 ' + rest.overflowY);

  // ── 切页过程中:横向滚动条一处都不许占位 ──
  await page.evaluate(GOTO, 2);
  let worstH = 0;
  let sawSlide = false;
  let sawOverflow = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 40));
    const p = await page.evaluate(PROBE);
    if (!p) continue;
    worstH = Math.max(worstH, p.hScrollSpace);
    if (p.sliding > 0) sawSlide = true;
    if (p.scrollW > p.clientW + 1) sawOverflow = true;
  }
  assert.ok(sawSlide, '切换过程中没有层在横向移动 —— 「画面直接划过去」的动画丢了');
  assert.ok(
    sawOverflow,
    '切换过程中没有出现横向溢出 —— 说明动画没真的在跑,这条用例等于没测到东西'
  );
  assert.strictEqual(
    worstH,
    0,
    '切换过程中内容区底部出现了一条横向滚动条(占位 ' + worstH + 'px)—— 用户说的「下面那条滑条」'
  );

  // ── 判别性:把 overflow-x 改回 auto,同样的横向溢出就会让浏览器
  //    画出一条横向滚动条(= 用户看到的那条)。改回来仍要是 hidden。
  await page.evaluate(() => {
    const card = document.querySelector('.rounded-4xl');
    const scroller = [...card.querySelectorAll('div')].find((d) => getComputedStyle(d).overflowY === 'auto');
    scroller.style.overflowX = 'auto';
  });
  await page.evaluate(GOTO, 1);
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(GOTO, 2);
  let sawOverflowAuto = false;
  let overflowXAuto = '';
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 40));
    const p = await page.evaluate(PROBE);
    if (!p) continue;
    overflowXAuto = p.overflowX;
    if (p.scrollW > p.clientW + 1) sawOverflowAuto = true;
  }
  assert.strictEqual(overflowXAuto, 'auto', '改回 auto 没生效,这条判别检查等于没跑');
  assert.ok(
    sawOverflowAuto,
    '改成 auto 之后横向溢出没发生 —— 证明「auto + 溢出 = 出滚动条」这个前提在本用例里不成立'
  );
});
