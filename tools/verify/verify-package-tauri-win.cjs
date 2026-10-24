/**
 * Tauri Windows 安装包的**运行时产物**自检 —— 防止再打出"装上但功能是坏的"的包。
 *
 * ## 为什么要有这条
 *
 * Electron 线那边最要命的一个坑是 `build.files` 白名单漏文件 ⇒
 * 「装上即崩」(见 ADR-0014)。**Tauri 侧不走 electron-builder**,
 * 所以没有那个白名单 —— 但**「运行时产物齐不齐」这件事一样要有人盯**:
 * 没人盯就等于没有。
 *
 * 盯的是这几样:
 *   1. NSIS 安装包在(用户下载得到);
 *   2. 主程序 exe 在(而且不是空壳);
 *   3. **字形参考库**(`resources/glyph-db-48.crdb.gz`)真的被带进了产物目录,
 *      且与仓库里那份**逐字节相同** —— 被截断 / 漏拷在这里当场暴露;
 *   4. 前端产物完整:`dist/index.html` 引用的资源都在(前端是**嵌进二进制**的,
 *      缺一个资源,页面上就是白屏或 404,但安装包看着一切正常)。
 *
 * ## 为什么用字节比对而不是"文件存在"
 *
 * "文件在"不等于"文件对"。参考库被截断(拷贝中断)时,文件照样在那儿,
 * 但引擎读它会得到一个坏库 ⇒ 复制出来是乱码。
 * 逐字节比对是最省事、也最不容易自欺欺人的办法。
 *
 *   node tools/verify/verify-package-tauri-win.cjs [targetDir]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_TAURI = path.join(ROOT, 'tauri-app', 'src-tauri');

// 产物目录:命令行参数 → CI 里的默认位置。
const TARGET = path.resolve(process.argv[2] || path.join(SRC_TAURI, 'target', 'release'));
const DIST = path.join(ROOT, 'dist');
// (参考库的相对路径见下面的 dbCandidates)

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

console.log(`检查 Tauri Windows 产物: ${TARGET}\n`);

// ① NSIS 安装包
const nsisDir = path.join(SRC_TAURI, 'target', 'release', 'bundle', 'nsis');
let installer = null;
if (fs.existsSync(nsisDir)) {
  const exes = fs.readdirSync(nsisDir).filter((f) => f.toLowerCase().endsWith('.exe'));
  if (exes.length) installer = path.join(nsisDir, exes[0]);
}
check('NSIS 安装包已生成', !!installer, installer || '(没找到 .exe —— 打包那步失败了吗?)');
if (installer) {
  const size = fs.statSync(installer).size;
  check('安装包不是空壳', size > 1024 * 1024, `${(size / 1024 / 1024).toFixed(1)} MB`);
}

// ② 主程序 exe
//    正常在 target/release/<包名>.exe;找不到就在那一层里找任意 .exe
//    (Tauri 打包时会把它拷进 NSIS 暂存目录,名字可能被改成产品名)。
function findExe(dir) {
  const direct = path.join(dir, 'simuinput-tauri.exe');
  if (fs.existsSync(direct)) return direct;
  try {
    const exes = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe'))
      .map((e) => path.join(dir, e.name));
    return exes[0] || null;
  } catch (_) {
    return null;
  }
}
const exe = findExe(TARGET);
check('主程序 exe 已生成', !!exe, exe || '(没找到 —— 打包那步失败了吗?)');
if (exe) {
  const size = fs.statSync(exe).size;
  // 前端是**嵌进二进制**的 ⇒ 一个空壳 exe 不会有几百 KB。
  check('主程序含前端产物(体积说得过去)', size > 512 * 1024, `${(size / 1024).toFixed(0)} KB`);
}

// ③ 字形参考库:在产物目录里,且与仓库里那份逐字节相同
//
//    **不猜它被放在哪**:在 target/release 下面**递归找**(跳过 cargo 的
//    deps/build/incremental),找到的每一份都要与仓库里那份逐字节相同。
//    为什么递归找:不同的 Tauri 版本把它放在 exe 旁边还是 resources/ 下
//    未必一样 —— 但「它必须进了产物目录」这件事是不变的。
const srcDb = path.join(SRC_TAURI, 'resources', 'glyph-db-48.crdb.gz');
const SKIP_DIRS = new Set(['deps', 'build', 'incremental', '.fingerprint', '.cargo-lock']);
function findResourceFiles(dir, depth, out) {
  if (depth > 4 || !fs.existsSync(dir)) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findResourceFiles(full, depth + 1, out);
    else if (e.name === 'glyph-db-48.crdb.gz') out.push(full);
  }
  return out;
}
const dbFiles = findResourceFiles(TARGET, 0, []);
check('产物目录里有字形参考库', dbFiles.length > 0,
  dbFiles.length ? dbFiles.map((p) => path.relative(TARGET, p)).join(', ') : '(在 ' + TARGET + ' 下面没找到)');
if (fs.existsSync(srcDb) && dbFiles.length) {
  const a = fs.readFileSync(srcDb);
  let allSame = true;
  let detail = '';
  for (const f of dbFiles) {
    const b = fs.readFileSync(f);
    if (!a.equals(b)) { allSame = false; detail = `${f} 与仓库里那份不一样`; break; }
    detail = `${dbFiles.length} 份,都是 ${a.length} 字节`;
  }
  check('字形参考库与仓库里那份逐字节相同', allSame, detail);
  // 再解一次:确认不是"看着一样、其实压坏了"
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(dbFiles[0]));
    check('字形参考库能解开(gzip 完好)', raw.length > 0, `解开 ${raw.length} 字节`);
  } catch (e) {
    check('字形参考库能解开(gzip 完好)', false, e.message);
  }
}

// ④ 前端产物完整:index.html 引用的资源都在
const indexHtml = path.join(DIST, 'index.html');
check('前端产物 index.html 在', fs.existsSync(indexHtml), indexHtml);
if (fs.existsSync(indexHtml)) {
  const html = fs.readFileSync(indexHtml, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => u && !/^(https?:)?\/\//.test(u) && !u.startsWith('data:'));
  let missing = [];
  for (const ref of refs) {
    const p = path.join(DIST, ref.replace(/^\//, ''));
    if (!fs.existsSync(p)) missing.push(ref);
  }
  check('index.html 引用的资源都在', missing.length === 0,
    missing.length ? '缺: ' + missing.join(', ') : `${refs.length} 个引用`);
}

console.log(failed === 0 ? '\n✔ Tauri Windows 产物自检全部通过' : `\n✖ ${failed} 项不通过`);
process.exit(failed === 0 ? 0 : 1);
