//! 非 macOS / 非 Windows 平台的占位实现。
//!
//! 只为了让 crate 在别的平台也能编过(比如 CI 上做类型检查),
//! 真正跑起来会明确报错,不会假装成功。

fn unsupported(what: &str) -> String {
    format!("当前平台不支持{}（只有 macOS 与 Windows 有原生实现）", what)
}

pub fn mouse_click(_x: f64, _y: f64) -> Result<bool, String> {
    Err(unsupported("模拟鼠标点击"))
}

pub fn mouse_get_position() -> Result<(f64, f64), String> {
    Err(unsupported("读取鼠标位置"))
}

pub fn send_text(_text: String) -> Result<bool, String> {
    Err(unsupported("发送文本"))
}

pub fn send_key(_key_code: u16, _flags: u32) -> Result<bool, String> {
    Err(unsupported("发送按键"))
}

/// 当前输入源信息 —— 本平台不支持。
pub fn current_input_source_info() -> Result<crate::commands::native::InputSourceInfo, String> {
    Err(unsupported("读取输入源"))
}

pub fn select_input_source(_source_id: String) -> Result<bool, String> {
    Err(unsupported("切换输入源"))
}
