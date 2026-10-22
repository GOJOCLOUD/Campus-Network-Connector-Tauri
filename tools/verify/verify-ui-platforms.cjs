/**
 * 界面裁剪自检 —— 验证「Windows 版不做录制、但保留拼音输入」这件事**真的发生在界面上**。
 *
 * 只看代码不够:平台判断写错了(或者判断的是构建期常量而不是运行时平台),
 * 界面照样会把不该出现的步骤渲染出来。所以这里用真实浏览器跑一遍:
 *
 *   - 模拟 darwin → 4 个步骤(激活 / 默认执行 / 模拟点击 / 键盘输入)
 *   - 模拟 win32  → 3 个步骤(激活 / 默认执行 / 键盘输入),且界面上没有「模拟点击」
 *
 * 口径见 ADR-0012:Windows 保留拼音自动键入,不保留录制。
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
function stub(platform, accessibilityTrusted = false) {
  return `(function () {
    window.cnc = {
      platform: ${JSON.stringify(platform)},
      quit() {}, minimize() {}, maximize() {},
      getFeatures: async () => [],
      getFeatureStatus: async () => null,
      setFeatureEnabled() {}, setFeatureEnabledSetting() {},
      getNativeStatus: async () => ({ ok: true, platform: ${JSON.stringify(platform)}, accessibilityTrusted: ${JSON.stringify(accessibilityTrusted)} }),
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

/**
 * 找「辅助功能」授权小问号。
 * 它必须是个**小问号**,不是占一整条的大横幅 ——
 * 红=还不能用,绿=可以用,灰=状态未知。
 */
async function probeBadge(page) {
  return page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => (b.textContent || '').trim() === '?');
    if (!btn) return null;
    return {
      cls: typeof btn.className === 'string' ? btn.className : '',
      title: btn.getAttribute('title') || '',
    };
  });
}

/** 点到第 n 个步骤(0 起) */
async function gotoStep(page, index) {
  await page.evaluate((i) => {
    const circles = [...document.querySelectorAll('div')]
      .filter((d) => typeof d.className === 'string'
        && d.className.includes('h-8') && d.className.includes('w-8')
        && d.className.includes('rounded-full'));
    const target = circles[i];
    if (target && target.parentElement) target.parentElement.click();
  }, index);
  await new Promise((r) => setTimeout(r, 500));
}

/** 量卡片与内容区:高度、底边、有没有被裁 */
async function probeLayout(page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-panel-probe]');
    if (!card) return { cardH: 0, bottom: 0, scrollerClientH: 0, scrollerScrollH: 0, clipped: true };
    const r = card.getBoundingClientRect();
    const scroller = [...card.querySelectorAll('div')]
      .find((d) => getComputedStyle(d).overflowY === 'auto');
    return {
      cardH: Math.round(r.height),
      bottom: Math.round(r.bottom),
      scrollerClientH: scroller ? scroller.clientHeight : 0,
      scrollerScrollH: scroller ? scroller.scrollHeight : 0,
      clipped: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : true,
    };
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
    // ── 每一页的功能都得**完整展示**(不能被藏进滚动条) ──
    // 窗口宽 520、高 640(Tauri 侧高度由内容决定,这里给一个够用的高度)。
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 520, height: 640, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(stub('darwin'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      let clippedPages = [];
      for (let i = 0; i < 4; i += 1) {
        await gotoStep(page, i);
        const m = await probeLayout(page);
        if (m.clipped) clippedPages.push(`第${i + 1}页(可视${m.scrollerClientH}/内容${m.scrollerScrollH})`);
      }
      check('4 个页面的功能都完整展示(没有被藏进滚动条)', clippedPages.length === 0, clippedPages.join(' '));
      await page.close();
    }

    // ── 窗口比内容矮时:卡片不能被压扁,内容更不能被裁掉 ──
    // 卡片是 flex 项,默认 flex-shrink:1;它自己带 overflow-hidden,
    // 自动最小尺寸会被算成 0 → 窗口一矮就把卡片压扁。
    // 一旦压扁:①功能被裁;②量出来的底边永远等于"窗口底 - 8px",
    // 于是窗口一直长、内容一直缺(实测卡片 440 被压成 272,内容只剩 66/234)。
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 520, height: 320, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(stub('darwin'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      await gotoStep(page, 3);
      const m = await probeLayout(page);
      check('窗口比内容矮时卡片不被压扁', m.cardH > 300, `卡片高 ${m.cardH}`);
      check('窗口比内容矮时内容不被裁掉', !m.clipped, `可视 ${m.scrollerClientH} / 内容 ${m.scrollerScrollH}`);
      check('窗口比内容矮时卡片底边超出窗口(窗口据此长高)', m.bottom > 320, `底边 ${m.bottom}`);
      await page.close();
    }

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
      await gotoStep(page, 2);
      check('macOS 第 3 步是「模拟点击」(录制)', (await probe(page)).text.includes('模拟点击'));
      await gotoStep(page, 3);
      check('macOS 第 4 步是「键盘输入」(快捷输入)', (await probe(page)).text.includes('键盘输入'));

      // 授权提示:必须是第 4 页的一个**小问号**,不能是占一整条的大横幅
      const badge = await probeBadge(page);
      check('第 4 页有「辅助功能」授权小问号', !!badge, badge ? '' : '没找到');
      check('没授权时问号是红色的', !!badge && badge.cls.includes('text-red-600'), badge ? badge.cls : '');
      check('界面上没有那条橙色大横幅了', !(await probe(page)).text.includes('未获得「辅助功能」权限'));
      await page.close();
    }

    // ── 已授权时:小问号应该是绿的 ──
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('darwin', true));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      await gotoStep(page, 3);
      const badge = await probeBadge(page);
      check('已授权时问号是绿色的', !!badge && badge.cls.includes('text-emerald-600'), badge ? badge.cls : '没找到');
      await page.close();
    }

    // ── Windows:三个步骤(激活 / 默认执行 / 键盘输入),没有录制 ──
    // 按 ADR-0012:Windows 保留**拼音自动键入**,不保留**录制**。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      const s = await probe(page);
      check('Windows 渲染 3 个步骤', s.steps === 3, `实际 ${s.steps}`);
      check('Windows 界面上没有「模拟点击」(录制不做)', !s.text.includes('模拟点击'));
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

      // 第 3 步是「键盘输入」(拼音自动键入)—— 得点进去才看得到文案
      await page.evaluate(() => {
        const circles = [...document.querySelectorAll('div')]
          .filter((d) => typeof d.className === 'string'
            && d.className.includes('h-8') && d.className.includes('w-8')
            && d.className.includes('rounded-full'));
        const target = circles[2];
        if (target && target.parentElement) target.parentElement.click();
      });
      await new Promise((r) => setTimeout(r, 500));
      const winStep3 = await probe(page);
      check('Windows 第 3 步是「键盘输入」(拼音自动键入)', winStep3.text.includes('键盘输入'));
      check('Windows 第 3 步有「开始输入」按钮', winStep3.text.includes('开始输入'));
      const winBadge = await probeBadge(page);
      check('Windows 不显示授权小问号(Windows 没有「辅助功能」这回事)', !winBadge);
      check('Windows 界面上没有橙色大横幅', !winStep3.text.includes('未获得「辅助功能」权限'));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed === 0 ? '\n✔ 界面裁剪自检全部通过' : `\n✖ ${failed} 项不通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
