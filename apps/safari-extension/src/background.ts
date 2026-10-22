/**
 * Safari 后台（非持久化背景页）。
 *
 * 与 Chromium 后台共用同一套匹配逻辑，差别只在 WebExtension API 的调用方式。
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
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function loadDb(): Promise<GlyphDb> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = browser.runtime.getURL('assets/glyph-db.crdb.gz');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`glyph db fetch failed: ${response.status}`);
      const bytes = await gunzip(await response.arrayBuffer());
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
    results.push({
      char: item.char,
      codepoint: match.codepoint,
      score: match.score,
      margin: match.margin,
      selfDistance: ownIndex >= 0 ? db.distanceToIndex(ownIndex, coverage) : 1,
      inReference: ownIndex >= 0,
    });
  }
  return { type: 'cr:match-result', results };
}

browser.runtime.onMessage.addListener((message: BackgroundRequest) => {
  if (!message || typeof message !== 'object') return undefined;
  if (message.type === 'cr:match') {
    return handleMatch(message).catch((error) => {
      logger.error('match-failed', { error: String(error) });
      return { type: 'cr:match-result', results: [] } as BackgroundResponse;
    });
  }
  if (message.type === 'cr:diagnostics') {
    return Promise.resolve({
      type: 'cr:diagnostics-result',
      entries: sink.entries(),
    } as BackgroundResponse);
  }
  return undefined;
});
