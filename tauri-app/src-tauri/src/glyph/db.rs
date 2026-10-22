//! 参考字形库（CRDB）的读取 + 快速匹配器。
//!
//! 这是 `packages/core/src/glyph-matching/db.ts`（格式 + 最近邻）
//! 与 `src/features/safari-repair/fast-matcher.js`（快速路径 + 二值距离）
//! 的**合并移植**。
//!
//! CRDB v1 格式（全部大端）：
//! ```text
//!   0  : magic 'CRDB'
//!   4  : version u32 = 1
//!   8  : gridSize u32
//!   12 : count u32
//!   16 : coarseSize u32
//!   20 : codepoints[count] u32
//!   .. : coarse[count * coarseSize^2 / 2] 字节（4bit 量化）
//!   .. : fine[count * gridSize^2 / 2] 字节（4bit 量化）
//! ```

use std::collections::HashMap;

pub const GLYPH_DB_MAGIC: u32 = 0x4352_4442; // 'CRDB'
pub const GLYPH_DB_VERSION: u32 = 1;

/// 4bit 量化表：nibble / 15
#[inline]
fn nib(n: u8) -> f32 {
    n as f32 / 15.0
}

/// 参考字形库。
#[derive(Clone)]
pub struct GlyphDb {
    pub grid_size: usize,
    pub coarse_size: usize,
    pub count: usize,
    pub codepoints: Vec<u32>,
    pub coarse: Vec<u8>,
    pub fine: Vec<u8>,
}

impl GlyphDb {
    pub fn deserialize(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 20 {
            return Err("glyph db: 文件太短".into());
        }
        let rd = |off: usize| -> u32 {
            u32::from_be_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
        };
        let magic = rd(0);
        if magic != GLYPH_DB_MAGIC {
            return Err(format!("glyph db: bad magic 0x{:x}", magic));
        }
        let version = rd(4);
        if version != GLYPH_DB_VERSION {
            return Err(format!("glyph db: 不支持的版本 {}", version));
        }
        let grid_size = rd(8) as usize;
        let count = rd(12) as usize;
        let coarse_size = rd(16) as usize;
        let coarse_bytes = (count * coarse_size * coarse_size) >> 1;
        let fine_bytes = (count * grid_size * grid_size) >> 1;

        let mut offset = 20usize;
        let mut codepoints = Vec::with_capacity(count);
        for _ in 0..count {
            codepoints.push(rd(offset));
            offset += 4;
        }
        if bytes.len() < offset + coarse_bytes + fine_bytes {
            return Err("glyph db: 数据被截断".into());
        }
        let coarse = bytes[offset..offset + coarse_bytes].to_vec();
        offset += coarse_bytes;
        let fine = bytes[offset..offset + fine_bytes].to_vec();
        Ok(Self {
            grid_size,
            coarse_size,
            count,
            codepoints,
            coarse,
            fine,
        })
    }

    /// 码位 → 库内下标（码位已排序，二分）；不存在返回 None。
    pub fn index_of_codepoint(&self, codepoint: u32) -> Option<usize> {
        self.codepoints.binary_search(&codepoint).ok()
    }

    /// 目标覆盖度与库内某个字形的灰度 L1 距离（0 = 完全一致）。
    pub fn distance_to_index(&self, index: usize, coverage: &[f32]) -> f32 {
        let size = self.grid_size;
        let offset = index * ((size * size) >> 1);
        let length = size * size;
        let mut sum = 0.0f32;
        for i in 0..length {
            let byte = self.fine[offset + (i >> 1)];
            let v = if i % 2 == 0 { byte >> 4 } else { byte & 0x0f };
            sum += (nib(v) - coverage[i]).abs();
        }
        sum / length as f32
    }
}

/// 匹配候选。
#[derive(Clone, Copy, Debug)]
pub struct Candidate {
    pub codepoint: u32,
    /// 灰度 L1 分数（越大越像）—— 分数闸门沿用这个口径
    pub score: f32,
    /// 二值距离（越小越像）—— 排序与 margin 用这个（比形状、不比粗细）
    pub distance: f32,
}

