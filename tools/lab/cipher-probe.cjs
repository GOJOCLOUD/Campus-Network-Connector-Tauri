/**
 * 探针：问页面要「加密字体 + 选区」，用**引擎**算出哪些码位是密文码位、
 * 哪些没能还原。验收脚本据此判定"剪贴板里还有没有没还原的密文"。
 *
 *   node tools/lab/cipher-probe.cjs <tabIndex>
 *
 * 为什么不能只看映射表的键：
 *   **没被还原的码位不在表里** —— 那样就查不出残留（实测「坉」就这么漏判）。
 * 为什么不能只看"用加密字体渲染的字符"：
 *   加密字体里也装着大量**没被重映射**的正常字（【】创业必备…），那是明文。
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', 'src', 'features', 'safari-repair', 'bridge'));
const { GlyphEngine } = require(path.join(__dirname, '..', '..', 'src', 'features', 'safari-repair', 'engine'));

/** 从页面取：加密字体的 base64、选区原文 */
const PAGE_PROBE = `(function(){
  var out = { fonts: [], domText: '', cipherFontChars: [] };
  function visit(w, p, d) {
    if (d > 6 || !w) return;
    try {
      var sheets = Array.from(w.document.styleSheets);
      for (var s = 0; s < sheets.length; s++) {
        var rules = null;
        try { rules = sheets[s].cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) {
          if (rules[r].type !== 5) continue;
          var fam = String(rules[r].style.fontFamily || '');
          if (!/cxsecret/i.test(fam)) continue;
          var src = String(rules[r].style.getPropertyValue('src') || '');
          var m = src.match(/base64,([^)]+)/);
          if (m) out.fonts.push(m[1]);
        }
      }
    } catch (e) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) visit(l[j].contentWindow, p + '/' + j, d + 1);
    } catch (e) {}
  }
  visit(window, 'top', 0);
  // 选区所在 frame
  function findSel(w, d) {
    if (d > 6 || !w) return null;
    try {
      var s = w.getSelection();
      if (s && !s.isCollapsed && s.rangeCount > 0) return w;
    } catch (e) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) {
        var r = findSel(l[j].contentWindow, d + 1);
        if (r) return r;
      }
    } catch (e) {}
    return null;
  }
  var f = findSel(window, 0);
  if (f) out.domText = f.getSelection().toString();
  return JSON.stringify(out);
})()`;

/**
 * 算出：密文码位集合、已还原的映射、没能还原的码位。
 * @returns {Promise<{cipherChars:string[], mapped:Object, unmapped:string[], domText:string}>}
 */
async function probeCipher(bridge, tabIndex, engine) {
  const raw = await bridge.evaluate(PAGE_PROBE, { tabIndex, timeout: 15000 });
  const page = JSON.parse(raw);
  const eg = engine || new GlyphEngine({ log: () => {} });
  const mapped = {};
  const unmapped = [];
  for (const b64 of page.fonts || []) {
    const font = { kind: 'data', value: b64 };
    // 取字体里的全部码位：引擎会逐个分析，映射表 + 不确定的
    const result = await eg.processScope('probe-' + b64.length, [], font, {});
    for (const [ch, plain] of Object.entries(result.mapping || {})) mapped[ch] = plain;
    for (const u of result.uncertain || []) unmapped.push(u.char);
  }
  // 字体里"被重映射但被闸门挡住"的码位 = 引擎没给出映射、但字体里存在且不是自身
  const cipherChars = [...new Set([...Object.keys(mapped), ...unmapped])];
  return { cipherChars, mapped, unmapped: [...new Set(unmapped)], domText: page.domText || '' };
}

module.exports = { probeCipher, PAGE_PROBE };

if (require.main === module) {
  const tabIndex = Number(process.argv[2] || 19);
  const bridge = new SafariBridge({});
  probeCipher(bridge, tabIndex)
    .then((r) => {
      console.log('密文码位', r.cipherChars.length, '个');
      console.log('已还原', Object.keys(r.mapped).length, '个');
      console.log('没能还原', r.unmapped.length, '个:', r.unmapped.join(' '));
    })
    .catch((e) => {
      console.error('失败:', e && e.message ? e.message : e);
      process.exit(1);
    });
}
