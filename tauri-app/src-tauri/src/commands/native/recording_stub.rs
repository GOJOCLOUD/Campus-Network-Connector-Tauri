//! 非 macOS 平台的录制占位。
//!
//! 录制依赖 CoreGraphics 的 CGEventTap,只有 macOS 有。
//! Windows 线按 ADR-0012 **不做录制**,所以这里只把命令占住,
//! 让前端拿到一句明确的"不支持",而不是"命令不存在"。

/// 一次点击(非 macOS 平台恒为空)。
#[derive(Clone, Copy, Debug)]
pub struct ClickEvent {
    pub x: f64,
    pub y: f64,
    pub timestamp: f64,
}

const UNSUPPORTED: &str = "录制功能只有 macOS 实现(Windows 线按 ADR-0012 不做录制)";

pub fn start_recording() -> Result<bool, String> {
    Err(UNSUPPORTED.to_string())
}

pub fn stop_recording() -> bool {
    false
}

pub fn get_recording_clicks() -> Vec<ClickEvent> {
    Vec::new()
}

pub fn clear_recording_clicks() -> bool {
    false
}

/// 删掉第 index 次点击(非 macOS 平台没有可删的东西)。
pub fn remove_click(_index: usize) -> bool {
    false
}

/// 设置排除矩形(非 macOS 平台用不上,空实现)。
pub fn set_exclude_rect(_rect: Option<[f64; 4]>) {}

/// 当前排除矩形(非 macOS 平台恒为 None)。
pub fn exclude_rect() -> Option<[f64; 4]> {
    None
}

/// 最近一次自检的结果(非 macOS 平台恒为 None)。
pub fn diag_result() -> Option<serde_json::Value> {
    None
}

/// 记下自检结果(非 macOS 平台用不上)。
pub fn set_diag_result(_value: serde_json::Value) {}

pub fn is_recording() -> bool {
    false
}

pub fn tap_failed() -> bool {
    false
}
