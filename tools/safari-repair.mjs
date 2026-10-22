/**
 * Safari 复制修复（方案 B：AppleScript 热键工具）。
 *
 * 不需要 Safari Web Extension、不需要付费开发者团队：
 *   1) 通过 `do JavaScript` 把页面探针注入当前标签页
 *   2) 探针取回选区文本、按字体作用域的字符、每个字符的渲染位图
 *   3) Node 侧用参考字形库做匹配与还原（与扩展共用同一套核心代码）
 *   4) 把还原后的文本写回系统剪贴板
 *
 * 用法：
 *   node tools/safari-repair.mjs              # 修复当前选区
 *   node tools/safari-repair.mjs --probe      # 只打印探测数据
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { GlyphDb, dequantize } from '../packages/core/src/glyph-matching/db.ts';
import { decideChar, decideScope } from '../packages/core/src/glyph-matching/policy.ts';
import { repairSelectionText } from '../packages/core/src/copy/repair.ts';
import { scopeFromStyle, scopeKey } from '../packages/core/src/font-analysis/scope.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// 资源位置可覆盖，便于把工具打包成自包含目录分发
const AGENT_PATH = resolve(argValue('agent', resolve(root, 'dist-core/safari-agent/page-agent.js')));
const DB_PATH = resolve(argValue('db', resolve(root, 'vendor/glyph-db-48.crdb.gz')));

function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' });
}

function readClipboard() {
  try {
    // AppleScript 的 clipboard as text 会给多行文本补一个尾随换行，比较时要去掉
    return execFileSync('osascript', ['-e', 'the clipboard as text'], {
      encoding: 'utf8',
    }).replace(/\n$/, '');
  } catch {
    return '';
  }
}

function writeClipboard(text) {
  // 注意：必须显式给 UTF-8 locale。若环境里 LANG/LC_CTYPE 是 "C"，
  // pbcopy 遇到非 ASCII 会静默写空（实测踩过：剪贴板变成空的）。
  const result = spawnSync('pbcopy', {
    input: text,
    env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  });
  if (result.status !== 0) throw new Error(`pbcopy 失败: ${result.stderr?.toString()}`);
}

/** 写完必须回读核对：不能只打印"打算写的内容"就当成功。 */
function writeClipboardVerified(text) {
  writeClipboard(text);
  const actual = readClipboard();
  if (actual.replace(/\n$/, '') !== text.replace(/\n$/, '')) {
    throw new Error(
      `剪贴板写入未生效（期望 ${JSON.stringify(text.slice(0, 40))}，实际 ${JSON.stringify(actual.slice(0, 40))}）`,
    );
  }
}

/** 把页面探针注入当前标签页并取回结果 */
function runProbe() {
  if (!existsSync(AGENT_PATH)) {
    throw new Error(`页面探针未构建，请先执行 node tools/build-safari-tool.mjs`);
  }
  // 标签选择：
  //   默认 —— 用户当前正在看的那个标签页（front tab of front window）
  //   --url-contains —— 在前台窗口里找 URL 含该串的标签（自动化测试用，
  //                    避免新开的标签没有切到前台导致选区找不到）
  const urlFilter = process.argv.find((a) => a.startsWith('--url-contains='));
  const filter = urlFilter ? urlFilter.slice('--url-contains='.length) : '';
  const agentPath = AGENT_PATH.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  let target = 'front tab of front window';
  if (filter) {
    // 先把目标解析成 (窗口号, 标签号)：AppleScript 的 tab 引用跨循环会失效，
    // 必须在同一次调用里用显式索引。
    const located = osa(`tell application "Safari"
      set out to ""
      repeat with wi from 1 to (count of windows)
        try
          repeat with ti from 1 to (count of tabs of window wi)
            if (URL of tab ti of window wi) contains "${filter.replace(/"/g, '')}" then
              set out to (wi as text) & "," & (ti as text)
              exit repeat
            end if
          end repeat
        end try
        if out is not "" then exit repeat
      end repeat
      return out
    end tell`).trim();
    if (located) target = `tab ${located.split(',')[1]} of window ${located.split(',')[0]}`;
  }

  const script = `
    set jsCode to (read POSIX file "${agentPath}") as «class utf8»
    tell application "Safari"
      do JavaScript jsCode in ${target}
      do JavaScript "JSON.stringify(window.__copyRepairProbe ? window.__copyRepairProbe() : {hasSelection:false})" in ${target}
    end tell
  `;
  const raw = osa(script).trim();
  if (!raw) throw new Error('页面探针没有返回数据');
  return JSON.parse(raw);
}

