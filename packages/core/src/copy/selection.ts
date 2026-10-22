/**
 * 选区分段：把 DOM 选区切成"同字体作用域"的文本片段。
 *
 * 只使用 Web 标准 DOM API；不依赖任何浏览器专有接口。
 */

import type { FontScope } from '../font-analysis/scope.ts';

export interface TextRun {
  text: string;
  scope: FontScope;
}

export interface RunCollector {
  /** 取文本节点的字体作用域 */
  resolveScope(node: Text): FontScope;
  /** 判断元素是否不可见（不可见内容不参与选区） */
  isHidden(element: Element): boolean;
  /** 判断元素是否在 DOM 树上 */
  isConnected(node: Node): boolean;
}

/** 块级元素分段的 display 取值。 */
const BLOCK_DISPLAYS = new Set([
  'block',
  'flex',
  'grid',
  'table',
  'table-row',
  'table-cell',
  'list-item',
  'flow-root',
]);

/**
 * 遍历选区覆盖的文本节点，产出同作用域连续片段。
 *
 * 注意：这里产出的是"DOM 顺序"的片段，与 selection.toString() 的换行规则不完全一致，
 * 因此上层需要再做一次对齐（见 copy/repair.ts）。
 */
export function collectRuns(root: Node, collector: RunCollector): TextRun[] {
  const runs: TextRun[] = [];
  let current: TextRun | null = null;

  const push = (text: string, scope: FontScope) => {
    if (text.length === 0) return;
    if (current && scopeKeyOf(current.scope) === scopeKeyOf(scope)) {
      current.text += text;
    } else {
      current = { text, scope };
      runs.push(current);
    }
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      if (tag === 'br') {
        push('\n', collector.resolveScope(element as unknown as Text));
        current = null;
        return;
      }
      // 隐藏元素整棵子树都不参与选区
      if (collector.isHidden(element)) return;
      const display = window.getComputedStyle(element).display;
      if (BLOCK_DISPLAYS.has(display) && current) current = null;
      for (const child of Array.from(element.childNodes)) visit(child);
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      if (collector.isConnected(textNode) && textNode.data.length > 0) {
        push(textNode.data, collector.resolveScope(textNode));
      }
    }
  };

  if (root.nodeType === Node.TEXT_NODE) {
    const textNode = root as Text;
    if (textNode.data.length > 0) push(textNode.data, collector.resolveScope(textNode));
  } else {
    for (const child of Array.from((root as Element).childNodes)) visit(child);
  }
  return runs;
}

function scopeKeyOf(scope: FontScope): string {
  return `${scope.style}|${scope.weight}|${scope.family}`;
}
