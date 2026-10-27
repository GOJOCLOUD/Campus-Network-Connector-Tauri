/**
 * 门禁：两个 Windows 正式版本（Electron 版 / Tauri 版）必须**一眼能分清**。
 *
 * ## 为什么必须有这条门禁（2026-10-27 用户原话）
 *
 * > 「Electron版本和那个版本，你根本就没有区分，让我测试」
 *
 * 两个版本**界面一模一样、功能一模一样**，而窗口与托盘都是**自绘**的
 * （Windows 上没有原生标题栏：Electron 用 `frame:false`、Tauri 用 `hiddenTitle:true`）
 * ⇒ 光看窗口根本分不出自己在测哪一个。
 *
 * ## 检查项
 *
 *   ① `src/lib/build-info.js` 导出 BUILD_FLAVOR（且不为空）
 *   ② 界面**顶部**渲染了这个徽标（`App.jsx` 导入并渲染）
 *   ③ **托盘提示**里写的是同一个版本名
 *   ④ **窗口标题**里写的是同一个版本名
 *
 * ③④ 各自在 main.js / lib.rs / tauri.conf.json 里，任一处漏改 ⇒ 门禁红。
 *
 * 跑法：
 *   node --test tools/verify/verify-build-flavor.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const FLAVOR_FILE = path.join(ROOT, 'src', 'lib', 'build-info.js');
const APP_JSX = path.join(ROOT, 'src', 'App.jsx');

/** 这个仓是 Electron 版还是 Tauri 版（决定去哪儿找托盘/标题） */
const isTauri = fs.existsSync(path.join(ROOT, 'tauri-app', 'src-tauri', 'tauri.conf.json'));

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return '';
  }
}

test('版本徽标存在且不为空', () => {
  assert.ok(fs.existsSync(FLAVOR_FILE), '缺少 src/lib/build-info.js（两个 Windows 正式版本必须能分清）');
  const src = fs.readFileSync(FLAVOR_FILE, 'utf8');
  const m = /export const BUILD_FLAVOR\s*=\s*'([^']+)'/.exec(src);
  assert.ok(m, 'build-info.js 里没有 export const BUILD_FLAVOR = \'…\'');
  assert.ok(m[1].trim().length > 0, 'BUILD_FLAVOR 是空的');
  assert.ok(/Electron 版|Tauri 版/.test(m[1]),
    `BUILD_FLAVOR 应该是「Electron 版」或「Tauri 版」，实际是「${m[1]}」`);
});

test('界面顶部渲染了版本徽标', () => {
  const app = fs.readFileSync(APP_JSX, 'utf8');
  assert.ok(/import\s*\{\s*BUILD_FLAVOR\s*\}\s*from\s*'\.\/lib\/build-info'/.test(app),
    'App.jsx 没有导入 BUILD_FLAVOR');
  assert.ok(/\{BUILD_FLAVOR\}/.test(app), 'App.jsx 没有渲染 BUILD_FLAVOR');
  // 徽标要放在**顶部**（Windows 上没有原生标题栏，顶部那块空白是唯一的常驻位置）
  assert.ok(/absolute[^"]*left-3[^"]*top-2/.test(app) || /top-2[^"]*left-3/.test(app),
    '版本徽标不在窗口左上角（顶部那条空白带是唯一能常驻显示的地方）');
});

test('托盘提示与窗口标题写的是同一个版本', () => {
  const flavor = /export const BUILD_FLAVOR\s*=\s*'([^']+)'/.exec(
    fs.readFileSync(FLAVOR_FILE, 'utf8'),
  )[1];

  const tray = isTauri
    ? readIfExists(path.join(ROOT, 'tauri-app', 'src-tauri', 'src', 'lib.rs'))
    : readIfExists(path.join(ROOT, 'main.js'));
  assert.ok(tray.includes(`模拟输入（${flavor}）`),
    `托盘提示里没有「模拟输入（${flavor}）」`);

  const title = isTauri
    ? readIfExists(path.join(ROOT, 'tauri-app', 'src-tauri', 'tauri.conf.json'))
    : readIfExists(path.join(ROOT, 'main.js'));
  assert.ok(title.includes(`模拟输入（${flavor}）`),
    `窗口标题里没有「模拟输入（${flavor}）」`);
});

test('Electron 版还改了安装名/开始菜单名（跟 mac 线同名会分不清）', () => {
  if (isTauri) {
    // Tauri 的 productName 本来就带 -Tauri，不用额外要求
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(/Electron/.test(pkg.build.productName),
    `build.productName 应该带 Electron（现在「${pkg.build.productName}」跟 mac 线同名）`);
  assert.ok(/Electron/.test(pkg.build.nsis.shortcutName),
    `build.nsis.shortcutName 应该带 Electron（现在「${pkg.build.nsis.shortcutName}」）`);
});
