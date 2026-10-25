/**
 * 界面裁剪自检 —— 验证「Windows 版不做录制、不做回放,但保留拼音输入」这件事
 * **真的发生在界面上**。
 *
 * 只看代码不够:平台判断写错了(或者判断的是构建期常量而不是运行时平台),
 * 界面照样会把不该出现的步骤渲染出来。所以这里用真实浏览器跑一遍:
 *
 *   - 模拟 darwin → 4 个步骤(激活 / 默认执行 / 模拟点击 / 键盘输入)
 *   - 模拟 win32  → 2 个步骤(激活 / 键盘输入),界面上既没有「模拟点击」,
 *                   也没有「默认执行(回放)」这一屏
 *
 * 口径见 ADR-0012(平台功能范围)与 ADR-0026(Windows 线不保留「默认执行」界面):
 * Windows 保留拼音自动键入;不保留录制,也不保留回放。
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
function stub(platform, accessibilityTrusted = false, nativeStatus = null, features = []) {
  const status = nativeStatus || { ok: true, platform, accessibilityTrusted };
  // 功能清单:Windows 线上是「浏览器复制修复」(与 mac 的「Safari 复制修复」同一个组件)。
  // 先在**函数里**序列化成 JSON,再插进下面那个模板字符串(模板里再拼字符串很容易出错)。
  const featureListJson = JSON.stringify(features);
  const featureStatusJson = JSON.stringify(Object.fromEntries(features.map((f) => [f.prefix, {
    enabled: true,
    supported: true,
    injected: true,
    hint: '已注册到 Chrome、Edge,下次打开浏览器即生效。',
    lastError: '',
  }])));
  return `(function () {
    // 窗口动作的**调用记录**:用来断言右上角那四个按钮各自调了什么
    // (「关闭软件」= quit 一次点击真退出;「放到后台」= hide 进程留着)。
    window.__winCalls = [];
    // 键入请求的记录:用来断言「开始输入」带 3 秒倒计时。
    window.__pinyinInputs = [];
    window.cnc = {
      platform: ${JSON.stringify(platform)},
      quit() { window.__winCalls.push('quit'); },
      minimize() { window.__winCalls.push('minimize'); },
      maximize() { window.__winCalls.push('maximize'); },
      hide() { window.__winCalls.push('hide'); },
      clipboardReadText: async () => '来自剪贴板的文字',
      getFeatures: async () => ${featureListJson},
      getFeatureStatus: async (prefix) => (${featureStatusJson})[prefix] || null,
      setFeatureEnabled() {}, setFeatureEnabledSetting() {},
      getNativeStatus: async () => (${JSON.stringify(status)}),
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
      pinyinInput: async (text, delay, autoSwitch) => {
        window.__pinyinInputs.push([text, delay, autoSwitch]);
        return { status: 'success' };
      },
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
const { resolveExecutablePath } = require('../chrome-path.cjs');
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

/**
 * 等布局**稳定**再量(别量动画中间态)。
 *
 * ## 为什么要有这个
 *
 * 面板切换有 **0.4s 的高度动画**。之前是「点完睡 500ms 就量」——
 * CI 机器慢的时候,500ms 里动画**还没走完** ⇒ 量到的是**动画中间态**
 * (内容区只剩几十像素高)⇒ 误判成「内容被藏进滚动条了」。
 *
 * 真实踩到:2026-10-24 的 mac CI 报「第2页(可视36/内容84)」——
 * **36px 明显是动画中间态**,不是真的裁切(那一页的内容本来就不高)。
 *
 * 改成:**轮询到尺寸不再变化**才算数。
 */
async function waitForStableLayout(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let m = await probeLayout(page);
  let last = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    m = await probeLayout(page);
    const key = `${m.cardH}:${m.scrollerClientH}:${m.scrollerScrollH}`;
    if (key === last) {
      stable += 1;
      // 连续两次一样 ⇒ 动画结束了
      if (stable >= 2) return m;
    } else {
      stable = 0;
      last = key;
    }
  }
  return m;
}

