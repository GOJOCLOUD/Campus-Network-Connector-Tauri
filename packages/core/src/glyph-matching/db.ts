/**
 * 参考字形库（Reference Glyph Database）。
 *
 * 用途：把网页字体渲染出来的「可见字形」映射回「参考字体中的真实字符」。
 * 库里存的是参考字体（Noto Sans SC）每个字符的归一化覆盖度位图，
 * 运行时用浏览器 canvas 渲染目标字体同一字符的位图，再做最近邻匹配。
 *
 * 二进制格式（CRDB v1，全部大端）：
 *   0  : magic 'CRDB'
 *   4  : version u32 = 1
 *   8  : gridSize u32          （精细栅格边长，建议 32）
 *   12 : count u32
 *   16 : coarseSize u32        （粗筛栅格边长，建议 8）
 *   20 : codepoints[count] u32
 *   .. : coarse[count * coarseSize^2 / 2] 字节（4bit 量化）
 *   .. : fine[count * gridSize^2 / 2] 字节（4bit 量化）
 */

import { blur } from './raster.ts';

export const GLYPH_DB_MAGIC = 0x43524442; // 'CRDB'
export const GLYPH_DB_VERSION = 1;

export interface GlyphDbHeader {
  gridSize: number;
  coarseSize: number;
  count: number;
}

export interface GlyphMatch {
  /** 命中的字符码位；未命中为 null */
  codepoint: number | null;
  /** 最佳匹配的相似度（0..1，1 为完全一致） */
  score: number;
  /** 与次优匹配的相似度差距；差距越小越不可信 */
  margin: number;
  /** 次优匹配字符 */
  runnerUp: number | null;
  /** 候选列表（按相似度降序），用于"用同一字体二次渲染确认" */
  candidates?: Array<{ codepoint: number; score: number }>;
}

const NIBBLE_TABLE = /* @__PURE__ */ (() => {
  const table = new Float32Array(16);
  for (let i = 0; i < 16; i += 1) table[i] = i / 15;
  return table;
})();

function quantize(coverage: Float32Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(coverage.length / 2));
  for (let i = 0; i < coverage.length; i += 2) {
    const hi = Math.round(Math.min(1, Math.max(0, coverage[i])) * 15);
    const lo = Math.min(1, Math.max(0, coverage[i + 1] ?? 0));
    out[i >> 1] = (hi << 4) | Math.round(lo * 15);
  }
  return out;
}

export function dequantize(packed: Uint8Array, offset: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const byte = packed[offset + (i >> 1)];
    const nib = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out[i] = NIBBLE_TABLE[nib];
  }
  return out;
}

export class GlyphDb {
  readonly header: GlyphDbHeader;
  readonly codepoints: Uint32Array;
  readonly coarse: Uint8Array;
  readonly fine: Uint8Array;

  constructor(
    header: GlyphDbHeader,
    codepoints: Uint32Array,
    coarse: Uint8Array,
    fine: Uint8Array,
  ) {
    this.header = header;
    this.codepoints = codepoints;
    this.coarse = coarse;
    this.fine = fine;
  }

  static deserialize(input: ArrayBuffer | Uint8Array): GlyphDb {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, false);
    if (magic !== GLYPH_DB_MAGIC) {
      throw new Error(`glyph db: bad magic 0x${magic.toString(16)}`);
    }
    const version = view.getUint32(4, false);
    if (version !== GLYPH_DB_VERSION) {
      throw new Error(`glyph db: unsupported version ${version}`);
    }
    const gridSize = view.getUint32(8, false);
    const count = view.getUint32(12, false);
    const coarseSize = view.getUint32(16, false);
    const coarseBytes = (count * coarseSize * coarseSize) >> 1;
    const fineBytes = (count * gridSize * gridSize) >> 1;

