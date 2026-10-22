/**
 * Safari 扩展构建：WebExtension 目录 → Xcode 工程 → 可安装的 .app
 *
 *   node tools/build-safari.mjs
 *
 * 产物：build/safari-app/Copy Repair.app
 *
 * 说明：
 *  - 使用 ad-hoc 签名（本机没有可用的 "Mac Development" 证书时也能构建出可运行产物）
 *  - ad-hoc 签名的扩展在 Safari 里属于"未签名扩展"，需要一次性打开
 *    开发菜单 →「允许未签名的扩展」，详见 docs/安装指南-macOS-Safari.md
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
const APP_NAME = 'Copy Repair';
const BUNDLE_ID = 'com.copyrepair.copyrepair';
// 签名团队：Safari Web Extension 扩展点需要"付费开发者团队"才能签出带
// application-identifier / team-identifier 的描述文件；free 个人团队签出来的
// appex 没有这些权限，Safari 不会加载它。
// 用法：node tools/build-safari.mjs [TEAM_ID]
const TEAM_ID = process.argv[2] || process.env.CR_SAFARI_TEAM || '';

function run(command, args, options = {}) {
  console.log(`[safari] ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...options,
  });
}

function main() {
  if (!existsSync(resolve(DEVELOPER_DIR))) {
    throw new Error('未找到 Xcode，请安装 Xcode 或设置 DEVELOPER_DIR');
  }

  // 1) 打包 WebExtension
  run(process.execPath, [resolve(root, 'tools/build.mjs'), 'safari']);

  // 2) 转成 Xcode 工程
  const projectLocation = resolve(root, 'build/safari-xcode');
  if (existsSync(projectLocation)) rmSync(projectLocation, { recursive: true, force: true });
  mkdirSync(projectLocation, { recursive: true });
  run(
    resolve(DEVELOPER_DIR, 'usr/bin/safari-web-extension-converter'),
    [
      resolve(root, 'dist-core/safari'),
      '--project-location',
      projectLocation,
      '--app-name',
      APP_NAME,
      '--bundle-identifier',
      BUNDLE_ID,
      '--swift',
      '--macos-only',
      '--no-open',
      '--force',
    ],
    { quiet: true },
  );

  // 3) 修正宿主 App 的 bundle id（转换器会按 App 名生成，与扩展 id 前缀对不上会导致签名校验失败）
  const projectDir = resolve(projectLocation, APP_NAME);
  const pbxproj = resolve(projectDir, `${APP_NAME}.xcodeproj/project.pbxproj`);
  let content = readFileSync(pbxproj, 'utf8');
  content = content.replace(
    /PRODUCT_BUNDLE_IDENTIFIER = "[^"]*";/g,
    `PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`,
  );
  if (TEAM_ID) {
    content = content.replace(
      /(PRODUCT_BUNDLE_IDENTIFIER = [^;]+;)/g,
      `$1\n\t\t\t\tCODE_SIGN_IDENTITY = "Apple Development";\n\t\t\t\tDEVELOPMENT_TEAM = ${TEAM_ID};\n\t\t\t\tCODE_SIGN_STYLE = Automatic;`,
    );
  }
  writeFileSync(pbxproj, content);

  // 4) 构建
  run(
    resolve(DEVELOPER_DIR, 'usr/bin/xcodebuild'),
    [
      '-project',
      `${APP_NAME}.xcodeproj`,
      '-scheme',
      APP_NAME,
      '-configuration',
      'Release',
      '-derivedDataPath',
      './build',
      ...(TEAM_ID
        ? ['-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${TEAM_ID}`, 'CODE_SIGN_STYLE=Automatic']
        : ['CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGNING_ALLOWED=YES']),
      'ENABLE_HARDENED_RUNTIME=NO',
      'build',
    ],
    { cwd: projectDir },
  );

  const app = resolve(projectDir, 'build/Build/Products/Release', `${APP_NAME}.app`);
  console.log(`[safari] 产物: ${app}`);
}

main();
