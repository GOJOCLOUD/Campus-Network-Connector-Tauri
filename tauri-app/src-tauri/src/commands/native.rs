//! 原生能力:模拟鼠标 / 键盘 / 输入源。
//!
//! 命令签名**两个平台完全一致**,前端不用区分:
//! - macOS 走 CoreGraphics / Carbon TIS(见 `native/macos.rs`)
//! - Windows 走 SendInput(见 `native/windows.rs`)
//!
//! 平台差异只在这一层往下;`#[tauri::command]` 都挂在这里,
//! 免得每个平台各写一份宏、命令名对不上。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;

#[cfg(target_os = "macos")]
use macos as imp;
#[cfg(target_os = "windows")]
use windows as imp;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use unsupported as imp;

/// 鼠标点击(左键按下+抬起)。坐标是屏幕全局坐标。
#[tauri::command]
pub fn mouse_click(x: f64, y: f64) -> Result<bool, String> {
    imp::mouse_click(x, y)
}

/// 当前鼠标位置(屏幕全局坐标)。
#[tauri::command]
pub fn mouse_get_position() -> Result<(f64, f64), String> {
    imp::mouse_get_position()
}

/// 发送文本(按 Unicode 逐字敲入,跨输入法可用)。
#[tauri::command]
pub fn send_text(text: String) -> Result<bool, String> {
    imp::send_text(text)
}

/// 发送按键(键码 + 修饰键标志)。
///
/// flags 位:1=shift 2=control 4=alt 8=command/win。
/// 键码是平台自己的虚拟键码:macOS 是 CGKeyCode,Windows 是 VK_*。
#[tauri::command]
pub fn send_key(key_code: u16, flags: u32) -> Result<bool, String> {
    imp::send_key(key_code, flags)
}

/// 当前输入源(拼音/ABC 等)。只有 macOS 有这个能力。
#[tauri::command]
pub fn get_current_input_source() -> Result<String, String> {
    imp::get_current_input_source()
}

/// 切换输入源(传输入源 id)。只有 macOS 有这个能力。
#[tauri::command]
pub fn select_input_source(source_id: String) -> Result<bool, String> {
    imp::select_input_source(source_id)
}

// ── 剪贴板（macOS 专有：NSPasteboard）──────────────────────────

/// 读剪贴板里的文本。
///
/// Electron 版用 Electron 的 clipboard API；Tauri 版没有内置剪贴板，
/// 这里直接用 NSPasteboard（objc2-app-kit 已经有这个 feature）。
#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        let pb = NSPasteboard::generalPasteboard();
        // NSPasteboardTypeString 是 extern static,取用要进 unsafe 块
        let text = unsafe { pb.stringForType(NSPasteboardTypeString) }
            .map(|s| s.to_string())
            .unwrap_or_default();
        Ok(text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("剪贴板读取目前只有 macOS 实现".to_string())
    }
}
