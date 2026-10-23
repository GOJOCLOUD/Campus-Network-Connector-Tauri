/**
 * 桌面交付包：**两条线**的产物各打一个包,放在桌面。
 *
 *   node tools/lab/package-deliverables.cjs
 *
 * 产出(桌面):
 *   模拟输入-mac-arm64.zip        —— 内含 模拟输入.app(Electron 版)
 *                                     + 模拟输入-Tauri.app(Tauri 版)
 *                                     + README-Install.txt
 *   模拟输入-Windows-全部.zip      —— 内含 SimuInput-Electron-Setup-0.0.0-x64.exe
 *                                     + SimuInput-Tauri-Setup-0.0.0-x64.exe
 *                                     + README-Install.txt
 *
 * ## 为什么两个包不合并成一个
 * mac 与 Windows 的用户群不同、装法也不同,合成一个包会让两边都别扭。
 * 但**同一条线内的两个版本**是同等优先的两个正式产品(ADR-0012),
 * 放进同一个包里,用户一次解压就拿到全部 —— 不用去猜哪个才是"那个"。
 *
 * ## 桌面位置
 * 用 `~/Desktop`,**不是**仓库的上一级目录 —— 仓库搬进
 * `Campus-Network-Connector/` 这个容器之后,"上一级"已经不是桌面了
 * (老脚本就是这么写错的:包跑到了容器目录里,桌面上的还是旧的)。
 *
 * ## Windows 产物从哪来
 * **本机不打包 Windows**(交叉编译出来的包不带原生模块)。
 * 统一从 CI 的 release 里取:
 *   - Tauri   → release `win-tauri-<run_id>`
 *   - Electron → release `win-<run_id>`
 * 脚本会自动挑**最新的**那个 win release;要指定就设环境变量
 * `WIN_TAURI_TAG` / `WIN_ELECTRON_TAG`。
 *
 * ## 清理
 * 旧的 `模拟输入-win-x64-安装包.zip`(被合并包取代)与桌面上的 `*.dmg`
 * 会被移进**可恢复回收站**(不是永久删除),动作会打印出来。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DESKTOP = path.join(os.homedir(), 'Desktop');

// 容器里两条线是兄弟目录:electron/ 与 tauri/
const SIBLING = fs.existsSync(path.join(ROOT, 'tauri-app'))
  ? path.join(ROOT, '..', 'electron')
  : path.join(ROOT, '..', 'tauri');

const MAC_APP_ELECTRON = path.join(SIBLING, 'release', 'mac-arm64', '模拟输入.app');
const MAC_APP_TAURI = path.join(ROOT, 'tauri-app', 'src-tauri', 'target', 'release', 'bundle', 'macos', '模拟输入-Tauri.app');

const REPO_TAURI = 'GOJOCLOUD/Campus-Network-Connector-Tauri';
const REPO_ELECTRON = 'GOJOCLOUD/Campus-Network-Connector-Electron';

const MAC_TARGET = path.join(DESKTOP, '模拟输入-mac-arm64.zip');
const WIN_TARGET = path.join(DESKTOP, '模拟输入-Windows-全部.zip');
/** 被合并包取代的旧交付物 */
const STALE_WIN_ZIP = path.join(DESKTOP, '模拟输入-win-x64-安装包.zip');

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

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** 最新的 win release 标签(按创建时间)。 */
function latestWinTag(repo, prefix) {
  if (process.env.WIN_TAURI_TAG && repo === REPO_TAURI) return process.env.WIN_TAURI_TAG;
  if (process.env.WIN_ELECTRON_TAG && repo === REPO_ELECTRON) return process.env.WIN_ELECTRON_TAG;
  const out = sh('gh', ['release', 'list', '--repo', repo, '--limit', '50', '--json', 'tagName,createdAt']);
  const list = JSON.parse(out)
    .filter((r) => r.tagName.startsWith(prefix))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!list.length) {
    console.error(`在 ${repo} 里找不到以 "${prefix}" 开头的 release`);
    process.exit(1);
  }
  return list[list.length - 1].tagName;
}

