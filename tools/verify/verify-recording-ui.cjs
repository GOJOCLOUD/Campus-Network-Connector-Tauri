/**
 * 录制的回归测试：**单条删除**能删对那一条,以及「点自己界面上的按钮不算一次点击」
 * 的契约没被前端破坏。
 *
 * ## 需求(用户反馈)
 *
 * 1. 录制时点击软件内部**不该**算一次点击 —— 尤其点「结束」按钮。
 * 2. 录到的点击**必须能单条删除**,不能只有一次性清空。
 *
 * ## 这条用例盯的是什么
 *
 * - **单条删除**:录完之后每一条点击旁边有个「×」,点它:
 *   ① 调 `cnc.removeRecordingClick(index)`,传的 index 就是那一行的序号;
 *   ② 界面上那一条真的消失,别的条不动。
 *   (原生那边也要删同一条 —— 那边才是回放时真正用的。)
 *
 * - **开始录制时前端不再传排除矩形**:
 *   「点自己界面上的按钮不算一次点击」由**原生层**负责 —— 排除矩形用原生窗口
 *   位置算,并且在窗口每次移动/变高时刷新。前端传的那份只是「开始那一刻」的
 *   一张快照,窗口一动就过期(点「结束」会被记成一次点击)。
 *   所以这里断言 `startRecording` **不带任何参数**。
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

/**
 * 桩:激活态 + 一份「录到的点击」。
 * `window.__recStub` 用来把调用记录带出来(开始录制带了几个参数、删了哪一条)。
 */
const STUB = `(function () {
  window.__recStub = {
    clicks: [
      { x: 100, y: 200, timestamp: 0.1 },
      { x: 300, y: 400, timestamp: 0.5 },
      { x: 500, y: 600, timestamp: 0.9 },
    ],
    startArgs: [],
    removed: [],
    cleared: false,
  };
  const stub = window.__recStub;
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
    startRecording: async function () {
      stub.startArgs.push(Array.prototype.slice.call(arguments));
      return true;
    },
    stopRecording: async () => stub.clicks.slice(),
    getRecordingClicks: async () => stub.clicks.slice(),
    clearRecordingClicks: async () => { stub.cleared = true; stub.clicks = []; return true; },
    removeRecordingClick: async (index) => {
      stub.removed.push(index);
      if (index >= 0 && index < stub.clicks.length) stub.clicks.splice(index, 1);
      return true;
    },
    isRecording: async () => false,
    tapFailed: async () => false,
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

/** 有没有某个文字的按钮(**只看,不许点** —— 「清空」一点就把列表清了) */
const HAS_TEXT = (text) =>
  [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === text);

/** 按可见文字找按钮并点它 */
const CLICK_TEXT = (text) => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === text);
  if (!btn) return false;
  btn.click();
  return true;
};

/** 点第 n 个步骤圆圈(1-based) */
const GOTO_STEP = (n) => {
  const circles = [...document.querySelectorAll('div')].filter((d) => {
    const c = typeof d.className === 'string' ? d.className : '';
    return c.includes('h-8') && c.includes('w-8') && c.includes('rounded-full');
  });
  const target = circles[n - 1];
  if (target && target.parentElement) target.parentElement.click();
  return !!target;
};

/** 当前录到的点击列表(界面上显示的那几条) */
const READ_ROWS = () =>
  [...document.querySelectorAll('li')].map((li) => ({
    text: (li.textContent || '').trim(),
    hasDelete: !!li.querySelector('button[aria-label^="删除第"]'),
  }));

test('录制:录完能单条删除,开始录制不再由前端传那张会过期的矩形', async (t) => {
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

  t.after(async () => {
    await browser.close();
    server.close();
  });

  // 到第 3 页(录制面板)
  await page.evaluate(GOTO_STEP, 3);
  await new Promise((r) => setTimeout(r, 800));

  // 开始 → 倒计时 3 秒
  assert.ok(await page.evaluate(CLICK_TEXT, '开始'), '找不到「开始」按钮');
  await new Promise((r) => setTimeout(r, 3600));

  const startArgs = await page.evaluate(() => window.__recStub.startArgs);
  assert.strictEqual(startArgs.length, 1, '「开始」没有调到 startRecording');
  assert.deepStrictEqual(
    startArgs[0],
    [],
    '开始录制时前端还在传排除矩形 —— 那是「开始那一刻」的一张快照,窗口一动就过期' +
      '(点「结束」会被记成一次点击)。排除矩形必须由原生层按当前窗口位置算。'
  );

  // 录制中 → 停止
  assert.ok(await page.evaluate(CLICK_TEXT, '结束'), '找不到「结束」按钮');
  await new Promise((r) => setTimeout(r, 600));

  // 停止后应当看到每一条点击,每条旁边都有「×」
  let rows = await page.evaluate(READ_ROWS);
  assert.strictEqual(rows.length, 3, '停止后应当看到 3 条点击,实际 ' + rows.length + ' 条');
  for (const r of rows) {
    assert.ok(r.hasDelete, '有一条点击旁边没有删除按钮:「' + r.text + '」');
  }
  assert.ok(
    await page.evaluate(HAS_TEXT, '清空'),
    '「清空」按钮没了 —— 单条删除是**加**上去的,不是替掉它的'
  );

  // 点第 2 条的「×」→ 只删第 2 条
  const clicked = await page.evaluate(() => {
    const li = [...document.querySelectorAll('li')][1];
    const btn = li && li.querySelector('button[aria-label^="删除第"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  assert.ok(clicked, '找不到第 2 条的删除按钮');
  await new Promise((r) => setTimeout(r, 300));

  const removed = await page.evaluate(() => window.__recStub.removed);
  assert.deepStrictEqual(removed, [1], '删第 2 条应该只调一次 removeRecordingClick(1),实际 ' + JSON.stringify(removed));

  rows = await page.evaluate(READ_ROWS);
  assert.strictEqual(rows.length, 2, '删掉一条后应当剩 2 条,实际 ' + rows.length);
  // 序号会重新编(1、2),所以要看**坐标**:删掉的是 (300, 400) 那一条,
  // 剩下的是 (100, 200) 和 (500, 600)。
  const coords = rows.map((r) => {
    const m = r.text.match(/\((\d+), (\d+)\)/);
    return m ? m[1] + ',' + m[2] : r.text;
  });
  assert.deepStrictEqual(
    coords.sort(),
    ['100,200', '500,600'],
    '删掉的应当只是中间那一条 (300, 400),剩下的两条坐标不该变:实际 ' + JSON.stringify(coords)
  );
  assert.ok(
    rows.every((r) => r.hasDelete),
    '删完之后剩下的每一条旁边仍然要有删除按钮'
  );
});
