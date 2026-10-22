/**
 * 回归测试：选区刚换、采集还没轮到就复制 —— 必须**全部**还原，不能只修一半。
 *
 * 故障原理（旧守卫）：
 *   映射表是按字体整份下发的，但"字符 → 作用域"（charScopes）是**采集缓存**，
 *   更新比复制慢一拍。用户改选区后立刻 Cmd+C，新选区里的密文字没有作用域记录
 *   → 查表落空 → 原样进剪贴板。表现就是"前半句修好了、后半句还是密文"。
 *
 * 本脚本模拟这个场景：把 charScopes 清空（= 采集还没轮到），然后立刻复制。
 *
 *   node tools/lab/verify-fastcopy.cjs --tab 20 [--guard /path/to/page-guard.js]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { SafariBridge } = require(path.join(__dirname, '..', '..', 'src', 'features', 'safari-repair', 'bridge'));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TAB = Number(arg('--tab', '20'));
const GUARD = arg('--guard', path.join(__dirname, '..', '..', 'vendor', 'page-guard.js'));
const GUARD_SOURCE = fs.readFileSync(GUARD, 'utf8');

function readClipboard() {
  return execFileSync('osascript', ['-e', 'the clipboard as text'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * 一个 Apple Event 内做完：装守卫 → 搬运映射 → 清采集缓存 → 建选区 → 复制。
 * 全部同步完成，避免被 App 的轮询插进来抢跑。
 */
const SCRIPT = `(function(){
  var GUARD = __GUARD__;
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

  // 记下当前映射（按字体整份下发的那张表）
  var before = W.__copyRepairGuard;
  var mappings = before ? JSON.parse(JSON.stringify(before.mappings || {})) : {};
  var cipherKeys = [];
  for (var k in mappings) {
    for (var c in mappings[k]) cipherKeys.push(c);
  }
  if (!cipherKeys.length) return JSON.stringify({ error: 'no-mapping' });

  // 装上被测守卫（版本不同会自己替换旧的）
  try { W.eval(GUARD); } catch (e) { return JSON.stringify({ error: 'eval-failed: ' + String(e) }); }
  var g = W.__copyRepairGuard;
  if (!g) return JSON.stringify({ error: 'guard-not-installed' });

  // 搬运映射，并**清空采集缓存** —— 模拟"选区刚换，采集还没轮到"
  g.mappings = mappings;
  g.charScopes = {};

  // 建选区：所有混淆字体元素的公共祖先
  var els = [];
  var all = W.document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var st = W.getComputedStyle(all[i]);
    if (st && st.fontFamily && st.fontFamily.indexOf('cxsecret') >= 0) {
      var t = (all[i].textContent || '').trim();
      if (t) els.push(all[i]);
    }
  }
  var anc = els[0];
  for (var j = 0; j < els.length; j++) {
    while (anc && anc !== els[j] && anc.contains && !anc.contains(els[j])) anc = anc.parentElement;
  }
  var r = W.document.createRange();
  r.selectNodeContents(anc);
  var sel = W.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);

  var selected = sel.toString();
  var copied = W.document.execCommand('copy');
  return JSON.stringify({
    selected: selected.length,
    copied: copied,
    cipherKeys: cipherKeys,
    guardVersion: g.version,
    charScopeCount: Object.keys(g.charScopes || {}).length,
    repairs: g.repairs,
    copyEvents: g.copyEvents,
  });
})()`;

async function main() {
  const bridge = new SafariBridge({});
  const js = SCRIPT.replace('__GUARD__', JSON.stringify(GUARD_SOURCE));
  const raw = await bridge.evaluate(js, { tabIndex: TAB, timeout: 20000 });
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log('解析失败：' + String(raw).slice(0, 300));
    process.exit(1);
  }
  if (data.error) {
    console.log('错误：' + data.error);
    process.exit(1);
  }
  console.log(`守卫版本 v${data.guardVersion}  选区 ${data.selected} 字  密文字 ${data.cipherKeys.length} 个`);
  console.log(`复制后：repairs=${data.repairs} copyEvents=${data.copyEvents} charScopes=${data.charScopeCount}`);

  await new Promise((r) => setTimeout(r, 600));
  const text = readClipboard();
  const keys = new Set(data.cipherKeys);
  const remaining = [];
  for (const ch of text) if (keys.has(ch)) remaining.push(ch);
  const uniq = [...new Set(remaining)];
  console.log(`\n剪贴板 ${text.length} 字，残留密文字 ${uniq.length} 个：${uniq.join(' ')}`);
  if (uniq.length === 0) {
    console.log('✔ 通过：选区刚换就复制，也能全部还原');
    process.exitCode = 0;
  } else {
    console.log('✖ 失败：只还原了一部分（采集缓存落空的那些字原样进了剪贴板）');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('失败：' + String(e && e.message ? e.message : e));
  process.exit(1);
});
