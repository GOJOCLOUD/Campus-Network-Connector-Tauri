//! 字形判定策略：把"匹配结果"变成"要不要改、改成什么"的决策。
//!
//! 这是 `packages/core/src/glyph-matching/policy.ts` 与
//! `src/features/safari-repair/engine.js` 里 `pickCandidate` 的**移植**。
//!
//! 四条判据（全部来自实测，见 docs/02-设计/字体映射技术说明.md）：
//!  1. selfDistance —— 目标字体渲染的字形，与参考库里"同一个字符"的参考字形差多远。
//!     混淆字体：差得极远（≈0.9）；普通字体：只差风格（≈0.1）。
//!  2. bestMatch —— 最近邻，回答"屏幕上到底显示的是哪个字"。
//!  3. margin —— 最近邻与次近邻的差距，太小说明分不清。
//!  4. **排序用二值距离**：站点把字形重绘得更细，灰度 L1 会偏向"笔画少"的字
//!     （实测：站点的「略」离「赂」0.1007、离「略」0.1162 → 判错）。
//!     二值化去掉粗细因素后：「略」0.0920 < 「赂」0.1042 → 判对。
//!
//! 原则：**宁可留错字，绝不写错字** —— 任何一条不满足就不改。

use super::db::{Candidate, MatchResult};
use super::common_charset::is_common_char;

/// 判定阈值（与 TS 侧 DEFAULT_THRESHOLDS / DEFAULTS 完全一致）。
#[derive(Clone, Copy, Debug)]
pub struct Thresholds {
    /// 作用域判为混淆所需的最低 selfDistance
    pub obfuscated_self_distance: f32,
    /// 作用域判为混淆所需的最低投票比例
    pub obfuscated_vote_ratio: f32,
    /// 单字符替换所需的最低 selfDistance
    pub replace_self_distance: f32,
    /// 单字符替换所需的最低最近邻相似度
    pub replace_min_score: f32,
    /// 单字符替换所需的最低次优差距
    pub replace_min_margin: f32,
    /// 采样多少个字符用于作用域投票
    pub vote_sample_size: usize,
    /// 字体级闸门：多少比例的字形对得上常用字，才认定是混淆字体
    pub min_font_fit_ratio: f32,
    /// 字体级闸门用的最低分（比逐字闸门严）
    pub min_prefetch_score: f32,
    /// 常用字先验加分：像素分不出偏旁相同的字时，用字频打破平局
    pub common_char_prior_bonus: f32,
    /// 候选里保留几个备选
    pub keep_candidates: usize,
    /// 粗筛后保留多少候选做精筛
    pub max_candidates: usize,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            obfuscated_self_distance: 0.15,
            obfuscated_vote_ratio: 0.6,
            replace_self_distance: 0.15,
            replace_min_score: 0.8,
            replace_min_margin: 0.01,
            vote_sample_size: 24,
            min_font_fit_ratio: 0.7,
            min_prefetch_score: 0.88,
            common_char_prior_bonus: 0.02,
            keep_candidates: 3,
            max_candidates: 512,
        }
    }
}

/// 单个字符的匹配结果（喂给判定用的最小信息）。
#[derive(Clone, Debug)]
pub struct GlyphCandidate {
    /// DOM 里的底层字符
    pub ch: char,
    /// 参考库最近邻
    pub best_codepoint: Option<u32>,
    pub best_score: f32,
    pub best_margin: f32,
    /// 与"该字符自身参考字形"的距离（0=完全一致，1=完全不同）
    pub self_distance: f32,
    /// 字符是否在参考库中
    pub in_reference: bool,
}

/// 作用域级判定结果。
#[derive(Clone, Copy, Debug)]
pub struct ScopeDecision {
    pub obfuscated: bool,
    pub votes: usize,
    pub samples: usize,
    pub median_self_distance: f32,
}

/// 是否满足"可以放心把底层字符换成最近邻字符"的全部条件。
pub fn is_confident_substitution(c: &GlyphCandidate, t: &Thresholds) -> bool {
    if !c.in_reference {
        return false;
    }
    let Some(best) = c.best_codepoint else {
        return false;
    };
    if best == (c.ch as u32) {
        return false; // 最近邻就是它自己 → 字体画的就是这个字
    }
    if c.self_distance < t.replace_self_distance {
        return false;
    }
    if c.best_score < t.replace_min_score {
        return false;
    }
    if c.best_margin < t.replace_min_margin {
        return false;
    }
    true
}

