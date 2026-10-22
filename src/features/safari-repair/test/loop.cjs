/**
 * 闭环冒烟测试（纯 Node，不启动 Electron）：
 *   注入守卫 → 页面渲染字形 → 本地匹配 → 下发映射 → 复制 → 核对系统剪贴板
 *
 * 浏览器卫生：只在**前台窗口末尾加一个**临时标签，用完精确删掉；
 * 不新开窗口、不关用户已有窗口，测试前后标签数必须一致。
 *
 *   node safari-repair/test/loop.cjs
 *
 * ⚠️ 本用例会真实操作 Safari 的标签页（加临时标签、用完删掉），
 *    必须**串行**运行：node --test --test-concurrency=1
 *    并行跑会和 iframe-case.cjs 互相抢标签索引，导致假失败。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { InjectorCoordinator } = require('../coordinator');

const FIXTURES = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json' };
const EXPECTED = '人工智能正在改变世界科技';
const EXPECTED2 = '发展未来数据算法模型训练';
const EXPECTED3 = '推理应用场景需求用户体验设计开发测试部署运维监控';

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, resp) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.join(FIXTURES, rel === '/' ? '/obfuscated.html' : rel);
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

/** 在指定标签执行 JS；tabIndex 为 null 时用前台标签。 */
function runJs(tabIndex, js) {
  const target = tabIndex ? `tab ${tabIndex} of front window` : 'front tab of front window';
  return osa(`tell application "Safari" to do JavaScript "${js}" in ${target}`).trim();
}

