/**
 * 字形渲染器：用页面自己的字体把字符渲染成归一化覆盖度位图。
 *
 * 为什么走 canvas 而不是解析字体文件：
 *  - 不需要下载/解析 WOFF/WOFF2/TTF/OTF，不受 CORS 与字体容器格式限制
 *  - 渲染结果就是浏览器实际显示的样子，天然处理 CFF/glyf/可变字体/unicode-range
 *  - 同一份代码在 Chromium 与 Safari 都能跑
 *
 * 归一化窗口与参考库一致：x∈[0,1em]，y∈[-0.85em,+0.15em]，基线在 0.85 处。
 */

import { blur } from '../../../../core/src/glyph-matching/raster.ts';
import { cssFontShorthand, type FontScope } from '../../../../core/src/font-analysis/scope.ts';

/** 探测用字符：用于计算字体指纹，检测字体是否被替换。 */
export const PROBE_CHARS = ['永', '国', '的', 'A', '7', '、'];

export interface RenderResult {
  /** 4bit 量化的覆盖度位图（行优先，长度 = size*size/2） */
  bitmap: Uint8Array;
  /** true 表示该字符没有命中目标字体（渲染成了回退字体） */
  fallback: boolean;
}

export class GlyphRenderer {
  private readonly size: number;
  private readonly scale: number;
  private readonly renderSize: number;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cache = new Map<string, RenderResult>();

  constructor(size = 32, scale = 4) {
    this.size = size;
    this.scale = scale;
    this.renderSize = size * scale;
  }

  private ensureContext(): CanvasRenderingContext2D {
    if (this.ctx) return this.ctx;
    const canvas = document.createElement('canvas');
    canvas.width = this.renderSize;
    canvas.height = this.renderSize;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('copy-repair: 2D canvas 不可用');
    this.canvas = canvas;
    this.ctx = ctx;
    return ctx;
  }

  /** 用给定字体渲染单个字符，返回归一化覆盖度。 */
  render(scope: FontScope, char: string): RenderResult {
    const key = `${scope.style}|${scope.weight}|${scope.family}|${char}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const ctx = this.ensureContext();
    const size = this.renderSize;
    const draw = (font: string): Float32Array => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.font = font;
      ctx.fillText(char, 0, size * 0.85);
      const data = ctx.getImageData(0, 0, size, size).data;
      const alpha = new Float32Array(size * size);
      for (let i = 0; i < size * size; i += 1) alpha[i] = data[i * 4 + 3] / 255;
      return alpha;
    };

    const target = draw(cssFontShorthand(scope, size));
    const control = draw('32px "__copyrepair_missing_family__"');

    // 面积平均降采样到参考库栅格
    const grid = this.size;
    const small = new Float32Array(grid * grid);
    for (let y = 0; y < grid; y += 1) {
      for (let x = 0; x < grid; x += 1) {
        let sum = 0;
        for (let dy = 0; dy < this.scale; dy += 1) {
          for (let dx = 0; dx < this.scale; dx += 1) {
            sum += target[(y * this.scale + dy) * size + (x * this.scale + dx)];
          }
        }
        small[y * grid + x] = sum / (this.scale * this.scale);
      }
    }

    let fallback = true;
    for (let i = 0; i < target.length; i += 1) {
      if (Math.abs(target[i] - control[i]) > 0.02) {
        fallback = false;
        break;
      }
    }

    const result: RenderResult = {
      bitmap: quantize(blur(small, grid)),
      fallback,
    };
    this.cache.set(key, result);
    return result;
  }

  /**
   * 字体指纹：探针字符渲染结果的哈希。
   * 字体文件被替换后指纹随之变化，用来自动作废旧映射缓存。
   */
  signature(scope: FontScope): string {
    const ctx = this.ensureContext();
    const size = this.renderSize;
    const font = cssFontShorthand(scope, size);
    let hash = 0x811c9dc5;
    for (const char of PROBE_CHARS) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.font = font;
      ctx.fillText(char, 0, size * 0.85);
      const data = ctx.getImageData(0, 0, size, size).data;
      for (let i = 3; i < data.length; i += 37) {
        hash ^= data[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
    }
    return hash.toString(16).padStart(8, '0');
  }

  /** 清空渲染缓存（字体变更时调用）。 */
  clearCache(): void {
    this.cache.clear();
  }
}

/** 4bit 量化：每字节两个像素。 */
export function quantize(coverage: Float32Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(coverage.length / 2));
  for (let i = 0; i < coverage.length; i += 2) {
    const hi = Math.round(Math.min(1, Math.max(0, coverage[i])) * 15);
    const lo = Math.round(Math.min(1, Math.max(0, coverage[i + 1] ?? 0)) * 15);
    out[i >> 1] = (hi << 4) | lo;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
