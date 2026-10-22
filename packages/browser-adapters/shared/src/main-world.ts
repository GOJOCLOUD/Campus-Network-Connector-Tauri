/**
 * 主世界护栏（document_start 注入）。
 *
 * 页面脚本与扩展注入脚本运行在同一个 JS 世界（MAIN world），
 * 页面可以给 copy 事件写上自己的 clipboardData，从而破坏复制结果。
 *
 * Chromium 的提交规则（实测结论，见 docs/字体映射技术说明.md）：
 *   · copy 事件未被 preventDefault → 浏览器提交"原始选区"，事件里的 clipboardData 改写被丢弃
 *   · copy 事件被 preventDefault      → 浏览器提交事件里的 clipboardData
 * 因此护栏要做两件事：
 *   1. repair 模式（我们有已验证的替换文本）：拦住页面对 text/plain 的覆盖与 preventDefault
 *   2. observe 模式（我们没有替换文本）：如果页面"既改写 text/plain 又 preventDefault"，
 *      判定为篡改，拦下它的 preventDefault —— 浏览器就会提交原始选区（即用户看到的文字）
 */

import { INTENT_EVENT, type CopyIntent } from './protocol.ts';

export interface GuardOptions {
  onEvent?: (event: string, data?: Record<string, unknown>) => void;
}

interface GuardState {
  copyActive: boolean;
  intent: CopyIntent | null;
  /** 页面是否改写过 text/plain */
  substitution: boolean;
}

export function installMainWorldGuards(options: GuardOptions = {}): GuardState {
  const state: GuardState = { copyActive: false, intent: null, substitution: false };
  const report = (event: string, data?: Record<string, unknown>) => options.onEvent?.(event, data);

  // 隔离世界通过 DOM 事件同步告知"本次复制应写入的文本"
  document.addEventListener(
    INTENT_EVENT,
    (event) => {
      const detail = (event as CustomEvent).detail as CopyIntent | undefined;
      if (!detail) return;
      state.intent = detail;
      state.substitution = false;
      state.copyActive = true;
      report('intent-armed', { id: detail.id, mode: detail.mode });
    },
    true,
  );

  window.addEventListener(
    'copy',
    () => {
      state.copyActive = true;
      // 派发是同步的，微任务在整段派发结束后执行
      queueMicrotask(() => {
        state.copyActive = false;
        state.substitution = false;
      });
    },
    true,
  );

  const patchTransfer = (proto: DataTransfer | undefined): void => {
    if (!proto) return;
    const originalSetData = proto.setData;
    proto.setData = function setData(this: DataTransfer, format: string, data: string) {
      if (state.copyActive && state.intent && isPlainText(format)) {
        if (String(data) !== state.intent.text) {
          state.substitution = true;
          if (state.intent.mode === 'repair') {
            // 我们已经写入验证过的文本，不允许页面覆盖
            report('guard:blocked-setData', { length: String(data).length });
            return;
          }
          report('guard:observed-setData', { length: String(data).length });
        }
      }
      return originalSetData.call(this, format, data);
    };

    const originalClearData = proto.clearData;
    proto.clearData = function clearData(this: DataTransfer, format?: string) {
      if (
        state.copyActive &&
        state.intent?.mode === 'repair' &&
        (format === undefined || isPlainText(format))
      ) {
        report('guard:blocked-clearData', { format: format ?? '*' });
        return;
      }
      return originalClearData.call(this, format);
    };
  };
  patchTransfer(typeof DataTransfer !== 'undefined' ? DataTransfer.prototype : undefined);

  if (typeof Event !== 'undefined' && Event.prototype) {
    const originalPreventDefault = Event.prototype.preventDefault;
    Event.prototype.preventDefault = function preventDefault(this: Event) {
      if (state.copyActive && state.intent && this.type === 'copy') {
        if (state.intent.mode === 'repair') {
          // 我们已经接管了这次复制，页面不能再取消
          report('guard:blocked-preventDefault', { reason: 'repair-mode' });
          return;
        }
        if (state.substitution) {
          // 页面改写了文本还想取消原生复制 = 篡改
          report('guard:blocked-preventDefault', { reason: 'tamper-pattern' });
          return;
        }
      }
      return originalPreventDefault.call(this);
    };
  }

  return state;
}

function isPlainText(format: string): boolean {
  return String(format).toLowerCase() === 'text/plain';
}
