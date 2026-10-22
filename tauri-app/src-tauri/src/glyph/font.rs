//! 字体解析：把字体文件里的某个字符的轮廓取出来，栅格化成覆盖度位图。
//!
//! TS 侧用的是 opentype.js 的 `font.getPath(char, 0, 0, 1)`：
//!   - scale = 1 / unitsPerEm
//!   - **y 取反**（屏幕坐标，y 向下为正）
//!   - 二次曲线给 'Q'、三次曲线给 'C'，各细分成 12 段
//!
//! Rust 侧用 ttf-parser 取轮廓，坐标换算完全照上面来，
//! 保证与 TS 侧**逐像素一致**（参考库是 TS 建的，两边必须同一把尺子）。

use ttf_parser::{Face, GlyphId, OutlineBuilder};

use super::raster::{quad_at, cubic_at, rasterize_contours, Contour, RasterWindow};

/// 曲线细分段数（与 TS 的 CURVE_SEGMENTS 一致）。
const CURVE_SEGMENTS: usize = 12;

/// 路径构造器：直接把 ttf-parser 的轮廓指令展开成多边形轮廓。
struct PathBuilder {
    contours: Vec<Contour>,
    current: Contour,
    /// 当前点（二次/三次曲线的起点）
    cx: f32,
    cy: f32,
    scale: f32,
}

impl PathBuilder {
    fn new(upem: f32) -> Self {
        Self {
            contours: Vec::new(),
            current: Vec::new(),
            cx: 0.0,
            cy: 0.0,
            scale: 1.0 / upem,
        }
    }

    #[inline]
    fn push(&mut self, x: f32, y: f32) {
        // y 取反：字体坐标 y 向上，屏幕坐标 y 向下
        self.current.push(x * self.scale);
        self.current.push(-y * self.scale);
    }

    fn finish(mut self) -> Vec<Contour> {
        if self.current.len() >= 6 {
            self.contours.push(std::mem::take(&mut self.current));
        }
        self.contours
    }
}

impl OutlineBuilder for PathBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        if self.current.len() >= 6 {
            self.contours.push(std::mem::take(&mut self.current));
        }
        self.cx = x;
        self.cy = y;
        self.push(x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.cx = x;
        self.cy = y;
        self.push(x, y);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (cx, cy) = (self.cx, self.cy);
        for i in 1..=CURVE_SEGMENTS {
            let t = i as f32 / CURVE_SEGMENTS as f32;
            self.push(quad_at(cx, x1, x, t), quad_at(cy, y1, y, t));
        }
        self.cx = x;
        self.cy = y;
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (cx, cy) = (self.cx, self.cy);
        for i in 1..=CURVE_SEGMENTS {
            let t = i as f32 / CURVE_SEGMENTS as f32;
            self.push(
                cubic_at(cx, x1, x2, x, t),
                cubic_at(cy, y1, y2, y, t),
            );
        }
        self.cx = x;
        self.cy = y;
    }

    fn close(&mut self) {
        if self.current.len() >= 6 {
            self.contours.push(std::mem::take(&mut self.current));
        }
    }
}

/// 取某个字符的覆盖度位图（`size × size`，0..1）。
///
/// 返回 `None` 表示该字符在字体里没有轮廓（空白）。
pub fn coverage_for_char(
    face: &Face<'_>,
    ch: char,
    size: usize,
    window: RasterWindow,
) -> Option<Vec<f32>> {
    let glyph_id = face.glyph_index(ch)?;
    let gid = GlyphId(glyph_id.0);
    let upem = face.units_per_em() as f32;
    let mut builder = PathBuilder::new(upem);
    face.outline_glyph(gid, &mut builder);
    let contours = builder.finish();
    if contours.is_empty() {
        return None;
    }
    let coverage = rasterize_contours(&contours, size, window);
    // 全空 = 没有墨迹（.notdef 之类的空字形）
    if coverage.iter().all(|v| *v <= 0.0) {
        return None;
    }
    Some(coverage)
}
