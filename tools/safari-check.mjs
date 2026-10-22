/**
 * Safari 端到端检查：用 AppleScript 驱动 Safari 打开测试页、选中文字、触发复制，
 * 再用 osascript 读取系统剪贴板核对结果。
 *
 * 用法：node tools/safari-check.mjs [fixture] [selector]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { startServer } from '../tests/e2e/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' });
}

function clipboard() {
  try {
    return execFileSync('osascript', ['-e', 'the clipboard as text'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

async function main() {
  const fixture = process.argv[2] || 'c-font-obfuscation.html';
  const selector = process.argv[3] || '#target';
  const site = await startServer(root);
  const url = `${site.origin}/tests/fixtures/${fixture}`;
  console.log('[safari] 打开', url);

  osa(`tell application "Safari"
    activate
    make new document with properties {URL:"${url}"}
  end tell`);
  await new Promise((r) => setTimeout(r, 2500));

  const selectScript = `tell application "Safari" to do JavaScript "
    (function(){
      var el = document.querySelector('${selector}');
      if (!el) return 'NO-EL';
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return 'SELECTED';
    })()
  " in tab (count of tabs of window 1) of window 1`;
  console.log('[safari] 选区:', osa(selectScript).trim());

  // 等待扩展完成选区分析（防抖 + 后台匹配）
  await new Promise((r) => setTimeout(r, 2000));

  const statsScript = `tell application "Safari" to do JavaScript "
    document.documentElement.getAttribute('data-copy-repair') || 'NO-STATS'
  " in tab (count of tabs of window 1) of window 1`;
  const stats = osa(statsScript).trim();
  console.log('[safari] 扩展状态:', stats);

  const copyScript = `tell application "Safari" to do JavaScript "
    (function(){
      try { return 'EXEC=' + document.execCommand('copy'); }
      catch (e) { return 'ERR=' + e; }
    })()
  " in tab (count of tabs of window 1) of window 1`;
  console.log('[safari] 复制:', osa(copyScript).trim());
  await new Promise((r) => setTimeout(r, 800));

  const text = clipboard();
  console.log('[safari] 系统剪贴板:', JSON.stringify(text));

  const pageState = osa(`tell application "Safari" to do JavaScript "
    JSON.stringify({url:location.href, ready:document.readyState, title:document.title, len:(document.body&&document.body.innerHTML||'').length})
  " in tab (count of tabs of window 1) of window 1`).trim();
  console.log('[safari] 页面状态:', pageState);

  const visible = osa(
    `tell application "Safari" to do JavaScript "document.querySelector('${selector}').textContent" in tab (count of tabs of window 1) of window 1`,
  ).trim();
  console.log('[safari] 页面 DOM 文本:', JSON.stringify(visible));

  await site.close();
}

main();
