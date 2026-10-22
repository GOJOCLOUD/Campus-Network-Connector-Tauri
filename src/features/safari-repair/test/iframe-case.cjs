/**
 * iframe 场景闭环测试：选区在同源 iframe 内。
 *
 * ⚠️ 同样会真实操作 Safari 标签页，必须串行运行（--test-concurrency=1）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { InjectorCoordinator } = require('../coordinator');

const FIXTURES = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf' };
const EXPECTED = '人工智能正在改变世界科技';

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, resp) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.join(FIXTURES, rel === '/' ? '/iframe-host.html' : rel);
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) { resp.writeHead(404); resp.end('nf'); return; }
      resp.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      resp.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function osa(s) { return execFileSync('osascript', ['-e', s], { encoding: 'utf8' }); }
function clipboard() { try { return osa('the clipboard as text').replace(/\n$/, ''); } catch { return ''; } }
function tabCount() { return Number(osa('tell application "Safari" to return count of tabs of front window').trim() || '0'); }


/**
 * 打开一个属于测试的**临时标签页**（加在前台窗口末尾）。
 *
 * 浏览器卫生：**绝不新建/关闭窗口** —— 新建窗口会把用户的标签页重新分窗，
 * 关窗口又可能误伤用户自己的窗口（之前按 "tab 1 含 127.0.0.1" 关窗，
 * 结果把用户窗口拆成了两个）。只加标签、精确删标签，窗口结构不变。
 */
async function openTestTab(url, port) {
  osa(`tell application "Safari"
    activate
    make new tab with properties {URL:"${url}"} at end of tabs of front window
  end tell`);
  // Safari 会把新标签插到当前标签之后 → 按**本测试的端口**精确查真实索引
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
    if (found) return Number(found);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('找不到测试标签');
}

/** 只关掉测试自己那个标签（按索引精确关闭）。 */
function closeTestTab(tabIndex) {
  if (!tabIndex) return;
  osa(`tell application "Safari"
    try
      close tab ${tabIndex} of front window
    end try
  end tell`);
}

