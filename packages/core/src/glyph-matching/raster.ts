/**
 * 字形栅格化：把字体轮廓（贝塞尔曲线）转成覆盖度位图。
 *
 * 该模块刻意不依赖任何浏览器 API —— 同一份实现既用于 Node 侧构建参考字形库，
 * 也用于浏览器侧对目标字体做归一化，避免"两套渲染器"造成匹配漂移。
 */

/** 展平后的轮廓：每个轮廓是扁平的 [x0,y0,x1,y1,...] 数组。 */
export type Contour = number[];

/** opentype.js 风格的路径指令。 */
export interface PathCommand {
  type: string;
  [key: string]: unknown;
}

export interface RasterWindow {
  /** 路径坐标系下的窗口左边界 */
  x0: number;
  /** 路径坐标系下的窗口上边界（y 向下为正，与屏幕坐标一致） */
  y0: number;
  /** 窗口宽度（路径单位） */
  width: number;
  /** 窗口高度（路径单位） */
  height: number;
}

/**
 * 归一化窗口定义。
 *
 * 约定：字体 em 尺寸 = 1.0，基线在 y=0（屏幕坐标向下为正）。
 * 窗口取 x∈[0,1]（一个字身框宽），y∈[-0.85,0.15]（基线上方 0.85em、下方 0.15em）。
 * 该窗口与具体字体的 ascent/descent 指标无关，因此 CJK 与拉丁字体可用同一套刻度。
 */
export const CANONICAL_WINDOW: RasterWindow = {
  x0: 0,
  y0: -0.85,
  width: 1,
  height: 1,
};

/** 曲线细分段数：足够在 32px 栅格下复现字形轮廓。 */
const CURVE_SEGMENTS = 12;

function quadAt(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

function cubicAt(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** 把路径指令展平为多边形轮廓。 */
export function flattenPath(commands: PathCommand[]): Contour[] {
  const contours: Contour[] = [];
  let current: Contour = [];
  let cx = 0;
  let cy = 0;

  const push = (x: number, y: number) => {
    current.push(x, y);
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M': {
        if (current.length >= 6) contours.push(current);
        current = [];
        cx = cmd.x as number;
        cy = cmd.y as number;
        push(cx, cy);
        break;
      }
      case 'L': {
        const x = cmd.x as number;
        const y = cmd.y as number;
        push(x, y);
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        const x1 = cmd.x1 as number;
        const y1 = cmd.y1 as number;
        const x = cmd.x as number;
        const y = cmd.y as number;
        for (let i = 1; i <= CURVE_SEGMENTS; i += 1) {
          const t = i / CURVE_SEGMENTS;
          push(quadAt(cx, x1, x, t), quadAt(cy, y1, y, t));
        }
        cx = x;
        cy = y;
        break;
      }
      case 'C': {
        const x1 = cmd.x1 as number;
        const y1 = cmd.y1 as number;
        const x2 = cmd.x2 as number;
        const y2 = cmd.y2 as number;
        const x = cmd.x as number;
        const y = cmd.y as number;
        for (let i = 1; i <= CURVE_SEGMENTS; i += 1) {
          const t = i / CURVE_SEGMENTS;
          push(cubicAt(cx, x1, x2, x, t), cubicAt(cy, y1, y2, y, t));
        }
        cx = x;
        cy = y;
        break;
      }
      case 'Z': {
        if (current.length >= 6) contours.push(current);
        current = [];
        break;
      }
      default:
        break;
    }
  }
  if (current.length >= 6) contours.push(current);
  return contours;
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 扫描线栅格化（非零环绕规则），垂直 4x 超采样 + 水平分数覆盖。
 * 返回长度 size*size 的 Float32Array，取值 0..1。
 */
export function rasterizeContours(
  contours: Contour[],
  size: number,
  window: RasterWindow = CANONICAL_WINDOW,
): Float32Array {
  const coverage = new Float32Array(size * size);
  const edges: Edge[] = [];

  for (const contour of contours) {
    const count = contour.length / 2;
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      const x0 = contour[i * 2];
      const y0 = contour[i * 2 + 1];
      const x1 = contour[j * 2];
      const y1 = contour[j * 2 + 1];
      if (y0 === y1) continue;
      edges.push({ x0, y0, x1, y1 });
    }
  }
  if (edges.length === 0) return coverage;

  const sx = size / window.width;
  const sy = size / window.height;
  const SUB = 4; // 垂直方向超采样倍数
  const subCoverage = new Float32Array(size);
  const crossings: Array<{ x: number; dir: number }> = [];

  for (let py = 0; py < size; py += 1) {
    subCoverage.fill(0);
    for (let s = 0; s < SUB; s += 1) {
      const sampleY = window.y0 + ((py + (s + 0.5) / SUB) / size) * window.height;
      crossings.length = 0;
      for (const edge of edges) {
        const yMin = Math.min(edge.y0, edge.y1);
        const yMax = Math.max(edge.y0, edge.y1);
        if (sampleY < yMin || sampleY >= yMax) continue;
        const t = (sampleY - edge.y0) / (edge.y1 - edge.y0);
        const x = edge.x0 + t * (edge.x1 - edge.x0);
        crossings.push({ x, dir: edge.y1 > edge.y0 ? 1 : -1 });
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x);

      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i += 1) {
        winding += crossings[i].dir;
        if (winding === 0) continue;
        const spanStart = crossings[i].x;
        const spanEnd = crossings[i + 1].x;
        const px0 = (spanStart - window.x0) * sx;
        const px1 = (spanEnd - window.x0) * sx;
        if (px1 <= 0 || px0 >= size) continue;
        const clipped0 = Math.max(0, px0);
        const clipped1 = Math.min(size, px1);
        if (clipped1 <= clipped0) continue;
        const first = Math.floor(clipped0);
        const last = Math.ceil(clipped1) - 1;
        for (let px = first; px <= last; px += 1) {
          const cellStart = Math.max(clipped0, px);
          const cellEnd = Math.min(clipped1, px + 1);
          const amount = cellEnd - cellStart;
          if (amount > 0) subCoverage[px] += amount / SUB;
        }
      }
    }
    for (let px = 0; px < size; px += 1) {
      coverage[py * size + px] = Math.min(1, subCoverage[px]);
    }
  }
  return coverage;
}

/** 3x3 盒式模糊，用于抹平不同渲染引擎之间的抗锯齿差异。 */
export function blur(coverage: Float32Array, size: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= size) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= size) continue;
          sum += coverage[ny * size + nx];
          count += 1;
        }
      }
      out[y * size + x] = sum / count;
    }
  }
  return out;
}

/** 覆盖率数组的 L1 距离（取值范围 0..1，0 表示完全一致）。 */
export function l1Distance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** 覆盖率数组的余弦相似度（1 表示完全一致）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
