/**
 * 门禁：右上角「最小化 / 叉叉」两个按钮**点得动**，而且那一栏的说明**足够短**。
 *
 * ## 为什么要有这道门禁（2026-10-27 用户真机反馈）
 *
 * 用户原话：「右上角的缩小，最小化按钮，以及关闭按钮，完全就无法生效，
 * 然后打开浏览器这一栏界面说明太详细了，看起来乱七八糟的，不够简短」。
 *
 * ### 根因（Electron 线真机取证，根因同源）
 *
 * 1. **按钮点不动**：根容器是 `data-tauri-drag-region="deep"`（整窗都是拖拽区），
 *    而 Tauri 判定「这次 mousedown 要不要拖窗口」时，是从**被点到的元素**往上找
 *    **最近一个**带 `data-tauri-drag-region` 的祖先 ⇒ 找到根容器（"deep"）
 *    ⇒ 判定成「拖窗口」⇒ **点击根本不会触发按钮**。
 *    只有在那一层显式写 `data-tauri-drag-region="false"`，`closest()` 才会先命中它。
 *
 *    另外「步骤圈 + 进度线」那一行的矩形横跨整张卡片、右上角正好压在窗口按钮上
 *    ⇒ 那一块也会被当成拖窗口。
 *
 * 2. **说明太长**：`description` + `hint` + 「浏览器已关闭」三段大字叠在一起
 *    ⇒ 那一栏变成密密麻麻的一大块 ⇒ 用户看着乱。
 *
 * ## 断言
 *
 *   ① 右上角按钮容器**必须**写 `data-tauri-drag-region="false"`。
 *   ② 内容区**必须**写 `data-tauri-drag-region="false"`（否则里面的开关点不动）。
 *   ③ 「步骤圈那一行」**不能**是拖拽区。
 *   ④ 两个按钮**必须**真的调 minimize / quit。
 *   ⑤ 三句文案**必须有长度上限**（防止以后又被写长）。
 *
 * 跑法：
 *   node --test tools/verify/verify-window-buttons.cjs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const STEPPER = read('src', 'components', 'Stepper.jsx');
const APP_JSX = read('src', 'App.jsx');
const TOGGLES = read('src', 'panels', 'FeatureToggles.jsx');
const APP_RS = read('tauri-app', 'src-tauri', 'src', 'commands', 'app.rs');
const REPAIR_RS = read('tauri-app', 'src-tauri', 'src', 'chromium', 'repair.rs');

test('右上角按钮容器**必须**写 data-tauri-drag-region="false"', () => {
  const corner = /<div className="app-nodrag absolute top-3 right-3 z-20"([^>]*)>/.exec(STEPPER);
  assert.ok(corner, 'Stepper.jsx 里找不到右上角按钮的容器（app-nodrag absolute top-3 right-3）');
  assert.ok(/data-tauri-drag-region="false"/.test(corner[1]),
    '右上角按钮容器必须写 data-tauri-drag-region="false"，否则 mousedown 会被当成「拖窗口」⇒ 按钮点不动');
});

test('内容区**必须**写 data-tauri-drag-region="false"（否则里面的开关点不动）', () => {
  // ⚠️ **必须看 StepContentWrapper 内部那个 motion.div**。
  //    这个组件**不透传**多余 props ⇒ 属性写在 `<StepContentWrapper ...>` 上
  //    是**没用**的（2026-10-27 真机踩过：装包后读 DOM，内容区那层没有这个属性
  //    ⇒ 开关依然点不动）。
  const wrapper = /function StepContentWrapper\([\s\S]*?\r?\n\}\r?\n/.exec(STEPPER);
  assert.ok(wrapper, 'Stepper.jsx 里找不到 StepContentWrapper 的定义');
  assert.ok(/data-tauri-drag-region="false"/.test(wrapper[0]),
    'StepContentWrapper 内部的 motion.div 上必须有 data-tauri-drag-region="false"，' +
    '否则内容区里的「开启 / 关闭」「输入框」在 Tauri 里点了没反应');
});

test('「步骤圈那一行」**不能**是拖拽区（它的矩形盖住右上角按钮）', () => {
  const row = /className=\{`\$\{stepContainerClassName\}([^`]*)`\}/.exec(STEPPER);
  assert.ok(row, 'Stepper.jsx 里找不到「步骤圈那一行」的 className');
  assert.ok(!row[1].includes('app-drag'),
    `步骤圈那一行又是拖拽区了（${row[1].trim()}）⇒ 它的矩形盖住右上角按钮`);
  const before = STEPPER.slice(Math.max(0, STEPPER.indexOf(row[0]) - 400), STEPPER.indexOf(row[0]));
  assert.ok(!/data-tauri-drag-region="deep"/.test(before),
    '步骤圈那一行又是 Tauri 拖拽区了 ⇒ 会盖住右上角按钮');
});

test('两个按钮真的调 minimize / quit', () => {
  assert.ok(/cnc\.minimize\?\.\(\)/.test(APP_JSX), '最小化按钮没有调 cnc.minimize()');
  assert.ok(/cnc\.quit\?\.\(\)/.test(APP_JSX), '叉叉按钮没有调 cnc.quit()');
});

test('那一栏的文案**必须短**（2026-10-27 用户口径）', () => {
  // 只查 **Windows 那一栏**（chromium-repair）；
  // safari-repair 那条是 macOS 的界面文案，**不许**在这里改。
  const winBlock = /cfg!\(target_os = "windows"\)\s*\{[\s\S]*?"description":\s*"([^"]+)"/.exec(APP_RS);
  assert.ok(winBlock, 'commands/app.rs 里找不到 Windows 分支的 chromium-repair description');
  assert.ok(winBlock[1].length <= 16,
    `功能说明太长（${winBlock[1].length} 字）：「${winBlock[1]}」⇒ 界面上看着乱，改到 16 字以内`);

  const hint = /pub const HINT_ON:\s*&str\s*=\s*"([^"]+)"/.exec(REPAIR_RS);
  assert.ok(hint, 'chromium/repair.rs 里找不到 HINT_ON');
  assert.ok(hint[1].length <= 24,
    `提示太长（${hint[1].length} 字）：「${hint[1]}」⇒ 界面上看着乱，改到 24 字以内`);

  const closed = /<span>([^<]*浏览器已关闭[^<]*)<\/span>/.exec(TOGGLES);
  assert.ok(closed, 'FeatureToggles.jsx 里找不到「浏览器已关闭」那一行');
  assert.ok(closed[1].length <= 20,
    `「浏览器已关闭」那一行太长（${closed[1].length} 字）：「${closed[1]}」`);
});
