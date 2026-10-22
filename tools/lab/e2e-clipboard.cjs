/**
 * 端到端验收（不需要人手）:在真实页面里程序化选中题目 → 触发复制 → 读**系统剪贴板**核对。
 *
 * 这条链覆盖了用户实际会走的那条:
 *   页面守卫 → copy 事件 → setData+preventDefault → 系统剪贴板
 *
 *   node tools/lab/e2e-clipboard.cjs <tabIndex>
 */
const { execFileSync } = require('node:child_process');
const { SafariBridge } = require('../../src/features/safari-repair/bridge');
const { InjectorCoordinator } = require('../../src/features/safari-repair/coordinator');
const { probeCipher } = require('./cipher-probe.cjs');

const tabIndex = Number(process.argv[2] || 19);

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

/** 在"用混淆字体的那个 frame"里选中全部题目并复制 */
const SELECT_AND_COPY = `(function(){
  var found = null;
  function visit(w, d) {
    if (found || d > 6 || !w) return;
    try {
      var all = w.document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var s2 = w.getComputedStyle(all[i]);
        if (s2 && s2.fontFamily && s2.fontFamily.indexOf('cxsecret') >= 0) { found = w; return; }
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
    // 选中所有用混淆字体的元素的公共祖先
    var els = [];
    var all = found.document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var st = found.getComputedStyle(all[i]);
      if (st && st.fontFamily && st.fontFamily.indexOf('cxsecret') >= 0) {
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
    found.document.execCommand('copy');
    return JSON.stringify({ selected: len, copied: true });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
})()`;

async function main() {
  const bridge = new SafariBridge({ log: () => {} });
  // --no-coordinator:不自己驱动协调器,让**已安装的 App** 来做(验证 App 自己的调度)
  const useOwn = !process.argv.includes('--no-coordinator');
  const coordinator = new InjectorCoordinator({ log: () => {}, targetTabIndex: tabIndex });
  coordinator.enabled = useOwn;

  if (useOwn) {
    // 预热：先让协调器跑几轮，把映射建好并下发（不需要选区）
    for (let i = 0; i < 4; i += 1) {
      await coordinator.tick();
      await new Promise((r) => setTimeout(r, 250));
    }
  } else {
    console.log('（不自己驱动,等 App 调度;若 App 未开开关则本测试会失败）');
    await new Promise((r) => setTimeout(r, 2000));
  }

  setClipboard('SENTINEL');
  const sel = await bridge.evaluate(SELECT_AND_COPY, { tabIndex, timeout: 20000 });
  console.log('选区+复制:', sel);
  await new Promise((r) => setTimeout(r, 800));

  const text = clipboard();
  console.log('\n系统剪贴板内容:');
  console.log(text.slice(0, 400));
  console.log('---');
  // 密文字判定：用**引擎**算出的密文码位集合（含没能还原的）。
  // 只看映射表的键会漏判 —— 没还原的码位不在表里（实测「坉」就这么漏判成"通过"）。
  const probe = await probeCipher(bridge, tabIndex);
  const cipherSet = new Set(probe.cipherChars);
  const cipherLeft = [...text].filter((c) => cipherSet.has(c));
  const uniqLeft = [...new Set(cipherLeft)];
  const ok = text.length > 10 && cipherLeft.length === 0 && !text.includes('SENTINEL');
  console.log(ok ? '✔ 端到端通过：剪贴板里是修复后的可见文字' : '✖ 端到端失败');
  console.log(
    `   长度=${text.length} 残留密文字=${cipherLeft.length}` +
      `${uniqLeft.length ? '（' + uniqLeft.join(' ') + '）' : ''} 仍是哨兵=${text.includes('SENTINEL')}`,
  );
  console.log(
    `   · 加密字体码位 ${probe.cipherChars.length} 个，已还原 ${Object.keys(probe.mapped).length} 个` +
      `${probe.unmapped.length ? `，没能还原 ${probe.unmapped.length} 个（${probe.unmapped.join(' ')}）` : ''}`,
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
