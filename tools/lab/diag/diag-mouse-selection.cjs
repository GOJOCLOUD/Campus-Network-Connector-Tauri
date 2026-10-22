/**
 * 诊断：**鼠标拖选式**的选区（跨多个文本节点的 Range）能不能正确还原？
 *
 *   node tools/lab/diag-mouse-selection.cjs [tabIndex]
 *
 * 背景：日常验收用的是 selectNodeContents（单节点整选），
 *      而用户是**鼠标拖选**（Range 跨多个文本节点、可能只覆盖节点的一部分）。
 *      这两条路径喂给守卫的 selection.toString() 不一样，必须单独验。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

function clipboard() {
  try {
    return execFileSync('osascript', ['-e', 'the clipboard as text'], { encoding: 'utf8' }).replace(/\n$/, '');
  } catch (_) {
    return '';
  }
}

const PROBE = `(function(){
  function findSel(w, d) {
    if (d > 6 || !w) return null;
    try { var s = w.getSelection(); if (s && !s.isCollapsed && s.rangeCount > 0) return w; } catch (e) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) { var r = findSel(l[j].contentWindow, d + 1); if (r) return r; }
    } catch (e) {}
    return null;
  }
  function step(name, fn) {
    try { return fn(); } catch (e) { return { __err: name + ': ' + String(e && e.message ? e.message : e) }; }
  }
  var W = findSel(window, 0);
  if (!W) return JSON.stringify({ error: 'no-selection' });
  var r1 = step('walk', function () {
    var nodes = [];
    var all = W.document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var st = W.getComputedStyle(el);
      if (!st || !st.fontFamily || st.fontFamily.indexOf('cxsecret') < 0) continue;
      for (var k = 0; k < el.childNodes.length; k++) {
        var c = el.childNodes[k];
        if (c.nodeType === 3 && c.data && c.data.trim()) nodes.push(c);
      }
    }
    if (nodes.length < 2) return { __err: 'only ' + nodes.length + ' text nodes' };
    // 鼠标拖选：从第一个节点**中间**拖到最后一个节点**中间**
    // （跨多个节点、且两端都不取整节点 —— 最接近真人拖选）
    var a = nodes[0];
    var b = nodes[nodes.length - 1];
    var rg = W.document.createRange();
    rg.setStart(a, Math.floor(a.data.length / 2));
    rg.setEnd(b, Math.floor(b.data.length / 2));
    var s = W.getSelection();
    s.removeAllRanges();
    s.addRange(rg);
    // 选好**立刻**复制（避免被 App 的轮询打断选区）
    document.execCommand('copy');
    return {
      nodes: nodes.length,
      selected: s.toString().length,
      head: s.toString().slice(0, 60),
      tail: s.toString().slice(-40),
    };
  });
  return JSON.stringify(r1);
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 19);
  const bridge = new SafariBridge({});
  const raw = await bridge.evaluate(PROBE, { tabIndex, timeout: 15000 });
  console.log('选区信息:', raw);
  const info = JSON.parse(raw);
  if (info.error) return;

  await new Promise((r) => setTimeout(r, 500));
  const text = clipboard();
  console.log('\n剪贴板内容:');
  console.log(text.slice(0, 300));
  console.log('---');
  // 判断：密文码位是否还在（用守卫的映射键来判）
  const keys = JSON.parse(
    await bridge.evaluate(
      `(function(){
        var g = window.__copyRepairGuard;
        var out = [];
        function findSel(w, d) {
          if (d > 6 || !w) return null;
          try { var s = w.getSelection(); if (s && !s.isCollapsed && s.rangeCount > 0) return w; } catch (e) {}
          try { var l = w.document.querySelectorAll('iframe');
            for (var j = 0; j < l.length; j++) { var r = findSel(l[j].contentWindow, d + 1); if (r) return r; }
          } catch (e) {}
          return null;
        }
        var W = findSel(window, 0);
        var g2 = W && W.__copyRepairGuard;
        var maps = (g2 && g2.mappings) || {};
        for (var sc in maps) for (var ch in maps[sc]) out.push(ch);
        return JSON.stringify(out);
      })()`,
      { tabIndex, timeout: 10000 },
    ),
  );
  const keySet = new Set(keys);
  const left = [...text].filter((c) => keySet.has(c));
  console.log('残留密文码位:', left.length, left.length ? [...new Set(left)].join(' ') : '(无)');
  console.log(left.length === 0 ? '✔ 鼠标拖选式选区也完全还原' : '✖ 有残留');
}

main().catch((e) => {
  console.error('失败:' + String(e && e.message ? e.message : e));
  process.exit(1);
});
