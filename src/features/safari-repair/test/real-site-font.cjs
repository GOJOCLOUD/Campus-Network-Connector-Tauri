/**
 * 真实站点字体回归：用**真实加密字体 + 真值**钉死"必须 100% 还原"。
 *
 *   node src/features/safari-repair/test/real-site-font.cjs
 *
 * 这条测试守的是两个**系统性**根因（不是个别字的个案）：
 *   ① 站点用**同一套轮廓、更细的笔画**画字（实测墨量只有参考的 88%，
 *      包围盒/重心完全一致）→ 灰度像素距离会偏向"笔画少"的字（略 输给 赂）
 *      → 修法：排序与 margin 用**二值距离**（比形状、不比粗细）
 *   ② 参考库里有**只差一笔的孪生字**（国 / 囯，差一个点）→ margin 极小
 *      → 被"分不清"闸门挡 → 修法：**常用字先验**参与判定
 *
 * 另外验证**稳健性**：把字形再"腐蚀"一两级（模拟笔画更细），仍要认对。
 */
const fs = require('fs');
const path = require('path');

const { GlyphEngine, pickCandidate, loadReferenceDb } = require('../engine');
const { FastGlyphMatcher } = require('../fast-matcher');

const FIX = path.join(__dirname, 'fixtures', 'live');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const core = require(path.join(ROOT, 'vendor', 'copy-repair-core.cjs'));
const opentype = require(path.join(ROOT, 'vendor', 'opentype.js'));

const SIZE = 48;

function cov(font, ch) {
  return core.rasterizeContours(core.flattenPath(font.getPath(ch, 0, 0, 1).commands), SIZE);
}

/**
 * 模拟"笔画变细"：**覆盖度整体变轻**（墨量 × 系数）。
 * 这才是站点真实的做法 —— 同一套轮廓、同样的几何，只是渲染得更轻
 * （实测墨量 88%，包围盒与重心完全一致）。
 */
function thin(c, factor) {
  const out = new Float32Array(c.length);
  for (let i = 0; i < c.length; i += 1) out[i] = c[i] * factor;
  return out;
}

async function main() {
  const fonts = fs.readdirSync(FIX).filter((f) => f.endsWith('.ttf'));
  if (!fonts.length) {
    console.log('没有真实字体夹具,跳过');
    return;
  }
  let failed = 0;

  for (const fontFile of fonts) {
    const name = fontFile.replace(/\.ttf$/, '');
    const truth = JSON.parse(fs.readFileSync(path.join(FIX, `${name}.truth.json`), 'utf8')).truth;
    const bytes = fs.readFileSync(path.join(FIX, fontFile));
    console.log(`\n=== 真实站点字体 ${name}（${Object.keys(truth).length} 个密文码位）===`);

    // ① 引擎必须全对
    const engine = new GlyphEngine({ log: () => {} });
    const result = await engine.processScope('real', [], { kind: 'data', value: bytes.toString('base64') }, {});
    const mapping = result.mapping || {};
    const wrong = [];
    const missing = [];
    for (const [cipher, plain] of Object.entries(truth)) {
      if (!mapping[cipher]) missing.push(cipher);
      else if (mapping[cipher] !== plain) wrong.push(`${cipher}→${mapping[cipher]}(应 ${plain})`);
    }
    const okAll = wrong.length === 0 && missing.length === 0;
    if (!okAll) failed += 1;
    console.log(
      `  ${okAll ? '✔' : '✖'} 全量还原：${Object.keys(truth).length - wrong.length - missing.length}/${Object.keys(truth).length}` +
        `${wrong.length ? '  认错：' + wrong.join(' ') : ''}${missing.length ? '  没认出来：' + missing.join(' ') : ''}`,
    );

    // ② 稳健性：笔画再轻（墨量 ×0.8 / ×0.6），仍要认对
    const db = loadReferenceDb('glyph-db-48.crdb.gz');
    const matcher = new FastGlyphMatcher(db);
    const site = opentype.parse(bytes);
    for (const factor of [0.88, 0.8, 0.7]) {
      let ok = 0;
      let bad = [];
      for (const [cipher, plain] of Object.entries(truth)) {
        const c = thin(cov(site, cipher), factor);
        // 走**完整判定路径**（含常用字先验），不是裸匹配器
        const r = pickCandidate(matcher.lookup(c, { maxCandidates: 512 }));
        const got = r.codepoint ? String.fromCodePoint(r.codepoint) : '';
        if (got === plain) ok += 1;
        else if (bad.length < 5) bad.push(`${cipher}→${got || '?'}(应 ${plain})`);
      }
      // 单笔画的字（「一」这种）对笔画粗细最敏感 → 允许 1 个例外，其余必须全对
      const pass = ok >= Object.keys(truth).length - 1;
      if (!pass) failed += 1;
      console.log(
        `  ${pass ? '✔' : '✖'} 笔画再轻(墨量×${factor})：${ok}/${Object.keys(truth).length}` +
          `${bad.length ? '  错：' + bad.join(' ') : ''}`,
      );
    }
  }

  console.log(`\n${failed === 0 ? '✔ 真实站点字体回归全部通过' : `✖ ${failed} 项未通过`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('失败:', e && e.message ? e.message : e);
  process.exit(1);
});
