/**
 * 决定性验证 v2：把"被还原出来的每一个明文字"逐个丢进同源接口的响应里搜。
 *
 *   node tools/lab/fetch-plaintext.cjs [tabIndex]
 *
 * 只要响应里出现任何一个**只可能来自原文**的明文字，就说明明文就在接口响应里
 * → 就不该再靠像素反推。
 */
const path = require('path');
const { SafariBridge } = require(path.join(__dirname, '..', '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

const PROBE = `(function(){
  function findSel(w, d) {
    if (d > 6 || !w) return null;
    try { var s = w.getSelection(); if (s && !s.isCollapsed && s.rangeCount > 0) return w; } catch (e) {}
    try { var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) { var r = findSel(l[j].contentWindow, d + 1); if (r) return r; }
    } catch (e) {}
    return null;
  }
  var W = findSel(window, 0);
  if (!W) return JSON.stringify({ error: 'no-selection' });

  var g = W.__copyRepairGuard;
  var maps = (g && g.mappings) || {};
  var cipherText = W.getSelection().toString();

  // 逐字：密文码位 → 明文字（只取确实被重映射过的）
  var restored = [];
  for (var i = 0; i < cipherText.length; i++) {
    var c = cipherText[i];
    for (var scope in maps) {
      if (maps[scope][c] !== undefined) { restored.push({ cipher: c, plain: maps[scope][c] }); break; }
    }
  }
  var url = W.location.href;
  W.__plainProbe2 = { pending: true, url: url, restored: restored.slice(0, 40) };

  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.onload = function () {
    var body = xhr.responseText || '';
    var res = { status: xhr.status, len: body.length, hits: [], samples: [], cipherHit: body.indexOf(cipherText.slice(0, 30)) >= 0 };
    var seen = {};
    for (var i = 0; i < restored.length; i++) {
      var p = restored[i].plain;
      if (seen[p]) continue;
      seen[p] = 1;
      var at = body.indexOf(p);
      if (at >= 0 && res.hits.length < 8) {
        res.hits.push(p);
        res.samples.push(p + ' → ' + body.slice(Math.max(0, at - 90), at + 90).replace(/\\s+/g, ' '));
      }
    }
    W.__plainProbe2 = res;
  };
  xhr.onerror = function () { W.__plainProbe2 = { error: 'xhr-failed' }; };
  xhr.send();
  return JSON.stringify({ pending: true, url: url, restored: restored.length, chars: restored.slice(0, 12) });
})()`;

async function main() {
  const tabIndex = Number(process.argv[2] || 19);
  const bridge = new SafariBridge({});
  const first = JSON.parse(await bridge.evaluate(PROBE, { tabIndex, timeout: 20000 }));
  console.log('题目 frame URL:', first.url);
  console.log('被还原的明文字:', first.restored, '个 →', JSON.stringify(first.chars));
  if (first.error) { console.log('错误:', first.error); return; }

  const READ = `(function(){
    function findSel(w, d) {
      if (d > 6 || !w) return null;
      try { var s = w.getSelection(); if (s && !s.isCollapsed && s.rangeCount > 0) return w; } catch (e) {}
      try { var l = w.document.querySelectorAll('iframe');
        for (var j = 0; j < l.length; j++) { var r = findSel(l[j].contentWindow, d + 1); if (r) return r; }
      } catch (e) {}
      return null;
    }
    var W = findSel(window, 0);
    return JSON.stringify((W && W.__plainProbe2) || { pending: true });
  })()`;

  for (let i = 0; i < 14; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const res = JSON.parse(await bridge.evaluate(READ, { tabIndex, timeout: 10000 }));
    if (res.error) { console.log('错误:', res.error); return; }
    if (res.hits || res.len) {
      console.log('\nHTTP', res.status, ' 响应长度', res.len, ' 响应里有密文片段:', res.cipherHit);
      console.log('命中的明文字:', res.hits.length ? res.hits.join(' ') : '(一个都没有)');
      for (const s of res.samples || []) console.log('  ' + s);
      return;
    }
  }
  console.log('(没取到结果)');
}

main().catch((e) => {
  console.error('失败:' + String(e && e.message ? e.message : e));
  process.exit(1);
});
