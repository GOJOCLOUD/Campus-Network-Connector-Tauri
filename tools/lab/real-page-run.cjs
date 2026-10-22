/**
 * 真实页面端到端验证驱动（不启动 Electron，直接用协调器模块）。
 *
 *   node tools/lab/real-page-run.cjs <tabIndex>
 *
 * 做三件事：
 *   1) 递归注入守卫到所有同源 frame
 *   2) 驱动采集 → 本地匹配 → 下发映射
 *   3) 打印状态，等用户按 Cmd+C 后由 lab-read-real.mjs 复核
 */
const { execFileSync } = require('node:child_process');
const { writeFileSync, readFileSync } = require('fs');
const path = require('path');
const { InjectorCoordinator } = require('../../src/features/safari-repair/coordinator');

const ROOT = path.join(__dirname, '..', '..');
const tabIndex = Number(process.argv[2] || 19);
const windowIndex = Number(process.argv[3] || 1);

function osa(s) {
  return execFileSync('osascript', ['-e', s], { encoding: 'utf8' });
}

async function main() {
  const coordinator = new InjectorCoordinator({
    log: (m) => console.log('  ·', m),
    targetTabIndex: tabIndex,
  });
  coordinator.enabled = true; // 只手动驱动，不启动定时器

  for (let i = 0; i < 12; i += 1) {
    const r = await coordinator.tick();
    if (r.action === 'mapped') {
      console.log(`[real] 第 ${i + 1} 轮完成映射:`, JSON.stringify(r));
      break;
    }
    if (r.action === 'idle' && i === 11) {
      console.log('[real] 12 轮后仍未取到待处理位图（可能选区不在了）');
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // 读回页面状态：各 frame 的映射是否到位
  const js = `(function(){
    var out = [];
    function walk(w, p, d) {
      if (d > 6) return;
      var rec = { path: p };
      try {
        var g = w.__copyRepairGuard;   // 守卫（不是探针）
        rec.guard = !!g;
        rec.scopes = g ? Object.keys(g.mappings) : [];
        rec.mapChars = g ? Object.keys(g.mappings).map(function(k){ return Object.keys(g.mappings[k]).length; }) : [];
        rec.charScopes = g ? Object.keys(g.charScopes || {}).length : 0;
        rec.selNow = (function(){ var s = w.getSelection(); return s ? s.toString().length : -1; })();
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
  const f = '/tmp/real-read.js';
  writeFileSync(f, js, 'utf8');
  const raw = osa(`tell application "Safari"
    set jsCode to (read POSIX file "${f}") as «class utf8»
    do JavaScript jsCode in tab ${tabIndex} of window ${windowIndex}
  end tell`).trim();

  console.log('\n[real] 各 frame 的守卫/映射状态:');
  try {
    for (const r of JSON.parse(raw)) {
      if (!r.guard && !r.err) continue;
      console.log(
        `  ${(r.path || '').padEnd(12)} guard=${r.guard} 映射作用域数=${(r.scopes||[]).length} 每作用域字符数=${JSON.stringify(r.mapChars || [])} 字符-作用域表=${r.charScopes} 当前选区=${r.selNow}`,
      );
    }
  } catch (_) {
    console.log(raw.slice(0, 400));
  }
  writeFileSync('/tmp/real-state.json', JSON.stringify({ tabIndex, windowIndex }));
  console.log('\n[real] 现在请在那个页面上按 Cmd+C，然后粘贴到 TextEdit，告诉我粘贴出来的是乱码还是正常汉字。');
}

main();
