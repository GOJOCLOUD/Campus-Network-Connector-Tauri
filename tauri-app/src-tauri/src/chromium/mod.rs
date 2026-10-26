//! Chromium 集成：Windows 上的「浏览器复制修复」。
//!
//! macOS 线走 Safari + Apple Events（`crate::safari`），没有这一层。
//!
//! 形态（ADR-0030）：**软件自己起一个 Edge**（带自己的 profile），
//! 用 CDP 给每个标签页在 document_start 注入页面守卫。
//!
//! - [`cdp`]：最小 CDP 客户端（WebSocket + JSON-RPC）
//! - [`browser`]：定位 Edge/Chrome、用自己的 profile 起进程、管生命周期
//! - [`bridge`]：在页面里执行 JS 的那一层（注入 / 读状态 / 下发映射）
//! - [`coordinator`]：调度轮次、快轮询、映射下发
//! - [`repair`]：功能入口与状态

pub mod bridge;
pub mod browser;
pub mod cdp;
pub mod coordinator;
pub mod repair;