#[derive(Clone, Debug)]
pub struct MatchResult {
    pub codepoint: Option<u32>,
    pub score: f32,
    pub margin: f32,
    pub distance: f32,
    pub runner_up: Option<u32>,
    pub exact: bool,
    pub candidates: Vec<Candidate>,
}

/// 量化覆盖度 → 4bit 打包字节（与参考库同格式）。
pub fn pack(coverage: &[f32], size: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; (size * size) >> 1];
    for i in (0..size * size).step_by(2) {
        let hi = (coverage[i].clamp(0.0, 1.0) * 15.0).round() as u8;
        let lo = if i + 1 < coverage.len() {
            (coverage[i + 1].clamp(0.0, 1.0) * 15.0).round() as u8
        } else {
            0
        };
        bytes[i >> 1] = (hi << 4) | lo;
    }
    bytes
}

/// FNV-1a 64 位。TS 侧用两个 32 位拼字符串当 key，
/// 这里直接用 u64 —— **哈希值本身不影响判定**（只决定"精确命中"这条路走不走）。
fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// 快速字形匹配器。
pub struct FastGlyphMatcher {
    db: GlyphDb,
    size: usize,
    coarse_size: usize,
    count: usize,
    fine_bytes: usize,
    coarse_cells: usize,
    /// 参考库粗栅格解包成 nibble 数组，避免每次查询都解包
    coarse_nibbles: Vec<u8>,
    /// 精确哈希索引：量化位图 → 库内下标
    exact: HashMap<u64, Vec<u32>>,
}

impl FastGlyphMatcher {
    pub fn new(db: GlyphDb) -> Self {
        let size = db.grid_size;
        let coarse_size = db.coarse_size;
        let count = db.count;
        let fine_bytes = (size * size) >> 1;
        let coarse_cells = coarse_size * coarse_size;

        let mut coarse_nibbles = vec![0u8; count * coarse_cells];
        for i in 0..count {
            let off = i * (coarse_cells >> 1);
            for c in 0..coarse_cells {
                let b = db.coarse[off + (c >> 1)];
                coarse_nibbles[i * coarse_cells + c] = if c % 2 == 0 { b >> 4 } else { b & 15 };
            }
        }

        let mut exact: HashMap<u64, Vec<u32>> = HashMap::with_capacity(count * 2);
        for i in 0..count {
            let off = i * fine_bytes;
            let key = hash_bytes(&db.fine[off..off + fine_bytes]);
            exact.entry(key).or_default().push(i as u32);
        }

        Self {
            db,
            size,
            coarse_size,
            count,
            fine_bytes,
            coarse_cells,
            coarse_nibbles,
            exact,
        }
    }

    pub fn db(&self) -> &GlyphDb {
        &self.db
    }

    fn same_as_reference(&self, query_packed: &[u8], index: usize) -> bool {
        let off = index * self.fine_bytes;
        &self.db.fine[off..off + self.fine_bytes] == query_packed
    }

