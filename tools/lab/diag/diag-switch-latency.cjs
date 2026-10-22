/**
 * 诊断：换题后**立刻复制**会怎样？映射要多久才就绪？
 *
 *   node tools/lab/diag-switch-latency.cjs
 *
 * 模拟用户真实动作：换题 → 马上拖选 → 马上 Cmd+C。
 * 每一步都记录"复制时的剪贴板是否正确"，以及"从换题到正确用了多久"。
 */
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { InjectorCoordinator } = require(path.join(ROOT, 'src/features/safari-repair/coordinator'));
const { SafariBridge } = require(path.join(ROOT, 'src/features/safari-repair/bridge'));

const FIX = path.join(ROOT, 'src/features/safari-repair/test/fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json' };

const TRUTH_A = JSON.parse(fs.readFileSync(path.join(FIX, 'fonts', 'obf-same-style.map.json'), 'utf8'));
const TRUTH_B = JSON.parse(fs.readFileSync(path.join(FIX, 'fonts', 'obf-second-style.map.json'), 'utf8'));
const TEXT = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾';
const EXPECT = { a: [...TEXT].map((c) => TRUTH_A[c]).join(''), b: [...TEXT].map((c) => TRUTH_B[c]).join('') };

function osa(s) {
  return execFileSync('osascript', ['-e', s], { encoding: 'utf8' });
}
function clipboard() {
  try {
    return osa('the clipboard as text').replace(/\n$/, '');
  } catch (_) {
    return '';
  }
}

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

  const coordinator = new InjectorCoordinator({ log: (m) => { if (/fastPoll/.test(m)) console.log('    ' + m); }, targetTabIndex: tabIndex });
  let fastCalls = 0;
  const origFast = coordinator.fastTick.bind(coordinator);
  coordinator.fastTick = async function () { fastCalls++; return origFast(); };
  coordinator.setEnabled(true);
  for (let i = 0; i < 6; i += 1) {
    await coordinator.tick();
    await new Promise((r) => setTimeout(r, 200));
  }

  async function copyNow() {
    osa('set the clipboard to "SENTINEL"');
    await bridge.evaluate(
      `(function(){
        var el = document.getElementById('target');
        if (!el) return 'NO-EL';
        var r = document.createRange();
        r.selectNodeContents(el);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        document.execCommand('copy');
        return 'ok';
      })()`,
      { tabIndex, timeout: 10000 },
    );
    await new Promise((r) => setTimeout(r, 300));
    return clipboard();
  }

  async function switchTo(which) {
    osa(`tell application "Safari" to set URL of tab ${tabIndex} of front window to "${origin}/switch-font.html?font=${which}"`);
  }

  // 换题 → 每 300ms 复制一次，看映射何时就绪
  console.log('\n=== 换题后每隔 300ms 复制一次 ===');
  await switchTo('b');
  const t0 = Date.now();
  console.log('  [t0=' + (t0 % 100000) + '] 已切换到 B');
  let readyAt = -1;
  for (let i = 1; i <= 12; i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    const t = await copyNow();
    const dt = Date.now() - t0;
    console.log('    [t=' + (Date.now() % 100000) + '] 复制完成');
    const ok = t === EXPECT.b;
    console.log(`  +${dt}ms：${ok ? '✔ 正确' : '✖ 仍是密文'}`);
    if (ok && readyAt < 0) { readyAt = dt; break; }
  }
  console.log(`\n  → 映射就绪耗时 ${readyAt < 0 ? '>3.6s（没就绪）' : readyAt + 'ms'}`);

  coordinator.stop();
  osa(`tell application "Safari" to close tab ${tabIndex} of front window`);
  server.close();
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