/// 作用域级判定：这个字体作用域是不是混淆字体。
pub fn decide_scope(candidates: &[GlyphCandidate], t: &Thresholds) -> ScopeDecision {
    let usable: Vec<&GlyphCandidate> = candidates.iter().filter(|c| c.in_reference).collect();
    if usable.is_empty() {
        return ScopeDecision {
            obfuscated: false,
            votes: 0,
            samples: 0,
            median_self_distance: 0.0,
        };
    }
    let sample: Vec<&GlyphCandidate> = usable.iter().take(t.vote_sample_size).copied().collect();
    let votes = sample
        .iter()
        .filter(|c| is_confident_substitution(c, t))
        .count();
    let ratio = votes as f32 / sample.len() as f32;
    let mut sorted: Vec<f32> = sample.iter().map(|c| c.self_distance).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_self_distance = sorted[sorted.len() / 2];
    ScopeDecision {
        obfuscated: ratio >= t.obfuscated_vote_ratio,
        votes,
        samples: sample.len(),
        median_self_distance,
    }
}

/// 单字符替换决策：返回可见字符；None 表示不改（保持原字符）。
pub fn decide_char(c: &GlyphCandidate, t: &Thresholds) -> Option<char> {
    if !is_confident_substitution(c, t) {
        return None;
    }
    c.best_codepoint.and_then(char::from_u32)
}

/// 字体级闸门：多少比例的字形对得上常用字。
///
/// 图标字体(icomoon/VideoJS)里偶尔有一个字形碰巧像某个汉字，
/// 逐字判定就会把它映射成汉字 → 复制出来是错字。
/// 混淆字体的特征是**几乎每个字形**都对得上一个常用字。
pub fn font_fit_ratio(per_char: &[(u32, GlyphCandidate)], t: &Thresholds) -> f32 {
    if per_char.is_empty() {
        return 0.0;
    }
    let fit = per_char
        .iter()
        .filter(|(_, info)| {
            info.best_codepoint.is_some()
                && info.best_codepoint != Some(info.ch as u32)
                && info.best_score >= t.min_prefetch_score
                && info.best_margin >= t.replace_min_margin
                && info.self_distance >= t.replace_self_distance
        })
        .count();
    fit as f32 / per_char.len() as f32
}

/// 选最终答案（TS 侧 `pickCandidate`）。
///
/// 距离用**二值差异**（越小越像）；常用字先验等价于把距离调小一点。
/// margin 用**调整后**的距离差 —— 先验参与判定，margin 才反映真实把握。
pub struct Picked {
    pub codepoint: Option<u32>,
    /// 分数仍是灰度 L1 的分数（分数闸门沿用原口径）
    pub score: f32,
    pub margin: f32,
    pub alts: Vec<Candidate>,
}

pub fn pick_candidate(m: &MatchResult, t: &Thresholds) -> Picked {
    if m.candidates.is_empty() {
        return Picked {
            codepoint: m.codepoint,
            score: m.score,
            margin: m.margin,
            alts: Vec::new(),
        };
    }
    let bonus = |cp: u32| -> f32 {
        if is_common_char(cp) {
            t.common_char_prior_bonus
        } else {
            0.0
        }
    };
    let adjusted = |c: &Candidate| -> f32 { c.distance - bonus(c.codepoint) };
    let mut ranked: Vec<&Candidate> = m.candidates.iter().collect();
    ranked.sort_by(|a, b| {
        adjusted(a)
            .partial_cmp(&adjusted(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let preferred = ranked[0];
    let mut second = f32::INFINITY;
    for c in &ranked {
        if c.codepoint == preferred.codepoint {
            continue;
        }
        let a = adjusted(c);
        if a < second {
            second = a;
        }
    }
    let alts = m
        .candidates
        .iter()
        .filter(|c| c.codepoint != preferred.codepoint)
        .take(t.keep_candidates)
        .map(|c| Candidate {
            codepoint: c.codepoint,
            score: (c.score * 10000.0).round() / 10000.0,
            distance: c.distance,
        })
        .collect();
    Picked {
        codepoint: Some(preferred.codepoint),
        score: preferred.score,
        margin: (second - adjusted(preferred)).max(0.0),
        alts,
    }
}
