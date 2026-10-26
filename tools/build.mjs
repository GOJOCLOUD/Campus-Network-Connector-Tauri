/**
 * 构建扩展产物。
 *
 *   node tools/build.mjs safari
 *
 * 产物：
 *   dist-core/safari/     —— 可交给 safari-web-extension-converter 的 WebExtension 目录
 *
 * 注：Windows 线**不再需要 Chromium 扩展**（2026-10-26 起改成「软件自己起浏览器
 * + CDP 注入页面守卫」，扩展已退役，见 ADR-0030），所以这里只剩 safari 一个目标。
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const TARGETS = {
  safari: {
    outDir: resolve(root, 'dist-core/safari'),
    app: resolve(root, 'apps/safari-extension'),
    target: ['safari16'],
  },
};

async function build(name) {
  const cfg = TARGETS[name];
  if (!cfg) throw new Error(`unknown target: ${name}`);
  mkdirSync(resolve(cfg.outDir, 'assets'), { recursive: true });

  const entries = [
    { in: resolve(cfg.app, 'src/background.ts'), out: 'background' },
    { in: resolve(cfg.app, 'src/content-isolated.ts'), out: 'content-isolated' },
    { in: resolve(cfg.app, 'src/content-main.ts'), out: 'content-main' },
  ];

  for (const entry of entries) {
    if (!existsSync(entry.in)) continue;
    await esbuild.build({
      entryPoints: [entry.in],
      bundle: true,
      format: 'iife',
      target: cfg.target,
      platform: 'browser',
      minify: false,
      sourcemap: false,
      legalComments: 'none',
      outfile: resolve(cfg.outDir, `${entry.out}.js`),
    });
  }

  // manifest（Safari 用的是自己的变体）
  const manifest = JSON.parse(readFileSync(resolve(cfg.app, 'manifest.json'), 'utf8'));
  writeFileSync(
    resolve(cfg.outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // 参考字形库：随扩展打包（vendor/ 下那份就是 gzip 版，直接拷，不再压一遍）
  const dbPath = resolve(root, 'vendor/glyph-db-48.crdb.gz');
  if (existsSync(dbPath)) {
    copyFileSync(dbPath, resolve(cfg.outDir, 'assets/glyph-db.crdb.gz'));
    console.log(`[build] glyph-db.crdb.gz ${(statSync(dbPath).size / 1024 / 1024).toFixed(2)} MB`);
  }

  // 其它静态资源
  const assetsDir = resolve(cfg.app, 'assets');
  if (existsSync(assetsDir)) {
    for (const file of ['diagnostics.html']) {
      const src = resolve(assetsDir, file);
      if (existsSync(src)) copyFileSync(src, resolve(cfg.outDir, file));
    }
  }

  console.log(`[build] ${name} -> ${cfg.outDir}`);
}

const target = process.argv[2] || 'safari';
await build(target);
