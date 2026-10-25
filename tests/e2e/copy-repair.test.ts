/**
 * 端到端测试：Chromium 扩展的复制修复行为。
 *
 * 运行前需要先构建扩展：
 *   node tools/build.mjs chromium
 *   node --test tests/e2e/copy-repair.test.ts
 *
 * 说明：这些测试会打开一个真实的 Chrome 窗口并读写系统剪贴板，
 * 因为 headless 模式不会把 copy 事件里改写的 clipboardData 提交到系统剪贴板。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  startServer,
} from './server.mjs';
import {
  ROOT,
  launchWithExtension,
  selectElement,
  copyAndRead,
  extensionStats,
  sleep,
} from './harness.mjs';

// 扩展产物的目录 —— 与 `tools/build.mjs chromium` 的输出一致。
//
// ⚠️ 这里原来写的是 `dist/chromium`,而构建脚本输出到 **`dist-core/chromium`**
// (`dist/` 是 vite 的前端产物目录)⇒ 这条用例**从来没跑通过**,
// 于是「扩展到底能不能把密文还原成明文」一直没人验证过。
const EXTENSION = resolve(ROOT, 'dist-core/chromium');
const EXPECT = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/expectations.json'), 'utf8'));

let site;
let browser;
let page;
let client;

before(async () => {
  assert.ok(
    existsSync(resolve(EXTENSION, 'manifest.json')),
    '扩展未构建，请先执行 node tools/build.mjs chromium',
  );
  site = await startServer(ROOT);
  browser = await launchWithExtension(EXTENSION);
  page = await browser.newPage();
  client = await page.createCDPSession();
});

after(async () => {
  await browser?.close();
  await site?.close();
});

async function openFixture(name) {
  await page.goto(`${site.origin}/tests/fixtures/${name}`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    // 只等 `document.fonts.ready` **不够**：
    // 它可能在字体请求发出**之前**就 resolve ⇒ 那一刻 canvas 画出来的还是回退字体
    // ⇒ 扩展判定「没被混淆」⇒ 复制出来是密文。
    // （2026-10-25 在 CI 上实测到：测试 D 第一次复制没还原。）
    // 这里显式把页面用到的字体 load 出来并等它真的到位，让用例不再靠时序碰运气。
    const faces = Array.from(document.fonts);
    await Promise.all(
      faces.map((f) =>
        document.fonts.load(`${f.style} ${f.weight} 16px "${f.family}"`).catch(() => []),
      ),
    );
    await document.fonts.ready;
  });
  await sleep(300);
}

/** 扩展的运行统计（失败时打进断言消息，省得回头猜）。 */
async function statsText(): Promise<string> {
  const stats = await extensionStats(page);
  return stats ? JSON.stringify(stats) : '(页面里没有扩展统计)';
}

test('测试 A：普通网页的复制结果与原生一致', async () => {
  await openFixture('a-normal.html');
  await selectElement(page, '#p1');
  await sleep(800);
  const text = await copyAndRead(page, client);
  const expected = '人工智能正在改变世界。Hello, World! 2026 年 3 月 15 日，价格 1,234.56 元。';
  assert.equal(text.trim(), expected, '普通页面不应被改动');
});

test('测试 B：网页篡改 copy 事件时，复制结果不被篡改', async () => {
  await openFixture('b-tamper.html');
  await selectElement(page, '#target');
  await sleep(800);
  const text = await copyAndRead(page, client);
  const expected = '这段文字会被网页在 copy 事件里替换成乱码。';
  assert.ok(
    !text.includes('TAMPERED'),
    `剪贴板不应包含网页注入的垃圾内容，实际=${JSON.stringify(text)}`,
  );
  assert.equal(text.trim(), expected, '应保留原始可见文本');
});

test('测试 C：字体混淆页面复制出可见文字', async () => {
  await openFixture('c-font-obfuscation.html');
  await selectElement(page, '#target');
  await sleep(1000);
  const text = await copyAndRead(page, client);
  assert.equal(
    text.trim(),
    EXPECT.obfuscatedDisplay,
    `字体混淆还原失败，实际=${JSON.stringify(text)}，扩展统计=${await statsText()}`,
  );
  const stats = await extensionStats(page);
  assert.ok(stats && stats.repairs >= 1, '扩展应记录到一次修复');
});

