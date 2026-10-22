/**
 * 把两个平台的交付物放到桌面，**统一用 zip 存放**：
 *   模拟输入-mac-arm64.zip          —— 内含 模拟输入.app（macOS arm64）
 *   模拟输入-win-x64-安装包.zip     —— 内含 SimuInput-Setup-0.0.0-x64.exe
 *
 *   node tools/lab/package-deliverables.cjs
 *
 * 约定：
 *   · 桌面只留这两个 zip，不再产出/保留 dmg（体积一样，解压即用）
 *   · zip 内部文件名用 ASCII（中文名在 Windows 资源管理器里可能显示成问号）
 *   · mac 的 .app 用 ditto 打包，保住 framework 里的符号链接
 *   · 临时目录用 mkdtemp，跑完即删
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RELEASE = path.join(ROOT, 'release');
const DESKTOP = path.join(ROOT, '..');

const MAC_APP = path.join(RELEASE, 'mac-arm64', '模拟输入.app');
const WIN_EXE = path.join(RELEASE, 'CampusNetworkConnector-win-0.0.0.exe');

function human(size) {
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

function mustExist(f, hint) {
  if (!fs.existsSync(f)) {
    console.error(`缺少产物: ${f}`);
    if (hint) console.error(hint);
    process.exit(1);
  }
}

function zipMac(appPath, target) {
  // ditto 能正确保留 .app 里的符号链接与结构；zip 命令行要额外加 -y
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, target]);
  // 再塞一份安装说明到压缩包根目录
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'simuinput-mac-'));
  try {
    fs.writeFileSync(
      path.join(stage, 'README-Install.txt'),
      [
        '模拟输入 · macOS (Apple Silicon) 安装包',
        '',
        '1) 双击解压本 zip，得到「模拟输入.app」',
        '2) 把「模拟输入.app」拖进「应用程序」文件夹',
        '3) 双击启动（首次打开若提示「无法验证开发者」，右键点它 → 「打开」→ 再点「打开」）',
        '',
        '要用 Safari 复制修复生效，还需要打开 Safari 的 Apple Events 通道：',
        '  Safari → 设置 → 高级 → 勾选「显示网页开发者功能」',
        '  再到菜单栏「开发」→ 勾选「允许来自 Apple Events 的 JavaScript」',
        '',
        '构建时间: ' + new Date().toLocaleString('zh-CN'),
      ].join('\n'),
      'utf8',
    );
    execFileSync('zip', ['-q', '-X', target, 'README-Install.txt'], { cwd: stage });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function zipWin(exePath, target) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'simuinput-win-'));
  try {
    const exeName = 'SimuInput-Setup-0.0.0-x64.exe';
    fs.copyFileSync(exePath, path.join(stage, exeName));
    fs.writeFileSync(
      path.join(stage, 'README-Install.txt'),
      [
        '模拟输入 · Windows x64 安装包',
        '',
        '1) 双击「' + exeName + '」开始安装（NSIS 一键安装，无需管理员权限）',
        '2) 安装完成后从桌面/开始菜单启动「模拟输入」',
        '',
        '说明：Safari 复制修复功能依赖 macOS 的 Safari + Apple Events，',
        '      Windows 版不包含该功能（界面上不会出现该开关）。',
        '',
        '构建时间: ' + new Date().toLocaleString('zh-CN'),
      ].join('\n'),
      'utf8',
    );
    execFileSync('zip', ['-r', '-q', '-X', target, '.'], { cwd: stage });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function main() {
  mustExist(MAC_APP, '先构建: npm run build && npm run build:native && npx electron-builder --mac dir --arm64 --publish never');
  mustExist(WIN_EXE, '先构建: npx electron-builder --win --x64 --publish never');

  // 1) macOS: .app 打进 zip
  const macTarget = path.join(DESKTOP, '模拟输入-mac-arm64.zip');
  fs.rmSync(macTarget, { force: true });
  zipMac(MAC_APP, macTarget);
  console.log(`[mac]   ${macTarget}  (${human(fs.statSync(macTarget).size)})`);

  // 2) Windows: 安装程序打进 zip
  const winTarget = path.join(DESKTOP, '模拟输入-win-x64-安装包.zip');
  fs.rmSync(winTarget, { force: true });
  zipWin(WIN_EXE, winTarget);
  console.log(`[win]   ${winTarget}  (${human(fs.statSync(winTarget).size)})`);

  // 3) 自检：两个 zip 的内容
  for (const t of [macTarget, winTarget]) {
    console.log(`\n${path.basename(t)} 内容:`);
    const list = execFileSync('unzip', ['-l', t], { encoding: 'utf8' });
    const rows = list
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('-'))
      .slice(0, 12);
    for (const line of rows) console.log('   ' + line.trim());
  }

  // 4) 旧的 dmg 不再作为交付物（体积一样，解压即用）
  const staleDmg = path.join(DESKTOP, '模拟输入-mac-arm64.dmg');
  if (fs.existsSync(staleDmg)) {
    console.log(`\n提示: 桌面上还有旧交付物 ${staleDmg}，可移入废纸篓。`);
  }
}

main();
