/**
 * Safari 隔离世界内容脚本：与 Chromium 版共用运行时，差别只在消息 API。
 */

import { ContentRuntime } from '../../../packages/browser-adapters/shared/src/content-runtime.ts';
import { Logger } from '../../../packages/core/src/diagnostics/logger.ts';
import type { BackgroundRequest } from '../../../packages/browser-adapters/shared/src/protocol.ts';

const logger = new Logger('info');

const runtime = new ContentRuntime({
  sendMessage: (message: BackgroundRequest) =>
    browser.runtime.sendMessage(message) as Promise<never>,
  logger,
});

runtime.start();

document.addEventListener('copy-repair:guard', (event) => {
  const detail = (event as CustomEvent).detail as { event: string; data?: Record<string, unknown> };
  logger.info(`guard:${detail.event}`, detail.data);
});
