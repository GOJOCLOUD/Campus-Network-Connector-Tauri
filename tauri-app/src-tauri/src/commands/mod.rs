//! Tauri 命令集合。

pub mod app;
pub mod native;
pub mod play;
pub mod shortcuts;

// keepalive 依赖 `ureq`(HTTPS 客户端),而 ureq 只挂在 macOS target 上
// —— Windows 线按 ADR-0012 不做 keepalive,这个模块也就只在 macOS 编译。
#[cfg(target_os = "macos")]
pub mod keepalive;
