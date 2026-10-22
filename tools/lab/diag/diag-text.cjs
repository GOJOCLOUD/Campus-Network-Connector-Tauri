/**
 * 诊断：打印目标标签里各 frame 的文本内容（看页面当前是什么状态）。
 *
 *   node tools/lab/diag-text.cjs [tabIndex]
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  var out = [];
  function v(w, p, d) {
    if (d > 6 || !w) return;
    try {
      var t = (w.document.body ? w.document.body.innerText : '').replace(/\\s+/g, ' ').trim();
      out.push(p + ' len=' + t.length + ' :: ' + t.slice(0, 110));
    } catch (e) { out.push(p + ' ERR ' + String(e)); }
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var i = 0; i < l.length; i++) v(l[i].contentWindow, p + '/' + i, d + 1);
    } catch (e) {}
  }
  v(window, 'top', 0);
  return out.join('\\n');
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 19);
  const bridge = new SafariBridge({});
  const raw = await bridge.evaluate(PROBE, { tabIndex, timeout: 10000 });
  console.log(String(raw));
}

main().catch((e) => {
  console.error('失败：' + String(e && e.message ? e.message : e));
  process.exit(1);
});
