/**
 * 诊断：在混淆字体所在 frame 里连续采集 N 次，观察
 *   - 每次上报的作用域 key（是否闪变）
 *   - charScopes 里那几个"漏网"字符指向哪个作用域
 *   - mappings 里该作用域有幾条
 *
 *   node tools/lab/diag-loop.cjs [tabIndex] [次数]
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  var N = __N__;
  var out = { samples: [], cipherFrame: null };
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

  // 目标字符（就是那几个漏网的）
  var WATCH = ['\\u62B2', '\\u62B8', '\\u62B6', '\\u66F3', '\\u62B7', '\\u62B3', '\\u7832'];

  for (var k = 0; k < N; k++) {
    var rec = {};
    try {
      if (typeof W.__copyRepairCollect === 'function') W.__copyRepairCollect();
    } catch (e) { rec.collectErr = String(e); }
    var g = W.__copyRepairGuard;
    if (!g) { rec.noGuard = true; out.samples.push(rec); continue; }
    rec.pendingScopes = g.pending && g.pending.groups
      ? g.pending.groups.map(function (x) { return x.scopeKey + '[' + x.chars.length + ']'; })
      : [];
    rec.mappingKeys = Object.keys(g.mappings || {});
    rec.mapCounts = {};
    for (var mk in g.mappings) rec.mapCounts[mk] = Object.keys(g.mappings[mk]).length;
    rec.watch = {};
    for (var i = 0; i < WATCH.length; i++) {
      var ch = WATCH[i];
      var sc = g.charScopes ? g.charScopes[ch] : undefined;
      rec.watch[ch] = {
        scope: sc || null,
        mapped: sc && g.mappings[sc] ? (g.mappings[sc][ch] || null) : null,
      };
    }
    rec.charScopeCount = Object.keys(g.charScopes || {}).length;
    out.samples.push(rec);
  }
  return JSON.stringify(out);
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 20);
  const n = Number(process.argv[3] || 15);
  const bridge = new SafariBridge({});
  const raw = await bridge.evaluate(PROBE.replace('__N__', String(n)), { tabIndex, timeout: 20000 });
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
  for (let i = 0; i < data.samples.length; i += 1) {
    const s = data.samples[i];
    console.log(`\n--- 第 ${i + 1} 次采集 ---`);
    console.log('  上报作用域：' + (s.pendingScopes || []).join('  |  '));
    console.log('  mappings：' + JSON.stringify(s.mapCounts));
    console.log('  charScopes 条数：' + s.charScopeCount);
    for (const [ch, w] of Object.entries(s.watch || {})) {
      console.log(`    ${ch} scope=${w.scope} 映射=${w.mapped}`);
    }
  }
}

main().catch((e) => {
  console.error('失败：' + String(e && e.message ? e.message : e));
  process.exit(1);
});
