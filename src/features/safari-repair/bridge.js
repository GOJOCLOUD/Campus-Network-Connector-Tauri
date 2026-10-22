/**
 * Safari 自动化桥：通过 Apple Events 控制 Safari、执行页面 JavaScript。
 *
 * 四个必须遵守的坑（都是本机实测踩出来的）：
 *  1. AppleScript 读文件按**系统本地编码**解码（中文区域设置 = GBK），
 *     注入的 JS 里的中文会变乱码 → 注入内容一律 ASCII 化（非 ASCII 转 \uXXXX）。
 *  2. JS 不要内联进 AppleScript 字符串，多行 JS + 引号 + 换行极易出错
 *     → 一律走临时文件。
 *  3. **必须异步**：osascript 启动 + 执行要 50~150ms，同步调用会阻塞
 *     Electron 主进程，界面直接卡死（实测每秒 5 次同步调用 → 非常卡顿）。
 *  4. 返回值里的中文同样会被本地编码破坏 → 返回也做 ASCII 化。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpSeq = 0;

/** 把 JS 源码里的非 ASCII 字符转成 \uXXXX 转义（保证注入内容是纯 ASCII）。 */
function toAsciiJs(source) {
  // eslint-disable-next-line no-control-regex -- 非 ASCII 转义,控制字符范围是故意的
  return source.replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** 异步执行一段 AppleScript。 */
function osaAsync(script, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', script],
      { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.message = String(stderr || error.message).trim();
          reject(error);
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

/** 在目标位置执行一段 JS（走临时文件，避免 AppleScript 的引号/换行/编码问题）。 */
function runJsIn(target, js, { timeout = 5000 } = {}) {
  const file = path.join(os.tmpdir(), `cnc-sr-${process.pid}-${tmpSeq++}.js`);
  fs.writeFileSync(file, toAsciiJs(js), 'utf8');
  return osaAsync(
    `tell application "Safari"
      set jsCode to (read POSIX file "${file}") as «class utf8»
      do JavaScript jsCode in ${target}
    end tell`,
    { timeout },
  ).finally(() => {
    try {
      fs.unlinkSync(file);
    } catch (_) {
      /* ignore */
    }
  });
}

class SafariBridge {
  constructor({ log } = {}) {
    this.log = log || (() => {});
  }

  isRunning() {
    return osaAsync('tell application "System Events" to (name of processes) contains "Safari"', { timeout: 3000 })
      .then((out) => out === 'true')
      .catch(() => false);
  }

  isFrontmost() {
    return osaAsync(
      'tell application "System Events" to return (name of first application process whose frontmost is true)',
      { timeout: 3000 },
    )
      .then((out) => out === 'Safari')
      .catch(() => false);
  }

  frontTabURL() {
    return osaAsync('tell application "Safari" to return URL of front tab of front window', { timeout: 3000 })
      .then((url) => (url && url !== 'missing value' ? url : null))
      .catch(() => null);
  }

  evaluate(js, { timeout = 5000, tabIndex = null, windowIndex = null } = {}) {
    return runJsIn(this.target(tabIndex, windowIndex), js, { timeout });
  }

  /** 拼出 AppleScript 的目标位置（默认前台窗口的前台标签） */
  target(tabIndex = null, windowIndex = null) {
    const win = windowIndex ? `window ${windowIndex}` : 'front window';
    return tabIndex ? `tab ${tabIndex} of ${win}` : `front tab of ${win}`;
  }

  /**
   * 一轮状态采集：**一次 Apple Event 拿到全部信息**。
   * 返回 { guard, pending, frames, unrepaired, collect }
   */
  pollState({ tabIndex = null, windowIndex = null } = {}) {
    const target = this.target(tabIndex, windowIndex);
    const js = `(function(){
      var g = window.__copyRepairGuard;
      var out = {
        guard: !!g,
        pending: null,
        collect: 'none',
        frames: [],
        unrepaired: [],
        url: String(location.href || ''),
      };
      if (g) {
        if (window.__copyRepairCollect) {
          try { out.collect = String(window.__copyRepairCollect()); } catch (e) { out.collect = 'error'; }
        }
        if (g.pending && g.pending.groups && g.pending.groups.length > 0) {
          out.pending = { groups: g.pending.groups };
          g.pending = null;
        }
        if (window.__copyRepairBridge && typeof window.__copyRepairBridge.take === 'function') {
          try {
            var taken = window.__copyRepairBridge.take();
            out.frames = taken.pending || [];
            out.unrepaired = taken.unrepaired || [];
          } catch (e) { out.frames = []; out.unrepaired = []; }
        } else if (window.__copyRepairTakeUnrepaired) {
          try {
            var rawUnrepaired = window.__copyRepairTakeUnrepaired();
            out.unrepaired = rawUnrepaired ? [JSON.parse(rawUnrepaired)] : [];
          } catch (e) { out.unrepaired = []; }
        }
      }
      return JSON.stringify(out).replace(/[^\\x00-\\x7F]/g, function (c) {
        return '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      });
    })()`;
    return runJsIn(target, js, { timeout: 4000 })
      .then((raw) => {
        try {
          return JSON.parse(raw);
        } catch (_) {
          if (process.env.CR_DEBUG) {
            console.log('[pollState] 解析失败，长度=' + String(raw).length + ' 前200: ' + String(raw).slice(0, 200));
          }
          return { guard: false, pending: null, collect: 'parse-failed', frames: [], unrepaired: [] };
        }
      })
      .catch((error) => {
        if (process.env.CR_DEBUG) console.log('[pollState] 执行失败: ' + error.message);
        return { guard: false, pending: null, collect: 'evaluate-failed', frames: [], unrepaired: [] };
      });
  }

  /**
   * 列出所有窗口的所有标签：[{ window, index, url }]
   * 一次 Apple Event 拿全，App 据此按站点 URL 覆盖目标标签（不依赖前台标签）。
   */
  listTabs() {
    return osaAsync(
      `tell application "Safari"
        set out to ""
        repeat with wi from 1 to (count of windows)
          repeat with ti from 1 to (count of tabs of window wi)
            try
              set out to out & wi & "|" & ti & "|" & (URL of tab ti of window wi) & linefeed
            end try
          end repeat
        end repeat
        return out
      end tell`,
      { timeout: 5000 },
    )
      .then((raw) =>
        String(raw)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [w, t, ...rest] = line.split('|');
            return { window: Number(w), index: Number(t), url: rest.join('|') };
          })
          .filter((tab) => Number.isFinite(tab.window) && Number.isFinite(tab.index)),
      )
      .catch(() => []);
  }

  /** 在前台窗口里按 URL 前缀找标签页索引（找不到返回 -1）。 */
  findTabByUrl(prefix) {
    return osaAsync(
      `tell application "Safari"
        set out to -1
        repeat with ti from 1 to (count of tabs of front window)
          try
            if (URL of tab ti of front window) contains ${JSON.stringify(prefix)} then
              set out to ti
              exit repeat
            end if
          end try
        end repeat
        return out
      end tell`,
      { timeout: 3000 },
    )
      .then((v) => Number(v))
      .catch(() => -1);
  }

  /** 注入页面守卫脚本（幂等：页面内已有哨兵时不会重复安装）。 */
  injectGuard(guardSource, { tabIndex = null, windowIndex = null, frameBridgeSource = '' } = {}) {
    const combined = frameBridgeSource
      ? `${guardSource}\n;\n${frameBridgeSource}\n;\ntry { window.__copyRepairInstallFrameBridge({ guardSource: ${JSON.stringify(
          toAsciiJs(guardSource),
        )} }); } catch (e) { window.__copyRepairInjectError = String(e); }`
      : guardSource;
    const target = this.target(tabIndex, windowIndex);
    return runJsIn(target, combined, { timeout: 5000 });
  }

  /** 下发映射表（按作用域隔离，并分发到同源 iframe）。 */
  setMapping(scopeKey, mapping, { tabIndex = null, windowIndex = null } = {}) {
    const scopeJson = JSON.stringify(scopeKey);
    const mapJson = JSON.stringify(mapping);
    const target = this.target(tabIndex, windowIndex);
    const js = `(function(){
      var b = window.__copyRepairBridge;
      if (b && typeof b.setMapping === 'function') return 'FRAMES:' + b.setMapping(${scopeJson}, ${mapJson});
      var g = window.__copyRepairGuard;
      if (!g) return 'NO-GUARD';
      if (!window.__copyRepairSetMapping) return 'NO-API';
      return window.__copyRepairSetMapping(${scopeJson}, ${mapJson});
    })()`;
    return runJsIn(target, js, { timeout: 4000 }).catch(() => 'FAILED');
  }
}

module.exports = { SafariBridge, toAsciiJs, osaAsync };
