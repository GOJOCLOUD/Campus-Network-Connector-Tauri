/**
 * 复现用户场景：选中**全部 5 道题**后复制，看还有没有密文残留。
 *
 * 关键点：映射必须**按字体建**，否则选区扩大后新增的密文字没有映射。
 */
const { SafariBridge } = require('../../src/features/safari-repair/bridge');
const { InjectorCoordinator } = require('../../src/features/safari-repair/coordinator');

const tabIndex = Number(process.argv[2] || 19);

const SELECT_ALL_QUESTIONS = `(function(){
  // 找到所有用混淆字体的元素，取它们的公共祖先，选中整块
  var els = [];
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var st = window.getComputedStyle(all[i]);
    if (st && st.fontFamily && st.fontFamily.indexOf('cxsecret') >= 0) {
      var t = (all[i].textContent || '').trim();
      if (t) els.push(all[i]);
    }
  }
  if (!els.length) return 'NO-CIPHER-ELS';
  var anc = els[0];
  for (var j = 1; j < els.length; j++) {
    var e = els[j];
    while (anc && anc !== e && anc.contains && !anc.contains(e)) anc = anc.parentElement;
  }
  if (!anc) return 'NO-ANCESTOR';
  var r = document.createRange();
  r.selectNodeContents(anc);
  var s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  return JSON.stringify({ selected: s.toString().length, sample: s.toString().slice(0, 40) });
})()`;

const APPLY = `(function(){
  var s = window.getSelection();
  var text = s ? s.toString() : '';
  var g = window.__copyRepairGuard;
  if (!g) return JSON.stringify({ error: 'NO-GUARD' });
  var out = '', changed = 0;
  // 密文码位集合 = 映射表的 key（这些才是被加密的字）
  var cipherChars = {};
  for (var k in g.mappings) {
    var mk = g.mappings[k];
    for (var ck in mk) cipherChars[ck] = true;
  }
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    var sk = g.charScopes[c];
    var m = sk ? g.mappings[sk] : null;
    var v = m ? m[c] : null;
    if (v && v !== c) { out += v; changed++; }
    else out += c;
  }
  // 统计**输出里还剩多少个密文码位**
  var left = 0, leftSample = [];
  for (var j = 0; j < out.length; j++) {
    if (cipherChars[out[j]]) { left++; if (leftSample.length < 20) leftSample.push(out[j]); }
  }
  return JSON.stringify({
    len: text.length, changed: changed,
    cipherKinds: Object.keys(cipherChars).length,
    mappingSize: Object.keys(g.mappings).map(function(k){return Object.keys(g.mappings[k]).length;}),
    cipherLeft: left, cipherSample: leftSample.join(''),
    out: out.slice(0, 300)
  });
})()`;

async function main() {
  const bridge = new SafariBridge({ log: () => {} });
  const coordinator = new InjectorCoordinator({
    log: (m) => console.log('  ·', m),
    targetTabIndex: tabIndex,
  });
  coordinator.enabled = true;

  // 1) 选中全部 5 题（在第 4 层 frame 内）
  const selInfo = await bridge.evaluate(
    `(function(){
      var found = null;
      function visit(w, d) {
        if (found || d > 6 || !w) return;
        try {
          var st = w.getComputedStyle(w.document.body);
          if (st && st.fontFamily) { /* keep going */ }
          var all = w.document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var s2 = w.getComputedStyle(all[i]);
            if (s2 && s2.fontFamily && s2.fontFamily.indexOf('cxsecret') >= 0) { found = w; return; }
          }
        } catch (e) {}
        try {
          var l = w.document.querySelectorAll('iframe');
          for (var j = 0; j < l.length; j++) visit(l[j].contentWindow, d + 1);
        } catch (e) {}
      }
      visit(window, 0);
      if (!found) return 'NO-CIPHER-FRAME';
      try { return found.eval(${JSON.stringify(SELECT_ALL_QUESTIONS)}); }
      catch (e) { return 'ERR: ' + String(e && e.message ? e.message : e); }
    })()`,
    { tabIndex, timeout: 15000 },
  );
  console.log('[1] 选区:', selInfo);

  // 2) 让协调器跑一轮（注入 + 采集 + 匹配 + 下发）
  for (let i = 0; i < 6; i += 1) {
    const r = await coordinator.tick();
    if (i === 0) console.log('[2] 第 1 轮:', JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 250));
  }

  // 3) 在该 frame 内做一次"页面内模拟改写"，看还有多少密文残留
  const applied = await bridge.evaluate(
    `(function(){
      var found = null;
      function visit(w, d) {
        if (found || d > 6 || !w) return;
        try {
          var all = w.document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            var s2 = w.getComputedStyle(all[i]);
            if (s2 && s2.fontFamily && s2.fontFamily.indexOf('cxsecret') >= 0) { found = w; return; }
          }
        } catch (e) {}
        try {
          var l = w.document.querySelectorAll('iframe');
          for (var j = 0; j < l.length; j++) visit(l[j].contentWindow, d + 1);
        } catch (e) {}
      }
      visit(window, 0);
      if (!found) return 'NO-CIPHER-FRAME';
      try { return found.eval(${JSON.stringify(APPLY)}); }
      catch (e) { return 'ERR: ' + String(e && e.message ? e.message : e); }
    })()`,
    { tabIndex, timeout: 15000 },
  );
  console.log('[3] 页面内改写结果:', applied);
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
