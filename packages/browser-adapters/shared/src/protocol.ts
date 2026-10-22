/**
 * 内容脚本 <-> 后台 之间的消息协议（Chromium 与 Safari 通用）。
 */

export interface MatchRequestItem {
  /** 作用域键 */
  scopeKey: string;
  /** 底层字符 */
  char: string;
  /** 渲染位图（4bit 量化，base64） */
  bitmap: string;
}

export interface MatchRequest {
  type: 'cr:match';
  items: MatchRequestItem[];
}

export interface MatchResultItem {
  char: string;
  /** 参考库最近邻码位；null 表示库里没有可用匹配 */
  codepoint: number | null;
  /** 最近邻相似度 0..1 */
  score: number;
  /** 与次近邻的差距 0..1 */
  margin: number;
  /** 与"该字符自身参考字形"的距离 0..1 */
  selfDistance: number;
  /** 字符是否存在于参考库 */
  inReference: boolean;
}

export interface MatchResponse {
  type: 'cr:match-result';
  results: MatchResultItem[];
}

export interface CacheSnapshotRequest {
  type: 'cr:cache-snapshot';
}

export interface CacheSnapshotResponse {
  type: 'cr:cache-snapshot-result';
  snapshot: unknown;
}

export interface DiagnosticsRequest {
  type: 'cr:diagnostics';
}

export interface DiagnosticsResponse {
  type: 'cr:diagnostics-result';
  entries: Array<{ at: number; level: string; event: string; data?: Record<string, unknown> }>;
  stats?: Record<string, unknown>;
}

export type BackgroundRequest =
  | MatchRequest
  | CacheSnapshotRequest
  | DiagnosticsRequest;

export type BackgroundResponse =
  | MatchResponse
  | CacheSnapshotResponse
  | DiagnosticsResponse;

/** 主世界 <-> 隔离世界 的 DOM 事件通道（同步、无需消息总线）。 */
export const INTENT_EVENT = 'copy-repair:intent';

export interface CopyIntent {
  /** 本次复制期望写入的文本（修复后的可见文本，或原始选区文本） */
  text: string;
  /**
   * repair —— 我们有已验证的替换文本，护栏全面接管；
   * observe —— 我们没有替换文本，只在页面"改写文本 + 取消默认动作"时介入。
   */
  mode: 'repair' | 'observe';
  /** 诊断编号，便于对照日志 */
  id: number;
}
