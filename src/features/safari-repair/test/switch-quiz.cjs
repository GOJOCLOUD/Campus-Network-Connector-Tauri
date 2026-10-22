/**
 * 换题回归测试：**换字体（=换题）后必须自动适配，且旧映射不能泄漏到新题**。
 *
 *   node src/features/safari-repair/test/switch-quiz.cjs
 *
 * 为什么必须有这条测试：
 *   用户每换一套题，站点就换一套加密字体。系统必须做到
 *     ① 自动发现新字体 → 自动建映射 → 自动下发（**不需要任何人工干预**）
 *     ② 旧题目的映射**不能**用到新题目上（否则会把字还原成上一套的答案 → 写出错字）
 *   夹具里两套字体**码位相同、画成不同的字**：
 *     A: 天→人 地→工 玄→智 …
 *     B: 天→工 地→智 玄→能 …
 *   所以一旦旧映射泄漏，测出来的答案会明确错掉（人 vs 工），不会有歧义。
 *
 * ⚠️ 会真实操作 Safari 标签页（临时加一个、用完删掉），必须串行运行。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { InjectorCoordinator } = require('../coordinator');
const { SafariBridge } = require('../bridge');

let bridge = null;

const FIXTURES = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json' };

/** 两套字体的明文答案（取自 fixtures/fonts/*.map.json） */
const TRUTH = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'fonts', 'obf-same-style.map.json'), 'utf8'),
);
const TRUTH_B = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'fonts', 'obf-second-style.map.json'), 'utf8'),
);
/** 夹具正文用到的字 */
const CIPHER_TEXT = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾';
const CIPHER_TEXT2 = '水火土金木禾米竹';
const EXPECT_A = [...CIPHER_TEXT].map((c) => TRUTH[c]).join('');
const EXPECT_B = [...CIPHER_TEXT].map((c) => TRUTH_B[c]).join('');
const EXPECT_A2 = [...CIPHER_TEXT2].map((c) => TRUTH[c]).join('');
const EXPECT_B2 = [...CIPHER_TEXT2].map((c) => TRUTH_B[c]).join('');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, resp) => {
      const rel = decodeURIComponent((req.url || '').split('?')[0]);
      const file = path.join(FIXTURES, rel === '/' ? '/switch-font.html' : rel);
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
function runJs(tabIndex, js) {
  const target = tabIndex ? `tab ${tabIndex} of front window` : 'front tab of front window';
  return osa(`tell application "Safari" to do JavaScript "${js}" in ${target}`).trim();
}

/** 选中 #target 并复制 */
async function selectAndCopy(tabIndex) {
  setClipboard('SENTINEL');
  runJs(
    tabIndex,
    `(function(){
      var el = document.getElementById('target');
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
  await new Promise((r) => setTimeout(r, 600));
  return clipboard();
}

/** 换题：把同一个标签导航到另一套字体 */
function switchQuiz(tabIndex, url) {
  osa(`tell application "Safari"
    set URL of tab ${tabIndex} of front window to "${url}"
  end tell`);
}

/** 模拟真人拖选：从第一个密文文本节点**中间**拖到最后一个的**中间**（跨节点） */
async function selectAcrossNodes(tabIndex, bridge) {
  setClipboard('SENTINEL');
  const info = JSON.parse(
    await bridge.evaluate(
      `(function(){
        var nodes = [];
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var st = getComputedStyle(all[i]);
          if (!st || !st.fontFamily || st.fontFamily.indexOf('Obf') < 0) continue;
          for (var k = 0; k < all[i].childNodes.length; k++) {
            var c = all[i].childNodes[k];
            if (c.nodeType === 3 && c.data && c.data.trim()) nodes.push(c);
          }
        }
        if (nodes.length < 2) return JSON.stringify({ error: 'not-enough-nodes' });
        var a = nodes[0];
        var b = nodes[nodes.length - 1];
        var r = document.createRange();
        r.setStart(a, Math.floor(a.data.length / 2));
        r.setEnd(b, Math.floor(b.data.length / 2));
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        document.execCommand('copy');
        return JSON.stringify({
          len: s.toString().length,
          nodes: nodes.length,
          selected: s.toString(),
          font: window.__currentFont || 'a',
        });
      })()`,
      { tabIndex, timeout: 10000 },
    ),
  );
  await new Promise((r) => setTimeout(r, 500));
  // 期望值由选区原文按**当前题库**的映射表还原得到（与题目内容无关）
  const selected = String(info.selected || '');
  const table = info.font === 'b' ? TRUTH_B : TRUTH;
  const expect = [...selected].map((c) => (table[c] !== undefined ? table[c] : c)).join('');
  return { text: clipboard(), expect, info };
}

async function main() {
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const log = (m) => console.log('  ·', m);

  const windowsBefore = Number(osa('tell application "Safari" to return count of windows').trim() || '0');
  let createdWindow = false;
  let tabIndex = null;

  if (windowsBefore > 0) {
    osa(`tell application "Safari"
      activate
      make new tab with properties {URL:"${origin}/switch-font.html?font=a"} at end of tabs of front window
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
      make new document with properties {URL:"${origin}/switch-font.html?font=a"}
    end tell`);
  }
  await new Promise((r) => setTimeout(r, 1200));

  const coordinator = new InjectorCoordinator({
    log,
    targetTabIndex: createdWindow ? null : tabIndex,
  });
  coordinator.setEnabled(true);

  let failed = 0;
  bridge = new SafariBridge({});
  const check = async (name, actual, expect) => {
    const ok = actual === expect;
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✔' : '✖'} ${name}`);
    if (!ok) {
      console.log(`      期望 = ${JSON.stringify(expect)}`);
      console.log(`      实际 = ${JSON.stringify(actual)}`);
      // 诊断：页面守卫手里的映射表 vs 引擎算出来的
      try {
        const dump = JSON.parse(
          await bridge.evaluate(
            `(function(){
              var g = window.__copyRepairGuard;
              if (!g) return JSON.stringify({ error: 'no-guard' });
              var out = { scopes: {} };
              for (var scope in g.mappings) {
                out.scopes[scope] = Object.keys(g.mappings[scope]).length;
              }
              var s = window.getSelection();
              out.sel = s ? s.toString().slice(0, 60) : '';
              return JSON.stringify(out);
            })()`,
            { tabIndex, timeout: 10000 },
          ),
        );
        console.log(`      页面里的映射表: ${JSON.stringify(dump.scopes)}`);
        console.log(`      选区: ${JSON.stringify(dump.sel)}`);
        const dbg = JSON.parse(
          await bridge.evaluate(
            `(function(){
              var g = window.__copyRepairGuard;
              var d = g && g.lastCopyDebug;
              if (!d) return JSON.stringify({ error: 'no-debug' });
              return JSON.stringify({
                text: d.text,
                pieces: d.pieces,
                mappingKeys: d.mappingKeys,
                misses: d.misses,
              });
            })()`,
            { tabIndex, timeout: 10000 },
          ),
        );
        console.log(`      复制诊断: ${JSON.stringify(dbg)}`);
      } catch (e) {
        console.log(`      诊断失败: ${e && e.message ? e.message : e}`);
      }
    }
    return ok;
  };

  try {
    // 第一套题：等映射建好
    for (let i = 0; i < 6; i += 1) {
      await coordinator.tick();
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log('\n换题回归（同一标签内来回换）:\n');
    await check('第 1 题（字体 A）', await selectAndCopy(tabIndex), EXPECT_A);

    // 换题：导航到字体 B
    console.log('\n  —— 换题（A → B）——');
    switchQuiz(tabIndex, `${origin}/switch-font.html?font=b`);
    // 换题后页面重建，守卫要自愈、映射要重建。轮询若干轮等它适应。
    for (let i = 0; i < 8; i += 1) {
      await coordinator.tick();
      await new Promise((r) => setTimeout(r, 250));
    }
    const b1 = await selectAndCopy(tabIndex);
    await check('第 2 题（字体 B）', b1, EXPECT_B);
    if (b1 === EXPECT_A) {
      console.log('      ⚠ 还原成了**上一套题**的答案 → 旧映射泄漏了');
    }

    // 再换回来
    console.log('\n  —— 换题（B → A）——');
    switchQuiz(tabIndex, `${origin}/switch-font.html?font=a`);
    for (let i = 0; i < 8; i += 1) {
      await coordinator.tick();
      await new Promise((r) => setTimeout(r, 250));
    }
    await check('第 3 题（字体 A）', await selectAndCopy(tabIndex), EXPECT_A);

    // 再换到 B，连换三轮，看会不会串
    console.log('\n  —— 连续换题（A → B → A → B）——');
    for (const f of ['b', 'a', 'b']) {
      switchQuiz(tabIndex, `${origin}/switch-font.html?font=${f}`);
      for (let i = 0; i < 8; i += 1) {
        await coordinator.tick();
        await new Promise((r) => setTimeout(r, 250));
      }
      const actual = await selectAndCopy(tabIndex);
      await check(`切换到 ${f.toUpperCase()}`, actual, f === 'b' ? EXPECT_B : EXPECT_A);
    }

    // ── 阶段4：跨节点的"鼠标拖选式"选区 ──
    // 真人拖选出来的 Range 跨多个文本节点、两端还不取整节点 ——
    // 与 selectNodeContents（单节点整选）喂给守卫的 selection.toString() 完全不同，
    // 守卫的"逐段对齐"必须能处理这种选区。
    console.log('\n[阶段4] 跨节点拖选式选区（真人拖选的样子）');
    const multi = await selectAcrossNodes(tabIndex, bridge);
    // 剪贴板里的换行是 \r（WebKit 规范），DOM 里是 \n → 比对前归一化
    const norm = (s) => String(s).replace(/\r\n?/g, '\n');
    await check('阶段4 跨节点选区', norm(multi.text), norm(multi.expect));

    console.log(`\n${failed === 0 ? '✔ 换题回归全部通过' : `✖ ${failed} 个换题场景未通过`}`);
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
