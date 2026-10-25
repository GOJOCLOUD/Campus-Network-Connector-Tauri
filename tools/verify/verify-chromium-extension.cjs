/**
 * Chromium 扩展(复制修复)的**产物自检** —— 跑不过就不发包。
 *
 * ## 为什么要有这条门禁
 *
 * Windows 线缺「浏览器修复」功能(用户 2026-10-25 原话:
 * 「在windows上那个把密文转化成明文的那个功能是失效的,没有用的」)。
 *
 * 查下来根因不是"没写",是**写了但从没被打包**:
 * `apps/chromium-extension/`(MV3、自带 10.2MB 字形库、独立可运行)
 * 在两个仓库里都存在,但两个 Windows 安装包里**都没有它**
 * ⇒ 那条能力在 Windows 上实际等于零。
 *
 * 扩展是**构建产物**(esbuild 现场编译 + 拷字形库),所以"源码在"不等于"能装"。
 * 这里盯的是**产物真的齐、真的能用**:
 *   - manifest 是合法 MV3(Chrome/Edge 能加载);
 *   - 三个脚本都在、且不是空壳;
 *   - 字形库在、并且**能解开**(gzip 坏了 ⇒ 扩展会静默失能:
 *     后台拿不到参考字形 ⇒ 还原不出明文 ⇒ 用户看到的就是"功能没反应")。
 *
 * ## 为什么不做"在真浏览器里加载一次"
 *
 * 那要开浏览器、装扩展、跑一遍真实网页 —— CI 里做不了,也不该做。
 * 这里只保证**装得进去、依赖齐**;真机效果由用户验收。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..', '..');
/** 产物目录 —— 与 `tools/build.mjs chromium` 的输出一致。 */
const OUT = path.join(ROOT, 'dist-core', 'chromium');

function readOut(...parts) {
  return path.join(OUT, ...parts);
}

test('扩展产物目录存在(先跑 node tools/build.mjs chromium)', () => {
  assert.ok(
    fs.existsSync(OUT),
    `扩展产物目录不存在: ${OUT}\n` +
      '  ⇒ 先构建:node tools/build.mjs chromium'
  );
});

test('manifest.json 是合法的 MV3,Chrome/Edge 装得进去', () => {
  const raw = fs.readFileSync(readOut('manifest.json'), 'utf8');
  const m = JSON.parse(raw);
  assert.strictEqual(m.manifest_version, 3, '必须是 MV3');
  assert.ok(m.name, '必须有 name');
  assert.ok(m.version, '必须有 version');
  assert.ok(
    m.background && typeof m.background.service_worker === 'string',
    '必须有 background.service_worker(还原逻辑跑在后台 Service Worker 里)'
  );
  assert.ok(Array.isArray(m.content_scripts) && m.content_scripts.length >= 2,
    '必须有 content_scripts(主世界护栏 + 隔离世界脚本各一份)');
  // 主世界那份是**护栏**:没有它,页面能先拿到原生 copy 再绕过它。
  const worlds = m.content_scripts.map((c) => c.world);
  assert.ok(worlds.includes('MAIN'), '缺 world=MAIN 的护栏脚本');
  assert.ok(worlds.includes('ISOLATED'), '缺 world=ISOLATED 的脚本');
});

test('三个脚本都在,且不是空壳(空壳 = 构建静默失败)', () => {
  for (const f of ['background.js', 'content-main.js', 'content-isolated.js']) {
    const p = readOut(f);
    assert.ok(fs.existsSync(p), `缺 ${f}`);
    const size = fs.statSync(p).size;
    assert.ok(size > 1024, `${f} 只有 ${size} 字节,像空壳`);
  }
});

test('字形参考库在包里,而且能解开(坏 gzip ⇒ 扩展静默失能)', () => {
  const p = readOut('assets', 'glyph-db.crdb.gz');
  assert.ok(fs.existsSync(p), '缺 assets/glyph-db.crdb.gz');
  const raw = fs.readFileSync(p);
  assert.ok(raw.length > 5 * 1024 * 1024,
    `字形库只有 ${raw.length} 字节,不对(GBK 全集 gzip 后约 9.7MB)`);
  // gzip 魔数
  assert.strictEqual(raw[0], 0x1f, '不是 gzip 文件');
  assert.strictEqual(raw[1], 0x8b, '不是 gzip 文件');
  // 真的解开一次 —— 只看魔数会漏掉"尾部被截断"这种坏法
  const plain = zlib.gunzipSync(raw);
  assert.ok(plain.length > raw.length, '解开后的体积应该更大');
});
