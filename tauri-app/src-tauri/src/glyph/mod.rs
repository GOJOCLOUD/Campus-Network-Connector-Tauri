//! 字形还原引擎（Rust 移植）。
//!
//! 与 TypeScript 版（`packages/core/src/glyph-matching/*` +
//! `src/features/safari-repair/engine.js`）**同口径**：同一套栅格化器、
//! 同一个 CRDB 格式、同一套阈值。移植的意义是省掉 Node/Electron 运行时，
//! 不是改算法 —— 任何阈值/口径的改动都必须两边同步。

pub mod common_charset;
pub mod db;
pub mod font;
pub mod policy;
pub mod raster;

pub use db::{Candidate, FastGlyphMatcher, GlyphDb, MatchResult};
pub use policy::{
    decide_char, decide_scope, font_fit_ratio, is_confident_substitution, pick_candidate,
    GlyphCandidate, Picked, ScopeDecision, Thresholds,
};
