/**
 * 通用性测试：**不针对某一道题**，只检验"机制对不对"。
 *
 * 要害:同一个字符(例如「天」)同时出现在**两个不同的字体作用域**里 ——
 *   - 密文作用域:DOM 里是「天」,字体把它画成「人」
 *   - 普通作用域:DOM 里是「天」,字体画的就是「天」
 * 正确行为必须是**按出现位置**判定:
 *   密文那处 → 人;普通那处 → 天(一个字都不能错)
 *
 * 如果查表按"字符身份"做全局映射(同一个字只能对应一个作用域),
 * 那么普通那处会被一起改成「人」→ **复制出错字**。
 *
 *   node src/features/safari-repair/test/generality.cjs
 *
 * ⚠️ 会真实操作 Safari 标签页(临时加一个、用完删掉),必须串行运行。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { InjectorCoordinator } = require('../coordinator');

const FIXTURES = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json' };

/** 期望值：密文字按映射还原，普通文字一个字不动 */
const CASES = [
  { id: 's1-plain-first', expect: '天人', why: '普通在前 + 密文在后 → 普通保持「天」，密文还原成「人」' },
  { id: 's2-obf-first', expect: '人天', why: '密文在前 + 普通在后 → 密文还原成「人」，普通保持「天」' },
  { id: 's3-pure-obf', expect: '人工智能正在改变世界科技', why: '纯密文 → 全部还原' },
  { id: 's4-pure-plain', expect: '这是一段完全正常的普通文字，不应该被改动。', why: '纯普通文字 → 一个字都不动' },
  { id: 's5-mixed', expect: '人工智能普通文字正在改变', why: '密文与普通文字混在一段 → 各按各的作用域处理' },
  {
    id: 's6-two-fonts',
    expect: '人工智能工智能正',
    why: '同一个字在两种混淆字体里画成不同的字 → 必须按出现位置各查各的表',
  },
];

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, resp) => {
      const rel = decodeURIComponent((req.url || '').split('?')[0]);
      const file = path.join(FIXTURES, rel === '/' ? '/generality.html' : rel);
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
        resp.writeHead(404);
        resp.end('not found');
        return;
      }
      resp.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      resp.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' });
}
function clipboard() {
  try {
    return osa('the clipboard as text').replace(/\n$/, '');
  } catch (_) {
    return '';
  }
}
function setClipboard(text) {
  osa(`set the clipboard to ${JSON.stringify(text)}`);
}
function tabCount() {
  return Number(osa('tell application "Safari" to return count of tabs of front window').trim() || '0');
}

/** 在指定标签执行 JS */
function runJs(tabIndex, js) {
  const target = tabIndex ? `tab ${tabIndex} of front window` : 'front tab of front window';
  return osa(`tell application "Safari" to do JavaScript "${js}" in ${target}`).trim();
}

/** 选中某个 id 的内容并复制，返回复制后的剪贴板 */
function selectAndCopy(tabIndex, id) {
  setClipboard('SENTINEL');
  runJs(
    tabIndex,
    `(function(){
      var el = document.getElementById('${id}');
      if (!el) return 'NO-EL';
      var r = document.createRange();
      r.selectNodeContents(el);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.execCommand('copy');
      return 'copied:' + s.toString().length;
    })()`,
  );
  return new Promise((resolve) => setTimeout(() => resolve(clipboard()), 700));
}

