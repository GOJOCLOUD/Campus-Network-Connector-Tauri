/**
 * 门禁：**扩展 ID 必须在各处都算成同一个值**。
 *
 * ## 这条链是什么
 *
 * Windows 的「浏览器复制修复」靠**注册表**把扩展挂进 Chrome / Edge：
 *
 * ```text
 * HKCU\Software\Google\Chrome\Extensions\<id>\path     = 扩展目录
 * HKCU\Software\Microsoft\Edge\Extensions\<id>\path     = 扩展目录
 * ```
 *
 * `<id>` 必须**正好等于** Chrome 算出来的那个扩展 ID —— 算错了，
 * 浏览器根本不会加载这个扩展（而且**没有任何报错**，只是"没反应"）。
 *
 * ID 的来源是 manifest 里的 `key` 字段（公钥 DER 的 base64）：
 * `SHA-256(公钥 DER)` 的前 128 位 → 32 个十六进制位 → 每位映射到 a..p。
 *
 * ## 为什么值得设一道门禁
 *
 * 这个 ID 在**四个地方**各写了一遍：
 *   1. `apps/chromium-extension/manifest.json` 的 `key`（**真身**）
 *   2. Tauri 线 Rust 侧的测试向量（`src/chromium/repair.rs`）
 *   3. Electron 线 JS 侧的测试向量（`src/features/chromium-repair/test/`）
 *   4. 产物里的 manifest（构建时拷过去的）
 *
 * 任何一处对不上 ⇒ 注册表写到一把**没人认的键**上 ⇒ 开关显示"已接管"，
 * 浏览器里什么都没有。而且这个失败**在界面上完全看不出来**。
 *
 * 所以这里把「四处一致」变成会失败的断言。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * 扩展 ID —— 由下面那把公钥算出来的。
 *
 * 这值用**三条互相独立的管道**算过（openssl 一条管道 / node crypto /
 * 手工十六进制切片），三条结果一致 —— 取证记录见 ADR-0028。
 */
const EXPECTED_ID = 'fobnhpnnampboobopbbdlkkaapbmlonc';

/** manifest 里的公钥（base64 的 DER）—— 与上面那个 ID 一一对应。 */
const EXPECTED_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsOYcLLERtl0pDblJ47Uunky0CnDvpxHyeDua2N0xYLbSySmD/vpUUtWPBDpG1HCkd9qOB7bIY5ljBJKbB4E4iWWSuSpQezizwXk3fVlpUxr/MbJe+eiFVGCB3yXNZV7he3otyljTAIcDhiz5ArJaOb8yapq4Bj2VjHqg2CiXoNncCTEmtrCFydB+ftozpvWRYAXpYKz78aijJfiqp0fxaMWOH0ee9FM25Q83aVHqs9ISBK8JYj+1fszZce2z6XCx/RxCv4mah+TRtajJPnFQD0UHnk5GC3mBFqH0UR3XH9G/+jju9AOr49tYUS6tlltyVH5+D8pc1DoccGis40vDAQIDAQAB';

/** Chrome 的 ID 算法：SHA-256(公钥 DER) 前 128 位 → 32 个 a..p。 */
function idFromPublicKey(der) {
  const hash = crypto.createHash('sha256').update(der).digest();
  let out = '';
  for (const byte of hash.subarray(0, 16)) {
    out += String.fromCharCode(97 + (byte >> 4));
    out += String.fromCharCode(97 + (byte & 0x0f));
  }
  return out;
}

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('公钥算出来的 ID 就是那个 ID', () => {
  const der = Buffer.from(EXPECTED_PUBLIC_KEY, 'base64');
  assert.strictEqual(idFromPublicKey(der), EXPECTED_ID);
  // 必须是 32 个 a..p 的字母
  assert.strictEqual(EXPECTED_ID.length, 32);
  assert.ok(/^[a-p]{32}$/.test(EXPECTED_ID), `ID 形状不对: ${EXPECTED_ID}`);
});

test('源码 manifest 的 key 算出来的 ID 一致', () => {
  const file = path.join(ROOT, 'apps', 'chromium-extension', 'manifest.json');
  assert.ok(fs.existsSync(file), `缺 ${file}`);
  const manifest = readManifest(file);
  assert.ok(manifest.key, 'manifest 里必须有 key 字段(扩展 ID 由它决定)');
  assert.strictEqual(manifest.key, EXPECTED_PUBLIC_KEY, 'manifest 里的公钥与测试向量不一致');
  assert.strictEqual(
    idFromPublicKey(Buffer.from(manifest.key, 'base64')),
    EXPECTED_ID,
    'manifest 的 key 算出来的 ID 不对',
  );
});

test('构建产物里的 manifest 与源码一致(拷的时候不能丢 key)', () => {
  const built = path.join(ROOT, 'dist-core', 'chromium', 'manifest.json');
  if (!fs.existsSync(built)) {
    // 没构建过扩展 ⇒ 这一项没法验（如实说明，不假装通过）
    console.log('[verify-extension-id] 扩展还没构建，跳过产物检查');
    return;
  }
  const manifest = readManifest(built);
  assert.strictEqual(manifest.key, EXPECTED_PUBLIC_KEY, '产物 manifest 里的 key 与源码不一致');
});

test('Tauri 线 Rust 侧用的 ID 与之一致', () => {
  const file = path.join(
    ROOT, 'tauri-app', 'src-tauri', 'src', 'chromium', 'repair.rs',
  );
  if (!fs.existsSync(file)) {
    console.log('[verify-extension-id] 本分支没有 Chromium 注册模块，跳过');
    return;
  }
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(
    source.includes(EXPECTED_ID),
    `Rust 侧没有出现扩展 ID ${EXPECTED_ID} —— 注册表键名会写错`,
  );
  assert.ok(
    source.includes(EXPECTED_PUBLIC_KEY),
    'Rust 侧的测试向量公钥与本文件不一致',
  );
});

test('Electron 线 JS 侧算出来的 ID 与之一致', () => {
  const file = path.join(ROOT, 'src', 'features', 'chromium-repair', 'registry.js');
  if (!fs.existsSync(file)) {
    console.log('[verify-extension-id] 本分支没有 Chromium 注册模块，跳过');
    return;
  }
  // eslint-disable-next-line global-require
  const registry = require(file);
  const manifest = readManifest(
    path.join(ROOT, 'apps', 'chromium-extension', 'manifest.json'),
  );
  assert.strictEqual(
    registry.extensionId(manifest),
    EXPECTED_ID,
    'JS 侧算出来的 ID 与 Rust 侧/门禁不一致 ⇒ 两个产品线注册到不同的键上',
  );
});
