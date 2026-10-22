/**
 * 诊断：页面守卫手里的映射表，与引擎算出来的**逐键对比**。
 *
 *   node tools/lab/diag-mapping-diff.cjs
 *
 * 做法：开夹具页 → 协调器跑几轮 → 页面里导出映射的键 → 与引擎的键集对比。
 */
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { InjectorCoordinator } = require(path.join(ROOT, 'src/features/safari-repair/coordinator'));
const { SafariBridge } = require(path.join(ROOT, 'src/features/safari-repair/bridge'));
const { GlyphEngine } = require(path.join(ROOT, 'src/features/safari-repair/engine'));

const FIX = path.join(ROOT, 'src/features/safari-repair/test/fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json' };

function osa(s) {
  return execFileSync('osascript', ['-e', s], { encoding: 'utf8' });
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
  console.log('夹具标签页 =', tabIndex);
  if (tabIndex <= 0) throw new Error('找不到夹具标签页');

  const coordinator = new InjectorCoordinator({ log: (m) => console.log('  ·', m), targetTabIndex: tabIndex });
  coordinator.setEnabled(true);
  for (let i = 0; i < 6; i += 1) {
    await coordinator.tick();
    await new Promise((r) => setTimeout(r, 250));
  }

  // 先选中正文（模拟真实复制场景：选区交付会再发一次映射）
  await bridge.evaluate(
    `(function(){
      var el = document.getElementById('target');
      if (!el) return 'NO-EL';
      var r = document.createRange();
      r.selectNodeContents(el);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return 'sel';
    })()`,
    { tabIndex, timeout: 10000 },
  );
  for (let i = 0; i < 4; i += 1) {
    await coordinator.tick();
    await new Promise((r) => setTimeout(r, 250));
  }
  const raw = await bridge.evaluate(
    `(function(){
      var g = window.__copyRepairGuard;
      if (!g) return JSON.stringify({ error: 'no-guard' });
      var out = { scopes: {} };
      for (var scope in g.mappings) {
        var m = g.mappings[scope];
        var keys = Object.keys(m);
        out.scopes[scope] = { count: keys.length, keys: keys.join('') };
      }
      return JSON.stringify(out);
    })()`,
    { tabIndex, timeout: 10000 },
  );
  const page = JSON.parse(raw);

  // 引擎侧：同一份字体文件
  const engine = new GlyphEngine({ log: () => {} });
  const bytes = fs.readFileSync(path.join(FIX, 'fonts', 'obf-same-style.ttf'));
  const result = await engine.processScope('cmp', [], { kind: 'data', value: bytes.toString('base64') }, {});

  for (const [scope, info] of Object.entries(page.scopes || {})) {
    const pageKeys = new Set(info.keys.split(''));
    const engineKeys = new Set(Object.keys(result.mapping || {}));
    const onlyEngine = [...engineKeys].filter((k) => !pageKeys.has(k));
    const onlyPage = [...pageKeys].filter((k) => !engineKeys.has(k));
    console.log(`\n作用域 ${scope}: 页面 ${info.count} 条 / 引擎 ${engineKeys.size} 条`);
    if (onlyEngine.length) console.log('  只有引擎有: ' + onlyEngine.join(' ') + '  (值: ' + onlyEngine.map((k) => k + '→' + result.mapping[k]).join(' ') + ')');
    if (onlyPage.length) console.log('  只有页面有: ' + onlyPage.join(' '));
    // 值是否一致
    const raw2 = await bridge.evaluate(
      `(function(){
        var g = window.__copyRepairGuard;
        var out = {};
        for (var scope in g.mappings) {
          var m = g.mappings[scope];
          var bad = [];
          for (var ch in m) { if (m[ch] === ch) bad.push(ch + '→自身'); }
          out[scope] = { selfMapped: bad.join(' ') };
        }
        return JSON.stringify(out);
      })()`,
      { tabIndex, timeout: 10000 },
    );
    console.log('  页面里"映射到自己"的: ' + JSON.stringify(JSON.parse(raw2)[scope].selfMapped || '无'));
  }

  coordinator.stop();
  osa(`tell application "Safari" to close tab ${tabIndex} of front window`);
  server.close();
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
