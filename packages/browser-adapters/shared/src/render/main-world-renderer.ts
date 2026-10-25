/**
 * 主世界渲染桥 —— 浏览器扩展（Chromium / Safari Web Extension）专用。
 *
 * ## 为什么必须有它
 *
 * 扩展的**内容脚本跑在隔离世界**。实测（Chromium，2026-10-25，页面里的
 * 字体混淆夹具）：
 *
 * | 上下文 | `document.fonts` | canvas 画「ObfA」的结果 |
 * | --- | --- | --- |
 * | 页面**主世界** | 有（`ObfA:loaded`） | 与缺省字体**不同** ⇒ 字体可用 |
 * | 扩展**隔离世界** | **空** | 与「一个不存在的字体」**逐像素相同** ⇒ 字体用不了 |
 *
 * ⇒ 隔离世界里 canvas 画出来的是**回退字体** ⇒ 字形的最近邻还是它自己
 * ⇒ 判定「这个作用域没被混淆」⇒ **永远不还原**
 * （实测：仓库自带的 e2e 用例 6 个挂 4 个，复制出来还是密文）。
 *
 * ## 为什么 Mac 上没这个问题
 *
 * Mac 那条路（Safari + Apple Events）执行的 JS **就在页面主世界里**
 * —— `page-agent.ts` 就是那么跑的 ⇒ 页面自己的字体当然可用。
 * ⇒ 同一个机制搬到 Chromium 上，**必须把渲染也搬到主世界**，
 * 不能只把「匹配」搬过去。
 *
 * ## 桥的形状
 *
 * 隔离世界 → 主世界:一条 DOM CustomEvent(`copy-repair:render-request`),
 * 带自增 id 与随机 token;主世界渲染完再派发一条
 * (`copy-repair:render-response`),原样带回 token / id / 结果。
 *
 * **一次请求一批字符**(一个作用域一批)—— 每个字符一次往返太慢。
 *
 * ⚠️ 这条通道**不是安全边界**:页面脚本同样能看到这两个事件、也能伪造响应。
 * 本工具只在本机运行、只影响剪贴板内容,故按「够用且可审计」处理:
 * 请求带随机 token,响应必须原样带回才算数(挡的是串台,不是恶意页面)。
 */

import { fromBase64, GlyphRenderer, toBase64 } from './glyph-renderer.ts';
import { REFERENCE_GRID_SIZE } from '../../../../core/src/glyph-matching/grid.ts';
import type { FontScope } from '../../../core/src/font-analysis/scope.ts';

/** 隔离世界 → 主世界:请求渲染一批字符。 */
export const RENDER_REQUEST_EVENT = 'copy-repair:render-request';
/** 主世界 → 隔离世界:渲染结果。 */
export const RENDER_RESPONSE_EVENT = 'copy-repair:render-response';
/**
 * 主世界 → 隔离世界:页面字体加载完成。
 *
 * 为什么需要它:字体晚到时,扩展在**隔离世界**里第一次画出来的是回退字体
 * ⇒ 那一轮判定「没被混淆」⇒ 用户复制出来还是密文。
 * 让隔离世界在字体到位后重新分析一次,才能自愈。
 *
 * 为什么由主世界广播:主世界一定能拿到页面的 `document.fonts`
 * ⇒ 一定收得到 `loadingdone`。隔离世界能不能收到取决于引擎
 * (Chromium 实测**能**收到,`document.fonts.size === 1`),
 * 所以两条路都留着,互为保险。
 */
export const FONTS_LOADED_EVENT = 'copy-repair:fonts-loaded';

export interface RenderRequestDetail {
  /** 随机 token:响应必须原样带回,否则丢弃 */
  token: string;
  id: number;
  scope: FontScope;
  chars: string[];
}

export interface RenderedChar {
  char: string;
  /** 4bit 量化位图(base64) */
  bitmap: string;
  /** 该字符没命中目标字体(渲染成了回退字体) */
  fallback: boolean;
}

export interface RenderResponseDetail {
  token: string;
  id: number;
  /** 字体指纹:字体文件被换掉时随之变化 */
  signature: string;
  items: RenderedChar[];
}

/**
 * 主世界侧:装上渲染服务。
 *
 * 必须在 `document_start` 装 —— 与护栏同一个脚本、同一套注入时机。
 */