/** 量卡片与内容区:高度、底边、有没有被裁 */
async function probeLayout(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.rounded-4xl');
    if (!card) return { cardH: 0, bottom: 0, scrollerClientH: 0, scrollerScrollH: 0, clipped: true };
    const r = card.getBoundingClientRect();
    const scroller = [...card.querySelectorAll('div')]
      .find((d) => getComputedStyle(d).overflowY === 'auto');
    return {
      cardH: Math.round(r.height),
      bottom: Math.round(r.bottom),
      scrollerClientH: scroller ? scroller.clientHeight : 0,
      scrollerScrollH: scroller ? scroller.scrollHeight : 0,
      scrollerOverflowY: scroller ? getComputedStyle(scroller).overflowY : '',
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
        // **等布局稳定再量** —— 别量到面板切换动画的中间态
        // (2026-10-24 的 mac CI 在这里误报过一次:「第2页(可视36/内容84)」)。
        const m = await waitForStableLayout(page);
        if (m.clipped) clippedPages.push(`第${i + 1}页(可视${m.scrollerClientH}/内容${m.scrollerScrollH})`);
      }
      check('4 个页面的功能都完整展示(没有被藏进滚动条)', clippedPages.length === 0, clippedPages.join(' '));
      await page.close();
    }

    // ── 窗口比内容矮时:卡片不能被压扁,内容还得翻得到 ──
    // 卡片是 flex 项,默认 flex-shrink:1;它自己带 overflow-hidden,
    // 自动最小尺寸会被算成 0 → 窗口一矮就把卡片压扁。
    // 一旦压扁:①功能被裁;②量出来的底边永远等于"窗口底 - 8px",
    // 于是窗口一直长、内容一直缺(实测卡片 440 被压成 272,内容只剩 66/234)。
    //
    // 窗口不够高时**内容区自己滚**(Electron 版就是这么做的:
    // 内容区 `maxHeight: 65vh` + `overflowY: auto`),
    // 所以这里的判据不是"没有滚动条",而是:
    //   ① 卡片没被压扁;
    //   ② 内容在一个**滚动容器**里(overflowY=auto),超出的部分翻得到,
    //      而不是被根容器的 overflow-hidden 一刀切掉、哪儿也翻不到;
    //   ③ 卡片底边超出窗口 → 窗口据此长高(真机上由 fitWindow 收窗口)。
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 520, height: 320, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(stub('darwin'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      await gotoStep(page, 3);
      const m = await waitForStableLayout(page);
      check('窗口比内容矮时卡片不被压扁', m.cardH > 300, `卡片高 ${m.cardH}`);
      check(
        '窗口比内容矮时内容在滚动容器里(翻得到,没被根容器一刀切)',
        m.scrollerOverflowY === 'auto' && m.scrollerScrollH > 0,
        `overflowY=${m.scrollerOverflowY} 可视 ${m.scrollerClientH} / 内容 ${m.scrollerScrollH}`,
      );
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

    // ── Windows:两个步骤(激活 / 键盘输入),没有录制、没有「默认执行」 ──
    // 按 ADR-0012 + ADR-0026:Windows 线保留**拼音自动键入**,
    // 不保留**录制**,也**不保留「默认执行(回放)」这一屏**
    // (Windows 没有录制 ⇒ 没有可回放的源 ⇒ 那一屏是「点了没反应」的死界面)。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32'));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      const s = await probe(page);
      check('Windows 渲染 2 个步骤', s.steps === 2, `实际 ${s.steps}`);
      check('Windows 界面上没有「模拟点击」(录制不做)', !s.text.includes('模拟点击'));
      check('Windows 界面上没有「默认执行」(回放不做,那一屏是死界面)', !s.text.includes('默认执行'));
      check('Windows 界面上没有「选择录制」', !s.text.includes('选择录制'));
      check('Windows 界面上没有「管理」入口', !s.text.includes('管理'));
      check(
        'Windows 界面上没有红底白字横幅(原生模块没坏就不该报「加载失败」)',
        !s.text.includes('模拟输入相关功能不可用'),
      );

      // 第 2 步是「键盘输入」(拼音自动键入)—— 得点进去才看得到文案
      await page.evaluate(() => {
        const circles = [...document.querySelectorAll('div')]
          .filter((d) => typeof d.className === 'string'
            && d.className.includes('h-8') && d.className.includes('w-8')
            && d.className.includes('rounded-full'));
        const target = circles[1];
        if (target && target.parentElement) target.parentElement.click();
      });
      await new Promise((r) => setTimeout(r, 500));
      const winStep2 = await probe(page);
      check('Windows 第 2 步是「键盘输入」(拼音自动键入)', winStep2.text.includes('键盘输入'));
      check('Windows 第 2 步有「开始输入」按钮', winStep2.text.includes('开始输入'));
      const winBadge = await probeBadge(page);
      check('Windows 不显示授权小问号(Windows 没有「辅助功能」这回事)', !winBadge);
      check('Windows 界面上没有橙色大横幅', !winStep2.text.includes('未获得「辅助功能」权限'));

      // ── 右上角只留**两个**按钮:最小化 / 叉叉(=终止)──
      //
      // 2026-10-25 用户口径(第二次,最终版):「把全屏按钮给我删除掉,最小化保留,
      // 然后叉叉也保留,你能不能搞个终止按钮,搞个叉车,两个就重复了呀,
      // 现在就保留两个,一个最小化,一个终止,终止的形状要叉叉,其他的都不要」。
      //
      // - **最小化**;
      // - **叉叉** = **终止**(形状就是叉叉;彻底退出,一次点击就退)。
      //
      // 被删掉的三个(都是用户明令,不是我们自己猜的):
      // - **最大化**(「把全屏按钮给我删除掉」);
      // - **关闭软件**(电源图标)—— 与叉叉**重复**(用户原话「搞个叉车,两个就重复了呀」);
      // - **放到后台** —— 窗口藏起来**仍然做得到**:Alt+F4 / 任务栏右键「关闭窗口」,
      //   回来靠**托盘图标**(左键)或再运行一次程序。
      const corner = await page.evaluate(() => {
        const host = [...document.querySelectorAll('.app-nodrag')].find((d) => {
          const c = typeof d.className === 'string' ? d.className : '';
          return c.includes('top-3') && c.includes('right-3');
        });
        if (!host) return null;
        return [...host.querySelectorAll('button')].map((b) => ({
          aria: b.getAttribute('aria-label') || '',
          title: b.getAttribute('title') || '',
        }));
      });
      check('Windows 右上角只有 2 个按钮', corner && corner.length === 2,
        corner ? corner.map((b) => b.aria).join(',') : '没找到右上角按钮组');
      check('两个按钮是「最小化 / 终止(叉叉)」',
        corner && corner.map((b) => b.aria).join(',') === '最小化,终止',
        corner ? corner.map((b) => b.aria).join(',') : '');

      // 点这四个按钮,看它们各自调的是哪个窗口动作。
      //
      // 关键两条:
      // - 「**关闭软件**」必须调 **quit** —— 一次点击就真退出
      //   (用户口径:「人家真正想关软件还得点两次」⇒ 不能让他先去托盘再点一次);
      // - 「**放到后台**」(小叉)必须调 **hide** —— 窗口藏起来、进程留着
      //   (用户口径:「要在后台挂着,功能依然生效」)⇒ 小叉**不是退出**。
      await page.evaluate(() => {
        const host = [...document.querySelectorAll('.app-nodrag')].find((d) => {
          const c = typeof d.className === 'string' ? d.className : '';
          return c.includes('top-3') && c.includes('right-3');
        });
        [...host.querySelectorAll('button')].forEach((b) => b.click());
      });
      const calls = await page.evaluate(() => window.__winCalls);
      check('两个按钮分别调 minimize / quit',
        JSON.stringify(calls) === JSON.stringify(['minimize', 'quit']),
        JSON.stringify(calls));
      check('右上角**没有**「放到后台」(hide)按钮了(用户明令删掉)',
        !calls.includes('hide'), JSON.stringify(calls));

      // ── 「从剪贴板读入并键入」按钮**已经撤掉**(2026-10-25 用户口径)──
      //
      // 用户原话:「你这个界面本来就有开始输入这个按钮,只不过给了你三秒来定位光标在哪?
      // 你现在多加个按钮进去,那跟普通的界面有什么区别?我现在就是要快捷键触发呀」。
      //
      // ⇒ 这个能力回到 **⌃D 全局快捷键**,界面上不再有第二个按钮。
      check('界面上**没有**「从剪贴板读入并键入」按钮(这个能力回到 ⌃D 快捷键)',
        !winStep2.text.includes('从剪贴板读入并键入'));
      check('「开始输入（3s 后键入）」按钮还在(界面上唯一的输入入口)',
        winStep2.text.includes('开始输入（3s 后键入）'),
        winStep2.text.includes('开始输入') ? '' : '没找到「开始输入」按钮');
      // 点它:必须**带 3 秒倒计时**。
      // ⚠️ 点我们按钮的那一刻,焦点在**我们自己的窗口**里 —— 立刻键入的话,
      // 字会打进我们自己的界面,而不是用户想输入的目标软件。
      // (⌃D 全局键那条路不一样:它是**目标软件**在前台时按的,焦点本来就在那边,
      //  所以它可以立刻键入。)
      await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        if (ta) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '测试文字');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await new Promise((r) => setTimeout(r, 200));
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => (b.textContent || '').includes('开始输入'));
        if (btn) btn.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      const typed = await page.evaluate(() => window.__pinyinInputs);
      check('「开始输入」把内容送进键入通道',
        typed.some((p) => p[0] === '测试文字'), JSON.stringify(typed));
      check('「开始输入」带 3 秒倒计时(不是立刻键入)',
        typed.some((p) => p[0] === '测试文字' && p[1] === 3), JSON.stringify(typed));
      check('界面上有倒计时提示(用户要时间去把光标移到目标位置)',
        (await probe(page)).text.includes('秒后开始输入'));

      await page.close();
    }

    // ── ⌃D **抢没抢到**必须**看得见**(2026-10-25 用户口径)──
    //
    // 抢 ⌃D 的目的:在别的软件里按 Ctrl+D 时,那个软件**收不到**这个组合键,
    // 于是它不会被自己的「退出」关掉。
    //
    // 但注册是**系统级独占**的:别的软件先注册了同一个组合键 ⇒ 我们**抢不到**。
    // 抢不到时有两件事同时成立:
    //   ① 按它**不会触发我们**;
    //   ② 目标软件自己的 Ctrl+D **照常生效** ⇒ 那个软件还是会被它关掉。
    // 这两件用户必须知道,否则只会觉得「按了没反应,是不是软件坏了」。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32', false, {
        ok: true, platform: 'win32', shortcutPasteRegistered: false,
      }));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      await gotoStep(page, 1);
      const lost = await probe(page);
      check('⌃D 没抢到 ⇒ 界面出现提示(说清楚按了不会触发我们)',
        lost.text.includes('没抢到'), lost.text.includes('没抢到') ? '' : lost.text.slice(0, 160));
      check('⌃D 没抢到的提示里说清了「目标软件自己的 Ctrl+D 照常生效」',
        lost.text.includes('照常生效'), '');
      await page.close();
    }
    // 抢到了 ⇒ **不该**出现那条提示(别一上来就吓人)
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32', false, {
        ok: true, platform: 'win32', shortcutPasteRegistered: true,
      }));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      await gotoStep(page, 1);
      const won = await probe(page);
      check('⌃D 抢到了 ⇒ 界面没有那条提示',
        !won.text.includes('没抢到'), '');
      await page.close();
    }

    // ── 原生模块真的坏了:红底白字横幅**必须出现** ──
    // 这条横幅不是死代码 —— 它只在 `nativeStatus.ok === false` 时出现。
    // 它以前在 Windows 上**必然**出现(原生状态里那个 `ok` 字段写成了
    // 「是不是 macOS」,在 Windows 上恒为 false),而实际上模块好好的。
    // 修好之后两种情况都要对:模块正常 ⇒ 不出现;模块真坏了 ⇒ 出现。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32', false, {
        ok: false,
        platform: 'win32',
        error: '原生模块加载失败(测试桩)',
      }));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      const broken = await probe(page);
      check(
        '原生模块真坏了 ⇒ 红底白字横幅出现(而且写明原因)',
        broken.text.includes('模拟输入相关功能不可用') && broken.text.includes('原生模块加载失败(测试桩)'),
      );
      await page.close();
    }

    // ── Windows 线**只抢 ⌃⇧D**,不抢 ⌃S(源码级断言)──
    //
    // 2026-10-25 用户口径:「干脆直接把系统的抢了,我的软件优先级最高……
    // Ctrl 加 D 我发现在普通桌面它是退出软件的功能,那在使用这个的时候
    // 没必要退出吧,所以就给他压制住」+「你不要用ctrl+D了,直接ctrl+shift+D吧」。
    //
    // - **⌃⇧D** = 读剪贴板并键入 —— 我们抢的就是它(抢到手,别的软件就收不到);
    // - **⌃S** = 默认执行(回放)—— Windows 上那一屏**已经没有界面了**
    //   (ADR-0016),而 Ctrl+S 在别的软件里是「保存」⇒ **不抢**。
    //
    // 这条**只能在源码里查**:界面上看不出"系统里注册了哪些全局键"。
    {
      const libRs = fs.readFileSync(
        path.join(__dirname, '..', '..', 'tauri-app', 'src-tauri', 'src', 'lib.rs'),
        'utf8',
      );
      // 注册清单由 `global_shortcut_keys()` 决定 —— 它必须**只含 ⌃⇧D**。
      const keysFn = libRs.match(/pub fn global_shortcut_keys\(\)[^{]*\{([^{}]*)\}/);
      const keysBody = keysFn ? keysFn[1] : '';
      check('Tauri 的全局快捷键清单里**有** ⌃⇧D(要抢的就是它)',
        /SHORTCUT_PASTE/.test(keysBody),
        keysBody.trim() || '没找到 global_shortcut_keys()');
      check('Tauri 的全局快捷键清单里**没有** ⌃S(默认执行:Windows 那屏已撤,且 Ctrl+S 是「保存」)',
        !/SHORTCUT_DEFAULT_EXECUTE/.test(keysBody), keysBody.trim());
      // ⌃⇧D 的**值**必须是 `Control+Shift+D`:
      //   - 少了 Shift ⇒ 又变成 ⌃D(用户明令改掉的键,而且 ⌃D 在别的软件里
      //     是「退出」那一族);
      //   - 修饰键必须写在键**之前**(global-hotkey 0.8.0 的解析器要求,
      //     `Ctrl+Shift+D` 能解析,`Ctrl+D+Shift` 直接报错)。
      const pasteConst = libRs.match(/SHORTCUT_PASTE\s*:\s*&str\s*=\s*"([^"]+)"/);
      const pasteVal = pasteConst ? pasteConst[1] : '';
      check('Tauri 的 ⌃⇧D 常量值是 "Control+Shift+D"',
        pasteVal === 'Control+Shift+D', pasteVal || '没找到 SHORTCUT_PASTE 的值');
      check('Tauri 的 ⌃⇧D **没有**退回成 "Control+D"(用户明令改键)',
        pasteVal !== 'Control+D', pasteVal);
      // Control 按下/松开的轮询观察器**只为全局键的 latch 服务** ——
      // 抢了 ⌃⇧D 就必须开着(不然按住 Ctrl 连按会连着触发,剪贴板被键入好几遍)。
      // (查的是**开关常量**,不是"调用点消失":调用点还在,被这个开关挡着。)
      const observerOn = /HOTKEY_OBSERVER_ENABLED:\s*bool\s*=\s*true/.test(libRs);
      check('Control 轮询观察器是开的(⌃⇧D 的 latch 需要它)',
        observerOn,
        observerOn ? 'HOTKEY_OBSERVER_ENABLED = true' : '没找到 HOTKEY_OBSERVER_ENABLED = true');
      // 「抢没抢到」要能被界面读到 ⇒ 原生状态里必须有这一栏。
      const appRs = fs.readFileSync(
        path.join(__dirname, '..', '..', 'tauri-app', 'src-tauri', 'src', 'commands', 'app.rs'),
        'utf8',
      );
      check('原生状态里有「shortcutPasteRegistered」这一栏(界面靠它显示提示)',
        /"shortcutPasteRegistered"/.test(appRs));
      // 诊断(diag.json)的 `globalShortcutsEnabled` 在 Windows 上**必须是 true** ——
      // 上一版还写着 false(那是「一个全局键都不占」那版留下的),
      // 会让排查的人以为「按政策不注册」,而我们其实**抢了 ⌃D**。
      check('诊断里 globalShortcutsEnabled 不是 false(Windows 现在有全局键)',
        !/global_shortcuts_enabled\s*=\s*false/.test(libRs),
        /global_shortcuts_enabled\s*=\s*(true|false)/.exec(libRs)
          ? /global_shortcuts_enabled\s*=\s*(true|false)/.exec(libRs)[0] : '没找到 global_shortcuts_enabled');
    }

    // ── 最后一页必须有**「浏览器复制修复」开关**(Windows 线)──
    //
    // 2026-10-25 用户原话:「Windows上我要和Mac一样的工作方式,
    // 你别搞什么这种搞扩展这么复杂的操作,越简单越好,你为什么不照搬,还搞这么特殊的」
    //
    // ⇒ 上一版给的**说明块**(让用户自己去 chrome://extensions「加载已解压的扩展程序」)
    //   作废:现在是**和 mac 同一个位置、同一个组件**的开关
    //   (桌面程序自己把扩展注册进浏览器 ⇒ 用户不用碰扩展本身)。
    {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(stub('win32', false, {
        ok: true, platform: 'win32', shortcutPasteRegistered: true,
      }, [{
        id: 'chromium-repair',
        title: '浏览器复制修复',
        description: '把被网页字体混淆的文字还原成你看到的那句话',
        prefix: 'chromiumRepair',
      }]));
      await page.goto(base, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 600));
      await gotoStep(page, 1);
      const last = await probe(page);
      check('Windows 最后一页有「浏览器复制修复」开关',
        last.text.includes('浏览器复制修复'),
        last.text.includes('浏览器复制修复') ? '' : last.text.slice(0, 200));
      check('它是**真开关**(有「开启/关闭」按钮,不是一段说明书)',
        /开启|关闭/.test(last.text), '');
      // 说明书那一套必须**没有**了 —— 用户原话否掉的就是它。
      check('Windows 最后一页**没有**「自己去装扩展」那套说明书',
        !last.text.includes('chrome://extensions')
        && !last.text.includes('开发者模式')
        && !last.text.includes('加载已解压')
        && !last.text.includes('browser-extension'), '');
      // **不该**出现 mac 的「Safari 复制修复」开关(Windows 上没有 Safari)。
      check('Windows 最后一页**没有** mac 的「Safari 复制修复」开关',
        !last.text.includes('Safari 复制修复'), '');
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed === 0 ? '\n✔ 界面裁剪自检全部通过' : `\n✖ ${failed} 项不通过`);
  process.exit(failed === 0 ? 0 : 1);
})();
