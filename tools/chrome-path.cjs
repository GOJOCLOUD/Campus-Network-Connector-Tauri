/**
 * 找到 puppeteer 要用的 Chrome —— **跨平台**。
 *
 * ## 为什么要有这个文件
 *
 * 以前这段逻辑**被复制在 8 个地方**(两个仓库 × 多个测试文件),改一处忘另一处
 * 就会漂移。2026-10-24 Windows CI 第一次跑这些界面用例时就是这么红的:
 * 那段代码只认 `process.env.HOME`,而 **Windows 上没有 `HOME`**
 * (只有 `USERPROFILE` / `LOCALAPPDATA`)⇒ 拼出来是个**相对路径**
 * `.cache/puppeteer` ⇒ 断言「找不到 Chrome」⇒ 门禁变红 ——
 * 而**门禁本身没毛病**,是它找不到浏览器。
 *
 * ⇒ 抽成**唯一入口**:所有测试脚本都 `require` 这个文件,不再各写一份。
 *
 * ## 查找顺序
 *
 * 1. `PUPPETEER_EXECUTABLE_PATH`(环境变量,最高优先级);
 * 2. `puppeteer.executablePath()` —— puppeteer 自己知道各平台的缓存目录;
 * 3. 手动扫各平台缓存目录(mac / Linux / Windows 各不相同);
 * 4. Windows 上兜底用系统自带的 Edge / Chrome(runner 上一般有)。
 */
const fs = require('fs');
const path = require('path');

/** 从候选列表里取第一个真实存在的路径。 */
function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}

/** puppeteer 的 Chrome 可执行文件路径;找不到返回 undefined。 */
function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  // 2) puppeteer 自己知道缓存目录(各平台不同)
  try {
    const p = require('puppeteer').executablePath();
    // puppeteer 各版本返回的可能是 string,也可能是 URL 或带 filePath 的对象
    const asPath = typeof p === 'string' ? p : (p && p.filePath) ? p.filePath : '';
    if (asPath && fs.existsSync(asPath)) return asPath;
  } catch (_) {
    // 没装 / 没下载 ⇒ 走下面的手动找
  }

  // 3) 手动扫缓存目录
  //    ⚠️ Windows 上**没有 `HOME`**,只有 `USERPROFILE` / `LOCALAPPDATA` ——
  //    只认 HOME 就会拼出相对路径,永远找不到(2026-10-24 的 Windows CI 就是这么红的)。
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const roots = [
    path.join(home, '.cache', 'puppeteer'),
    path.join(home, 'Library', 'Caches', 'puppeteer'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'puppeteer') : null,
    process.env.PUPPETEER_CACHE_DIR || null,
  ].filter(Boolean);

  const names = ['Google Chrome for Testing', 'chrome-headless-shell', 'Chromium', 'chrome', 'msedge'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
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

  // 4) Windows:系统自带浏览器(runner 上一般有 Edge)
  if (process.platform === 'win32') {
    const sys = firstExisting([
      process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : null,
      process.env['ProgramFiles']
        ? path.join(process.env['ProgramFiles'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        : null,
      process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
      process.env['ProgramFiles']
        ? path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
    ]);
    if (sys) return sys;
  }

  return undefined;
}

module.exports = { resolveExecutablePath };
