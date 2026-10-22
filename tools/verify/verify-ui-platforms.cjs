/**
 * 界面裁剪自检 —— 验证「Windows 版没有快捷输入、没有录制」这件事**真的发生在界面上**。
 *
 * 只看代码不够:平台判断写错了(或者判断的是构建期常量而不是运行时平台),
 * 界面照样会把两个不该出现的步骤渲染出来。所以这里用真实浏览器跑一遍:
 *
 *   - 模拟 darwin → 4 个步骤(激活 / 默认执行 / 模拟点击 / 键盘输入)
 *   - 模拟 win32  → 2 个步骤(激活 / 默认执行),且界面上没有「模拟点击」「键盘输入」
 *
 *   node tools/verify/verify-ui-platforms.cjs
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DIST = path.join(__dirname, '..', '..', 'dist');
const PORT = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** 起一个静态服务器,把 dist/ 挂上去 */
function serveDist() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(DIST, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 造一个够用的 window.cnc 桩 */
function stub(platform) {
  return `(function () {
    window.cnc = {
      platform: ${JSON.stringify(platform)},
      quit() {}, minimize() {}, maximize() {},
      getFeatures: async () => [],
      getFeatureStatus: async () => null,
      setFeatureEnabled() {}, setFeatureEnabledSetting() {},
      getNativeStatus: async () => ({ ok: true, platform: ${JSON.stringify(platform)} }),
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
      playFile: async () => ({ status: 'success' }),
      pinyinInput: async () => ({ status: 'success' }),
      startRecording: async () => true, stopRecording: async () => [],
      getRecordingClicks: async () => [], clearRecordingClicks: async () => true,
      settings: { setSelectedJson() {} },
    };
  })();`;
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

/**
 * 找可用的 Chrome。
 * puppeteer 会去找**精确版本号**的构建,本机缓存里常常是差几个补丁号的那个
 * (例:缓存 155.0.8059.79,puppeteer 要 155.0.8059.84)→ 直接启动失败。
 * 所以这里兜底:在 puppeteer 缓存目录里扫一个真实存在的可执行文件。
 */
function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    // puppeteer 各版本返回的可能是 string 也可能是 URL，统一成字符串再喂给 fs
    const p = puppeteer.executablePath();
    const asPath = typeof p === 'string' ? p : (p && p.filePath) ? p.filePath : '';
    if (asPath && fs.existsSync(asPath)) return asPath;
  } catch (_) { /* 继续找 */ }
  const roots = [
    path.join(process.env.HOME || '', '.cache', 'puppeteer'),
    path.join(process.env.HOME || '', 'Library', 'Caches', 'puppeteer'),
  ];
  const names = [
    'Google Chrome for Testing',
    'chrome-headless-shell',
    'Chromium',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith('chrome')) continue;
      const base = path.join(root, dir);
      const stack = [base];
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

/** 读当前页面的步骤数与可见文案 */
async function probe(page) {
  return page.evaluate(() => {
    const stepCircles = [...document.querySelectorAll('div')]
      .filter((d) => typeof d.className === 'string'
        && d.className.includes('h-8') && d.className.includes('w-8')
        && d.className.includes('rounded-full'));
    const text = document.body.innerText || '';
    return { steps: stepCircles.length, text };
  });
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('✖ 没有 dist/index.html,先跑: npm run build');
    process.exit(1);
  }
  const server = await serveDist();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const executablePath = resolveExecutablePath();
  if (!executablePath) {
    console.error('✖ 找不到可用的 Chrome,先跑: npx puppeteer browsers install chrome');
    server.close();
    process.exit(1);
  }
  console.log(`使用浏览器: ${executablePath}\n`);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox'],
  });

  try {
    // ── macOS:四个步骤 ──
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('darwin'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      const s = await probe(page);
      check('macOS 渲染 4 个步骤', s.steps === 4, `实际 ${s.steps}`);
      check('macOS 保留「默认执行」', s.text.includes('默认执行'));

      // 点到第 3、4 步,确认这两个界面在 macOS 上真的还在
      const clickStep = async (index) => {
        await page.evaluate((i) => {
          const circles = [...document.querySelectorAll('div')]
            .filter((d) => typeof d.className === 'string'
              && d.className.includes('h-8') && d.className.includes('w-8')
              && d.className.includes('rounded-full'));
          const target = circles[i];
          if (target && target.parentElement) target.parentElement.click();
        }, index);
        await new Promise((r) => setTimeout(r, 500));
      };
      await clickStep(2);
      check('macOS 第 3 步是「模拟点击」(录制)', (await probe(page)).text.includes('模拟点击'));
      await clickStep(3);
      check('macOS 第 4 步是「键盘输入」(快捷输入)', (await probe(page)).text.includes('键盘输入'));
      await page.close();
    }

    // ── Windows:两个步骤,且没有快捷输入/录制 ──
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      const s = await probe(page);
      check('Windows 只渲染 2 个步骤', s.steps === 2, `实际 ${s.steps}`);
      check('Windows 界面上没有「模拟点击」', !s.text.includes('模拟点击'));
      check('Windows 界面上没有「键盘输入」', !s.text.includes('键盘输入'));
      check('Windows 保留「默认执行」', s.text.includes('默认执行'));
      check('Windows 保留「选择录制」', s.text.includes('选择录制'));
      check('Windows 保留「管理」入口(文件管理不能跟着录制界面一起没掉)', s.text.includes('管理'));

      // 点「管理」应该能进到「管理录制文件」视图,再点「返回」回到执行面板
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '管理');
        if (btn) btn.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      const managed = await probe(page);
      check('Windows 点「管理」进入「管理录制文件」视图', managed.text.includes('管理录制文件'));
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '返回');
        if (btn) btn.click();
      });
      await new Promise((r) => setTimeout(r, 400));
      const back = await probe(page);
      check('Windows 点「返回」回到执行面板', back.text.includes('默认执行') && !back.text.includes('管理录制文件'));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed === 0 ? '\n✔ 界面裁剪自检全部通过' : `\n✖ ${failed} 项不通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