async function main() {
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const log = (m) => console.log('  ·', m);

  const windowsBefore = Number(osa('tell application "Safari" to return count of windows').trim() || '0');
  const tabsBefore = windowsBefore > 0 ? tabCount() : 0;
  let createdWindow = false;
  let tabIndex = null;

  if (windowsBefore > 0) {
    osa(`tell application "Safari"
      activate
      make new tab with properties {URL:"${origin}/generality.html"} at end of tabs of front window
    end tell`);
    for (let i = 0; i < 20; i += 1) {
      const found = osa(`tell application "Safari"
        set out to ""
        repeat with ti from 1 to (count of tabs of front window)
          try
            if (URL of tab ti of front window) contains "127.0.0.1:${port}" then
              set out to out & (ti as text)
              exit repeat
            end if
          end try
        end repeat
        return out
      end tell`).trim();
      if (found) {
        tabIndex = Number(found);
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!tabIndex) throw new Error('找不到测试标签');
  } else {
    createdWindow = true;
    osa(`tell application "Safari"
      activate
      make new document with properties {URL:"${origin}/generality.html"}
    end tell`);
  }
  await new Promise((r) => setTimeout(r, 1200));

  const coordinator = new InjectorCoordinator({
    log,
    targetTabIndex: createdWindow ? null : tabIndex,
  });
  coordinator.setEnabled(true);

  let failed = 0;
  try {
    // 建好映射（预热即可，不需要选区）
    for (let i = 0; i < 4; i += 1) {
      await coordinator.tick();
      await new Promise((r) => setTimeout(r, 250));
    }

    console.log('\n通用性用例（按机制判定，不依赖具体题目）:\n');
    for (const c of CASES) {
      const actual = await selectAndCopy(tabIndex, c.id);
      const ok = actual === c.expect;
      if (!ok) failed += 1;
      console.log(`  ${ok ? '✔' : '✖'} ${c.id}`);
      console.log(`      期望 = ${JSON.stringify(c.expect)}`);
      console.log(`      实际 = ${JSON.stringify(actual)}`);
      console.log(`      ${c.why}`);
    }

    // 额外一条：把全部用例一次性选中（多作用域 + 同字符跨作用域同时出现）
    setClipboard('SENTINEL');
    runJs(
      tabIndex,
      `(function(){
        var r = document.createRange();
        r.selectNodeContents(document.body);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        document.execCommand('copy');
        return 'copied:' + s.toString().length;
      })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const all = clipboard();
    const expectAll = [
      '通用性测试页',
      '下面这些用例检验的是「机制」而不是某一道题：同一个字符同时出现在密文作用域与普通作用域、多个作用域混在一次选区里、纯普通文字不该被动。',
      '天人',
      '人天',
      '人工智能正在改变世界科技',
      '这是一段完全正常的普通文字，不应该被改动。',
      '人工智能普通文字正在改变',
      '人工智能工智能正',
    ].join('');
    const allOk = String(all).replace(/\s+/g, '') === expectAll.replace(/\s+/g, '');
    if (!allOk) failed += 1;
    console.log(`  ${allOk ? '✔' : '✖'} 整页一次选中（最难组合）`);
    console.log(`      实际 = ${JSON.stringify(String(all).slice(0, 160))}`);
    console.log('      （整页里「天」在两个作用域都出现，是最容易写错字的组合）');

    console.log(`\n${failed === 0 ? '✔ 通用性用例全部通过' : `✖ ${failed} 个用例未通过`}`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    coordinator.stop();
    if (createdWindow) {
      const toClose = osa(`tell application "Safari"
        set out to ""
        repeat with wi from 1 to (count of windows)
          try
            if (URL of tab 1 of window wi) contains "127.0.0.1" then
              set out to out & (wi as text) & ","
            end if
          end try
        end repeat
        return out
      end tell`).trim();
      if (toClose) {
        for (const wi of toClose.split(',').filter(Boolean).map(Number).sort((a, b) => b - a)) {
          osa(`tell application "Safari"
            try
              close window ${wi}
            end try
          end tell`);
        }
      }
    } else if (tabIndex) {
      osa(`tell application "Safari"
        try
          close tab ${tabIndex} of front window
        end try
      end tell`);
    }
    server.close();
    const windowsAfter = Number(osa('tell application "Safari" to return count of windows').trim() || '0');
    console.log(`\n[测试] 窗口数 ${windowsBefore} → ${windowsAfter}${windowsAfter === windowsBefore ? ' ✔' : ' ✖ 未清干净'}`);
  }
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
