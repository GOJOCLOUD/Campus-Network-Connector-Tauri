/**
 * 主世界内容脚本（document_start）：安装复制事件护栏。
 *
 * 必须早于页面脚本运行，否则页面可以先拿到原生方法再绕过护栏。
 */

import { installMainWorldGuards } from '../../../packages/browser-adapters/shared/src/main-world.ts';

installMainWorldGuards({
  onEvent: (event, data) => {
    document.dispatchEvent(
      new CustomEvent('copy-repair:guard', { detail: { event, data } }),
    );
  },
});
