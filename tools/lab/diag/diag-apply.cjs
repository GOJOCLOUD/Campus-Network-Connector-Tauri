/**
 * 诊断：逐字复算 applyMapping 的查表路径，找出"该替换却没替换"的字符。
 *
 *   node tools/lab/diag-apply.cjs [tabIndex] [选择方式]
 *     选择方式：full=全选（默认） / judge=只选判断题 / body=只选两个题干
 *
 * 做法：在混淆字体所在 frame 里建选区 → 触发 __copyRepairCollect() →
 *       对选区文本逐字输出 charScopes / mappings 的查表结果。
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  var mode = '__MODE__';
  var out = { mode: mode, cipherFrame: null, selected: '', misses: [], hits: [], scopeTally: {} };

  function findCipher(w, d) {
    if (d > 6 || !w) return null;
    try {
      var all = w.document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var st = w.getComputedStyle(all[i]);
        if (st && st.fontFamily && st.fontFamily.indexOf('cxsecret') >= 0) {
          var t = (all[i].textContent || '').trim();
          if (t && t.length > 4) return w;
        }
      }
    } catch (e) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) {
        var r = findCipher(l[j].contentWindow, d + 1);
        if (r) return r;
      }
    } catch (e) {}
    return null;
  }

  var W = findCipher(window, 0);
  if (!W) return JSON.stringify({ error: 'no-cipher-frame' });
  out.cipherFrame = 'found';

  // 找所有用混淆字体的元素
  var els = [];
  var all = W.document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var st = W.getComputedStyle(all[i]);
    if (st && st.fontFamily && st.fontFamily.indexOf('cxsecret') >= 0) {
      var t = (all[i].textContent || '').trim();
      if (t) els.push(all[i]);
    }
  }

  function pickEl(pred) {
    for (var i = 0; i < els.length; i++) if (pred(els[i])) return els[i];
    return null;
  }
  function txt(el) { return (el.textContent || '').replace(/\\s+/g, ' ').trim(); }

  var target = null;
  if (mode === 'judge') {
    target = pickEl(function (e) { return txt(e).indexOf('\\u5224\\u65ad\\u9898') >= 0 && txt(e).length < 120; });
  } else if (mode === 'body') {
    target = pickEl(function (e) { var t = txt(e); return t.indexOf('\\u5224\\u65ad\\u9898') >= 0 && t.length < 120; });
  } else {
    // full：所有混淆元素的公共祖先
    var anc = els[0];
    for (var j = 0; j < els.length; j++) {
      while (anc && anc !== els[j] && anc.contains && !anc.contains(els[j])) anc = anc.parentElement;
    }
    target = anc;
  }
  if (!target) return JSON.stringify({ error: 'no-target', mode: mode });

  // 建选区
  var r = W.document.createRange();
  if (mode === 'body') {
    // 两个题干：第一个含「单选题」的元素 + 判断题元素
    var single = pickEl(function (e) { var t = txt(e); return t.indexOf('\\u5355\\u9009\\u9898') >= 0 && t.length < 120; });
    var judge = pickEl(function (e) { var t = txt(e); return t.indexOf('\\u5224\\u65ad\\u9898') >= 0 && t.length < 120; });
    if (!single || !judge) return JSON.stringify({ error: 'missing-part' });
    r.setStartBefore(single);
    r.setEndAfter(judge);
  } else {
    r.selectNodeContents(target);
  }
  var sel = W.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  out.selected = sel.toString();

  // 刷新 charScopes
  if (typeof W.__copyRepairCollect === 'function') {
    try { out.collect = String(W.__copyRepairCollect()); } catch (e) { out.collect = 'err'; }
  }

  // 逐字复算查表
  var g = W.__copyRepairGuard;
  if (!g) return JSON.stringify({ error: 'no-guard' });
  var text = sel.toString();
  var seen = {};
  for (var k = 0; k < text.length; k++) {
    var ch = text.charAt(k);
    if (seen[ch]) continue;
    seen[ch] = 1;
    var scopeKey = g.charScopes ? g.charScopes[ch] : undefined;
    var mapping = scopeKey ? g.mappings[scopeKey] : null;
    var mapped = mapping ? mapping[ch] : null;
    out.scopeTally[scopeKey || '(none)'] = (out.scopeTally[scopeKey || '(none)'] || 0) + 1;
    var rec = {
      ch: ch,
      cp: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
      scope: scopeKey || null,
      mapped: mapped || null,
    };
    if (mapped) out.hits.push(rec); else out.misses.push(rec);
  }
  out.mappingsKeys = Object.keys(g.mappings || {});
  out.charScopeCount = Object.keys(g.charScopes || {}).length;
  return JSON.stringify(out);
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 20);
  const mode = process.argv[3] || 'full';
  const bridge = new SafariBridge({});
  const js = PROBE.replace('__MODE__', mode);
  const raw = await bridge.evaluate(js, { tabIndex, timeout: 15000 });
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log('解析失败：' + String(raw).slice(0, 300));
    return;
  }
  if (data.error) {
    console.log('错误：' + data.error);
    return;
  }
  console.log('模式=' + data.mode + '  collect=' + data.collect);
  console.log('选区长度=' + (data.selected || '').length + '  charScopes=' + data.charScopeCount);
  console.log('选区文本：' + String(data.selected || '').replace(/\n/g, '⏎'));
  console.log('\n作用域分布：');
  for (const [k, v] of Object.entries(data.scopeTally || {})) {
    console.log(`  ${v} 次  ${k}`);
  }
  console.log(`\n命中映射 ${data.hits.length} 个：`);
  for (const h of data.hits) console.log(`  ${h.ch} ${h.cp} → ${h.mapped}`);
  console.log(`\n未命中 ${data.misses.length} 个（这些字会原样进剪贴板）：`);
  for (const m of data.misses) console.log(`  ${m.ch} ${m.cp}  scope=${m.scope}`);
}

main().catch((e) => {
  console.error('失败：' + String(e && e.message ? e.message : e));
  process.exit(1);
});
