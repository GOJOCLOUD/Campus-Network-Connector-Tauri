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

import { FONTS_LOADED_EVENT, MainWorldRendererClient } from './render/main-world-renderer.ts';
import {
  INTENT_EVENT,
  type BackgroundRequest,
  type BackgroundResponse,
  type CopyIntent,
  type MatchResultItem,
} from './protocol.ts';

/** 页面字体还没加载完时的首轮重试间隔（毫秒）。 */
const FALLBACK_RETRY_MS = 300;
/** 重试间隔上限（毫秒）—— 后面的重试按 1.5 倍拉长，但不超过这个值。 */
const FALLBACK_RETRY_MAX_MS = 2000;
/**
 * 最多重试几次（页面根本没有那个字体时不能无限重试）。
 *
 * 8 次 + 上面那个退避曲线 ⇒ 总窗口约 **10 秒**：
 * 300 + 450 + 675 + 1012 + 1519 + 2000 + 2000 + 2000。
 * 网页字体慢到这个程度还没到，就当它不存在（宁可不改，不可写错字）。
 */
const MAX_FALLBACK_RETRIES = 8;

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
  /**
   * 渲染器 —— **渲染发生在页面主世界**(桥过去),不是隔离世界。
   *
   * 原因:隔离世界拿不到页面的 `@font-face`(实测 `document.fonts` 是空的),
   * 画出来的是回退字体 ⇒ 判定「没混淆」⇒ 永远不还原。
   * 详见 `render/main-world-renderer.ts`。
   */
  private readonly renderer = new MainWorldRendererClient();
  private readonly scopes = new Map<string, ScopeCache>();
  private readonly logger: Logger;
  private readonly sendMessage: (message: BackgroundRequest) => Promise<BackgroundResponse>;
  private readonly debounceMs: number;
  private readonly maxCharsPerRequest: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 字体没加载完时的重试定时器 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连续重试了几次(防止无限重试) */
  private fallbackRetries = 0;
  private intentSeq = 0;
  private stats = {
    copyEvents: 0,
    repairs: 0,
    unresolved: 0,
    requests: 0,
    matchedChars: 0,
    rawCopyEvents: 0,
    /** 最近一次分析里「画成了回退字体」的字符数（>0 ⇒ 字体当时还没到位） */
    fallbackChars: 0,
    /** 因为字体没到位而触发的重试次数 */
    fontRetries: 0,
    /**
     * 诊断：隔离世界能看到的网页字体数量。
     *
     * -1 = 拿不到 `document.fonts`;0 = 拿得到但页面还没注册字体;
     * >0 = 隔离世界**也**能看到页面的 `@font-face`。
     *
     * ⚠️ 实测（2026-10-25，Chromium）：隔离世界的 `document.fonts.size === 1`
     * ⇒ **不是空的**（早先「隔离世界 document.fonts 为空」的判断是错的）。
     * 但隔离世界的 canvas 仍然画不出页面的 webfont（逐像素探针：与「一个
     * 不存在的字体」完全一致）⇒ **字形渲染仍然必须放在主世界**。
     */
    isolatedFontFaces: -1,
    /** 诊断：隔离世界看到的那些字体的状态（loaded / unloaded / error） */
    isolatedFontStatus: '',
    /** 诊断：selectionchange 触发次数 */
    selectionChanges: 0,
    /** 诊断：真正跑过的分析轮数 */
    analysisRuns: 0,
  };
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
    document.addEventListener('selectionchange', () => {
      this.stats.selectionChanges += 1;
      this.scheduleAnalyze();
    });
    // 网页字体**晚到**时要重新分析一次 ——
    // 字体没到之前画出来的是回退字体,那次判定是「没被混淆」,
    // 如果就此定死,用户在字体加载前选字 ⇒ 复制出来就是密文。
    // (2026-10-25 在 CI 上实测到:字体加载慢一点就复现。)
    //
    // 三条通知来源(任何一条都能触发重新分析):
    //  1) 主世界广播的 `copy-repair:fonts-loaded` —— 精确(字体真的到位了才发);
    //     不依赖隔离世界能不能拿到 FontFaceSet,所以最通用。
    //  2) 隔离世界自己的 `loadingdone` —— Chromium 实测能收到
    //     (隔离世界的 `document.fonts.size === 1`),比 1) 快一点点。
    //  3) 轮询兜底(`scheduleRetry`) —— 上面两条都没来时也能自愈。
    document.addEventListener(FONTS_LOADED_EVENT, () => {
      this.logger.debug('fonts-loaded');
      // 字体到位了 ⇒ 重试预算重置(下一轮没到位可以重新开始数)。
      this.fallbackRetries = 0;
      this.scheduleAnalyze();
    }, true);
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.addEventListener('loadingdone', () => this.scheduleAnalyze());
    }
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
    this.stats.analysisRuns += 1;
    const current = this.currentRuns();
    if (!current) return;

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

    // bitmap 走两用：base64 发给后台做匹配，raw 留在本地做"字体变了没"的比对
    const pendingItems: Array<{ scopeKey: string; char: string; bitmap: string; raw: Uint8Array }> = [];
    const touchedScopes: ScopeCache[] = [];
    /** 这一轮里有没有作用域的字体**还没加载完** */
    let needRetry = false;
    /** 这一轮里画成了回退字体的字符数（诊断用：>0 ⇒ 字体当时还没到位） */
    let fallbackChars = 0;

    for (const { scope, chars } of byScope.values()) {
      const key = scopeKey(scope);
      let cache = this.scopes.get(key);

      // **渲染在页面主世界做**(隔离世界拿不到页面的 @font-face ⇒ 画的是回退字体
      // ⇒ 永远判定「没混淆」)。一次一个作用域一批字符,避免逐字往返。
      const rendered = await this.renderer.renderScope(scope, chars.slice(0, this.maxCharsPerRequest));
      // 字体指纹变化 => 旧映射作废
      const signature = rendered.signature;
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

      let sawFallback = false;
      for (const item of rendered.items) {
        if (item.fallback) {
          // 该字符没命中目标字体(页面字体**还没加载完**,画的是回退字体)
          // ⇒ 不参与映射,而且**这一轮的判定不作数**:过一会儿字体到了要重来。
          sawFallback = true;
          fallbackChars += 1;
          continue;
        }
        const existing = cache.chars.get(item.char);
        if (existing && sameBitmap(existing.bitmap, item.bitmap)) continue;
        pendingItems.push({ scopeKey: key, char: item.char, bitmap: item.base64, raw: item.bitmap });
      }
      if (sawFallback) {
        // 这个作用域的字体还没到 ⇒ 稍后重试(见 scheduleRetry)
        needRetry = true;
      }
    }

    if (!needRetry) this.fallbackRetries = 0;
    this.stats.fallbackChars = fallbackChars;

    if (pendingItems.length === 0) {
      this.updateScopeDecisions(touchedScopes);
      this.publishStats();
      if (needRetry) this.scheduleRetry();
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
    if (needRetry) this.scheduleRetry();
  }

  /**
   * 页面字体**还没加载完** ⇒ 过一会儿重新分析。
   *
   * 为什么必须有:字体没到之前,canvas 画出来的是**回退字体**
   * ⇒ 那一轮会判定「这个作用域没被混淆」⇒ 如果就此定死,
   * 用户在网页字体加载完成**之前**选字,复制出来就是密文。
   * (2026-10-25 在 CI 上实测到这个:字体加载慢一点就复现。)
   *
   * 这是**兜底**手段:主世界广播(字体真到位才发)与隔离世界自己的
   * `loadingdone` 是更快的两条路;本条保证「那两条都没来」时也能自愈。
   *
   * 次数有上限(MAX_FALLBACK_RETRIES)—— 页面根本没有那个字体时,
   * 不能无限重试。
   */
  private scheduleRetry(): void {
    if (this.fallbackRetries >= MAX_FALLBACK_RETRIES) return;
    // 退避:越往后间隔越长(字体慢到几秒才到是常态),
    // 但总窗口封顶约 10 秒。
    const delay = Math.min(
      FALLBACK_RETRY_MS * Math.pow(1.5, this.fallbackRetries),
      FALLBACK_RETRY_MAX_MS,
    );
    this.fallbackRetries += 1;
    this.stats.fontRetries += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.analyzeSelection();
    }, delay);
  }

  private applyResults(
    items: Array<{ scopeKey: string; char: string; bitmap: string; raw: Uint8Array }>,
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
        // 位图必须用**本次主世界渲染**的那份 —— 隔离世界自己画不出页面字体。
        bitmap: item.raw,
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
    this.stats.isolatedFontFaces =
      typeof document !== 'undefined' && document.fonts ? document.fonts.size : -1;
    this.stats.isolatedFontStatus =
      typeof document !== 'undefined' && document.fonts
        ? Array.from(document.fonts)
            .map((f) => `${f.family}:${f.status}`)
            .join(',')
        : 'none';
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
