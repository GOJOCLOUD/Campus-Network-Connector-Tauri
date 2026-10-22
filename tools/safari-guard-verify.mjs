/**
 * Safari 页面内守卫验证：复制劫持矩阵。
 *
 * 回答任务书实验 3 的核心问题：
 *   页面内(window 捕获阶段 + 原型 patch)的守卫，能不能压过网页的复制劫持？
 *
 * 浏览器卫生：只在**前台窗口末尾加一个**临时标签，结束立刻删掉。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { startServer } from '../tests/e2e/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const GUARD_PATH = resolve(root, 'dist-core/page-guard/page-guard.js');
const MARK = '127.0.0.1';

// 模拟 App 侧匹配下发的映射：底层字符 → 可见字符
const MAPPING = { 天: '人', 地: '工', 玄: '智', 黄: '能', 宇: '正', 宙: '在', 洪: '改', 荒: '变', 日: '世', 月: '界', 盈: '科', 昃: '技' };
const EXPECTED = '人工智能正在改变世界科技';

const MODES = [
  { mode: 'none', expect: EXPECTED, note: '无劫持（基线）' },
  { mode: 'win-capture-setdata', expect: EXPECTED, note: '网页在 window 捕获阶段 setData（先注册）' },
  { mode: 'win-capture-prevent', expect: EXPECTED, note: '网页在 window 捕获阶段 preventDefault' },
  { mode: 'doc-capture-setdata', expect: EXPECTED, note: '网页在 document 捕获阶段 setData' },
  { mode: 'doc-bubble-setdata', expect: EXPECTED, note: '网页在 document 冒泡阶段 setData' },
  { mode: 'doc-bubble-stopimmediate', expect: EXPECTED, note: '网页 stopImmediatePropagation' },
  { mode: 'cached-native', expect: EXPECTED, note: '网页缓存原生方法（原型 patch 失效场景）' },
];

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' });
}

/**
 * 在指定标签页执行 JS。
 * JS 走临时文件 + AppleScript 读取，避免中文与引号的转义地狱。
 */
let tmpSeq = 0;
/**
 * 把 JS 源码里的非 ASCII 字符转成 \uXXXX 转义。
 * 这台机器的系统区域设置是中文/GBK，AppleScript 读文件时会按本地编码解码，
 * 中文直接传过去会变成乱码（"人" → "浜�"）。统一 ASCII 化即可绕开。
 */
function toAsciiJs(source) {
  return source.replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function runJs(tabIndex, js) {
  const tmp = `/tmp/cr-verify-${process.pid}-${tmpSeq++}.js`;
  writeFileSync(tmp, toAsciiJs(js), 'utf8');
  try {
    return osa(`tell application "Safari"
      set jsCode to (read POSIX file "${tmp}") as «class utf8»
      do JavaScript jsCode in tab ${tabIndex} of front window
    end tell`).trim();
  } finally {
    rmSync(tmp, { force: true });
  }
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

async function main() {
  const site = await startServer(root);
  const guardSource = readFileSync(GUARD_PATH, 'utf8');
  const guardPath = GUARD_PATH.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const tabsBefore = Number(osa('tell application "Safari" to return count of tabs of front window').trim());
  let tabIndex = 0;
  const results = [];

  const openFixture = (mode) => {
    if (tabIndex === 0) {
      tabIndex = tabsBefore + 1;
      osa(`tell application "Safari"
        activate
        make new tab with properties {URL:"about:blank"} at end of tabs of front window
      end tell`);
    }
    osa(
      `tell application "Safari" to set URL of tab ${tabIndex} of front window to "${site.origin}/tests/fixtures/h-tamper-matrix.html?mode=${mode}"`,
    );
  };

  try {
    for (const item of MODES) {
      openFixture(item.mode);
      await new Promise((r) => setTimeout(r, 1200));

      // 1) 注入守卫（模拟 App 通过 Apple Events 注入）
      osa(`tell application "Safari"
        set jsCode to (read POSIX file "${guardPath}") as «class utf8»
        do JavaScript jsCode in tab ${tabIndex} of front window
      end tell`);

      // 2) App 侧下发映射
      const mappingJson = JSON.stringify(MAPPING);
      const mapResult = runJs(
        tabIndex,
        `(function(){
          var g = window.__copyRepairGuard;
          if (!g) return 'NO-GUARD';
          g.mapping = ${mappingJson};
          return 'OK';
        })()`,
      );
      if (mapResult !== 'OK') console.log(`   [警告] 守卫未就绪: ${mapResult}`);
      const mapState = runJs(
        tabIndex,
        `(function(){
          var g = window.__copyRepairGuard;
          if (!g) return 'NO-GUARD';
          return JSON.stringify({keys: Object.keys(g.mapping).length, tian: g.mapping['天'], guardExists: true});
        })()`,
      );
      console.log(`   [映射状态] ${mapState}`);

      // 3) 选中并触发复制
      runJs(
        tabIndex,
        `(function(){
          var el = document.getElementById('target');
          var r = document.createRange();
          r.selectNodeContents(el);
          var s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
          return 'sel:' + s.toString().length;
        })()`,
      );
      await new Promise((r) => setTimeout(r, 300));

      setClipboard('SENTINEL');
      runJs(tabIndex, `document.execCommand('copy'); 'copied';`);
      await new Promise((r) => setTimeout(r, 500));

      const actual = clipboard();
      const log = runJs(
        tabIndex,
        `(function(){
          var g = window.__copyRepairGuard;
          var hijack = window.__hijackLog || [];
          return JSON.stringify({
            mapKeys: g ? Object.keys(g.mapping).length : null,
            hijack: hijack,
            guard: g ? g.log.map(function(e){return e.event;}) : null,
            repairs: g ? g.repairs : null
          });
        })()`,
      );

      const ok = actual === item.expect;
      results.push({ ...item, ok, actual, log });
      console.log(`${ok ? '✔' : '✖'} ${item.mode.padEnd(24)} ${item.note}`);
      console.log(`   剪贴板=${JSON.stringify(actual.slice(0, 24))} 期望=${JSON.stringify(item.expect.slice(0, 24))}`);
      console.log(`   事件=${log}`);
    }
  } finally {
    if (tabIndex) {
      osa(`tell application "Safari"
        try
          close tab ${tabIndex} of front window
        end try
      end tell`);
    }
    await site.close();
    const tabsAfter = Number(osa('tell application "Safari" to return count of tabs of front window').trim());
    console.log(`\n[测试] 标签数 ${tabsBefore} → ${tabsAfter}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