export function installMainWorldRenderer(): void {
  // 栅格尺寸必须与参考库一致（REFERENCE_GRID_SIZE），否则位图错位、匹配全是噪声。
  const renderer = new GlyphRenderer(REFERENCE_GRID_SIZE);
  // 页面字体加载完成 ⇒ 广播给隔离世界，让它重新分析一次。
  // （隔离世界在 Chromium 里也能收到 loadingdone，这条是跨引擎的保险。）
  if (typeof document !== 'undefined' && document.fonts) {
    document.fonts.addEventListener('loadingdone', () => {
      try {
        document.dispatchEvent(new CustomEvent(FONTS_LOADED_EVENT, { detail: { at: Date.now() } }));
      } catch {
        /* 广播失败不影响主流程 */
      }
    });
  }
  document.addEventListener(
    RENDER_REQUEST_EVENT,
    (event) => {
      const detail = (event as CustomEvent).detail as RenderRequestDetail | undefined;
      if (!detail || typeof detail.id !== 'number' || !Array.isArray(detail.chars)) return;
      let response: RenderResponseDetail;
      try {
        // 字体可能被页面换掉了 ⇒ 每次请求前先作废渲染缓存
        // (与原实现「每次分析前 clearCache()」的语义一致)
        renderer.clearCache();
        const items: RenderedChar[] = detail.chars.map((char) => {
          const result = renderer.render(detail.scope, char);
          return { char, bitmap: toBase64(result.bitmap), fallback: result.fallback };
        });
        response = {
          token: detail.token,
          id: detail.id,
          signature: renderer.signature(detail.scope),
          items,
        };
      } catch (_) {
        // 渲染失败 ⇒ 交回空结果:这一轮不做替换(保持浏览器原生行为),
        // 绝不用"猜"出来的字去改剪贴板。
        response = { token: detail.token, id: detail.id, signature: '', items: [] };
      }
      document.dispatchEvent(new CustomEvent(RENDER_RESPONSE_EVENT, { detail: response }));
    },
    true,
  );
}

export interface RenderedBatch {
  /** 字体指纹(空串 = 主世界没应答) */
  signature: string;
  items: Array<{ char: string; bitmap: Uint8Array; base64: string; fallback: boolean }>;
}

/**
 * 隔离世界侧:把渲染请求递到主世界去。
 *
 * 主世界没应答(脚本没装上/被页面弄坏)⇒ 超时后交回空结果,
 * 这一轮不替换任何字符 —— **宁可不改,不可写错字**。
 */
export class MainWorldRendererClient {
  private readonly pending = new Map<number, (detail: RenderResponseDetail) => void>();
  private readonly token: string;
  private readonly timeoutMs: number;
  private seq = 0;

  constructor(timeoutMs = 3000) {
    this.timeoutMs = timeoutMs;
    this.token = `cr-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    document.addEventListener(
      RENDER_RESPONSE_EVENT,
      (event) => {
        const detail = (event as CustomEvent).detail as RenderResponseDetail | undefined;
        if (!detail || detail.token !== this.token) return;
        const resolve = this.pending.get(detail.id);
        if (!resolve) return;
        this.pending.delete(detail.id);
        resolve(detail);
      },
      true,
    );
  }

  /** 渲染一个作用域里的一批字符(主世界执行)。 */
  renderScope(scope: FontScope, chars: string[]): Promise<RenderedBatch> {
    if (chars.length === 0) {
      return Promise.resolve({ signature: '', items: [] });
    }
    const id = ++this.seq;
    return new Promise<RenderedBatch>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ signature: '', items: [] });
      }, this.timeoutMs);
      this.pending.set(id, (detail) => {
        clearTimeout(timer);
        resolve({
          signature: detail.signature,
          items: (detail.items || []).map((item) => ({
            char: item.char,
            bitmap: fromBase64(item.bitmap),
            base64: item.bitmap,
            fallback: !!item.fallback,
          })),
        });
      });
      try {
        document.dispatchEvent(
          new CustomEvent(RENDER_REQUEST_EVENT, {
            detail: { token: this.token, id, scope, chars } as RenderRequestDetail,
          }),
        );
      } catch (_) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ signature: '', items: [] });
      }
    });
  }
}
