//! 字形栅格化：把字体轮廓（贝塞尔曲线）转成覆盖度位图。
//!
//! 这是 `packages/core/src/glyph-matching/raster.ts` 的**逐行移植**。
//! 必须保持逐位一致：参考库是用 TypeScript 那份栅格化器建出来的，
//! 两边只要有一点点差异，灰度距离就会整体抬高，最近邻就会判错
//! （实测：页面 canvas 渲染 vs 参考库，「专」被判成「令」）。
//!
//! 坐标约定：字体 em 尺寸 = 1.0，基线在 y=0，**y 向下为正**（屏幕坐标）。
//! 窗口取 x∈[0,1]，y∈[-0.85, 0.15]（基线上方 0.85em、下方 0.15em），
//! 与字体自身的 ascent/descent 无关，���是 CJK 与拉丁字体能用同一套刻度。

/// 展平后的轮廓：扁平的 [x0,y0,x1,y1,...]。
pub type Contour = Vec<f32>;

/// 归一化窗口。
#[derive(Clone, Copy, Debug)]
pub struct RasterWindow {
    /// 路径坐标系下的窗口左边界
    pub x0: f32,
    /// 路径坐标系下的窗口上边界（y 向下为正）
    pub y0: f32,
    pub width: f32,
    pub height: f32,
}

impl Default for RasterWindow {
    fn default() -> Self {
        Self::CANONICAL
    }
}

impl RasterWindow {
    pub const CANONICAL: RasterWindow = RasterWindow {
        x0: 0.0,
        y0: -0.85,
        width: 1.0,
        height: 1.0,
    };
}

#[inline]
pub fn quad_at(p0: f32, p1: f32, p2: f32, t: f32) -> f32 {
    let mt = 1.0 - t;
    mt * mt * p0 + 2.0 * mt * t * p1 + t * t * p2
}

#[inline]
pub fn cubic_at(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let mt = 1.0 - t;
    mt * mt * mt * p0 + 3.0 * mt * mt * t * p1 + 3.0 * mt * t * t * p2 + t * t * t * p3
}

/// 边（扫描线用）。
#[derive(Clone, Copy)]
struct Edge {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

/// 扫描线栅格化（非零环绕规则），垂直 4x 超采样 + 水平分数覆盖。
/// 返回长度 `size*size`，取值 0..1。
pub fn rasterize_contours(
    contours: &[Contour],
    size: usize,
    window: RasterWindow,
) -> Vec<f32> {
    let mut coverage = vec![0.0f32; size * size];
    let mut edges: Vec<Edge> = Vec::new();

    for contour in contours {
        let count = contour.len() / 2;
        if count < 3 {
            continue;
        }
        for i in 0..count {
            let j = (i + 1) % count;
            let x0 = contour[i * 2];
            let y0 = contour[i * 2 + 1];
            let x1 = contour[j * 2];
            let y1 = contour[j * 2 + 1];
            if y0 == y1 {
                continue;
            }
            edges.push(Edge { x0, y0, x1, y1 });
        }
    }
    if edges.is_empty() {
        return coverage;
    }

    let sx = size as f32 / window.width;
    const SUB: usize = 4; // 垂直方向超采样倍数
    let mut sub_coverage = vec![0.0f32; size];
    let mut crossings: Vec<(f32, i32)> = Vec::new();

    for py in 0..size {
        sub_coverage.iter_mut().for_each(|v| *v = 0.0);
        for s in 0..SUB {
            let sample_y = window.y0 + ((py as f32 + (s as f32 + 0.5) / SUB as f32) / size as f32) * window.height;
            crossings.clear();
            for edge in &edges {
                let y_min = edge.y0.min(edge.y1);
                let y_max = edge.y0.max(edge.y1);
                if sample_y < y_min || sample_y >= y_max {
                    continue;
                }
                let t = (sample_y - edge.y0) / (edge.y1 - edge.y0);
                let x = edge.x0 + t * (edge.x1 - edge.x0);
                crossings.push((x, if edge.y1 > edge.y0 { 1 } else { -1 }));
            }
            if crossings.len() < 2 {
                continue;
            }
            crossings.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

            let mut winding = 0;
            for i in 0..crossings.len() - 1 {
                winding += crossings[i].1;
                if winding == 0 {
                    continue;
                }
                let span_start = crossings[i].0;
                let span_end = crossings[i + 1].0;
                let px0 = (span_start - window.x0) * sx;
                let px1 = (span_end - window.x0) * sx;
                if px1 <= 0.0 || px0 >= size as f32 {
                    continue;
                }
                let clipped0 = px0.max(0.0);
                let clipped1 = px1.min(size as f32);
                if clipped1 <= clipped0 {
                    continue;
                }
                let first = clipped0.floor() as usize;
                let last = (clipped1.ceil() as usize) - 1;
                for px in first..=last {
                    let cell_start = clipped0.max(px as f32);
                    let cell_end = clipped1.min(px as f32 + 1.0);
                    let amount = cell_end - cell_start;
                    if amount > 0.0 {
                        sub_coverage[px] += amount / SUB as f32;
                    }
                }
            }
        }
        for px in 0..size {
            coverage[py * size + px] = sub_coverage[px].min(1.0);
        }
    }
    coverage
}

/// 3x3 盒式模糊，用于抹平不同渲染引擎之间的抗锯齿差异。
pub fn blur(coverage: &[f32], size: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; size * size];
    for y in 0..size {
        for x in 0..size {
            let mut sum = 0.0;
            let mut count = 0.0;
            for dy in -1i32..=1 {
                let ny = y as i32 + dy;
                if ny < 0 || ny >= size as i32 {
                    continue;
                }
                for dx in -1i32..=1 {
                    let nx = x as i32 + dx;
                    if nx < 0 || nx >= size as i32 {
                        continue;
                    }
                    sum += coverage[ny as usize * size + nx as usize];
                    count += 1.0;
                }
            }
            out[y * size + x] = sum / count;
        }
    }
    out
}

/// 把精细栅格降采样到粗栅格（面积平均）。
pub fn downsample(coverage: &[f32], from_size: usize, to_size: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; to_size * to_size];
    if from_size == to_size {
        let n = out.len().min(coverage.len());
        out[..n].copy_from_slice(&coverage[..n]);
        return out;
    }
    let ratio = from_size as f32 / to_size as f32;
    for y in 0..to_size {
        for x in 0..to_size {
            let x0 = (x as f32 * ratio).floor() as usize;
            let x1 = ((x + 1) as f32 * ratio).floor() as usize;
            let y0 = (y as f32 * ratio).floor() as usize;
            let y1 = ((y + 1) as f32 * ratio).floor() as usize;
            let x1 = x1.max(x0 + 1);
            let y1 = y1.max(y0 + 1);
            let mut sum = 0.0;
            let mut count = 0.0;
            let mut yy = y0;
            while yy < y1 && yy < from_size {
                let mut xx = x0;
                while xx < x1 && xx < from_size {
                    sum += coverage[yy * from_size + xx];
                    count += 1.0;
                    xx += 1;
                }
                yy += 1;
            }
            out[y * to_size + x] = if count > 0.0 { sum / count } else { 0.0 };
        }
    }
    out
}

/// 4bit 量化：把覆盖度压到 16 级。
///
/// 参考库里存的就是 4bit，查询侧必须压到同一把尺子上，
/// 否则灰度距离会整体抬高（TS 侧 engine.js 的 `quantize`）。
pub fn quantize(coverage: &[f32]) -> Vec<f32> {
    coverage
        .iter()
        .map(|v| (v.clamp(0.0, 1.0) * 15.0).round() / 15.0)
        .collect()
}
