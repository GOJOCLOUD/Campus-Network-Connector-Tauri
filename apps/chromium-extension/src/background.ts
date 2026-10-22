/**
 * Chromium 后台（MV3 Service Worker）。
 *
 * 职责：
 *  - 加载并常驻参考字形库（扩展包内，不请求网络）
 *  - 接收内容脚本送来的渲染位图，返回最近邻匹配结果
 *  - 维护诊断环形缓冲，供诊断页查看
 */

import { GlyphDb, dequantize } from '../../../packages/core/src/glyph-matching/db.ts';
import { Logger, RingBufferSink } from '../../../packages/core/src/diagnostics/logger.ts';
import type {
  BackgroundRequest,
  BackgroundResponse,
  MatchRequest,
  MatchResultItem,
} from '../../../packages/browser-adapters/shared/src/protocol.ts';

import { fromBase64 } from '../../../packages/browser-adapters/shared/src/render/glyph-renderer.ts';

const logger = new Logger('info');
const sink = new RingBufferSink(500);
logger.addSink(sink);

let dbPromise: Promise<GlyphDb> | null = null;

async function gunzip(buffer: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return out;
}

async function loadDb(): Promise<GlyphDb> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = chrome.runtime.getURL('assets/glyph-db.crdb.gz');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`glyph db fetch failed: ${response.status}`);
      const raw = await response.arrayBuffer();
      const bytes = await gunzip(raw);
      const db = GlyphDb.deserialize(bytes);
      logger.info('glyph-db-loaded', { count: db.header.count, grid: db.header.gridSize });
      return db;
    })();
  }
  return dbPromise;
}

async function handleMatch(request: MatchRequest): Promise<BackgroundResponse> {
  const db = await loadDb();
  const size = db.header.gridSize;
  const results: MatchResultItem[] = [];

  for (const item of request.items) {
    const bytes = fromBase64(item.bitmap);
    const coverage = dequantize(bytes, 0, size * size);
    const match = db.lookup(coverage);
    const ownIndex = db.indexOfCodepoint(item.char.codePointAt(0) ?? -1);
    const selfDistance = ownIndex >= 0 ? db.distanceToIndex(ownIndex, coverage) : 1;
    results.push({
      char: item.char,
      codepoint: match.codepoint,
      score: match.score,
      margin: match.margin,
      selfDistance,
      inReference: ownIndex >= 0,
    });
  }
  return { type: 'cr:match-result', results };
}

chrome.runtime.onMessage.addListener(
  (message: BackgroundRequest, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'cr:match') {
      handleMatch(message)
        .then(sendResponse)
        .catch((error) => {
          logger.error('match-failed', { error: String(error) });
          sendResponse({ type: 'cr:match-result', results: [] });
        });
      return true;
    }
    if (message.type === 'cr:diagnostics') {
      sendResponse({ type: 'cr:diagnostics-result', entries: sink.entries() });
      return true;
    }
    return false;
  },
);

chrome.runtime.onInstalled.addListener(() => {
  logger.info('extension-installed');
});