test('测试 D：同族字体换文件后缓存自动失效', async () => {
  await openFixture('d-dynamic-font.html');
  await selectElement(page, '#target');
  await sleep(1000);
  const first = await copyAndRead(page, client);
  assert.equal(
    first.trim(),
    EXPECT.obfuscatedDisplay,
    `第一次复制应还原为字体 A 的可见文字，实际=${JSON.stringify(first)}，扩展统计=${await statsText()}`,
  );

  await page.evaluate(() => window.swapFont());
  await sleep(600);
  await selectElement(page, '#target');
  await sleep(1200);
  const second = await copyAndRead(page, client);
  assert.notEqual(second.trim(), first.trim(), '换字体后结果不应沿用旧缓存');
  assert.ok(
    !second.includes(EXPECT.obfuscatedUnderlying.slice(0, 4)),
    `换字体后仍应还原，而不是输出底层字符，实际=${JSON.stringify(second)}，扩展统计=${await statsText()}`,
  );
});

test('测试 G：网页字体晚到时，先不改字；字体到位后自动还原', async (t) => {
  // 夹具把 @font-face 规则延迟 2 秒才注入 ⇒ 字体「晚到」。
  // 覆盖的是真实场景：用户可能先选字，网页字体后到。
  await page.goto(`${site.origin}/tests/fixtures/g-late-font.html`, { waitUntil: 'load' });
  await selectElement(page, '#target');
  await sleep(500);

  // 字体还没到位：扩展**不能**改写复制内容（宁可不改，不可写错字）
  const before = await copyAndRead(page, client);
  assert.equal(
    before.trim(),
    EXPECT.obfuscatedUnderlying,
    `字体没到位时不应改动复制内容，实际=${JSON.stringify(before)}，扩展统计=${await statsText()}`,
  );

  // 等扩展自己发现字体到位并重新分析 —— **不重新选区**，
  // 因为真实用户就是「选好字、字体加载完、再按复制」。
  await page.waitForFunction(
    () => {
      const raw = document.documentElement.getAttribute('data-copy-repair');
      if (!raw) return false;
      try {
        return JSON.parse(raw).obfuscatedScopes >= 1;
      } catch {
        return false;
      }
    },
    { timeout: 20000, polling: 200 },
  );

  const after = await copyAndRead(page, client);
  t.diagnostic(`测试 G 扩展统计：${await statsText()}`);
  assert.equal(
    after.trim(),
    EXPECT.obfuscatedDisplay,
    `字体到位后应还原为可见文字，实际=${JSON.stringify(after)}，扩展统计=${await statsText()}`,
  );
});

test('测试 E：混合字体选区逐段还原，正常文字不被破坏', async () => {
  await openFixture('e-mixed-font.html');
  await selectElement(page, '#mixed');
  await sleep(1000);
  const text = await copyAndRead(page, client);
  const expected =
    '正常开头文字，人工智能中间正常文字，宋体作用域文字正在改变结尾正常文字。';
  assert.equal(
    text.trim(),
    expected,
    `混合字体还原失败，实际=${JSON.stringify(text)}，扩展统计=${await statsText()}`,
  );
});

test('测试 F：复杂 DOM 中隐藏内容不出现、混淆内容被还原', async () => {
  await openFixture('f-complex-dom.html');
  await sleep(600);
  await selectElement(page, '#card');
  await sleep(1200);
  const text = await copyAndRead(page, client);
  assert.ok(!text.includes('隐藏内容'), `隐藏内容不应进入复制结果：${JSON.stringify(text)}`);
  assert.ok(
    text.includes('人工智能正在'),
    `混淆部分应被还原，实际=${JSON.stringify(text)}`,
  );
  assert.ok(
    text.includes('外层开始'),
    `普通嵌套文本应保留，实际=${JSON.stringify(text)}`,
  );
});
