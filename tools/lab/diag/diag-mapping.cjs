/**
 * 诊断：页面守卫手里的映射表，和引擎算出来的差在哪？
 *
 *   node tools/lab/diag-mapping.cjs <tabIndex> [期望的字]
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  var out = { scopes: {}, sel: null };
  var g = window.__copyRepairGuard;
  if (!g) return JSON.stringify({ error: 'no-guard' });
  for (var scope in g.mappings) {
    var m = g.mappings[scope];
    out.scopes[scope] = { count: Object.keys(m).length, sample: {} };
  }
  // 选区与每个字的查表结果
  var s = window.getSelection();
  if (s && !s.isCollapsed) {
    var text = s.toString();
    out.sel = { text: text.slice(0, 80), len: text.length, per: [] };
    for (var i = 0; i < text.length && out.sel.per.length < 60; i++) {
      var ch = text[i];
      var scope = g.charScopes[ch];
      var mapped = scope && g.mappings[scope] ? g.mappings[scope][ch] : null;
      out.sel.per.push(ch + '|' + (scope ? scope.slice(0, 30) : 'none') + '|' + (mapped || '-'));
    }
  }
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
  console.log('守卫里的映射表:');
  for (const [scope, info] of Object.entries(data.scopes || {})) {
    console.log(`  ${scope}\n    条数=${info.count}`);
  }
  if (data.sel) {
    console.log(`\n选区(${data.sel.len} 字): ${JSON.stringify(data.sel.text)}`);
    console.log('逐字查表:');
    for (const row of data.sel.per || []) console.log('  ' + row);
  }
}

main().catch((e) => {
  console.error('失败:' + String(e && e.message ? e.message : e));
  process.exit(1);
});
