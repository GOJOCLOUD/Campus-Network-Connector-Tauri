/**
 * 页面侧探针（Safari 方案 B 用）。
 *
 * 通过 AppleScript 的 `do JavaScript` 注入到 Safari 页面里，负责：
 *   1) 取当前选区的文本与"按字体作用域分段"的结果
 *   2) 用页面自己的字体把每个字符渲染成归一化位图
 *   3) 把这些数据交回 Node 侧做匹配与还原
 *
 * 页面侧不做匹配：字形库在 Node 侧，避免往页面里塞 2MB 资源。
 */

import { collectRuns, type RunCollector } from '../../../core/src/copy/selection.ts';
import { scopeFromStyle, scopeKey, type FontScope } from '../../../core/src/font-analysis/scope.ts';
import { GlyphRenderer, toBase64 } from './render/glyph-renderer.ts';

export interface ProbeScope {
  family: string;
  weight: string;
  style: string;
  key: string;
  chars: Array<{ char: string; bitmap: string; fallback: boolean }>;
}

export interface ProbeResult {
  nativeText: string;
  runs: Array<{ text: string; scope: { family: string; weight: string; style: string } }>;
  scopes: ProbeScope[];
  /** 页面里是否有选区 */
  hasSelection: boolean;
}

const renderer = new GlyphRenderer(32);

function collector(): RunCollector {
  return {
    resolveScope: (node: Text): FontScope => {
      const style = window.getComputedStyle(node.parentElement ?? node);
      return scopeFromStyle(style);
    },
    isHidden: (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      return style.display === 'none' || style.visibility === 'hidden';
    },
    isConnected: (node: Node): boolean => node.isConnected,
  };
}

export function probe(): ProbeResult {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return { nativeText: '', runs: [], scopes: [], hasSelection: false };
  }
  const nativeText = selection.toString();
  const range = selection.getRangeAt(0);
  const root = range.commonAncestorContainer;
  const container =
    root.nodeType === Node.TEXT_NODE ? (root.parentElement ?? root) : (root as Element);
  const runs = collectRuns(container, collector());

  const byScope = new Map<string, ProbeScope>();
  for (const run of runs) {
    const key = scopeKey(run.scope);
    let entry = byScope.get(key);
    if (!entry) {
      entry = {
        family: run.scope.family,
        weight: run.scope.weight,
        style: run.scope.style,
        key,
        chars: [],
      };
      byScope.set(key, entry);
    }
    const seen = new Set(entry.chars.map((c) => c.char));
    for (const char of run.text) {
      if (char === '\n' || char === '\r' || char === '\t' || char === ' ') continue;
      if (seen.has(char)) continue;
      seen.add(char);
      const render = renderer.render(run.scope, char);
      entry.chars.push({ char, bitmap: toBase64(render.bitmap), fallback: render.fallback });
    }
  }

  return {
    nativeText,
    runs: runs.map((run) => ({
      text: run.text,
      scope: { family: run.scope.family, weight: run.scope.weight, style: run.scope.style },
    })),
    scopes: [...byScope.values()],
    hasSelection: true,
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__copyRepairProbe = probe;
}
