/** 构建页面内守卫（注入用）：node tools/build-page-guard.mjs */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'dist-core/page-guard');
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, 'packages/browser-adapters/shared/src/page-guard.ts')],
  bundle: true,
  format: 'iife',
  target: ['safari16'],
  platform: 'browser',
  minify: false,
  legalComments: 'none',
  outfile: resolve(outDir, 'page-guard.js'),
});
console.log(`[guard] ${resolve(outDir, 'page-guard.js')}`);