async function main() {
  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const log = (m) => console.log('  ·', m);
  const tabsBefore = tabCount();
  const windowsBefore = Number(osa('tell application "Safari" to return count of windows').trim() || '0');

  const tabIndex = await openTestTab(`${origin}/iframe-host.html`, port);

  const coordinator = new InjectorCoordinator({ log, targetTabIndex: tabIndex });
  coordinator.enabled = true; // 只用手动 tick，避免定时器与手动调用抢同一轮
  const runJs = (js) =>
    osa(`tell application "Safari" to do JavaScript "${js}" in tab ${tabIndex} of front window`).trim();

  try {
    await coordinator.tick({ force: true });
    await new Promise((r) => setTimeout(r, 500));

    console.log('iframe 内手动采集:', runJs(`(function(){
      var f=document.getElementById('f'); var w=f.contentWindow;
      var g=w.__copyRepairGuard;
      if(!g) return 'NO-GUARD';
      var before = g.pending ? g.pending.chars.length : null;
      var r = w.__copyRepairCollect ? w.__copyRepairCollect() : 'NO-API';
      return JSON.stringify({ before: before, ret: r, after: g.pending ? g.pending.chars.length : null, log: g.log.map(function(e){return e.event;}), selLen: (w.getSelection()?w.getSelection().toString().length:-1), hasSetMapping: typeof w.__copyRepairSetMapping });
    })()`));
    console.log('注入错误:', runJs(`String(window.__copyRepairInjectError || 'none')`));
    console.log('bridge debug:', runJs(`JSON.stringify(window.__copyRepairBridge ? window.__copyRepairBridge.debug() : 'NO-BRIDGE')`));
    console.log('take() JSON 合法性:', runJs(`(function(){
      try {
        var r = window.__copyRepairBridge.take();
        var js = JSON.stringify(r);
        var back = JSON.parse(js);
        return 'OK len=' + js.length + ' pending=' + back.pending.length + ' chars=' + (back.pending[0] ? back.pending[0].chars.length : 0);
      } catch (e) { return 'ERR: ' + e.message; }
    })()`));
    console.log('take() 手动调用:', runJs(`(function(){
      try {
        var b = window.__copyRepairBridge;
        var r = b.take();
        return JSON.stringify({ pending: r.pending.length, unrepaired: r.unrepaired.length, chars: r.pending.map(function(x){return x.chars.length;}) });
      } catch (e) {
        return 'ERR: ' + e.message;
      }
    })()`));
    console.log('顶层 bridge:', runJs(`JSON.stringify({
      bridge: typeof window.__copyRepairBridge,
      installFn: typeof window.__copyRepairInstallFrameBridge,
      hasGuard: typeof window.__copyRepairGuard,
      iframeGuards: (function(){ var n=0; try{ var fs=document.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){ if(fs[i].contentWindow.__copyRepairGuard) n++; } }catch(e){} return n; })()
    })`));

    // 在 iframe 内选中文字
    const sel = runJs(`(function(){
      var f = document.getElementById('f');
      var d = f.contentDocument;
      var el = d.getElementById('target');
      if (!el) return 'NO-EL-IN-FRAME';
      var r = d.createRange();
      r.selectNodeContents(el);
      var s = f.contentWindow.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return 'selected:' + s.toString().length;
    })()`);
    console.log('iframe 内选中:', sel);

    // 触发 iframe 内的采集 + 匹配
    await new Promise((r) => setTimeout(r, 300));
    const rawState = await coordinator.bridge.pollState({ tabIndex });
    console.log('pollState 原始:', JSON.stringify(rawState).slice(0, 400));
    const t2 = await coordinator.tick({ force: true });
    console.log('tick2 =>', JSON.stringify(t2));

    const frameLog = runJs(`(function(){
      var f = document.getElementById('f');
      var w = f.contentWindow;
      var g = w.__copyRepairGuard;
      if (!g) return 'NO-GUARD-IN-FRAME';
      return JSON.stringify({
        log: g.log.map(function(e){return e.event;}),
        pending: g.pending ? g.pending.chars.length : null,
        lastText: (g.lastSelectionText||'').slice(0,20),
        selLen: (w.getSelection() ? w.getSelection().toString() : '').length,
        hasCollect: typeof w.__copyRepairCollect === 'function',
        topBridge: typeof (w.top.__copyRepairBridge)
      });
    })()`);
    console.log('iframe 内守卫:', frameLog);

    const st = runJs(`JSON.stringify({
      frames: (function(){
        var b = window.__copyRepairBridge;
        if (!b) return 'NO-BRIDGE';
        var n = 0;
        try {
          var fs = document.querySelectorAll('iframe');
          for (var i=0;i<fs.length;i++){ if (fs[i].contentWindow.__copyRepairGuard) n++; }
        } catch(e){}
        return n;
      })(),
      topMaps: Object.keys(window.__copyRepairGuard ? window.__copyRepairGuard.mappings : {}).length,
      log: window.__copyRepairGuard ? window.__copyRepairGuard.log.map(function(e){return e.event;}) : []
    })`);
    console.log('页面状态:', st);

    let mapsReady = 0;
    for (let i = 0; i < 20; i += 1) {
      mapsReady = Number(runJs(`(function(){
        var n = 0;
        try {
          var fs = document.querySelectorAll('iframe');
          for (var i=0;i<fs.length;i++){
            var g = fs[i].contentWindow.__copyRepairGuard;
            if (g && g.mappings) { var k = Object.keys(g.mappings)[0]; if (k) n += Object.keys(g.mappings[k]).length; }
          }
        } catch(e){}
        return n;
      })()`) || 0);
      if (mapsReady > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log('iframe 内已收到的映射字符数:', mapsReady);

    // 在 iframe 内触发复制
    setClipboardSafe('SENTINEL');
    runJs(`(function(){
      var f = document.getElementById('f');
      f.contentDocument.execCommand('copy');
      return 'copied';
    })()`);
    await new Promise((r) => setTimeout(r, 700));

    const actual = clipboard();
    console.log(`\n剪贴板 = ${JSON.stringify(actual)}`);
    console.log(`期望   = ${JSON.stringify(EXPECTED)}`);
    console.log(actual === EXPECTED ? '✔ iframe 闭环通过' : '✖ iframe 闭环失败');
    process.exitCode = actual === EXPECTED ? 0 : 1;
  } finally {
    closeTestTab(tabIndex);
    server.close();
    console.log(`\n[测试] 窗口 ${windowsBefore} → ${Number(osa('tell application "Safari" to return count of windows').trim())}，标签 ${tabsBefore} → ${tabCount()}`);
  }
}

function setClipboardSafe(text) {
  execFileSync('osascript', ['-e', `set the clipboard to ${JSON.stringify(text)}`], { encoding: 'utf8' });
}

main();
