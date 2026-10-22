/**
 * 列出页面加载/请求过的所有资源（按类型分），找出"题干数据"是从哪个接口来的。
 *
 *   node tools/lab/list-resources.cjs [tabIndex]
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  var out = [];
  function collect(w, p, d) {
    if (d > 6 || !w) return;
    try {
      var res = w.performance.getEntriesByType('resource');
      for (var i = 0; i < res.length; i++) {
        var e = res[i];
        out.push({
          frame: p,
          type: e.initiatorType,
          name: e.name,
          size: e.transferSize,
        });
      }
    } catch (err) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) collect(l[j].contentWindow, p + '/' + j, d + 1);
    } catch (err) {}
  }
  collect(window, 'top', 0);
  return JSON.stringify(out);
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 19);
  const bridge = new SafariBridge({});
  const raw = await bridge.evaluate(PROBE, { tabIndex, timeout: 20000 });
  const list = JSON.parse(raw);
  console.log('共 ' + list.length + ' 条资源\n');
  const byType = {};
  for (const r of list) {
    (byType[r.type] = byType[r.type] || []).push(r);
  }
  for (const [type, items] of Object.entries(byType)) {
    console.log(`--- ${type} (${items.length}) ---`);
    for (const r of items.slice(0, 40)) {
      console.log(`  [${r.frame}] ${r.name.slice(0, 150)}`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error('失败:' + String(e && e.message ? e.message : e));
  process.exit(1);
});