function matchScopes(db, probe) {
  /** scopeKey -> { scope, candidates: GlyphCandidate[] } */
  const byScope = new Map();

  for (const probeScope of probe.scopes) {
    const scope = scopeFromStyle({
      fontFamily: probeScope.family,
      fontWeight: probeScope.weight,
      fontStyle: probeScope.style,
    });
    const key = scopeKey(scope);
    const candidates = [];
    for (const entry of probeScope.chars) {
      if (entry.fallback) continue; // 没命中目标字体，不参与
      const bytes = Buffer.from(entry.bitmap, 'base64');
      const coverage = dequantize(new Uint8Array(bytes), 0, db.header.gridSize * db.header.gridSize);
      const match = db.lookup(coverage);
      const ownIndex = db.indexOfCodepoint(entry.char.codePointAt(0) ?? -1);
      const candidate = {
        char: entry.char,
        bestCodepoint: match.codepoint,
        bestScore: match.score,
        bestMargin: match.margin,
        selfDistance: ownIndex >= 0 ? db.distanceToIndex(ownIndex, coverage) : 1,
        inReference: ownIndex >= 0,
      };
      candidates.push(candidate);
    }
    byScope.set(key, { scope, candidates, decision: decideScope(candidates) });
  }
  return byScope;
}

/** 两个字符串是否有任何共同字符（用于区分"篡改垃圾"与"用户复制的别的东西"） */
function shareAnyChar(a, b) {
  if (!a || !b) return false;
  const set = new Set(a.replace(/\s/g, ''));
  for (const ch of b.replace(/\s/g, '')) {
    if (set.has(ch)) return true;
  }
  return false;
}

function main() {
  const probeOnly = process.argv.includes('--probe');
  // 参考库随包分发的是 gzip 版（.crdb.gz），解开后才是 CRDB 字节
  let raw = readFileSync(DB_PATH);
  if (DB_PATH.endsWith('.gz')) raw = gunzipSync(raw);
  const db = GlyphDb.deserialize(new Uint8Array(raw));
  const probe = runProbe();

  if (!probe.hasSelection || !probe.nativeText) {
    console.log('没有选区。先在 Safari 里选中一段文字再运行。');
    return;
  }
  console.log(`选区文本   : ${JSON.stringify(probe.nativeText.slice(0, 60))}`);
  console.log(`字体作用域 : ${probe.scopes.map((s) => s.family).join(' | ')}`);

  const byScope = matchScopes(db, probe);
  for (const [key, info] of byScope) {
    console.log(
      `  · ${key} → ${info.decision.obfuscated ? '混淆字体' : '普通字体'}` +
        ` (投票 ${info.decision.votes}/${info.decision.samples})`,
    );
  }

  if (probeOnly) {
    for (const [key, info] of byScope) {
      console.log(`\n[${key}]`);
      for (const c of info.candidates.slice(0, 12)) {
        const mapped = decideChar(c);
        console.log(
          `  ${c.char} → ${mapped ?? '(不还原)'}  score=${c.bestScore.toFixed(3)} ` +
            `margin=${c.bestMargin.toFixed(3)} self=${c.selfDistance.toFixed(3)}`,
        );
      }
    }
    return;
  }

  const before = readClipboard();
  const runs = probe.runs.map((run) => ({
    text: run.text,
    scope: scopeFromStyle({
      fontFamily: run.scope.family,
      fontWeight: run.scope.weight,
      fontStyle: run.scope.style,
    }),
  }));
  const result = repairSelectionText(probe.nativeText, runs, {
    isObfuscated: (scope) => byScope.get(scopeKey(scope))?.decision.obfuscated ?? false,
    mapChar: (scope, char) => {
      const info = byScope.get(scopeKey(scope));
      if (!info) return null;
      const candidate = info.candidates.find((c) => c.char === char);
      if (!candidate) return null;
      return decideChar(candidate);
    },
  });

  if (!result.changed) {
    // 没有可信的字体映射 —— 默认不动剪贴板（避免误伤"用户复制的是 URL/代码"等场景）。
    // --restore 开关：只在剪贴板内容与可见文字**毫无字符重叠**时，判定为网页篡改并恢复。
    const restore = process.argv.includes('--restore');
    const overlap = shareAnyChar(before, probe.nativeText);
    if (!restore) {
      console.log('没有可用的字体映射，剪贴板未改动（如需恢复被网页篡改的内容，加 --restore）');
      return;
    }
    if (overlap) {
      console.log('剪贴板与可见文字有共同字符，判定为正常复制，未改动');
      return;
    }
    writeClipboardVerified(probe.nativeText);
    console.log(`剪贴板被网页改写（与可见文字无任何共同字符），已恢复为可见文字（${probe.nativeText.length} 字符）`);
    console.log(`原剪贴板: ${JSON.stringify(before.slice(0, 60))}`);
    console.log(`现剪贴板: ${JSON.stringify(probe.nativeText.slice(0, 60))}`);
    return;
  }

  writeClipboardVerified(result.text);
  console.log(`已还原 ${result.applied.length} 个字符，未还原 ${result.unresolved} 个`);
  console.log(`剪贴板: ${JSON.stringify(result.text.slice(0, 80))}`);
}

main();
