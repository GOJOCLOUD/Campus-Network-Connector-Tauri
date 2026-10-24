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

pub fn start_recording(_exclude_rect: Option<[f64; 4]>) -> Result<bool, String> {
    Err(UNSUPPORTED.to_string())
}

/// 设置排除矩形 —— Windows 线不做录制,这里是空实现。
///
/// 命令照样占住,让上层代码在两个平台上**形状一致**
/// (免得 Windows 上因为少了这个函数而编译不过)。
pub fn set_exclude_rect(_rect: Option<[f64; 4]>) {}

/// 删掉第 index 次点击 —— Windows 线不做录制,这里是空实现。
pub fn remove_click(_index: usize) -> bool {
    false
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

pub fn is_recording() -> bool {
    false
}

pub fn tap_failed() -> bool {
    false
}
