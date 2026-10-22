/**
 * 诊断：为什么只有第 1 题被还原？
 *
 * 在每个 frame 里列出**所有**用到混淆字体的作用域（样式/字重/字体族），
 * 各自的字符数、样本文字，以及守卫当前持有的映射情况。
 */
(function () {
  var out = [];
  function scopeOf(el) {
    var st = window.getComputedStyle(el);
    return { style: st.fontStyle, weight: st.fontWeight, family: st.fontFamily, key: st.fontStyle + '|' + st.fontWeight + '|' + st.fontFamily };
  }
  function walk(w, path, d) {
    if (d > 6 || !w) return;
    var rec = { path: path, scopes: [], guard: null };
    try {
      var g = w.__copyRepairGuard;
      if (g) {
        rec.guard = {
          version: g.version,
          mappings: Object.keys(g.mappings || {}).map(function (k) {
            return { key: k, chars: Object.keys(g.mappings[k] || {}).length, sample: Object.keys(g.mappings[k] || {}).slice(0, 6).join('') };
          }),
          charScopes: Object.keys(g.charScopes || {}).length,
          pending: g.pending ? (g.pending.groups || []).map(function (x) {
            return { key: x.scopeKey, family: x.family, chars: (x.chars || []).length, font: x.font ? (x.font.kind + ':' + String(x.font.value).length) : null };
          }) : null,
          log: (g.log || []).slice(-6).map(function (e) { return e.event; })
        };
      }
      // 所有元素的字体作用域统计（只统计有文字的）
      var counts = {};
      var els = w.document.querySelectorAll('*');
      for (var i = 0; i < els.length; i += 1) {
        var el = els[i];
        var sc = scopeOf(el);
        if (!sc.family) continue;
        var text = (el.textContent || '').trim();
        if (!text) continue;
        if (!counts[sc.key]) counts[sc.key] = { key: sc.key, weight: sc.weight, family: sc.family, chars: 0, els: 0, sample: '' };
        counts[sc.key].chars += text.length;
        counts[sc.key].els += 1;
        if (!counts[sc.key].sample) counts[sc.key].sample = text.slice(0, 30);
      }
      rec.scopes = Object.keys(counts).map(function (k) { return counts[k]; })
        .filter(function (s) { return /cxsecret|font-|secret/i.test(s.family) || s.chars > 20; })
        .sort(function (a, b) { return b.chars - a.chars; });
      // 当前选区
      var sel = w.getSelection();
      rec.sel = sel ? sel.toString().length : -1;
      rec.selHead = sel ? sel.toString().slice(0, 40) : '';
    } catch (e) {
      rec.err = String(e && e.message ? e.message : e);
    }
    out.push(rec);
    try {
      var fs = w.document.querySelectorAll('iframe');
      for (var j = 0; j < fs.length; j += 1) walk(fs[j].contentWindow, path + '/' + j, d + 1);
    } catch (e) {}
  }
  walk(window, 'top', 0);
  return JSON.stringify(out);
})()
