/**
 * 诊断（不干扰式）：换题后，页面**拿到新字体的映射**用了多久？
 *
 *   node tools/lab/diag-mapping-ready.cjs
 *
 * 做法：切换字体后，只**读**页面守卫的 mappings（不复制、不抢 Apple Event），
 *      看新字体的作用域什么时候出现。复制是同步动作，抢占事件通道会污染测量。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { InjectorCoordinator } = require(path.join(ROOT, 'src/features/safari-repair/coordinator'));
const { SafariBridge } = require(path.join(ROOT, 'src/features/safari-repair/bridge'));

const FIX = path.join(ROOT, 'src/features/safari-repair/test/fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json' };

function osa(s) {
  return execFileSyncSafe(s);
}
function execFileSyncSafe(s) {
  const { execFileSync } = require('child_process');
  return execFileSync('osascript', ['-e', s], { encoding: 'utf8' });
}

const READ = `(function(){
  var g = window.__copyRepairGuard;
  if (!g) return JSON.stringify({ error: 'no-guard' });
  var out = {};
  for (var scope in g.mappings) out[scope] = Object.keys(g.mappings[scope]).length;
  return JSON.stringify({ scopes: out, font: window.__currentFont || '?', hasTarget: !!document.getElementById('target') });
})()`;

async function main() {
  const server = http.createServer((req, resp) => {
    const rel = decodeURIComponent((req.url || '').split('?')[0]);
    const file = path.join(FIX, rel === '/' ? '/switch-font.html' : rel);
    if (!file.startsWith(FIX) || !fs.existsSync(file)) {
      resp.writeHead(404);
      resp.end('nf');
      return;
    }
    resp.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    resp.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  osa(`tell application "Safari" to make new tab with properties {URL:"${origin}/switch-font.html?font=a"} at end of tabs of front window`);
  const bridge = new SafariBridge({});
  let tabIndex = -1;
  for (let i = 0; i < 25; i += 1) {
    tabIndex = await bridge.findTabByUrl(`127.0.0.1:${port}`);
    if (tabIndex > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('测试标签 =', tabIndex);

  const coordinator = new InjectorCoordinator({ log: () => {}, targetTabIndex: tabIndex });
  coordinator.setEnabled(true);
  for (let i = 0; i < 6; i += 1) {
    await coordinator.tick();
    await new Promise((r) => setTimeout(r, 200));
  }
  // 先确认 A 字体已就绪
  let before = JSON.parse(await bridge.evaluate(READ, { tabIndex, timeout: 10000 }));
  console.log('换题前的作用域:', JSON.stringify(before.scopes));

  // 切到 B
  osa(`tell application "Safari" to set URL of tab ${tabIndex} of front window to "${origin}/switch-font.html?font=b"`);
  const t0 = Date.now();
  let readyAt = -1;
  let contentAt = -1;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const s = JSON.parse(await bridge.evaluate(READ, { tabIndex, timeout: 10000 }));
    // 新内容出现的标志：页面自己切到了 B 且正文已渲染
    if (contentAt < 0 && s.font === 'b' && s.hasTarget) contentAt = Date.now() - t0;
    const hasB = Object.keys(s.scopes || {}).some((k) => k.includes('ObfB') && s.scopes[k] > 0);
    if (hasB) {
      readyAt = Date.now() - t0;
      console.log(`  新内容出现: +${contentAt}ms`);
      console.log(`  映射就绪:   +${readyAt}ms`);
      console.log(`  → 真正的窗口 = ${readyAt - contentAt}ms（新内容出现 → 映射可用）`);
      break;
    }
    if (i % 5 === 4) console.log(`  +${Date.now() - t0}ms 还没就绪…`);
  }
  if (readyAt < 0) console.log('  4 秒内没就绪 ✗');

  coordinator.stop();
  osa(`tell application "Safari" to close tab ${tabIndex} of front window`);
  server.close();
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
