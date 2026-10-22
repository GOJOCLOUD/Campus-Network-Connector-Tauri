/**
 * 内容脚本运行时（隔离世界）：把"选区 → 字体作用域 → 映射 → 修复文本"串成一条链路。
 *
 * Chromium 与 Safari 共用这一份实现，浏览器差异只体现在：
 *  - sendMessage 的具体 API
 *  - 扩展资源 URL 的取法
 *
 * 关键约束：
 *  - 复制事件必须同步完成：映射在"选中时"预先算好，复制时只做查表 + 拼接
 *  - 不满足条件时保持浏览器原生行为，绝不 preventDefault
 */

import { collectRuns, type RunCollector, type TextRun } from '../../../core/src/copy/selection.ts';
import { repairSelectionText, type MappingResolver, type RepairResult } from '../../../core/src/copy/repair.ts';
import { scopeFromStyle, scopeKey, type FontScope } from '../../../core/src/font-analysis/scope.ts';
import { decideChar, decideScope, type GlyphCandidate } from '../../../core/src/glyph-matching/policy.ts';
import type { Logger } from '../../../core/src/diagnostics/logger.ts';

import { GlyphRenderer, toBase64 } from './render/glyph-renderer.ts';
import {
  INTENT_EVENT,
  type BackgroundRequest,
  type BackgroundResponse,
  type CopyIntent,
  type MatchResultItem,
} from './protocol.ts';

export interface CharMapping {
  /** 参考库最近邻码位（原始值，未经过阈值过滤） */
  bestCodepoint: number | null;
  score: number;
  margin: number;
  selfDistance: number;
  inReference: boolean;
  /** 渲染位图，用于检测字体变化 */
  bitmap: Uint8Array;
}

export interface ScopeCache {
  scope: FontScope;
  key: string;
  signature: string;
  obfuscated: boolean;
  chars: Map<string, CharMapping>;
  updatedAt: number;
}

export interface ContentRuntimeOptions {
  sendMessage: (message: BackgroundRequest) => Promise<BackgroundResponse>;
  logger: Logger;
  /** 选区变化后的防抖间隔（毫秒） */
  debounceMs?: number;
  /** 单次请求最多处理多少个字符 */
  maxCharsPerRequest?: number;
}

export class ContentRuntime {
  private readonly renderer = new GlyphRenderer(32);
  private readonly scopes = new Map<string, ScopeCache>();
  private readonly logger: Logger;
  private readonly sendMessage: (message: BackgroundRequest) => Promise<BackgroundResponse>;
  private readonly debounceMs: number;
  private readonly maxCharsPerRequest: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private intentSeq = 0;
  private stats = { copyEvents: 0, repairs: 0, unresolved: 0, requests: 0, matchedChars: 0, rawCopyEvents: 0 };
  private debugScope: unknown = null;

  constructor(options: ContentRuntimeOptions) {
    this.sendMessage = options.sendMessage;
    this.logger = options.logger;
    this.debounceMs = options.debounceMs ?? 120;
    this.maxCharsPerRequest = options.maxCharsPerRequest ?? 96;
  }

  start(): void {
    window.addEventListener('copy', () => {
      this.stats.rawCopyEvents = (this.stats.rawCopyEvents ?? 0) + 1;
    }, true);
    window.addEventListener('copy', (event) => this.onCopy(event), true);
    window.addEventListener('copy', (event) => this.onCopyBubble(event), false);
    document.addEventListener('selectionchange', () => this.scheduleAnalyze());
    this.logger.info('runtime-started');
  }

  /* ---------------- 选区分析 ---------------- */

