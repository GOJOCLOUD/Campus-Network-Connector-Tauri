/**
 * 隔离世界内容脚本：负责选区分析、字形匹配请求、复制时写回修复文本。
 */

import { ContentRuntime } from '../../../packages/browser-adapters/shared/src/content-runtime.ts';
import { Logger } from '../../../packages/core/src/diagnostics/logger.ts';
import type { BackgroundRequest } from '../../../packages/browser-adapters/shared/src/protocol.ts';

const logger = new Logger('info');

const runtime = new ContentRuntime({
  sendMessage: (message: BackgroundRequest) =>
    chrome.runtime.sendMessage(message) as Promise<never>,
  logger,
});

runtime.start();

// 主世界护栏事件转成诊断日志（主世界拿不到 chrome.* API）
document.addEventListener('copy-repair:guard', (event) => {
  const detail = (event as CustomEvent).detail as { event: string; data?: Record<string, unknown> };
  logger.info(`guard:${detail.event}`, detail.data);
});
