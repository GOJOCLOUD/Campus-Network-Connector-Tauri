/**
 * 最终验收（模拟用户的真实操作 + App 自己的调度）：
 *
 *   1. 确认 App 在跑
 *   2. 确认学习通页**不是**前台标签（这正是之前失效的场景）
 *   3. 在学习通页里程序化选中题目 → 复制 → **读系统剪贴板**核对
 *
 * 全程不自己驱动协调器 —— 一切都由已安装的 App 完成。
 *
 *   node tools/lab/verify-app-e2e.cjs <tabIndex>
 */
const { execFileSync } = require('node:child_process');
const { SafariBridge } = require('../../src/features/safari-repair/bridge');
const { probeCipher } = require('../lab/cipher-probe.cjs');

let tabIndex = Number(process.argv[2] || 19);

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}
function clipboard() {
  try {
    return execFileSync('osascript', ['-e', 'the clipboard as text'], { encoding: 'utf8' }).replace(/\n$/, '');
  } catch (_) {
    return '';
  }
}
function setClipboard(text) {
  execFileSync('osascript', ['-e', `set the clipboard to ${JSON.stringify(text)}`], { encoding: 'utf8' });
}

const SELECT_AND_COPY = `(function(){
  var found = null;
  function visit(w, d) {
    if (found || d > 6 || !w) return;
    try {
      var all = w.document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var s2 = w.getComputedStyle(all[i]);
        if (s2 && s2.fontFamily && /cxsecret/.test(s2.fontFamily)) { found = w; return; }
      }
    } catch (e) {}
    try {
      var l = w.document.querySelectorAll('iframe');
      for (var j = 0; j < l.length; j++) visit(l[j].contentWindow, d + 1);
    } catch (e) {}
  }
  visit(window, 0);
  if (!found) return JSON.stringify({ error: 'no-cipher-frame' });
  try {
    var els = [];
    var all = found.document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var st = found.getComputedStyle(all[i]);
      if (st && st.fontFamily && /cxsecret/.test(st.fontFamily)) {
        var t = (all[i].textContent || '').trim();
        if (t) els.push(all[i]);
      }
    }
    if (!els.length) return JSON.stringify({ error: 'no-cipher-els' });
    var anc = els[0];
    for (var j2 = 1; j2 < els.length; j2++) {
      var e2 = els[j2];
      while (anc && anc !== e2 && anc.contains && !anc.contains(e2)) anc = anc.parentElement;
    }
    var r = found.document.createRange();
    r.selectNodeContents(anc);
    var s = found.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    var len = s.toString().length;
    var text = s.toString();
    found.document.execCommand('copy');
    return JSON.stringify({ selected: len, copied: true, text: text });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
})()`;

/**
 * 取页面里"被字体重映射过的码位"—— 这些就是密文字。
 *
 * ⚠️ 之前这里用的是 Unicode 区段猜测（U+3400–U+4DBF），而学习通真实的密文字
 *    在 U+62xx / U+66xx / U+78xx（如 抲 U+62B2、抸 U+62B8、曳 U+66F3），
 *    **完全落在那个区段之外** → 判定永远为 0 → 假通过。
 *    必须按**实际下发的映射表**来判定：表里的键就是被混淆的码位。
 */
const CIPHER_KEYS = `(function(){
  var out = [];
  var pairs = {};
  try {
    var g = window.__copyRepairGuard;
    if (!g) return JSON.stringify({ error: 'no-guard' });
    var maps = g.mappings || {};
    for (var scope in maps) {
      for (var ch in maps[scope]) {
        out.push(ch);
        pairs[ch] = maps[scope][ch];
      }
    }
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
  return JSON.stringify({ keys: out, pairs: pairs });
})()`;

