/**
 * 诊断：逐 frame 查 font-cxsecret 的 @font-face，并列出用混淆字体的文本节点作用域。
 *
 *   node tools/lab/diag-fonts.cjs [tabIndex]
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
 try {
  var out = { faces: [], cipherEls: [], byFrame: {} };
  var byFrame = out.byFrame;

  function collectFaces(w, pathStr, d) {
    if (d > 6 || !w) return;
    var sheets = [];
    try { sheets = Array.from(w.document.styleSheets); } catch (e) { sheets = []; }
    var frameInfo = byFrame[pathStr] || (byFrame[pathStr] = { sheets: sheets.length, cross: 0, faces: [] });
    for (var s = 0; s < sheets.length; s++) {
      var rules = null;
      try { rules = sheets[s].cssRules; } catch (e) { frameInfo.cross++; continue; }
      if (!rules) { frameInfo.cross++; continue; }
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (rule.type !== 5) continue;
        var fam = String(rule.style && rule.style.fontFamily || '');
        if (fam.toLowerCase().indexOf('cxsecret') < 0) continue;
        var src = String(rule.style && rule.style.getPropertyValue('src') || '');
        var rec = {
          frame: pathStr,
          family: fam,
          weight: String(rule.style && rule.style.fontWeight || ''),
          style: String(rule.style && rule.style.fontStyle || ''),
          srcLen: src.length,
          srcHead: src.slice(0, 100),
          isData: src.indexOf('data:') >= 0,
        };
        out.faces.push(rec);
        frameInfo.faces.push(rec);
      }
    }
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) collectFaces(l[j].contentWindow, pathStr + '/' + j, d + 1);
    } catch (e) {}
  }
  collectFaces(window, 'top', 0);

  function collectText(w, pathStr, d) {
    if (d > 6 || !w) return;
    try {
      var walker = w.document.createTreeWalker(w.document.body || w.document, NodeFilter.SHOW_TEXT);
      var node = walker.nextNode();
      var seen = {};
      while (node) {
        var t = node.data;
        if (t && t.trim()) {
          var st = w.getComputedStyle(node.parentElement);
          if (st && st.fontFamily && st.fontFamily.indexOf('cxsecret') >= 0) {
            var key = st.fontStyle + '|' + st.fontWeight + '|' + st.fontFamily + '|' + pathStr;
            if (!seen[key]) {
              seen[key] = 1;
              out.cipherEls.push({
                path: pathStr,
                scope: st.fontStyle + '|' + st.fontWeight + '|' + st.fontFamily,
                sample: t.replace(/\\s+/g, ' ').trim().slice(0, 60),
              });
            }
          }
        }
        node = walker.nextNode();
      }
    } catch (e) { out.collectErr = String(e); }
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) collectText(l[j].contentWindow, pathStr + '/' + j, d + 1);
    } catch (e) {}
  }
  collectText(window, 'top', 0);
  return JSON.stringify(out);
 } catch (e) {
  return JSON.stringify({ error: String(e && e.name) + ' | ' + String(e && e.message) + ' | ' + String(e && e.stack) });
 }
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 20);
  const bridge = new SafariBridge({});
  const raw = await bridge.evaluate(PROBE, { tabIndex, timeout: 15000 });
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log('解析失败：' + String(raw).slice(0, 400));
    return;
  }
  if (data.error) {
    console.log('错误：' + data.error);
    return;
  }
  for (const [pathStr, info] of Object.entries(data.byFrame || {})) {
    console.log(`[${pathStr}] 样式表 ${info.sheets} 张，跨源 ${info.cross} 张，cxsecret @font-face ${info.faces.length} 条`);
  }
  console.log(`\nfont-cxsecret 的 @font-face 共 ${data.faces.length} 条：`);
  for (const f of data.faces) {
    console.log(`  [${f.frame}] family=${f.family} weight=${f.weight} style=${f.style} data=${f.isData} src长度=${f.srcLen}`);
    console.log(`      ${f.srcHead}`);
  }
  console.log(`\n用混淆字体的文本节点（按 scope 去重）共 ${data.cipherEls.length} 处：`);
  for (const e of data.cipherEls) {
    console.log(`  [${e.path}] ${e.scope}`);
    console.log(`      ${e.sample}`);
  }
}

main().catch((e) => {
  console.error('失败：' + String(e && e.message ? e.message : e));
  process.exit(1);
});