    let offset = 20;
    const codepoints = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) {
      codepoints[i] = view.getUint32(offset, false);
      offset += 4;
    }
    const coarse = bytes.slice(offset, offset + coarseBytes);
    offset += coarseBytes;
    const fine = bytes.slice(offset, offset + fineBytes);
    return new GlyphDb({ gridSize, coarseSize, count }, codepoints, coarse, fine);
  }

  serialize(): Uint8Array {
    const { gridSize, coarseSize, count } = this.header;
    const coarseBytes = (count * coarseSize * coarseSize) >> 1;
    const fineBytes = (count * gridSize * gridSize) >> 1;
    const total = 20 + count * 4 + coarseBytes + fineBytes;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, GLYPH_DB_MAGIC, false);
    view.setUint32(4, GLYPH_DB_VERSION, false);
    view.setUint32(8, gridSize, false);
    view.setUint32(12, count, false);
    view.setUint32(16, coarseSize, false);
    let offset = 20;
    for (let i = 0; i < count; i += 1) {
      view.setUint32(offset, this.codepoints[i], false);
      offset += 4;
    }
    out.set(this.coarse, offset);
    offset += coarseBytes;
    out.set(this.fine, offset);
    return out;
  }

  /** 提取某个字符的精细覆盖度（用于自检与调试）。 */
  coverageAt(index: number): Float32Array {
    const size = this.header.gridSize;
    const offset = index * ((size * size) >> 1);
    return dequantize(this.fine, offset, size * size);
  }

  /** 查找码位对应的库内下标；不存在返回 -1。 */
  indexOfCodepoint(codepoint: number): number {
    // codepoints 已排序，用二分查找
    let lo = 0;
    let hi = this.codepoints.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = this.codepoints[mid];
      if (value === codepoint) return mid;
      if (value < codepoint) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** 目标覆盖度与库内某个字形的距离（0 = 完全一致）。 */
  distanceToIndex(index: number, coverage: Float32Array): number {
    const size = this.header.gridSize;
    const offset = index * ((size * size) >> 1);
    const length = size * size;
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
      const byte = this.fine[offset + (i >> 1)];
      const nib = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
      sum += Math.abs(NIBBLE_TABLE[nib] - coverage[i]);
    }
    return sum / length;
  }

  /**
   * 最近邻匹配。
   *
   * 两段式：先用 8x8 粗栅格筛出候选，再在候选上做精细栅格比较，
   * 既保证速度也给出「次优匹配」用于置信度评估。
   */
  lookup(coverage: Float32Array, options?: { maxCandidates?: number }): GlyphMatch {
    const { gridSize, coarseSize, count } = this.header;
    const fineLen = gridSize * gridSize;
    const coarseLen = coarseSize * coarseSize;
    const maxCandidates = options?.maxCandidates ?? 256;

    const coarseQuery = downsample(coverage, gridSize, coarseSize);
    const fineQuery = coverage;

    const coarseScores = new Float32Array(count);
    const coarseOffsetOf = (index: number) => index * ((coarseLen) >> 1);
    for (let i = 0; i < count; i += 1) {
      coarseScores[i] = 1 - l1Packed(this.coarse, coarseOffsetOf(i), coarseLen, coarseQuery);
    }

    const candidateIndexes: number[] = [];
    for (let i = 0; i < count; i += 1) candidateIndexes.push(i);
    candidateIndexes.sort((a, b) => coarseScores[b] - coarseScores[a]);
    const shortlist = candidateIndexes.slice(0, maxCandidates);

    let bestScore = -1;
    let bestIndex = -1;
    let secondScore = -1;
    let secondIndex = -1;
    for (const index of shortlist) {
      const offset = index * (fineLen >> 1);
      const score = 1 - l1Packed(this.fine, offset, fineLen, fineQuery);
      if (score > bestScore) {
        secondScore = bestScore;
        secondIndex = bestIndex;
        bestScore = score;
        bestIndex = index;
      } else if (score > secondScore) {
        secondScore = score;
        secondIndex = index;
      }
    }
    if (bestIndex < 0) {
      return { codepoint: null, score: 0, margin: 0, runnerUp: null, candidates: [] };
    }
    // 候选列表：粗筛后的前 N 个（按精细分数降序）
    const candidates = shortlist
      .map((index) => ({
        codepoint: this.codepoints[index],
        score: 1 - l1Packed(this.fine, index * (fineLen >> 1), fineLen, fineQuery),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);
    return {
      codepoint: this.codepoints[bestIndex],
      score: bestScore,
      margin: bestScore - Math.max(0, secondScore),
      runnerUp: secondIndex >= 0 ? this.codepoints[secondIndex] : null,
      candidates,
    };
  }
}

/** 把精细栅格降采样到粗栅格（面积平均）。 */
export function downsample(
  coverage: Float32Array,
  fromSize: number,
  toSize: number,
): Float32Array {
  const out = new Float32Array(toSize * toSize);
  if (fromSize === toSize) {
    out.set(coverage.subarray(0, out.length));
    return out;
  }
  const ratio = fromSize / toSize;
  for (let y = 0; y < toSize; y += 1) {
    for (let x = 0; x < toSize; x += 1) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * ratio));
      const y0 = Math.floor(y * ratio);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1 && yy < fromSize; yy += 1) {
        for (let xx = x0; xx < x1 && xx < fromSize; xx += 1) {
          sum += coverage[yy * fromSize + xx];
          count += 1;
        }
      }
      out[y * toSize + x] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** 打包 4bit 位图与 Float32 查询向量之间的平均 L1 距离。 */
function l1Packed(
  packed: Uint8Array,
  offset: number,
  length: number,
  query: Float32Array,
): number {
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const byte = packed[offset + (i >> 1)];
    const nib = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    sum += Math.abs(NIBBLE_TABLE[nib] - query[i]);
  }
  return sum / length;
}

/**
 * 由覆盖度数组构建数据库条目（构建期使用）。
 *
 * 存储前统一做 3x3 模糊：运行时目标位图也会做同样处理，
 * 两边必须处于同一尺度，否则抗锯齿差异会被放大成系统性偏差。
 */
export function buildGlyphDb(
  gridSize: number,
  coarseSize: number,
  entries: Array<{ codepoint: number; coverage: Float32Array }>,
): GlyphDb {
  const count = entries.length;
  const codepoints = new Uint32Array(count);
  const coarse = new Uint8Array((count * coarseSize * coarseSize) >> 1);
  const fine = new Uint8Array((count * gridSize * gridSize) >> 1);
  const coarseLen = (coarseSize * coarseSize) >> 1;
  const fineLen = (gridSize * gridSize) >> 1;
  for (let i = 0; i < count; i += 1) {
    codepoints[i] = entries[i].codepoint;
    const blurred = blur(entries[i].coverage, gridSize);
    const coarseBytes = quantize(downsample(blurred, gridSize, coarseSize));
    coarse.set(coarseBytes, i * coarseLen);
    const fineBytes = quantize(blurred);
    fine.set(fineBytes, i * fineLen);
  }
  return new GlyphDb({ gridSize, coarseSize, count }, codepoints, coarse, fine);
}
