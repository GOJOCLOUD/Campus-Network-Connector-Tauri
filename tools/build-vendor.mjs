/**
 * 打包给 Electron 主进程用的 vendor 产物。
 *
 *   node tools/build-vendor.mjs
 *
 * 产物（输出到 vendor/）：
 *   copy-repair-core.cjs  共享核心（commonjs，Node 侧做字形匹配）
 *   page-guard.js         注入网页的页面守卫
 *   glyph-db-48.crdb.gz   参考字形库（gzip 分发）
 *
 * 这些文件会被复制进 Electron 项目的 electron-builder files 列表。
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'vendor');
mkdirSync(out, { recursive: true });

// 1) 共享核心 → commonjs
await esbuild.build({
  entryPoints: [resolve(root, 'packages/core/src/index.ts')],
  bundle: true,
  format: 'cjs',
  target: ['node20'],
  platform: 'node',
  minify: false,
  legalComments: 'none',
  outfile: resolve(out, 'copy-repair-core.cjs'),
});
console.log('[vendor] copy-repair-core.cjs');

// 2) 页面守卫
await esbuild.build({
  entryPoints: [resolve(root, 'packages/browser-adapters/shared/src/page-guard.ts')],
  bundle: true,
  format: 'iife',
  target: ['safari16'],
  platform: 'browser',
  minify: false,
  legalComments: 'none',
  outfile: resolve(out, 'page-guard.js'),
});
console.log('[vendor] page-guard.js');

// 2b) iframe 桥
await esbuild.build({
  entryPoints: [resolve(root, 'packages/browser-adapters/shared/src/frame-bridge.ts')],
  bundle: true,
  format: 'iife',
  target: ['safari16'],
  platform: 'browser',
  minify: false,
  legalComments: 'none',
  outfile: resolve(out, 'frame-bridge.js'),
});
console.log('[vendor] frame-bridge.js');

// 2c) 常用字集（Node 侧做"常用字优先"打破平局时要用）
await esbuild.build({
  entryPoints: [resolve(root, 'packages/browser-adapters/shared/src/common-charset.ts')],
  bundle: true,
  format: 'cjs',
  target: ['node20'],
  platform: 'node',
  minify: false,
  legalComments: 'none',
  outfile: resolve(out, 'common-charset.js'),
});
console.log('[vendor] common-charset.js');

// 3) 参考字形库（GBK 全集，gzip 分发）
//    只带一套：Noto Sans SC 48×48。
//    48×48 才能分清「国/固」这类方框字（32×32 实测会判不出）。
//    只保留黑体系：目标站点的加密字体底稿就是思源黑体（Source Han Sans CN），
//    与 Noto Sans SC 是同一字型，带其它字型只会让包变大、命中变差。
//
//    必须是 **GBK 全集**：参考库缺字时最近邻会给出"形近但不是它"的字，
//    而且分数/margin 都过闸门 → 写出错字（实测 燚→焱、垚→寺）。
//    gzip 后 24.4MB → 9.7MB。
//
//    .crdb 是**纯构建产物**（由 NotoSansSC-Regular.otf 栅格化而来，实测 4.4 秒可重建、
//    字节级可复现），所以不进 git；缺了就地重建，别让"忘了先建库"变成一个坑。
const db = resolve(root, 'tools/reference-fonts/glyph-db-48-gbk.crdb');
if (!existsSync(db)) {
  console.log('[vendor] 参考库不存在，就地重建（约 5 秒）…');
  execFileSync(process.execPath, [
    resolve(here, 'build-reference-db.mjs'),
    '--size', '48',
    '--out', db,
  ], {
    stdio: 'inherit',
    env: { ...process.env, CR_INCLUDE_GBK: '1' },
  });
}
if (!existsSync(db)) {
  console.error('[vendor] 参考库重建失败：' + db);
  process.exit(1);
}
{
  const gz = gzipSync(readFileSync(db), { level: 9 });
  writeFileSync(resolve(out, 'glyph-db-48.crdb.gz'), gz);
  // 旧的未压缩库不再随包分发（省 9.4MB）；它是构建产物，删的是生成物
  const stale = resolve(out, 'glyph-db-48.crdb');
  if (existsSync(stale)) rmSync(stale);
  console.log(`[vendor] glyph-db-48.crdb.gz  (${(gz.length / 1024 / 1024).toFixed(1)} MB)`);
}
