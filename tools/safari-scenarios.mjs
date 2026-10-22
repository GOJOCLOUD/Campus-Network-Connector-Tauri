/**
 * Safari 端到端场景测试（方案 B：AppleScript 热键工具路径）。
 *
 * 覆盖：
 *   A  普通页面      —— 剪贴板必须保持原样
 *   C  字体混淆      —— 剪贴板必须变成"可见文字"
 *   B  复制事件篡改  —— 剪贴板必须被恢复成"可见文字"
 *
 * 浏览器卫生：测试自建**一个**窗口，只在它内部导航，结束时按 URL 精确关掉；
 * 不触碰用户已有的任何窗口与标签。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { startServer } from '../tests/e2e/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MARK = '127.0.0.1';

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' });
}

function clipboard() {
  try {
    return osa('the clipboard as text').replace(/\n$/, '');
  } catch {
    return '';
  }
}

function setClipboard(text) {
  osa(`set the clipboard to ${JSON.stringify(text)}`);
}

function windowCount() {
  return Number(osa('tell application "Safari" to return count of windows').trim() || '0');
}

/** 在前台窗口末尾加**一个**测试标签，返回它的索引；用完删掉 */
async function openTestTab(url) {
  const before = Number(
    osa('tell application "Safari" to return count of tabs of front window').trim(),
  );
  osa(`tell application "Safari"
    activate
    make new tab with properties {URL:"${url}"} at end of tabs of front window
  end tell`);
  return before + 1;
}

function selectIn(tabIndex, selector, copyInPage) {
  const js = copyInPage
    ? `(function(){var el=document.querySelector(${JSON.stringify(selector)});var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('copy');return 'copied';})()`
    : `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'NO-EL';var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);return 'selected:'+s.toString().length;})()`;
  return osa(
    `tell application "Safari" to do JavaScript "${js.replace(/"/g, '\\"')}" in tab ${tabIndex} of front window`,
  ).trim();
}

function closeTestTab(tabIndex) {
  osa(`tell application "Safari"
    try
      close tab ${tabIndex} of front window
    end try
  end tell`);
}

function runRepair(extraArgs = []) {
  try {
    return execFileSync(
      process.execPath,
      [
        resolve(root, 'tools/safari-repair.mjs'),
        `--url-contains=${MARK}`,
        ...extraArgs,
      ],
      { encoding: 'utf8' },
    );
  } catch (error) {
    console.log('  [工具异常]', String(error.stdout ?? '').trim(), String(error.stderr ?? '').slice(0, 200));
    return '';
  }
}

async function main() {
  const site = await startServer(root);
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const windowsBefore = windowCount();
  const tabsBefore = Number(
    osa('tell application "Safari" to return count of tabs of front window').trim(),
  );
  let tab = 0;
  try {
    tab = await openTestTab(`${site.origin}/tests/fixtures/a-normal.html`);
    console.log(`[测试] 自建测试标签 index=${tab}（测试前：窗口 ${windowsBefore}，标签 ${tabsBefore}）`);

    // 场景 A：普通页面不得被改动
    await new Promise((r) => setTimeout(r, 1500));
    // 普通页面：先做一次真实复制，再跑工具，剪贴板应保持可见文字不变
    console.log('  [复制]', selectIn(tab, '#p1', true));
    await new Promise((r) => setTimeout(r, 400));
    const copied = clipboard();
    const outA = runRepair();
    const afterA = clipboard();
    check(
      '测试 A：普通网页的剪贴板保持原生复制结果',
      afterA.trim() === copied.trim() && afterA.includes('Hello, World!'),
      `复制后=${JSON.stringify(copied.slice(0, 24))} → 工具后=${JSON.stringify(afterA.slice(0, 24))}`,
    );

    // 场景 C：字体混淆还原
    osa(`tell application "Safari" to set URL of tab ${tab} of front window to "${site.origin}/tests/fixtures/c-font-obfuscation.html"`);
    await new Promise((r) => setTimeout(r, 1800));
    console.log('  [选中]', selectIn(tab, '#target', false));
    setClipboard('SENTINEL');
    const outC = runRepair();
    const afterC = clipboard();
    check('测试 C：字体混淆复制出可见文字', afterC === '人工智能正在改变世界科技', `剪贴板=${JSON.stringify(afterC)}｜工具:${outC.trim().split('\n').pop()}`);

    // 场景 B：网页篡改复制内容后被恢复
    osa(`tell application "Safari" to set URL of tab ${tab} of front window to "${site.origin}/tests/fixtures/b-tamper.html"`);
    await new Promise((r) => setTimeout(r, 1500));
    console.log('  [复制]', selectIn(tab, '#target', true));
    await new Promise((r) => setTimeout(r, 500));
    const tampered = clipboard();
    runRepair(['--restore']);
    const afterB = clipboard();
    check(
      '测试 B：网页篡改后剪贴板被恢复为可见文字',
      tampered.includes('TAMPERED') && afterB === '这段文字会被网页在 copy 事件里替换成乱码。',
      `篡改后=${JSON.stringify(tampered.slice(0, 26))} → 恢复后=${JSON.stringify(afterB.slice(0, 26))}`,
    );
  } finally {
    if (tab) closeTestTab(tab);
    await site.close();
    const after = windowCount();
    const tabsAfter = Number(
      osa('tell application "Safari" to return count of tabs of front window').trim(),
    );
    console.log(`[测试] 结束：窗口 ${windowsBefore} → ${after}，标签 ${tabsBefore} → ${tabsAfter}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
