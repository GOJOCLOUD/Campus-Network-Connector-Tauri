/**
 * Windows 打包产物自检 —— 防止再打出"装上但功能是坏的"的包。
 *
 * Windows 侧最要命的一个坑(见 ADR-0003,macOS 上先踩过一遍):
 *   原生模块(.node)被塞进 app.asar → Electron 无法 dlopen → require 直接抛错。
 * 而旧版 Windows 分支的 main.js 是**顶层无条件 require** 原生模块,
 * 于是这个错误直接把主进程带崩 —— App 根本起不来,用户看到的就是"用不了"。
 *
 * 检查项:
 *   1. win-input.node 在 app.asar.unpacked 里(不在 asar 里)
 *   2. 它能真正被加载并导出预期方法
 *   3. asar 内含运行必需文件(main.js / preload.js / dist / win-input/index.js)
 *   4. asar 内**不含** macOS 专属的东西(原生模块、参考库、算法源码、Tauri)
 *
 *   node tools/verify/verify-package-win.cjs [appDir]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 查找顺序:命令行参数 → 本地构建产物(win-unpacked / win-x64-unpacked / win-arm64-unpacked ...)。
const APP_CANDIDATES = [
  process.argv[2],
  ...(() => {
    const releaseDir = path.join(__dirname, '..', '..', 'release');
    if (!fs.existsSync(releaseDir)) return [];
    return fs.readdirSync(releaseDir)
      .filter((d) => /^win.*-unpacked$/.test(d))
      .map((d) => path.join(releaseDir, d));
  })(),
].filter(Boolean);
const APP = APP_CANDIDATES.find((p) => fs.existsSync(p)) || path.resolve(APP_CANDIDATES[0]);
const ASAR = path.join(APP, 'resources', 'app.asar');
const UNPACKED = path.join(APP, 'resources', 'app.asar.unpacked');

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

console.log(`检查安装包: ${APP}\n`);

if (!fs.existsSync(ASAR)) {
  console.error('✖ 找不到 app.asar,先构建:');
  console.error('  npm run build && npm run build:win-native && npx electron-builder --win --x64');
  process.exit(1);
}

// ① 原生模块必须解包(在 asar 里 = 装上必然起不来)
const nodePath = path.join(UNPACKED, 'win-input', 'build', 'Release', 'win-input.node');
check('原生模块已解包到 app.asar.unpacked', fs.existsSync(nodePath),
  fs.existsSync(nodePath) ? '' : '(在 asar 里的话 Electron 无法 dlopen → 整个 App 起不来)');

// ② 原生模块能真正加载,并导出预期方法
if (fs.existsSync(nodePath)) {
  try {
    const binding = require(nodePath);
    const need = ['mouseClick', 'sendText', 'sendKey', 'getCurrentInputSource'];
    const missing = need.filter((k) => typeof binding[k] !== 'function');
    check('原生模块可加载且导出预期方法', missing.length === 0,
      missing.length ? '缺少: ' + missing.join(',') : `(${Object.keys(binding).length} 个方法)`);
  } catch (e) {
    check('原生模块可加载', false, e.message);
  }
}

// ③ asar 内容
/**
 * 读 asar 里的文件清单。
 * 优先用 @electron/asar 的 API(跨平台、纯 JS);
 * 兜底走命令行时**必须用 npx.cmd** —— Windows 上 npx 是 npx.cmd,
 * 直接 spawn 'npx' 会 ENOENT(踩过:清单读不到 → 一堆检查假失败)。
 */
function listAsar(asarPath) {
  try {
    const asar = require('@electron/asar');
    if (typeof asar.listPackage === 'function') {
      return asar.listPackage(asarPath).map((p) => String(p).replace(/\\/g, '/'));
    }
  } catch (_) { /* 走命令行兜底 */ }
  const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  try {
    return execFileSync(cli, ['asar', 'list', asarPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.log('  (无法读取 asar 列表:', e.message + ')');
    return null;
  }
}

const asarList = listAsar(ASAR);
if (asarList === null) {
  // 读不到清单 → 下面的"含/不含"判断全都失去意义,必须当作失败
  check('能读取 asar 清单', false, '清单读不到 → 内容检查无法进行');
} else {
  const needFiles = [
    '/main.js',
    '/preload.js',
    '/win-input/index.js',
    '/src/features/index.js',
  ];
  for (const f of needFiles) {
    check(`asar 内含 ${f}`, asarList.includes(f));
  }
  check('asar 内含前端产物', asarList.some((f) => f.startsWith('/dist/') && f.endsWith('index.html')));

  // ④ Windows 包里**不该有** macOS 的东西
  check('asar 内不含 macOS 原生模块', !asarList.some((f) => f.startsWith('/mac-coregraphics/')));
  check('asar 内不含参考库 vendor/', !asarList.some((f) => f.startsWith('/vendor/')));
  check('asar 内不含 Safari 修复模块', !asarList.some((f) => f.startsWith('/src/features/safari-repair/')));
  check('asar 内不含算法源码 packages/', !asarList.some((f) => f.startsWith('/packages/')));
  check('asar 内不含浏览器扩展 apps/', !asarList.some((f) => f.startsWith('/apps/')));
  check('asar 内不含 Tauri 源码', !asarList.some((f) => f.startsWith('/tauri-app/')));
  check('asar 内不含文档系统', !asarList.some((f) => f.startsWith('/docs/')));
  check('asar 内不含开发脚本', !asarList.some((f) => f.startsWith('/tools/')));
  check('asar 内不含功能自测目录', !asarList.some((f) => f.startsWith('/src/features/') && f.includes('/test/')));
}

console.log(failed === 0 ? '\n✔ 打包产物自检全部通过' : `\n✖ ${failed} 项不通过`);
process.exit(failed === 0 ? 0 : 1);
