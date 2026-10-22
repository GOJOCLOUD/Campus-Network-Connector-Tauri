/**
 * 诊断：复刻守卫的"逐段对齐"逻辑，定位段落对不上的地方。
 *
 *   node tools/lab/diag-pieces.cjs [tabIndex]
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  var out = { pieces: [], base: '', align: [] };
  // 选区可能在下层 frame 里 —— 找到有选区的那一层
  var target = null;
  function find(w, d) {
    if (d > 6 || !w || target) return;
    try {
      var s = w.getSelection();
      if (s && !s.isCollapsed && s.rangeCount > 0) { target = w; return; }
    } catch (e) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) find(l[j].contentWindow, d + 1);
    } catch (e) {}
  }
  find(window, 0);
  if (!target) return JSON.stringify({ error: 'no-selection' });
  var sel = target.getSelection();
  var range = sel.getRangeAt(0);
  var root = range.commonAncestorContainer;
  var container = root.nodeType === Node.TEXT_NODE ? (root.parentElement || root) : root;
  out.container = container.tagName + '#' + (container.id || '');
  out.base = sel.toString();

  var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  var node = walker.nextNode();
  while (node) {
    var parent = node.parentElement;
    var hidden = false;
    if (parent) {
      var st = window.getComputedStyle(parent);
      hidden = st.display === 'none' || st.visibility === 'hidden';
    }
    var rec = { parent: parent ? parent.tagName : null, hidden: hidden, text: '' };
    if (parent && !hidden) {
      try {
        if (range.intersectsNode(node)) {
          var sub = range.cloneRange();
          sub.selectNodeContents(node);
          if (sub.compareBoundaryPoints(Range.START_TO_START, range) < 0) sub.setStart(range.startContainer, range.startOffset);
          if (sub.compareBoundaryPoints(Range.END_TO_END, range) > 0) sub.setEnd(range.endContainer, range.endOffset);
          rec.text = sub.toString();
        }
      } catch (e) { rec.err = String(e); }
    }
    out.pieces.push(rec);
    node = walker.nextNode();
  }

  // 对齐
  var pos = 0;
  for (var i = 0; i < out.pieces.length; i++) {
    var p = out.pieces[i];
    if (!p.text) continue;
    var idx = out.base.indexOf(p.text, pos);
    out.align.push({ i: i, parent: p.parent, len: p.text.length, idx: idx, head: p.text.slice(0, 24) });
    if (idx < 0) { out.brokeAt = i; out.brokeText = p.text.slice(0, 40); break; }
    pos = idx + p.text.length;
  }
  out.baseLen = out.base.length;
  out.baseHead = out.base.slice(0, 160);
  out.codes = out.base.slice(0, 40).split('').map(function (c) { return c.charCodeAt(0); }).join(',');
  return JSON.stringify(out);
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 19);
  const bridge = new SafariBridge({});
  const raw = await bridge.evaluate(PROBE, { tabIndex, timeout: 15000 });
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log('解析失败:' + String(raw).slice(0, 300));
    return;
  }
  if (data.error) {
    console.log('错误:' + data.error);
    return;
  }
  console.log('容器:', data.container, ' 选区长度:', data.baseLen);
  console.log('选区前 160 字:', JSON.stringify(data.baseHead));
  console.log('选区前 40 字的码位:', data.codes);
  console.log('\n段落:');
  for (const a of data.align || []) {
    console.log(`  #${a.i} <${a.parent}> len=${a.len} idx=${a.idx} ${JSON.stringify(a.head)}`);
  }
  if (data.brokeAt !== undefined) {
    console.log(`\n✖ 对齐断在第 ${data.brokeAt} 段: ${JSON.stringify(data.brokeText)}`);
  }
  console.log('\n前 6 段原文:');
  for (const p of (data.pieces || []).slice(0, 6)) {
    console.log(`  <${p.parent}> hidden=${p.hidden} ${JSON.stringify(String(p.text).slice(0, 50))}`);
  }
}

main().catch((e) => {
  console.error('失败:' + String(e && e.message ? e.message : e));
  process.exit(1);
});