async function main() {
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const log = (m) => console.log('  ·', m);

  // 浏览器卫生：
  //  - 已有窗口 → 只在末尾加一个临时标签，用完精确删掉
  //  - 没有窗口 → 自建一个窗口（记录下来），用完按 URL 关掉
  // 跑完后窗口/标签数必须回到原值。
  const windowsBefore = Number(osa('tell application "Safari" to return count of windows').trim() || '0');
  const tabsBefore = windowsBefore > 0 ? tabCount() : 0;
  let createdWindow = false;
  let tabIndex = null;

  if (windowsBefore > 0) {
    osa(`tell application "Safari"
      activate
      make new tab with properties {URL:"${origin}/obfuscated.html"} at end of tabs of front window
    end tell`);
    // 新标签不一定在末尾（Safari 会插到当前标签之后）→ 按 URL 查真实索引
    // 注意：必须按**本测试的端口**精确匹配。只匹配 "127.0.0.1" 会误命中用户已开的
    // 其它本地页（本机常驻着实验台服务），导致选错标签、整场测试假失败。
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
      make new document with properties {URL:"${origin}/obfuscated.html"}
    end tell`);
  }
  await new Promise((r) => setTimeout(r, 1500));

  const coordinator = new InjectorCoordinator({
    log,
    targetTabIndex: createdWindow ? null : tabIndex,
  });
  coordinator.setEnabled(true);

  try {
    // 诊断：tabIndex / pollState 原始返回
    const { SafariBridge } = require('../bridge');
    const dbg = new SafariBridge({});
    console.log('tabIndex =', tabIndex);
    console.log('pollState 原始 =', JSON.stringify(await dbg.pollState({ tabIndex })));
    console.log('runJs 原始 =', runJs(tabIndex, 'String(typeof window.__copyRepairGuard)'));

    // 1) 注入守卫
    const r1 = await coordinator.tick({ force: true });
    console.log('轮次1:', JSON.stringify(r1));

    // 2) 选中文字（Safari 对程序化选区不派发 selectionchange，测试里显式调用采集入口）
    runJs(
      tabIndex,
      `(function(){
        var el = document.getElementById('target');
        var r = document.createRange();
        r.selectNodeContents(el);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return String(window.__copyRepairCollect && window.__copyRepairCollect());
      })()`,
    );

    console.log('手动采集返回:', runJs(tabIndex, `(function(){
      var el = document.getElementById('target');
      var r = document.createRange();
      r.selectNodeContents(el);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      var sel = window.getSelection();
      return JSON.stringify({ selLen: sel ? sel.toString().length : -1, collapsed: sel ? sel.isCollapsed : null, collect: String(window.__copyRepairCollect && window.__copyRepairCollect()), log: window.__copyRepairGuard.log.map(function(e){return e.event;}) });
    })()`));
    const guardLog = runJs(
      tabIndex,
      `(function(){
        var g = window.__copyRepairGuard;
        if (!g) return 'NO-GUARD';
        return JSON.stringify({log: g.log.map(function(e){return e.event;}), pending: g.pending ? g.pending.chars.length : null});
      })()`,
    );
    console.log('页面守卫:', guardLog);

    // 3) 拉位图 → 本地匹配 → 下发映射
    const r2 = await coordinator.tick({ force: true });
    console.log('轮次2:', JSON.stringify(r2));

    // 4) 复制，核对系统剪贴板
    setClipboard('SENTINEL');
    runJs(tabIndex, `document.execCommand('copy'); 'copied';`);
    await new Promise((r) => setTimeout(r, 600));

    const guardState = runJs(tabIndex, `JSON.stringify({
      mapKeys: Object.keys(window.__copyRepairGuard ? window.__copyRepairGuard.mappings : {}),
      sample: Object.keys(window.__copyRepairGuard ? window.__copyRepairGuard.mappings : {}).map(function(k){ return [k, Object.keys(window.__copyRepairGuard.mappings[k]).length]; }),
      log: window.__copyRepairGuard ? window.__copyRepairGuard.log.map(function(e){return e.event;}) : []
    })`);
    console.log('页面映射状态:', guardState);
    const actual = clipboard();
    const ok = actual === EXPECTED;
    console.log(`\n剪贴板 = ${JSON.stringify(actual)}`);
    console.log(`期望   = ${JSON.stringify(EXPECTED)}`);
    console.log(ok ? '✔ 闭环通过' : '✖ 闭环失败');
    console.log('状态:', JSON.stringify(coordinator.getStatus()));
    process.exitCode = ok ? 0 : 1;

    // ── 第二阶段：换一段**新的**密文选区 ──
    // 回归点：映射必须按**字体**建。若只映射"采集时选区里的字"，
    // 用户后来扩大/更换选区，新出现的密文字就没有映射 → 复制出来还是乱码。
    // 关键：**不重新采集、不重新下发映射**，直接用阶段1留下的那份映射去复制。
    // 这正是用户遇到的场景：映射是旧的（当时只选了第 1 题），后来换了选区就复制。
    // 映射按字体建 → 旧映射本来就覆盖全部密文码位 → 照样能还原。
    // （若映射只按选区建，这里就会漏掉 #target2 的密文字 → 阶段2 失败）
    // 先停掉协调器的定时器：否则它会在选区变化后偷偷跑一轮，
    // 重新采集 + 重新下发映射，把这个回归点盖掉（测试就失去意义了）。
    coordinator.stop();
    console.log('\n[阶段2] 换成第二段密文选区（#target2），**不重新采集**，直接复制');
    runJs(
      tabIndex,
      `(function(){
        var el = document.getElementById('target2');
        var r = document.createRange();
        r.selectNodeContents(el);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return 'selected:' + s.toString().length;
      })()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    setClipboard('SENTINEL');
    runJs(
      tabIndex,
      `(function(){
        var el = document.getElementById('target2');
        var r = document.createRange();
        r.selectNodeContents(el);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        document.execCommand('copy');
        return 'copied';
      })()`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const actual2 = clipboard();
    console.log(`[阶段2] 剪贴板 = ${JSON.stringify(actual2)}`);
    console.log(`[阶段2] 期望   = ${JSON.stringify(EXPECTED2)}`);
    const ok2 = actual2 === EXPECTED2;
    console.log(ok2 ? '✔ 阶段2 通过（换选区仍能还原）' : '✖ 阶段2 失败：换选区后新密文字没被还原');
    if (!ok2) process.exitCode = 1;

    // ── 第三阶段：选区刚换、采集缓存还没更新就复制 ──
    // 回归点（真实故障）：学习通测验页第 2 题出现了**第 1 题没有的密文字**。
    // 用户把第 2 题选中后立刻 Cmd+C，采集（selectionchange / 轮询）还没轮到，
    // 那些新密文字在"字符 → 作用域"缓存里查不到 → 查表落空 → 原样进剪贴板。
    // 表现就是：前半句（早先选过、缓存里有）修好了，后半句（刚选到的）还是密文。
    //
    // 这里用 #target3（一批从未被采集过的密文字），并且**选区与复制在同一次执行里完成**，
    // 模拟"用户改完选区马上按 Cmd+C"。正确实现必须在**复制那一刻**按当前选区现算作用域，
    // 不能依赖采集缓存。
    console.log('\n[阶段3] 选一段**全新密文字**并**立即复制**（不等采集轮询）');
    const stage3 = runJs(
      tabIndex,
      `(function(){
        var g = window.__copyRepairGuard;
        if (!g) return JSON.stringify({ error: 'no-guard' });
        var el = document.getElementById('target3');
        var r = document.createRange();
        r.selectNodeContents(el);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        // 复制**之前**先看缓存：这批字此时应该还不在缓存里（采集还没轮到）
        var known = 0;
        for (var i = 0; i < el.textContent.length; i++) {
          if (g.charScopes && g.charScopes[el.textContent.charAt(i)]) known++;
        }
        // 关键：选区与复制在**同一次同步执行**里完成 → 采集（异步）还没轮到
        document.execCommand('copy');
        return JSON.stringify({ selected: s.toString().length, knownInCacheBeforeCopy: known });
      })()`,
    );
    console.log('[阶段3] 选区与缓存:', stage3);
    await new Promise((r) => setTimeout(r, 700));
    const actual3 = clipboard();
    console.log(`[阶段3] 剪贴板 = ${JSON.stringify(actual3)}`);
    console.log(`[阶段3] 期望   = ${JSON.stringify(EXPECTED3)}`);
    const ok3 = actual3 === EXPECTED3;
    console.log(
      ok3
        ? '✔ 阶段3 通过（选区刚换就复制也能全部还原）'
        : '✖ 阶段3 失败：新选区的密文字没被还原（作用域查表落空）',
    );
    if (!ok3) process.exitCode = 1;
  } finally {
    if (createdWindow) {
      // 关掉自建的窗口：先收集编号再倒序关（边关边数会索引错位）
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
      // 精确删掉我们加的那一个标签
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

main();
