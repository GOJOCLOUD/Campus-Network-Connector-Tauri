/**
 * 诊断：把目标标签里**每一层同源 frame** 的守卫状态导出来。
 *
 *   node tools/lab/diag-frames.cjs <关键字> [tabIndex]
 *
 * 关注点：
 *   - 每层的 scopeKey（字体作用域）
 *   - mappings 的键（按作用域）
 *   - charScopes（字符 → 作用域）
 *   - 选区文本与按 run 分段的 scope
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  var out = { layers: [] };
  function esc(s){ return String(s == null ? '' : s); }
  function scopeOf(el){
    try {
      var st = window.getComputedStyle(el);
      return st.fontStyle + '|' + st.fontWeight + '|' + st.fontFamily;
    } catch(e){ return 'ERR'; }
  }
  function visit(win, pathStr, depth){
    if (depth > 8) return;
    var g = null;
    try { g = win.__copyRepairGuard; } catch(e){ return; }
    var layer = { path: pathStr, hasGuard: !!g, hasBridge: false };
    try { layer.hasBridge = !!win.__copyRepairBridge; } catch(e){}
    if (g) {
      var mapKeys = {};
      try {
        var mk = Object.keys(g.mappings);
        for (var i = 0; i < mk.length; i++) {
          mapKeys[mk[i]] = Object.keys(g.mappings[mk[i]]).length;
        }
      } catch(e){}
      layer.mappingKeys = mapKeys;
      layer.mappings = g.mappings;
      layer.charScopes = g.charScopes;
      layer.repairs = g.repairs;
      layer.copyEvents = g.copyEvents;
      layer.lastSelectionText = esc(g.lastSelectionText).slice(0, 300);
      layer.lastCollectedScope = esc(g.lastCollectedScope);
      var logs = [];
      try {
        var lg = g.log || [];
        for (var j = Math.max(0, lg.length - 8); j < lg.length; j++) {
          logs.push({ event: lg[j].event, data: lg[j].data });
        }
      } catch(e){}
      layer.log = logs;
    }
    out.layers.push(layer);
    var frames;
    try { frames = win.document.querySelectorAll('iframe'); } catch(e){ return; }
    for (var k = 0; k < frames.length; k++) {
      var cw = null;
      try { cw = frames[k].contentWindow; } catch(e){}
      if (!cw) { out.layers.push({ path: pathStr + '/' + k, crossOrigin: true }); continue; }
      visit(cw, pathStr + '/' + k, depth + 1);
    }
  }
  visit(window, 'top', 0);

  // 当前选区（在最深的那个 frame 里）：按 run 分段报 scope
  out.selection = null;
  try {
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      out.selection = { text: sel.toString().slice(0, 400), frames: 'top' };
    }
  } catch(e){}
  return JSON.stringify(out);
})()`;

async function main() {
  const keyword = process.argv[2] || 'chaoxing';
  const tabIndex = process.argv[3] ? Number(process.argv[3]) : null;
  const bridge = new SafariBridge({});
  if (tabIndex === null) {
    const { findTab } = require(path.join(__dirname, '..', 'find-tab.cjs'));
    const tabs = findTab(keyword);
    if (!tabs.length) {
      console.log('找不到标签页：' + keyword);
      return;
    }
    console.log('目标标签：窗口 ' + tabs[0].window + ' 标签 ' + tabs[0].index);
    const rawA = await bridge.evaluate(PROBE, { tabIndex: tabs[0].index, windowIndex: tabs[0].window });
    report(rawA);
    return;
  }
  const rawB = await bridge.evaluate(PROBE, { tabIndex, windowIndex: null });
  report(rawB);
}

function report(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log('解析失败：' + String(raw).slice(0, 400));
    return;
  }
  for (const layer of data.layers || []) {
    if (layer.crossOrigin) {
      console.log(`\n== ${layer.path} == 跨源（无法读取）`);
      continue;
    }
    console.log(`\n== ${layer.path} ==  guard=${layer.hasGuard} bridge=${layer.hasBridge}`);
    if (!layer.hasGuard) continue;
    console.log('  作用域 → 映射条数:');
    for (const [k, v] of Object.entries(layer.mappingKeys || {})) {
      console.log(`    ${k}  → ${v} 条`);
    }
    const cs = layer.charScopes || {};
    const entries = Object.entries(cs);
    console.log(`  charScopes: ${entries.length} 条`);
    const sample = entries.slice(0, 60);
    for (const [ch, scope] of sample) {
      const code = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      const mapped = (layer.mappings || {})[scope] ? (layer.mappings[scope][ch] || '(无)') : '(无该作用域)';
      console.log(`    ${ch} ${code} -> ${scope}  映射=${mapped}`);
    }
    console.log(`  repairs=${layer.repairs} copyEvents=${layer.copyEvents}`);
    console.log(`  lastCollectedScope=${layer.lastCollectedScope}`);
    console.log(`  lastSelectionText=${layer.lastSelectionText}`);
    console.log('  log: ' + JSON.stringify(layer.log));
  }
  if (data.selection) {
    console.log('\n选区文本：' + data.selection.text);
  }
}

main().catch((e) => {
  console.error('失败：' + String(e && e.message ? e.message : e));
  process.exit(1);
});