    /// 最近邻匹配。
    pub fn lookup(&self, coverage: &[f32], max_candidates: usize) -> MatchResult {
        let size = self.size;
        let query_packed = pack(coverage, size);

        // ① 精确命中（字形是原件搬运）
        if let Some(list) = self.exact.get(&hash_bytes(&query_packed)) {
            for index in list {
                let index = *index as usize;
                if self.same_as_reference(&query_packed, index) {
                    let codepoint = self.db.codepoints[index];
                    return MatchResult {
                        codepoint: Some(codepoint),
                        score: 1.0,
                        margin: 1.0,
                        distance: 0.0,
                        runner_up: None,
                        exact: true,
                        candidates: vec![Candidate {
                            codepoint,
                            score: 1.0,
                            distance: 0.0,
                        }],
                    };
                }
            }
        }

        // ② 粗距离
        let coarse_query = super::raster::downsample(coverage, size, self.coarse_size);
        let mut q_nibbles = vec![0u8; self.coarse_cells];
        for (c, v) in coarse_query.iter().enumerate().take(self.coarse_cells) {
            q_nibbles[c] = (v.clamp(0.0, 1.0) * 15.0).round() as u8;
        }
        let mut scores = vec![0.0f32; self.count];
        for i in 0..self.count {
            let base = i * self.coarse_cells;
            let mut sum = 0.0f32;
            for c in 0..self.coarse_cells {
                sum += (q_nibbles[c] as i32 - self.coarse_nibbles[base + c] as i32).abs() as f32;
            }
            scores[i] = 1.0 - sum / (15.0 * self.coarse_cells as f32);
        }

        // ③ 部分选择：只留前 K（不排序全库）
        let k = max_candidates.min(self.count);
        let mut best: Vec<u32> = Vec::with_capacity(k);
        let mut worst = -1.0f32;
        for i in 0..self.count {
            let s = scores[i];
            if best.len() < k {
                best.push(i as u32);
                if best.len() == k {
                    worst = scores[best[0] as usize];
                    for b in &best {
                        if scores[*b as usize] < worst {
                            worst = scores[*b as usize];
                        }
                    }
                }
            } else if s > worst {
                let mut wi = 0usize;
                let mut ws = f32::INFINITY;
                for (b, idx) in best.iter().enumerate() {
                    if scores[*idx as usize] < ws {
                        ws = scores[*idx as usize];
                        wi = b;
                    }
                }
                best[wi] = i as u32;
                worst = f32::INFINITY;
                for b in &best {
                    if scores[*b as usize] < worst {
                        worst = scores[*b as usize];
                    }
                }
            }
        }

        // ④ 精筛：同时算灰度分与二值距离
        //    排序/margin 用**二值距离**（比形状、不比笔画粗细）；
        //    分数闸门用**灰度 L1**（沿用原口径）。
        let cells2 = self.size * self.size;
        let mut best_index: i64 = -1;
        let mut best_score = -1.0f32;
        let mut best_dist = f32::INFINITY;
        let mut second_dist = f32::INFINITY;
        let mut ranked: Vec<Candidate> = Vec::with_capacity(best.len());
        for index in &best {
            let index = *index as usize;
            let off = index * self.fine_bytes;
            let mut sum = 0.0f32;
            let mut bin_diff = 0u32;
            for i in 0..self.fine_bytes {
                let b = self.db.fine[off + i];
                let q = query_packed[i];
                sum += ((b >> 4) as i32 - (q >> 4) as i32).abs() as f32;
                sum += ((b & 15) as i32 - (q & 15) as i32).abs() as f32;
                if ((b >> 4) >= 8) != ((q >> 4) >= 8) {
                    bin_diff += 1;
                }
                if ((b & 15) >= 8) != ((q & 15) >= 8) {
                    bin_diff += 1;
                }
            }
            let score = 1.0 - sum / (15.0 * cells2 as f32);
            let distance = bin_diff as f32 / cells2 as f32;
            ranked.push(Candidate {
                codepoint: self.db.codepoints[index],
                score,
                distance,
            });
            if distance < best_dist {
                second_dist = best_dist;
                best_dist = distance;
                best_score = score;
                best_index = index as i64;
            } else if distance < second_dist {
                second_dist = distance;
            }
        }
        ranked.sort_by(|a, b| {
            a.distance
                .partial_cmp(&b.distance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        MatchResult {
            codepoint: if best_index >= 0 {
                Some(self.db.codepoints[best_index as usize])
            } else {
                None
            },
            score: best_score.max(0.0),
            margin: (second_dist - best_dist).max(0.0),
            distance: best_dist,
            runner_up: if ranked.len() > 1 {
                Some(ranked[1].codepoint)
            } else {
                None
            },
            exact: false,
            candidates: ranked.into_iter().take(24).collect(),
        }
    }
}
