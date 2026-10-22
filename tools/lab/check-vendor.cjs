/**
 * 检查 vendor/ 里的注入产物是否与源码一致。
 *
 *   node tools/lab/check-vendor.cjs
 *
 * 背景：vendor/page-guard.js 等是**构建产物**，由 `tools/build-vendor.mjs`
 * 从 packages/browser-adapters/shared/src 生成。改完源码忘了重建 =
 * 装出去的 App 还在用旧守卫（这个坑踩过：修了但没生效）。
 *
 * 做法：记录重建前的 md5 → 重新构建 → 再看 md5。
 *   - 没变 → vendor 与源码一致 ✔
 *   - 变了 → 说明之前是过期的（脚本已顺手重建），退出码 1 提醒
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'vendor');
const FILES = ['page-guard.js', 'frame-bridge.js', 'copy-repair-core.cjs', 'common-charset.js'];

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function snapshot() {
  const out = {};
  for (const name of FILES) {
    const file = path.join(VENDOR, name);
    out[name] = fs.existsSync(file) ? md5(file) : null;
  }
  return out;
}

const before = snapshot();
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-vendor.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
const after = snapshot();

const changed = FILES.filter((name) => before[name] !== after[name]);
if (changed.length === 0) {
  console.log('\n✔ vendor 与源码一致（无需重建）');
} else {
  console.log(`\n✖ vendor 之前是过期的，已重建：${changed.join('、')}`);
  console.log('  （改完 packages/browser-adapters 后记得跑 node tools/build-vendor.mjs）');
  process.exitCode = 1;
}
