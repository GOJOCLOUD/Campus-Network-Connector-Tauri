/**
 * 在真实页面上用**完整事件链**点开「章节测验」。
 *
 * 站点对导航按钮的响应绑定在 pointerdown/mousedown/mouseup/click 全链路上，
 * 单纯 `.click()` 不会触发导航（实测）。所以这里逐个派发真实事件。
 *
 *   node tools/lab/open-quiz.cjs [tabIndex]
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  function findByText(w, needle, d) {
    if (d > 5 || !w) return null;
    try {
      var all = w.document.querySelectorAll('a,span,div,li,button');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var t = (el.textContent || '').trim();
        if (t && t.length < 20 && t.indexOf(needle) >= 0) {
          // 取最内层的那个
          if (!el.querySelector('a,span,div,li,button')) return el;
          var deeper = findByText(el, needle, d + 1);
          if (deeper) return deeper;
        }
      }
    } catch (e) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) {
        var r = findByText(l[j].contentWindow, needle, d + 1);
        if (r) return r;
      }
    } catch (e) {}
    return null;
  }

  var el = findByText(window, '__QUIZ_TEXT__', 0);
  if (!el) return JSON.stringify({ error: 'not-found' });
  var rect = el.getBoundingClientRect();
  var opts = {
    bubbles: true, cancelable: true, view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0, buttons: 1, detail: 1,
  };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
  try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { buttons: 0 }))); } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, opts, { buttons: 0 }))); } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('click', Object.assign({}, opts, { buttons: 0 }))); } catch (e) {}
  return JSON.stringify({ clicked: (el.textContent || '').trim().slice(0, 30) });
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 19);
  const bridge = new SafariBridge({});
  const js = PROBE.replace('__QUIZ_TEXT__', process.argv[3] || '章节测验');
  const raw = await bridge.evaluate(js, { tabIndex, timeout: 15000 });
  console.log('点击结果:', raw);
}

main().catch((e) => {
  console.error('失败：' + String(e && e.message ? e.message : e));
  process.exit(1);
});