/** 从 CI 的 release 里下载 Windows 安装程序,返回本地路径。 */
function downloadWinInstaller(repo, tag, destName, stage) {
  // 走 release-assets 的 CDN,偶尔会中途 EOF —— 重试几次(实测要重试才能下全)
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      sh('gh', ['release', 'download', tag, '--repo', repo, '--pattern', '*.exe', '--dir', stage, '--clobber']);
      break;
    } catch (err) {
      lastErr = err;
      console.log(`  下载 ${repo}@${tag} 第 ${attempt} 次失败,重试…`);
    }
  }
  if (lastErr && !fs.readdirSync(stage).some((f) => f.toLowerCase().endsWith('.exe'))) {
    console.error(String(lastErr.stderr || lastErr.message || lastErr));
    process.exit(1);
  }
  const files = fs.readdirSync(stage).filter((f) => f.toLowerCase().endsWith('.exe') && f !== destName);
  if (!files.length) {
    console.error(`${repo} 的 release ${tag} 里没有 .exe`);
    process.exit(1);
  }
  const src = path.join(stage, files[0]);
  const dest = path.join(stage, destName);
  fs.renameSync(src, dest);
  console.log(`  ${repo} @ ${tag} → ${destName}`);
  return dest;
}

function zipMac(apps, target) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'simuinput-mac-'));
  try {
    const names = [];
    for (const app of apps) {
      // 先复制进暂存目录:两个 .app 的来源目录不同,zip 只能把**当前目录**下的
      // 名字写进包根,不同源的同名结构必须先汇到一处。
      execFileSync('ditto', [app.path, path.join(stage, app.zipName)]);
      names.push(app.zipName);
    }
    fs.writeFileSync(
      path.join(stage, 'README-Install.txt'),
      [
        '模拟输入 · macOS (Apple Silicon) 安装包',
        '',
        '**这是两个正式版本,装哪个都行**(功能等同,技术栈不同):',
        '',
        '  · 模拟输入.app        —— Electron 版',
        '  · 模拟输入-Tauri.app  —— Tauri 版(体积更小)',
        '',
        '1) 双击解压本 zip',
        '2) 把想要的那个 .app 拖进「应用程序」文件夹',
        '3) 双击启动(首次打开若提示「无法验证开发者」,右键点它 → 「打开」→ 再点「打开」)',
        '',
        '要用 Safari 复制修复生效,还需要打开 Safari 的 Apple Events 通道:',
        '  Safari → 设置 → 高级 → 勾选「显示网页开发者功能」',
        '  再到菜单栏「开发」→ 勾选「允许来自 Apple Events 的 JavaScript」',
        '',
        '构建时间: ' + new Date().toLocaleString('zh-CN'),
      ].join('\n'),
      'utf8',
    );
    names.push('README-Install.txt');
    // **-y 不能省**:Electron 的 framework 里有 14 个符号链接
    // (Electron Framework.framework/Versions/Current 等),
    // 不加 -y 会被存成普通文件副本 → 解压出来的 App 起不来。
    execFileSync('zip', ['-r', '-y', '-q', '-X', target, ...names], { cwd: stage });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function zipWin(exes, target) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'simuinput-win-'));
  try {
    const names = [];
    for (const e of exes) {
      fs.copyFileSync(e.path, path.join(stage, e.name));
      names.push(e.name);
    }
    fs.writeFileSync(
      path.join(stage, 'README-Install.txt'),
      [
        '模拟输入 · Windows x64 安装包(两个正式版本)',
        '',
        '**这是两个正式版本,装哪个都行**(功能等同,技术栈不同):',
        '',
        '  · SimuInput-Electron-Setup-0.0.0-x64.exe  —— Electron 版',
        '  · SimuInput-Tauri-Setup-0.0.0-x64.exe    —— Tauri 版(体积更小)',
        '',
        '1) 双击对应的 .exe 开始安装(NSIS 一键安装,无需管理员权限)',
        '2) 安装完成后从桌面/开始菜单启动「模拟输入」',
        '',
        '说明:Safari 复制修复功能依赖 macOS 的 Safari + Apple Events,',
        '      Windows 版不包含该功能(界面上不会出现该开关)。',
        '',
        '构建时间: ' + new Date().toLocaleString('zh-CN'),
      ].join('\n'),
      'utf8',
    );
    names.push('README-Install.txt');
    // zip 内部用 ASCII 文件名(中文名在 Windows 资源管理器里可能显示成问号)
    execFileSync('zip', ['-r', '-y', '-q', '-X', target, ...names], { cwd: stage });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** 移进可恢复回收站(不永久删除)。 */
function toTrash(target) {
  const trash = path.join(os.homedir(), '.minimax', 'bin', 'mavis-trash');
  if (fs.existsSync(trash)) {
    sh(trash, ['--', target]);
  } else {
    const bak = target + '.old.' + Date.now();
    fs.renameSync(target, bak);
    console.log(`    (没有 mavis-trash,已改名保留在 ${bak})`);
  }
}

function main() {
  mustExist(MAC_APP_ELECTRON, '先构建 Electron 版: cd electron && npm run dist:mac:arm64');
  mustExist(MAC_APP_TAURI, '先构建 Tauri 版: cd tauri/tauri-app && npx @tauri-apps/cli@2 build --bundles app');

  // 1) macOS:两个 .app 打进一个 zip
  fs.rmSync(MAC_TARGET, { force: true });
  zipMac(
    [
      { path: MAC_APP_ELECTRON, zipName: '模拟输入.app' },
      { path: MAC_APP_TAURI, zipName: '模拟输入-Tauri.app' },
    ],
    MAC_TARGET,
  );
  console.log(`[mac]   ${MAC_TARGET}  (${human(fs.statSync(MAC_TARGET).size)})`);

  // 2) Windows:两个安装程序打进一个 zip
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'simuinput-winex-'));
  try {
    console.log('[win]   取 CI 的 Windows 产物:');
    const exes = [
      {
        path: downloadWinInstaller(
          REPO_ELECTRON,
          latestWinTag(REPO_ELECTRON, 'win-'),
          'SimuInput-Electron-Setup-0.0.0-x64.exe',
          stage,
        ),
        name: 'SimuInput-Electron-Setup-0.0.0-x64.exe',
      },
      {
        path: downloadWinInstaller(
          REPO_TAURI,
          latestWinTag(REPO_TAURI, 'win-tauri-'),
          'SimuInput-Tauri-Setup-0.0.0-x64.exe',
          stage,
        ),
        name: 'SimuInput-Tauri-Setup-0.0.0-x64.exe',
      },
    ];
    fs.rmSync(WIN_TARGET, { force: true });
    zipWin(exes, WIN_TARGET);
    console.log(`[win]   ${WIN_TARGET}  (${human(fs.statSync(WIN_TARGET).size)})`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  // 3) 清理被取代的旧交付物(可恢复回收站)
  console.log('\n[清理]');
  if (fs.existsSync(STALE_WIN_ZIP)) {
    toTrash(STALE_WIN_ZIP);
    console.log(`  已移入回收站: ${STALE_WIN_ZIP}(被「${path.basename(WIN_TARGET)}」取代)`);
  }
  for (const f of fs.readdirSync(DESKTOP)) {
    if (!f.toLowerCase().endsWith('.dmg')) continue;
    const p = path.join(DESKTOP, f);
    toTrash(p);
    console.log(`  已移入回收站: ${p}(旧的 dmg 交付物)`);
  }

  // 4) 自检:两个 zip 的内容
  for (const t of [MAC_TARGET, WIN_TARGET]) {
    console.log(`\n${path.basename(t)} 内容:`);
    const list = sh('unzip', ['-l', t]);
    for (const line of list.split('\n').filter((l) => l.trim() && !l.startsWith('-')).slice(0, 10)) {
      console.log('   ' + line.trim());
    }
  }
}

main();