  private scheduleAnalyze(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.analyzeSelection();
    }, this.debounceMs);
  }

  private collector(): RunCollector {
    return {
      resolveScope: (node: Text): FontScope => {
        const style = window.getComputedStyle(node.parentElement ?? node);
        return scopeFromStyle(style);
      },
      isHidden: (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display === 'none' || style.visibility === 'hidden';
      },
      isConnected: (node: Node): boolean => node.isConnected,
    };
  }

  private currentRuns(): { runs: TextRun[]; nativeText: string } | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const nativeText = selection.toString();
    if (nativeText.length === 0) return null;
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const container = root.nodeType === Node.TEXT_NODE ? root.parentElement ?? root : (root as Element);
    const runs = collectRuns(container, this.collector());
    return { runs, nativeText };
  }

  private async analyzeSelection(): Promise<void> {
    const current = this.currentRuns();
    if (!current) return;

    // 字体可能被页面换掉了：渲染缓存必须先作废，否则会拿旧位图去比对
    this.renderer.clearCache();

    // 按作用域分组，取每个作用域里出现过的不同字符
    const byScope = new Map<string, { scope: FontScope; chars: string[] }>();
    for (const run of current.runs) {
      const key = scopeKey(run.scope);
      let entry = byScope.get(key);
      if (!entry) {
        entry = { scope: run.scope, chars: [] };
        byScope.set(key, entry);
      }
      for (const char of run.text) {
        if (char === '\n' || char === '\r' || char === '\t' || char === ' ') continue;
        if (!entry.chars.includes(char)) entry.chars.push(char);
      }
    }

    const pendingItems: Array<{ scopeKey: string; char: string; bitmap: string }> = [];
    const touchedScopes: ScopeCache[] = [];

    for (const { scope, chars } of byScope.values()) {
      const key = scopeKey(scope);
      let cache = this.scopes.get(key);

      // 字体指纹变化 => 旧映射作废
      const signature = this.renderer.signature(scope);
      if (cache && cache.signature !== signature) {
        this.logger.info('font-changed', { scope: key });
        cache.chars.clear();
        cache.obfuscated = false;
        cache.signature = signature;
      }
      if (!cache) {
        cache = {
          scope,
          key,
          signature,
          obfuscated: false,
          chars: new Map(),
          updatedAt: Date.now(),
        };
        this.scopes.set(key, cache);
      }
      touchedScopes.push(cache);

      for (const char of chars.slice(0, this.maxCharsPerRequest)) {
        const render = this.renderer.render(scope, char);
        if (render.fallback) {
          // 该字符没命中目标字体（可能是回退字体），不参与映射
          continue;
        }
        const existing = cache.chars.get(char);
        if (existing && sameBitmap(existing.bitmap, render.bitmap)) continue;
        pendingItems.push({ scopeKey: key, char, bitmap: toBase64(render.bitmap) });
      }
    }

    if (pendingItems.length === 0) {
      this.updateScopeDecisions(touchedScopes);
      this.publishStats();
      return;
    }

    this.stats.requests += 1;
    try {
      const response = (await this.sendMessage({
        type: 'cr:match',
        items: pendingItems,
      })) as { type: 'cr:match-result'; results: MatchResultItem[] };
      this.applyResults(pendingItems, response.results, touchedScopes);
    } catch (error) {
      this.logger.warn('match-request-failed', { error: String(error) });
    }
    this.publishStats();
  }

  private applyResults(
    items: Array<{ scopeKey: string; char: string; bitmap: string }>,
    results: MatchResultItem[],
    touchedScopes: ScopeCache[],
  ): void {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const result = results[i];
      const cache = this.scopes.get(item.scopeKey);
      if (!cache || !result) continue;
      const candidate: GlyphCandidate = {
        char: item.char,
        bestCodepoint: result.codepoint,
        bestScore: result.score,
        bestMargin: result.margin,
        selfDistance: result.selfDistance,
        inReference: result.inReference,
      };
      cache.chars.set(item.char, {
        bestCodepoint: result.codepoint,
        score: result.score,
        margin: result.margin,
        selfDistance: result.selfDistance,
        inReference: result.inReference,
        bitmap: this.renderer.render(cache.scope, item.char).bitmap,
      });
      this.stats.matchedChars += 1;
    }
    for (const scope of touchedScopes) scope.updatedAt = Date.now();
    this.updateScopeDecisions(touchedScopes);
  }

  /** 依据当前已知的字形证据重新判定每个作用域是否为混淆字体。 */
  private updateScopeDecisions(scopes: ScopeCache[]): void {
    for (const cache of scopes) {
      const candidates: GlyphCandidate[] = [];
      for (const [char, mapping] of cache.chars) {
        candidates.push({
          char,
          bestCodepoint: mapping.bestCodepoint,
          bestScore: mapping.score,
          bestMargin: mapping.margin,
          selfDistance: mapping.selfDistance,
          inReference: mapping.inReference,
        });
      }
      const decision = decideScope(candidates);
      cache.obfuscated = decision.obfuscated;
      this.debugScope = {
        key: cache.key,
        obfuscated: decision.obfuscated,
        votes: decision.votes,
        samples: decision.samples,
        medianSelfDistance: Number(decision.medianSelfDistance.toFixed(3)),
        chars: candidates.slice(0, 6).map((c) => ({
          char: c.char,
          best: c.bestCodepoint !== null ? String.fromCodePoint(c.bestCodepoint) : null,
          score: Number(c.bestScore.toFixed(3)),
          margin: Number(c.bestMargin.toFixed(3)),
          self: Number(c.selfDistance.toFixed(3)),
          inRef: c.inReference,
        })),
      };
      this.logger.debug('scope-decision', {
        scope: cache.key,
        obfuscated: decision.obfuscated,
        votes: decision.votes,
        samples: decision.samples,
      });
    }
  }

  private resolver(): MappingResolver {
    return {
      isObfuscated: (scope) => this.scopes.get(scopeKey(scope))?.obfuscated ?? false,
      mapChar: (scope, char) => {
        const mapping = this.scopes.get(scopeKey(scope))?.chars.get(char);
        if (!mapping) return null;
        const decided = decideChar({
          char,
          bestCodepoint: mapping.bestCodepoint,
          bestScore: mapping.score,
          bestMargin: mapping.margin,
          selfDistance: mapping.selfDistance,
          inReference: mapping.inReference,
        });
        return decided;
      },
    };
  }

  /* ---------------- 复制事件 ---------------- */

  private onCopy(event: ClipboardEvent): void {
    this.stats.copyEvents += 1;
    const current = this.currentRuns();
    if (!current) return;

    const repair: RepairResult = repairSelectionText(
      current.nativeText,
      current.runs,
      this.resolver(),
    );

    if (!repair.changed) {
      this.logger.debug('copy-native', {
        obfuscatedRuns: repair.obfuscatedRuns,
        unresolved: repair.unresolved,
      });
      // 没有可验证的替换文本时，进入 observe 模式：
      // 若页面"改写 text/plain 又 preventDefault"，护栏会拦下它，浏览器于是提交原始选区。
      this.dispatchIntent(current.nativeText, 'observe');
      this.publishStats();
      return;
    }

    const clipboard = event.clipboardData;
    if (!clipboard) {
      this.publishStats();
      return;
    }

    // 只写 text/plain，不动浏览器原生的其它剪贴板格式
    try {
      clipboard.setData('text/plain', repair.text);
    } catch (error) {
      this.logger.warn('clipboard-write-failed', { error: String(error) });
      this.publishStats();
      return;
    }

    // 必须取消默认动作：Chrome 只有在 copy 事件被 preventDefault 时，
    // 才会把事件里 clipboardData 的内容提交到系统剪贴板；
    // 不取消默认动作时，浏览器会丢弃这里的改写、仍然复制原始选区。
    // （实测见 docs/字体映射技术说明.md · 复制提交机制）
    event.preventDefault();

    // 通知主世界护栏：本次复制已经写入修复文本，后续页面写入应被阻止
    this.dispatchIntent(repair.text, 'repair');

    this.stats.repairs += 1;
    this.stats.unresolved += repair.unresolved;
    this.publishStats();
    this.logger.info('copy-repaired', {
      applied: repair.applied.length,
      unresolved: repair.unresolved,
      obfuscatedRuns: repair.obfuscatedRuns,
      scopes: [...new Set(repair.applied.map((s) => s.scope.family))].length,
    });
  }

  /**
   * 冒泡阶段复写：页面的冒泡监听器可能晚于我们的捕获监听器执行，
   * 这里在 window 冒泡阶段再写一次，把页面的覆盖顶回去。
   */
  private onCopyBubble(event: ClipboardEvent): void {
    const current = this.currentRuns();
    if (!current) return;
    const repair = repairSelectionText(current.nativeText, current.runs, this.resolver());
    if (!repair.changed) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    try {
      if (clipboard.getData('text/plain') !== repair.text) {
        clipboard.setData('text/plain', repair.text);
        event.preventDefault();
        this.logger.debug('copy-rewritten-in-bubble');
      }
    } catch (error) {
      this.logger.debug('clipboard-bubble-failed', { error: String(error) });
    }
  }

  /** 把"本次复制应写入的文本"同步告知主世界护栏。 */
  private dispatchIntent(text: string, mode: 'repair' | 'observe'): void {
    const intent: CopyIntent = {
      text,
      mode,
      id: ++this.intentSeq,
    };
    try {
      document.dispatchEvent(new CustomEvent(INTENT_EVENT, { detail: intent }));
    } catch (error) {
      this.logger.warn('intent-dispatch-failed', { error: String(error) });
    }
  }

  getStats(): Record<string, unknown> {
    let entries = 0;
    let obfuscated = 0;
    for (const cache of this.scopes.values()) {
      entries += cache.chars.size;
      if (cache.obfuscated) obfuscated += 1;
    }
    return {
      ...this.stats,
      scopes: this.scopes.size,
      obfuscatedScopes: obfuscated,
      cachedChars: entries,
      debugScope: this.debugScope,
    };
  }

  /**
   * 把运行状态写到页面根节点属性上（只含计数，不含任何用户文本）。
   * 用途：e2e 测试与排障时观察扩展是否在正常工作。
   */
  private publishStats(): void {
    try {
      document.documentElement.setAttribute(
        'data-copy-repair',
        JSON.stringify(this.getStats()),
      );
    } catch {
      /* 忽略：诊断通道失败不影响主流程 */
    }
  }
}

function sameBitmap(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
