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

const EXTENSION = resolve(ROOT, 'dist/chromium');
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
    await document.fonts.ready;
  });
  await sleep(300);
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
    `字体混淆还原失败，实际=${JSON.stringify(text)}`,
  );
  const stats = await extensionStats(page);
  assert.ok(stats && stats.repairs >= 1, '扩展应记录到一次修复');
});

test('测试 D：同族字体换文件后缓存自动失效', async () => {
  await openFixture('d-dynamic-font.html');
  await selectElement(page, '#target');
  await sleep(1000);
  const first = await copyAndRead(page, client);
  assert.equal(first.trim(), EXPECT.obfuscatedDisplay, '第一次复制应还原为字体 A 的可见文字');

  await page.evaluate(() => window.swapFont());
  await sleep(600);
  await selectElement(page, '#target');
  await sleep(1200);
  const second = await copyAndRead(page, client);
  assert.notEqual(second.trim(), first.trim(), '换字体后结果不应沿用旧缓存');
  assert.ok(
    !second.includes(EXPECT.obfuscatedUnderlying.slice(0, 4)),
    `换字体后仍应还原，而不是输出底层字符，实际=${JSON.stringify(second)}`,
  );
});

test('测试 E：混合字体选区逐段还原，正常文字不被破坏', async () => {
  await openFixture('e-mixed-font.html');
  await selectElement(page, '#mixed');
  await sleep(1000);
  const text = await copyAndRead(page, client);
  const expected =
    '正常开头文字，人工智能中间正常文字，宋体作用域文字正在改变结尾正常文字。';
  assert.equal(text.trim(), expected, `混合字体还原失败，实际=${JSON.stringify(text)}`);
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
