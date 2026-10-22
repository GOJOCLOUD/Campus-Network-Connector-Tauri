/**
 * 打包 Safari 热键工具（方案 B）为自包含目录。
 *
 *   node tools/package-safari-tool.mjs
 *
 * 产物：release-core/safari-tool/
 *   bin/copy-repair.mjs      主程序
 *   dist/page-agent.js       页面探针
 *   packages/core/src/**     共享核心（与扩展同一份代码）
 *   reference/glyph-db-48.crdb.gz  参考字形库(gzip 分发)
 *   Copy Repair.app          macOS 快捷键 App
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'release-core/safari-tool');

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'bin'), { recursive: true });
mkdirSync(resolve(out, 'dist'), { recursive: true });
mkdirSync(resolve(out, 'reference'), { recursive: true });

// 页面探针
execFileSync(process.execPath, [resolve(root, 'tools/build-safari-tool.mjs')], { stdio: 'inherit' });
cpSync(resolve(root, 'dist-core/safari-agent/page-agent.js'), resolve(out, 'dist/page-agent.js'));

// 共享核心
cpSync(resolve(root, 'packages/core/src'), resolve(out, 'packages/core/src'), { recursive: true });

// 参考字形库
cpSync(resolve(root, 'vendor/glyph-db-48.crdb.gz'), resolve(out, 'reference/glyph-db-48.crdb.gz'));

// 主程序（改写资源路径为包内相对路径）
const toolSource = readFileSync(resolve(root, 'tools/safari-repair.mjs'), 'utf8');
const packaged = toolSource
  .replace(
    "const AGENT_PATH = resolve(argValue('agent', resolve(root, 'dist-core/safari-agent/page-agent.js')));",
    "const AGENT_PATH = resolve(argValue('agent', resolve(root, 'dist/page-agent.js')));",
  )
  .replace(
    "const DB_PATH = resolve(argValue('db', resolve(root, 'vendor/glyph-db-48.crdb.gz')));",
    "const DB_PATH = resolve(argValue('db', resolve(root, 'reference/glyph-db-48.crdb.gz')));",
  )
  .replace(
    "import { GlyphDb, dequantize } from '../packages/core/src/glyph-matching/db.ts';",
    "import { GlyphDb, dequantize } from '../packages/core/src/glyph-matching/db.ts';",
  );
writeFileSync(resolve(out, 'bin/copy-repair.mjs'), packaged);

// macOS 快捷键 App
const nodeBin = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
const scriptPath = resolve(out, 'copy-repair.applescript');
writeFileSync(
  scriptPath,
  `on run
    set toolDir to ${JSON.stringify(out)}
    set nodeBin to ${JSON.stringify(nodeBin)}
    set cmd to "cd " & quoted form of toolDir & " && " & quoted form of nodeBin & " bin/copy-repair.mjs > /tmp/copy-repair.log 2>&1"
    try
        do shell script cmd
    end try
    set summary to ""
    try
        set summary to do shell script "tail -n 1 /tmp/copy-repair.log"
    end try
    if summary is "" then set summary to "未取到结果"
    display notification summary with title "Copy Repair" subtitle "已处理 Safari 当前选区"
end run
`,
);
execFileSync('osacompile', ['-o', resolve(out, 'Copy Repair.app'), scriptPath], { stdio: 'ignore' });

console.log(`[package] 自包含目录: ${out}`);
console.log('[package] 使用：把 "Copy Repair.app" 拖进「应用程序」，再在「系统设置 → 键盘快捷键 → App 快捷键」绑一个键');
