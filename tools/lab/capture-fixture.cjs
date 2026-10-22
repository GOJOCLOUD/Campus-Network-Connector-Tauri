/**
 * 取证：真实站点的加密字体 + 该题的**真值**（页面渲染出来的可见文字），
 * 落成测试夹具，用来钉死"真实站点必须 100% 还原"这条。
 *
 *   node tools/lab/capture-fixture.cjs <tabIndex> <名字>
 *
 * 真值怎么来：页面 DOM 里是密文，剪贴板里是修复后的文字；
 * 两者逐字对齐 → 得到"密文码位 → 明文字"的真值表。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { SafariBridge } = require(path.join(ROOT, 'src/features/safari-repair/bridge'));

const PAGE_PROBE = `(function(){
  var out = { fonts: [], domText: '' };
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

const SELECT_ALL = `(function(){
  var f = null;
  function visit(w, d) {
    if (d > 6 || !w || f) return;
    try {
      var all = w.document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var st = w.getComputedStyle(all[i]);
        if (st && st.fontFamily && st.fontFamily.indexOf('cxsecret') >= 0) { f = w; return; }
      }
    } catch (e) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) visit(l[j].contentWindow, d + 1);
    } catch (e) {}
  }
  visit(window, 0);
  if (!f) return 'no-frame';
  var els = [];
  var all = f.document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var st = f.getComputedStyle(all[i]);
    if (st && st.fontFamily && st.fontFamily.indexOf('cxsecret') >= 0) {
      if ((all[i].textContent || '').trim()) els.push(all[i]);
    }
  }
  if (!els.length) return 'no-els';
  var anc = els[0];
  for (var j = 0; j < els.length; j++) {
    while (anc && anc !== els[j] && anc.contains && !anc.contains(els[j])) anc = anc.parentElement;
  }
  var r = f.document.createRange();
  r.selectNodeContents(anc);
  var s = f.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  f.document.execCommand('copy');
  return 'copied:' + s.toString().length;
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 19);
  const name = process.argv[3] || 'live-quiz';
  const bridge = new SafariBridge({});

  // 1) 选中全部密文 → 复制 → 读剪贴板（= 修复后的可见文字）
  const sel = await bridge.evaluate(SELECT_ALL, { tabIndex, timeout: 15000 });
  await new Promise((r) => setTimeout(r, 700));
  const visible = execFileSync('osascript', ['-e', 'the clipboard as text'], { encoding: 'utf8' });

  // 2) 页面里的 DOM 文本（密文）
  const page = JSON.parse(await bridge.evaluate(PAGE_PROBE, { tabIndex, timeout: 15000 }));
  const dom = page.domText || '';
  const norm = (s) => s.replace(/\r\n?/g, '\n');
  const d = norm(dom);
  const v = norm(visible);

  // 3) 逐字对齐 → 真值表
  const truth = {};
  let di = 0;
  let vi = 0;
  let mismatches = 0;
  while (di < d.length && vi < v.length) {
    const dc = d[di];
    const vc = v[vi];
    if (dc === vc) {
      di += 1;
      vi += 1;
      continue;
    }
    // 密文码位被换成了明文字
    if (!truth[dc]) truth[dc] = vc;
    di += 1;
    vi += 1;
    mismatches += 1;
  }
  const outDir = path.join(ROOT, 'src/features/safari-repair/test/fixtures/live');
  fs.mkdirSync(outDir, { recursive: true });
  const fontB64 = page.fonts[0];
  fs.writeFileSync(path.join(outDir, `${name}.ttf`), Buffer.from(fontB64, 'base64'));
  fs.writeFileSync(
    path.join(outDir, `${name}.truth.json`),
    JSON.stringify({ truth, domText: d, visibleText: v }, null, 1),
  );
  console.log(`已保存夹具 ${name}: 字体 ${page.fonts.length} 份, 真值 ${Object.keys(truth).length} 条`);
  console.log('真值样例:', JSON.stringify(Object.entries(truth).slice(0, 6)));
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
