/**
 * 把已安装的 App 就地更新为最新构建。
 *
 *   node tools/lab/update-installed-app.cjs
 *
 * 流程（每一步都可回滚）：
 *   1. 退出正在运行的 App
 *   2. 新构建**暂存**到 "<目标>.new"（复制失败不会破坏现有安装）
 *   3. 旧版本移到废纸篓（可恢复，不做永久删除）
 *   4. 暂存包转正
 *   5. 重新启动，并核对 asar 的 md5 与构建产物一致
 *
 * ⚠️ 只删"当前已安装的这份 App"，删前会核对绝对路径确实是 /Applications/模拟输入.app。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BUILT = path.join(ROOT, 'release', 'mac-arm64', '模拟输入.app');
const INSTALLED = '/Applications/模拟输入.app';
const STAGED = INSTALLED + '.new';
const TRASH = '/Users/wutiaoyun/.minimax/bin/mavis-trash';

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function asarOf(app) {
  return path.join(app, 'Contents', 'Resources', 'app.asar');
}

function main() {
  if (!fs.existsSync(BUILT)) {
    console.error('缺少新构建：' + BUILT);
    process.exit(1);
  }
  if (!fs.existsSync(INSTALLED)) {
    console.error('没找到已安装的 App：' + INSTALLED);
    process.exit(1);
  }
  // 删前核对：目标必须就是我们要换掉的那个 App
  const real = fs.realpathSync(INSTALLED);
  if (real !== INSTALLED) {
    console.error('目标路径是符号链接，拒绝操作：' + real);
    process.exit(1);
  }

  const before = md5(asarOf(INSTALLED));
  const after = md5(asarOf(BUILT));
  console.log('已安装 asar md5:', before);
  console.log('新构建 asar md5:', after);
  if (before === after) {
    console.log('内容一致，无需更新。');
    return;
  }

  // 1) 退出 App
  console.log('\n[1] 退出正在运行的 App…');
  try {
    execFileSync('osascript', ['-e', 'tell application "模拟输入" to quit'], { encoding: 'utf8' });
  } catch (_) {
    /* 没在跑就算了 */
  }
  try {
    execFileSync('pkill', ['-f', '模拟输入.app/Contents/MacOS'], { encoding: 'utf8' });
  } catch (_) {
    /* ignore */
  }

  // 2) 暂存
  console.log('[2] 暂存新构建到', STAGED);
  if (fs.existsSync(STAGED)) fs.rmSync(STAGED, { recursive: true, force: true });
  execFileSync('ditto', [BUILT, STAGED]);
  const stagedMd5 = md5(asarOf(STAGED));
  if (stagedMd5 !== after) {
    console.error('暂存包内容不对，中止（现有安装未动）：', stagedMd5);
    process.exit(1);
  }

  // 3) 旧版本移到废纸篓（可恢复）
  console.log('[3] 旧版本移入废纸篓（可恢复）');
  execFileSync(TRASH, ['--', INSTALLED]);

  // 4) 转正
  console.log('[4] 新版本就位');
  fs.renameSync(STAGED, INSTALLED);

  // 5) 重启并核对
  console.log('[5] 重新启动 App');
  execFileSync('open', ['-a', INSTALLED]);
  const now = md5(asarOf(INSTALLED));
  console.log('\n更新完成。已安装 asar md5 =', now, now === after ? '✔ 与构建一致' : '✖ 与构建不一致');
  process.exitCode = now === after ? 0 : 1;
}

main();
