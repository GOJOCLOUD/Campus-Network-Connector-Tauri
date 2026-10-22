/**
 * 往真实标签页注入守卫并读回状态（不启动 Electron）。
 *
 *   node tools/lab/guard-inject.cjs <tabIndex> [--collect]
 *
 * --collect 会强制触发一次采集（建字形表 + 出映射）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { SafariBridge } = require('../../src/features/safari-repair/bridge');

const ROOT = path.join(__dirname, '..', '..');
const tabIndex = Number(process.argv[2] || 19);
const doCollect = process.argv.includes('--collect');

const guardSource = fs.readFileSync(path.join(ROOT, 'vendor', 'page-guard.js'), 'utf8');
const frameBridgeSource = fs.readFileSync(path.join(ROOT, 'vendor', 'frame-bridge.js'), 'utf8');

/** 递归读每个 frame 的守卫状态 */
const READ_JS = `(function(){
  var out = [];
  function walk(w, p, d) {
    if (d > 6) return;
    var rec = { path: p };
    try {
      var g = w.__copyRepairGuard;
      rec.guard = !!g;
      rec.ver = g ? g.version : 0;
      rec.libs = g ? Object.keys(g.libraries || {}).length : 0;
      rec.scopes = g ? Object.keys(g.mappings || {}) : [];
      rec.mapChars = g ? Object.keys(g.mappings || {}).map(function(k){ return Object.keys(g.mappings[k]).length; }) : [];
      rec.localChars = g ? Object.keys(g.localMappings || {}).map(function(k){ return Object.keys(g.localMappings[k]).length; }) : [];
      rec.charScopes = g ? Object.keys(g.charScopes || {}).length : 0;
      var s = w.getSelection();
      rec.selLen = s ? s.toString().length : -1;
      rec.logs = g ? g.log.slice(-8).map(function(e){ return e.event; }) : [];
      rec.detail = null;
      try {
        if (g) {
          var lk = Object.keys(g.localMappings || {});
          if (lk.length) {
            var d = {};
            for (var i=0;i<lk.length;i++) d[lk[i]] = g.localMappings[lk[i]];
            rec.detail = d;
          }
        }
      } catch (e) {}
    } catch (e) { rec.err = e.name; }
    out.push(rec);
    try {
      var fs2 = w.document.querySelectorAll('iframe');
      for (var i=0;i<fs2.length;i++) walk(fs2[i].contentWindow, p+'/'+i, d+1);
    } catch (e) {}
  }
  walk(window, 'top', 0);
  return JSON.stringify(out);
})()`;

async function main() {
  const bridge = new SafariBridge({ log: () => {} });

  console.log('[1] 注入守卫 v4（含递归 frame bridge）…');
  const injectRes = await bridge.injectGuard(guardSource, {
    tabIndex,
    frameBridgeSource,
  });
  console.log('    注入返回:', String(injectRes).slice(0, 120));

  if (doCollect) {
    console.log('[2] 触发采集（建字形表可能要 1~3 秒）…');
    const t0 = Date.now();
    const res = await bridge.evaluate('window.__copyRepairCollect ? String(window.__copyRepairCollect()) : "NO-API"', {
      tabIndex,
      timeout: 8000,
    });
    console.log(`    采集返回: ${res}（${Date.now() - t0}ms）`);
  }

  const state = await bridge.pollState({ tabIndex });
  console.log('[3] pollState:', JSON.stringify(state).slice(0, 400));

  const raw = await bridge.evaluate(READ_JS, { tabIndex, timeout: 6000 });
  console.log('[4] 各 frame 状态:');
  let rows = [];
  try {
    rows = JSON.parse(raw);
  } catch (_) {
    console.log('    解析失败:', String(raw).slice(0, 200));
  }
  for (const r of rows) {
    if (!r.guard && !r.err) continue;
    console.log(
      `    ${(r.path || '').padEnd(10)} v${r.ver} 选区=${r.selLen} 字形表=${r.libs} 作用域=${(r.scopes || []).length} ` +
        `映射=${JSON.stringify(r.mapChars || [])} 本地精确=${JSON.stringify(r.localChars || [])} 字符域=${r.charScopes} 日志=${JSON.stringify(r.logs || [])}`,
    );
  }

  // 打印有映射的 frame 的映射内容
  for (const r of rows) {
    if (r.detail) {
      console.log(`[5] ${r.path} 的本地精确映射:`, JSON.stringify(r.detail).slice(0, 3000));
    }
  }
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
