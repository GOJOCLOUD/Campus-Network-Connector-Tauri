/**
 * 规模回归：字体里**所有**可能用到的字，都必须被映射，且速度可接受。
 *
 * 背景：真实需求是"把站点可能用到的密文字全部还原"，不是"只还原当前选区里的字"。
 * 这个测试直接对**整个字体**的码位表做断言：
 *   - 覆盖率 = 100%（一个都不能漏）
 *   - 判定正确率 = 100%
 *   - 耗时在可接受范围内（用户来不及等就会复制出乱码）
 *
 *   node safari-repair/test/stress-font.cjs [--font <参考字体路径>] [--n 1000]
 *
 * 不带 --font 时用仓库自带的 132 字测试字体（不需要外部字体）。
 */
const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const opentype = require(paths.vendor('opentype.js'));
const { GlyphEngine } = require(path.join(__dirname, '..', 'engine'));
const { COMMON_CHARSET } = require(paths.vendor('common-charset.js'));

/**
 * 屏幕坐标(y 向下) → 字体坐标(y 向上)。
 * getPath(..., 0, 0, upem) 返回的已经是**字体单位**的屏幕坐标，只需翻 y，不再缩放。
 */
function toFontUnits(cmd, upem) {
  switch (cmd.type) {
    case 'M': return { type: 'M', x: cmd.x * upem, y: -cmd.y * upem };
    case 'L': return { type: 'L', x: cmd.x * upem, y: -cmd.y * upem };
    case 'Q': return { type: 'Q', x1: cmd.x1 * upem, y1: -cmd.y1 * upem, x: cmd.x * upem, y: -cmd.y * upem };
    case 'C': return { type: 'C', x1: cmd.x1 * upem, y1: -cmd.y1 * upem, x2: cmd.x2 * upem, y2: -cmd.y2 * upem, x: cmd.x * upem, y: -cmd.y * upem };
    case 'Z': return { type: 'Z' };
    default: return cmd;
  }
}

/** 用参考字体造一个"密文字体"：码位是 underlying，字形画的是 display */
function buildObfuscatedFont(sourcePath, pairs, familyName) {
  const source = opentype.parse(fs.readFileSync(sourcePath));
  const upem = source.unitsPerEm;
  const glyphs = [
    new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: upem, path: new opentype.Path() }),
  ];
  for (const [underlying, display] of Object.entries(pairs)) {
    const uCp = underlying.codePointAt(0);
    const srcPath = source.getPath(display, 0, 0, upem);
    const p = new opentype.Path();
    p.commands = srcPath.commands.map((c) => toFontUnits(c, 1));
    glyphs.push(new opentype.Glyph({ name: `uni${uCp.toString(16)}`, unicode: uCp, advanceWidth: upem, path: p }));
  }
  const font = new opentype.Font({
    familyName,
    styleName: 'Regular',
    unitsPerEm: upem,
    ascender: source.ascender ?? upem * 0.88,
    descender: source.descender ?? -upem * 0.12,
    glyphs,
  });
  return Buffer.from(font.toArrayBuffer());
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const fontPath = arg('--font', null);
  const n = Number(arg('--n', '1000'));
  const timeBudgetMs = Number(arg('--budget', '2000'));

  let fontBytes;
  let pairs;
  let label;

  if (fontPath) {
    // 造字体需要 n*2 个不同的字：常用字不够就从参考库里取
    let chars = Array.from(COMMON_CHARSET);
    if (chars.length < n * 2) {
      // 参考库随包分发的是 **gzip** 版（vendor/glyph-db-48.crdb.gz），
      // 未压缩的 .crdb 不再存在 —— 这里必须走引擎自己的 loadDb（它会解 gzip）。
      const { GlyphEngine } = require(path.join(__dirname, '..', 'engine'));
      const engine = new GlyphEngine({ log: () => {} });
      const db = engine.loadDb('glyph-db-48.crdb.gz');
      chars = Array.from(db.codepoints)
        .filter((cp) => cp >= 0x3400 && cp <= 0x9fff)
        .map((cp) => String.fromCodePoint(cp));
    }
    if (chars.length < n * 2) throw new Error(`可用字只有 ${chars.length} 个，不够造 ${n} 组的字体`);
    pairs = {};
    for (let i = 0; i < n; i += 1) pairs[chars[i]] = chars[Math.floor(chars.length / 2) + i];
    fontBytes = buildObfuscatedFont(fontPath, pairs, 'ObfStress');
    label = `${n} 字合成字体`;
  } else {
    fontBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'fonts', 'obf-same-style.ttf'));
    const map = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'fonts', 'obf-same-style.map.json'), 'utf8'),
    );
    pairs = {};
    for (const [k, v] of Object.entries(map)) pairs[k] = v;
    label = `${Object.keys(pairs).length} 字仓库测试字体`;
  }

  const engine = new GlyphEngine({ log: (m) => console.log('   ' + m) });
  const b64 = fontBytes.toString('base64');
  const chars = Object.keys(pairs);

  const t0 = Date.now();
  const result = await engine.processScope('stress', chars, { kind: 'data', value: b64 });
  const ms = Date.now() - t0;

  const mapped = Object.keys(result.mapping).length;
  let correct = 0;
  const wrong = [];
  for (const c of chars) {
    const got = result.mapping[c];
    if (got === pairs[c]) correct += 1;
    else if (got) wrong.push(`${c}->${got}(应${pairs[c]})`);
  }

  console.log(`\n[${label}]`);
  console.log(`  码位总数      : ${chars.length}`);
  console.log(`  映射条数      : ${mapped}   ${mapped === chars.length ? '✔ 全覆盖' : '✗ 有漏'}`);
  console.log(`  判定正确      : ${correct}/${chars.length}   ${correct === chars.length ? '✔ 全对' : '✗ ' + wrong.slice(0, 5).join(' ')}`);
  console.log(`  总耗时        : ${ms}ms   ${ms <= timeBudgetMs ? '✔ 在预算内' : '✗ 超预算'}`);

  const ok = mapped === chars.length && correct === chars.length && ms <= timeBudgetMs;
  console.log(ok ? '\n✔ 规模回归通过' : '\n✖ 规模回归失败');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
