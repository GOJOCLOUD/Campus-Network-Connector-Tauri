/**
 * 门禁：**渲染栅格必须与参考字形库的栅格一致**。
 *
 * ## 它防的是哪一类故障（2026-10-25 实测）
 *
 * 字形匹配的原理是：浏览器把字符画成一张「N×N 的覆盖度位图」，
 * 匹配器拿这张位图与参考库里的字形**逐格**比较。
 *
 * 位图与库**不同尺寸**时，两张图是错位的 —— 比较的根本不是同一个东西：
 *   · 最近邻会落到「爫」「﹊」这类冷僻符号上（score≈0.9、margin≈0）
 *   · 于是永远判不出「这个作用域被混淆」
 *   · ⇒ 复制出来还是密文，**而且全程没有任何报错**
 *
 * 仓库里真实发生过：渲染器用 32×32，参考库是 48×48。
 * 扩展的端到端用例因为指向了不存在的目录而**从来没跑过**，
 * 所以这个错位一直没被发现。
 *
 * ## 为什么值得单独设一道门禁
 *
 * 这两个数字**分属两个文件**：栅格尺寸写在浏览器侧的渲染器里，
 * 栅格尺寸也写在参考库的二进制头里 —— 没有任何东西保证它们相等。
 * 而且「不一致」的表象是「功能没生效」，不是「报错」，最难查。
 *
 * 所以这里把「相等」变成一条会失败的断言。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const GRID_SOURCE = path.join(ROOT, 'packages/core/src/glyph-matching/grid.ts');

/** 仓库里可能存在的参考库（gzip / 裸包都算）。 */
const DB_CANDIDATES = [
  'tauri-app/src-tauri/resources/glyph-db-48.crdb.gz',
  'tools/reference-fonts/glyph-db-48-gbk.crdb',
  'vendor/glyph-db-48.crdb.gz',
  'vendor/glyph-db-48.crdb',
];

function readGridSize() {
  const source = fs.readFileSync(GRID_SOURCE, 'utf8');
  const match = source.match(/REFERENCE_GRID_SIZE\s*=\s*(\d+)/);
  assert.ok(match, `${GRID_SOURCE} 里必须导出 REFERENCE_GRID_SIZE`);
  return Number(match[1]);
}

/** 递归收集源码文件（只看 .ts / .js / .mjs / .cjs）。 */
function collectSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-core') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readDbGridSize(file) {
  const bytes = fs.readFileSync(file);
  const raw = file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes;
  if (raw.length < 20) return null;
  const magic = raw.readUInt32BE(0);
  if (magic !== 0x43524442) return null; // 'CRDB'
  return raw.readUInt32BE(8);
}

const GRID = readGridSize();

test('参考库的栅格尺寸就是 REFERENCE_GRID_SIZE', () => {
  const found = DB_CANDIDATES
    .map((rel) => path.join(ROOT, rel))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, grid: readDbGridSize(file) }))
    .filter((entry) => entry.grid !== null);

  if (found.length === 0) {
    // 仓库里没有已生成的库（例如 CI 里才生成）——
    // 代码层的断言仍然生效，这里如实说明「没查到」而不是假装通过。
    console.log(`[verify-glyph-grid] 仓库里没有已生成的参考库，跳过库头校验（栅格常量 = ${GRID}）`);
    return;
  }
  for (const { file, grid } of found) {
    assert.strictEqual(
      grid,
      GRID,
      `${path.relative(ROOT, file)} 的栅格是 ${grid}，但渲染器用的是 ${GRID} —— 位图会错位`,
    );
  }
});

test('渲染器不许写死栅格尺寸', () => {
  const files = [
    ...collectSourceFiles(path.join(ROOT, 'packages')),
    ...collectSourceFiles(path.join(ROOT, 'apps')),
  ];
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    // new GlyphRenderer(32) 这类写死数字的调用
    const matches = source.matchAll(/new\s+GlyphRenderer\s*\(\s*(\d+)\s*\)/g);
    for (const match of matches) {
      offenders.push(`${path.relative(ROOT, file)}: new GlyphRenderer(${match[1]})`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `栅格尺寸必须来自 REFERENCE_GRID_SIZE（${GRID}），不许写死：\n${offenders.join('\n')}`,
  );
});

test('参考库构建脚本的默认尺寸就是 REFERENCE_GRID_SIZE', () => {
  const script = path.join(ROOT, 'tools/build-reference-db.mjs');
  const source = fs.readFileSync(script, 'utf8');
  const match = source.match(/arg\('size',\s*'(\d+)'\)/);
  assert.ok(match, 'build-reference-db.mjs 必须显式声明默认 --size');
  assert.strictEqual(
    Number(match[1]),
    GRID,
    'build-reference-db.mjs 的默认 --size 必须等于 REFERENCE_GRID_SIZE —— '
      + '否则有人不带参数跑一次，就造出一份对不上的库',
  );
});