async function main() {
  const appRunning = execFileSync('pgrep', ['-f', '模拟输入.app/Contents/MacOS'], { encoding: 'utf8' }).trim();
  console.log('[1] App 进程:', appRunning ? '在跑 ✓' : '没跑 ✗');
  if (!appRunning) {
    console.log('    → 先启动 App 再验证');
    process.exitCode = 1;
    return;
  }

  // 按 URL 找目标标签（标签序号会变，URL 不会）
  const raw = execFileSync('osascript', ['-e', `tell application "Safari"
      set out to ""
      repeat with wi from 1 to (count of windows)
        repeat with ti from 1 to (count of tabs of window wi)
          try
            set out to out & wi & "|" & ti & "|" & (URL of tab ti of window wi) & linefeed
          end try
        end repeat
      end repeat
      return out
    end tell`], { encoding: 'utf8' });
  const list = String(raw).split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [w, t, ...r] = l.split('|'); return { window: Number(w), index: Number(t), url: r.join('|') }; });
  const hit = list.find((t) => t.url.includes('mooc1.chaoxing.com'));
  if (!hit) {
    console.log('找不到学习通页标签,当前标签:');
    for (const t of list) console.log('   ', t.window, t.index, t.url.slice(0, 70));
    process.exitCode = 1;
    return;
  }
  tabIndex = hit.index;
  const frontUrl = osa('tell application "Safari" to return URL of front tab of front window');
  const targetUrl = hit.url;
  const isFront = frontUrl === targetUrl;
  console.log(`[2b] 目标标签定位: 窗口 ${hit.window} 标签 ${hit.index}`);
  console.log(`[2] Safari 前台标签: ${frontUrl.slice(0, 56)}`);
  console.log(`    目标标签(${tabIndex}): ${targetUrl.slice(0, 56)}`);
  console.log(`    目标是否在前台: ${isFront ? '是' : '否 ← 正是之前失效的场景'}`);

  // 给 App 一点时间接管（它每 2 轮扫一次目标站点的标签）
  await new Promise((r) => setTimeout(r, 2500));

  setClipboard('SENTINEL');
  const bridge = new SafariBridge({ log: () => {} });
  const selRaw = await bridge.evaluate(SELECT_AND_COPY, { tabIndex, timeout: 20000 });
  let sel = {};
  try {
    sel = JSON.parse(selRaw);
  } catch (e) {
    sel = { raw: String(selRaw) };
  }
  console.log('[3] 选区+复制:', JSON.stringify({ selected: sel.selected, copied: sel.copied, error: sel.error }));
  await new Promise((r) => setTimeout(r, 800));

  const text = clipboard();
  console.log('\n[4] 系统剪贴板:');
  console.log(text.slice(0, 400));
  console.log('---');

  // 密文字残留判定：用**引擎**算出的密文码位集合（含没能还原的）。
  // 只看映射表的键会漏判 —— 没还原的码位不在表里（实测「坉」就这么漏判成"通过"）。
  const probe = await probeCipher(bridge, tabIndex);
  const cipherSet = new Set(probe.cipherChars);
  const cipherLeft = [...text].filter((c) => cipherSet.has(c));
  const uniqLeft = [...new Set(cipherLeft)];
  const unmapped = probe.unmapped;

  // 复核：页面选区文本按映射替换后的结果，必须与剪贴板**逐字一致**
  const domText = probe.domText;
  const expected = [...domText].map((c) => (probe.mapped[c] !== undefined ? probe.mapped[c] : c)).join('');
  const norm = (s) => s.replace(/\r\n?/g, '\n');
  const exactlySame = norm(expected) === norm(text);

  const ok =
    text.length > 10 &&
    !text.includes('SENTINEL') &&
    cipherLeft.length === 0 &&
    exactlySame &&
    unmapped.length === 0;
  console.log(ok ? '✔ 通过：剪贴板里是修复后的可见文字' : '✖ 失败');
  console.log(`    长度=${text.length} 含SENTINEL=${text.includes('SENTINEL')}`);
  console.log(
    `    密文码位=${probe.cipherChars.length} 个，残留=${cipherLeft.length} 个` +
      `${uniqLeft.length ? '（' + uniqLeft.join(' ') + '）' : ''}`,
  );
  console.log(
    `    已还原=${Object.keys(probe.mapped).length} 个` +
      `${unmapped.length ? `，没能还原=${unmapped.length} 个（${unmapped.join(' ')}）` : ''}`,
  );
  console.log(`    按映射替换后与剪贴板逐字一致=${exactlySame ? '是' : '否'}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
