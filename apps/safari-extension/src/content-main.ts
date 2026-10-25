/**
 * 主世界内容脚本（document_start）：安装复制事件护栏 + 字形渲染服务。
 *
 * 必须早于页面脚本运行，否则页面可以先拿到原生方法再绕过护栏。
 *
 * 为什么字形渲染必须放在主世界：
 * 扩展的隔离世界拿不到页面的 `@font-face`（实测 `document.fonts` 是空的），
 * canvas 画出来的是回退字体 ⇒ 判定「没混淆」⇒ 永远不还原。
 * 主世界是页面自己的上下文，页面的字体当然可用。
 * 详见 `packages/browser-adapters/shared/src/render/main-world-renderer.ts`。
 */

import { installMainWorldGuards } from '../../../packages/browser-adapters/shared/src/main-world.ts';
import { installMainWorldRenderer } from '../../../packages/browser-adapters/shared/src/render/main-world-renderer.ts';

installMainWorldRenderer();

installMainWorldGuards({
  onEvent: (event, data) => {
    document.dispatchEvent(
      new CustomEvent('copy-repair:guard', { detail: { event, data } }),
    );
  },
});
