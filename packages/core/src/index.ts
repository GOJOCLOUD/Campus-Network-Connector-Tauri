/**
 * 共享核心的统一出口。
 *
 * 供三处复用：
 *  - Chromium 扩展（浏览器内 / 后台）
 *  - Safari 页面探针
 *  - Electron 主进程（Node 侧做字形匹配，字形库不进网页）
 */

export {
  flattenPath,
  rasterizeContours,
  blur,
  l1Distance,
  cosineSimilarity,
  CANONICAL_WINDOW,
} from './glyph-matching/raster.ts';

export {
  GlyphDb,
  buildGlyphDb,
  dequantize,
  downsample,
} from './glyph-matching/db.ts';

export {
  decideChar,
  decideScope,
  isConfidentSubstitution,
  DEFAULT_THRESHOLDS,
} from './glyph-matching/policy.ts';

export type { GlyphCandidate, ScopeThresholds } from './glyph-matching/policy.ts';

export { scopeFromStyle, scopeKey, cssFontShorthand, normalizeFamily } from './font-analysis/scope.ts';
export type { FontScope, ScopeStyle } from './font-analysis/scope.ts';

export { collectRuns } from './copy/selection.ts';
export type { TextRun, RunCollector } from './copy/selection.ts';

export { alignRuns, repairSelectionText } from './copy/repair.ts';
export type { MappingResolver, RepairResult, RepairOptions } from './copy/repair.ts';

export { MappingCache } from './mapping-cache/cache.ts';
export type { MappingEntry, ScopeRecord, CacheSnapshot } from './mapping-cache/cache.ts';

export { Logger, RingBufferSink } from './diagnostics/logger.ts';
export type { DiagnosticEvent, LogLevel } from './diagnostics/logger.ts';
