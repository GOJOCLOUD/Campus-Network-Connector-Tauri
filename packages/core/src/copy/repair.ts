/**
 * 复制文本修复：把"DOM 底层字符"替换为"字体实际显示的字符"。
 *
 * 设计原则：
 *  1. 只在"已确认存在混淆的字体作用域"内改动，普通网页原样放行。
 *  2. 任何无法建立可信映射的字符一律保留原字符，绝不猜测、绝不伪造。
 *  3. 输出可诊断：哪些片段被替换、哪些字符没能还原，都记录清楚。
 */

import type { FontScope } from '../font-analysis/scope.ts';
import type { TextRun } from './selection.ts';

export interface MappingResolver {
  /** 该作用域是否已被判定为"混淆字体" */
  isObfuscated(scope: FontScope): boolean;
  /** 底层字符 -> 可见字符；null 表示没有可信映射 */
  mapChar(scope: FontScope, char: string): string | null;
}

export interface RepairSegment {
  /** 在 nativeText 中的起止下标 */
  start: number;
  end: number;
  from: string;
  to: string;
  scope: FontScope;
}

export interface RepairResult {
  text: string;
  changed: boolean;
  applied: RepairSegment[];
  /** 处于混淆作用域但没有可信映射的字符数 */
  unresolved: number;
  /** 因与原生文本对齐失败而整段跳过的 run 数 */
  skippedRuns: number;
  /** 参与判定的混淆 run 数 */
  obfuscatedRuns: number;
}

export interface RepairOptions {
  /**
   * strict = true：某个混淆 run 内只要有一个字符没有可信映射，整个 run 保持原样。
   * strict = false（默认）：逐字符还原，无法还原的字符保留原字符。
   */
  strict?: boolean;
}

/** 一个 run 在 nativeText 中的定位结果。 */
export interface RunAlignment {
  run: TextRun;
  start: number;
  end: number;
}

/**
 * 把 DOM run 对齐到 selection.toString() 的字符序列上。
 *
 * 浏览器的 selection.toString() 会在块级元素之间插入换行，
 * 与 DOM 遍历得到的文本不完全一致，因此这里做"忽略空白差异"的贪心对齐。
 * 对不齐的 run 返回 null，调用方应保持原样而不是猜测位置。
 */
export function alignRuns(runs: TextRun[], nativeText: string): Array<RunAlignment | null> {
  const result: Array<RunAlignment | null> = [];
  let cursor = 0;

  for (const run of runs) {
    if (run.text.length === 0) {
      result.push(null);
      continue;
    }
    // 快路径：完全命中
    const direct = nativeText.indexOf(run.text, cursor);
    if (direct >= 0) {
      result.push({ run, start: direct, end: direct + run.text.length });
      cursor = direct + run.text.length;
      continue;
    }
    // 慢路径：忽略空白差异的贪心对齐
    let ti = cursor;
    let ri = 0;
    const startGuess = ti;
    let ok = true;
    while (ri < run.text.length) {
      const rc = run.text[ri];
      const tc = ti < nativeText.length ? nativeText[ti] : '';
      if (rc === tc) {
        ti += 1;
        ri += 1;
        continue;
      }
      if (/\s/.test(tc) && !/\s/.test(rc)) {
        ti += 1;
        continue;
      }
      if (/\s/.test(rc) && !/\s/.test(tc)) {
        ri += 1;
        continue;
      }
      ok = false;
      break;
    }
    if (ok) {
      result.push({ run, start: startGuess, end: ti });
      cursor = ti;
    } else {
      result.push(null);
    }
  }
  return result;
}

/**
 * 生成修复后的文本。
 *
 * @param nativeText 浏览器原生的选区文本（selection.toString()）
 * @param runs       DOM 选区分段
 * @param resolver   映射来源
 */
export function repairSelectionText(
  nativeText: string,
  runs: TextRun[],
  resolver: MappingResolver,
  options: RepairOptions = {},
): RepairResult {
  const strict = options.strict ?? false;
  const alignments = alignRuns(runs, nativeText);
  const chars = nativeText.split('');
  const applied: RepairSegment[] = [];
  let unresolved = 0;
  let skippedRuns = 0;
  let obfuscatedRuns = 0;

  for (const alignment of alignments) {
    if (!alignment) continue;
    const { run, start } = alignment;
    if (!resolver.isObfuscated(run.scope)) continue;
    obfuscatedRuns += 1;

    let runUnresolved = 0;
    const replacements: Array<{ index: number; from: string; to: string }> = [];
    for (let i = 0; i < run.text.length; i += 1) {
      const from = run.text[i];
      if (from === '\n' || from === '\t' || from === ' ') continue;
      const to = resolver.mapChar(run.scope, from);
      if (to === null) {
        runUnresolved += 1;
        continue;
      }
      if (to === from) continue;
      replacements.push({ index: start + i, from, to });
    }

    if (runUnresolved > 0 && strict) {
      // 严格模式：整段放弃，保持原样
      unresolved += runUnresolved;
      skippedRuns += 1;
      continue;
    }

    unresolved += runUnresolved;
    for (const replacement of replacements) {
      const index = replacement.index;
      if (index < 0 || index >= chars.length) continue;
      if (chars[index] !== replacement.from) {
        // 对齐漂移：放弃该字符，不冒险改错位置
        unresolved += 1;
        continue;
      }
      chars[index] = replacement.to;
      applied.push({
        start: index,
        end: index + 1,
        from: replacement.from,
        to: replacement.to,
        scope: run.scope,
      });
    }
  }

  return {
    text: chars.join(''),
    changed: applied.length > 0,
    applied,
    unresolved,
    skippedRuns,
    obfuscatedRuns,
  };
}
