/**
 * Extract the cipher font (base64 data: URL) from the page and analyse it.
 *
 * The site's @font-face for `font-cxsecret` embeds the whole TTF as base64 in
 * a stylesheet. We pull that base64 out of the page, decode it and parse it
 * with opentype.js to answer the decisive question:
 *
 *   does the cipher codepoint share the SAME OUTLINE as the plaintext char?
 *   - same glyph id  -> the cmap reverse map gives an exact mapping
 *   - equal outline  -> we can match by path equality (still exact)
 *   - neither        -> the glyph was redrawn; only shape matching can work
 *
 * Usage: node tools/lab/font-extract.cjs <tabIndex>
 */
const fs = require('node:fs');
const path = require('node:path');
const opentype = require('/Users/wutiaoyun/Desktop/浏览器修复/node_modules/opentype.js');
const { SafariBridge } = require('../../../src/features/safari-repair/bridge');

const ROOT = path.join(__dirname, '..', '..', '..');
const tabIndex = Number(process.argv[2] || 19);

const EXTRACT_JS = `(function(){
  function scan(sheets, label) {
    for (var j = 0; j < sheets.length; j += 1) {
      var ss = sheets[j];
      var rules = null;
      try { rules = ss.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (var k = 0; k < rules.length; k += 1) {
        var r = rules[k];
        if (!r || r.type !== 5) continue;
        var txt = String(r.cssText);
        if (txt.indexOf('cxsecret') < 0) continue;
        var m = txt.match(/base64,([^"')]+)/);
        if (m) return { href: ss.href || '(inline)', label: label, b64: m[1] };
      }
    }
    return null;
  }
  function visit(w, d) {
    if (d > 6 || !w) return null;
    var r = scan(w.document.styleSheets, 'frame' + d);
    if (r) return r;
    try {
      var list = w.document.querySelectorAll('iframe');
      for (var i = 0; i < list.length; i += 1) {
        var sub = visit(list[i].contentWindow, d + 1);
        if (sub) return sub;
      }
    } catch (e) {}
    return null;
  }
  var found = visit(window, 0);
  if (!found) return JSON.stringify({ error: 'not-found' });
  return JSON.stringify({ href: found.href, b64Len: found.b64.length, b64: found.b64 });
})()`;

/** 把 glyph 的轮廓转成可比较的字符串（归一化后的路径指令） */
function pathKey(font, glyphIndex) {
  const p = font.glyphs.get(glyphIndex).getPath(0, 0, 1000);
  return p.commands
    .map((c) => {
      if (c.type === 'M' || c.type === 'L') return `${c.type}${Math.round(c.x)},${Math.round(c.y)}`;
      if (c.type === 'C') return `C${Math.round(c.x1)},${Math.round(c.y1)},${Math.round(c.x2)},${Math.round(c.y2)},${Math.round(c.x)},${Math.round(c.y)}`;
      if (c.type === 'Q') return `Q${Math.round(c.x1)},${Math.round(c.y1)},${Math.round(c.x)},${Math.round(c.y)}`;
      if (c.type === 'Z') return 'Z';
      return c.type;
    })
    .join('|');
}

async function main() {
  const bridge = new SafariBridge({ log: () => {} });
  const raw = await bridge.evaluate(EXTRACT_JS, { tabIndex, timeout: 20000 });
  const info = JSON.parse(raw);
  if (info.error) {
    console.log('未找到 font-cxsecret:', info.error);
    return;
  }
  console.log(`[1] 来源样式表: ${info.href}`);
  console.log(`[2] base64 长度: ${info.b64Len}`);
  const buf = Buffer.from(info.b64, 'base64');
  const outPath = '/tmp/font-cxsecret.ttf';
  fs.writeFileSync(outPath, buf);
  console.log(`[3] 解码字体 ${buf.length} 字节 -> ${outPath}`);

  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  console.log(`    字形数=${font.numGlyphs} 家族=${font.names.fontFamily?.en || '?'}`);

  // 反向 cmap：字形 -> 码位
  const reverse = new Map();
  for (let cp = 0x20; cp < 0x20000; cp += 1) {
    const g = font.charToGlyphIndex(String.fromCodePoint(cp));
    if (!g) continue;
    if (!reverse.has(g)) reverse.set(g, []);
    reverse.get(g).push(cp);
  }
  console.log(`[4] 字形总数=${font.numGlyphs} 被引用的字形数=${reverse.size}`);

  const CIPHERS = ['垕', '垖', '垔', '垘', '垙', '垗', '垚', '垜', '垛', '垝', '垞', '垥', '垨', '垤', '垪', '堊', '垟', '垱', '垬', '垰', '垯', '埡', '垮', '堖', '垳', '塏'];
  const pathIndex = new Map(); // pathKey -> [codepoints]
  for (const [g, cps] of reverse) {
    const key = pathKey(font, g);
    if (!pathIndex.has(key)) pathIndex.set(key, []);
    pathIndex.get(key).push(...cps);
  }
  console.log(`[5] 不同轮廓数=${pathIndex.size}`);

  console.log('\n密文 -> 候选（同一字形 / 同一轮廓）:');
  for (const ch of CIPHERS) {
    const cp = ch.codePointAt(0);
    const g = font.charToGlyphIndex(ch);
    const sameGlyph = reverse.get(g) || [];
    const key = pathKey(font, g);
    const sameOutline = pathIndex.get(key) || [];
    const fmt = (list) =>
      list
        .filter((c) => c >= 0x4e00 && c <= 0x9fff)
        .slice(0, 10)
        .map((c) => `${String.fromCodePoint(c)}(U+${c.toString(16)})`)
        .join(' ');
    console.log(`  ${ch} U+${cp.toString(16)} gid=${g}`);
    console.log(`      同一字形: ${fmt(sameGlyph)}`);
    console.log(`      同一轮廓: ${fmt(sameOutline)}`);
  }
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
