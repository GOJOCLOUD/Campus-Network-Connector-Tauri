/**
 * 构建 Safari 热键工具的页面探针（方案 B）。
 *
 *   node tools/build-safari-tool.mjs
 *
 * 产物：dist-core/safari-agent/page-agent.js
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const outDir = resolve(root, 'dist-core/safari-agent');
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, 'packages/browser-adapters/shared/src/page-agent.ts')],
  bundle: true,
  format: 'iife',
  target: ['safari16'],
  platform: 'browser',
  minify: false,
  legalComments: 'none',
  outfile: resolve(outDir, 'page-agent.js'),
});

console.log(`[safari-tool] 探针已构建: ${resolve(outDir, 'page-agent.js')}`);
