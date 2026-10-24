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

// 录制(CGEventTap)只有 macOS 有;其它平台用占位实现,
// 让命令照样存在、返回一句明确的"不支持"。
//
// **`rec` 是对外的统一入口**:macOS 指向真实现,其它平台指向占位实现。
// 上层(命令层、运行自检)只认 `rec`,不直接碰 `recording` ——
// 否则 Windows 上会因为模块名不一样而编译不过。
#[cfg(target_os = "macos")]
pub mod recording;
#[cfg(target_os = "macos")]
pub use recording as rec;

#[cfg(not(target_os = "macos"))]
pub mod recording_stub;
#[cfg(not(target_os = "macos"))]
pub use recording_stub as rec;

// 全局快捷键的**事件监听**只有 macOS 有(macOS 自己监听 ⇒ 匹配更宽松、
// 能把按键吃掉,不会漏出多余的字符);其它平台用系统的全局热键。
#[cfg(target_os = "macos")]
pub mod hotkey;

/// 快捷键的**平台无关核心**(判定 + latch 状态机)。
///
/// macOS 与 Windows **跑的是同一份**状态机 —— 规则不许两边各写一套,
/// 否则迟早有一边 drifted。见 `hotkey_core` 的文件头。
pub mod hotkey_core;

/// Windows 侧的快捷键实现:latch + 「Control 按下/松开」的观察源。
#[cfg(target_os = "windows")]
pub mod hotkey_win;

#[cfg(target_os = "macos")]
use macos as imp;
#[cfg(target_os = "windows")]
use windows as imp;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use unsupported as imp;

/// 当前输入源信息 —— 与 Electron 版原生模块返回的对象**同一形状**。
#[derive(Clone, Default, Debug)]
pub struct InputSourceInfo {
    pub id: String,
    pub name: String,
    pub is_ascii: bool,
}

/// 鼠标点击(左键按下+抬起)。坐标是屏幕全局坐标。
#[tauri::command]
pub fn mouse_click(x: f64, y: f64) -> Result<bool, String> {
    imp::mouse_click(x, y)
}

/// 当前鼠标位置(屏幕全局坐标)。
///
/// 返回 `{ x, y }` —— 与 Electron 版原生模块(`mac-coregraphics`)同一形状。
/// (之前返回的是 `[x, y]` 元组,两个壳的接口形状不一样,迟早有人踩。)
#[tauri::command]
pub fn mouse_get_position() -> Result<serde_json::Value, String> {
    let (x, y) = imp::mouse_get_position()?;
    Ok(serde_json::json!({ "x": x, "y": y }))
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
///
/// 返回 `{ id, name, isASCII }` —— 与 Electron 版原生模块同一形状。
#[tauri::command]
pub fn get_current_input_source() -> Result<serde_json::Value, String> {
    let info = imp::current_input_source_info()?;
    Ok(serde_json::json!({
        "id": info.id,
        "name": info.name,
        "isASCII": info.is_ascii,
    }))
}

/// 切换输入源(传输入源 id)。只有 macOS 有这个能力。
#[tauri::command]
pub fn select_input_source(source_id: String) -> Result<bool, String> {
    imp::select_input_source(source_id)
}

// ── 剪贴板（macOS 专有：NSPasteboard）──────────────────────────

/// 当前进程有没有「辅助功能」权限。
///
/// 决定能不能发合成点击/按键(模拟输入、回放、拼音自动键入都靠它)。
/// 没有权限时系统会**静默丢弃**事件 —— 命令返回成功,屏幕上什么都没发生,
/// 所以这个状态必须查出来告诉界面。
pub fn accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::accessibility_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows 没有这个概念(SendInput 不需要额外授权)
        true
    }
}

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
    // Windows 走 Win32 的 OpenClipboard/GetClipboardData(见 native/windows.rs)。
    //
    // 这条是 ⌃D「剪贴板直输」在 Windows 上能干活的前提 ——
    // 之前 Windows 这条恒返回 Err,快捷键按下去**什么都不发生**。
    #[cfg(target_os = "windows")]
    {
        windows::clipboard_read_text()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("剪贴板读取目前只有 macOS 与 Windows 实现".to_string())
    }
}

/// 写剪贴板里的文本。
///
/// 界面里「复制 UUID」用的是 `navigator.clipboard.writeText` —— 那是浏览器 API,
/// WKWebView 里不一定成(Electron 里是能用的)。这里给一份原生实现,
/// 桥接层把浏览器的剪贴板 API 接到它上面,**界面代码一个字都不用改**。
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;
        let pb = NSPasteboard::generalPasteboard();
        unsafe {
            pb.clearContents();
            let s = NSString::from_str(&text);
            pb.setString_forType(&s, NSPasteboardTypeString);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("剪贴板写入目前只有 macOS 实现".to_string())
    }
}

// ── 录制(CGEventTap)────────────────────────────────────
//
// 对应 Electron 版 `mac-coregraphics/src/main.mm` 的 6 个导出:
//   startRecording / stopRecording / getRecordingClicks /
//   clearRecordingClicks / isRecording / tapFailed

/// 自身窗口的屏幕坐标范围(排除矩形)。
///
/// 用**原生**窗口的位置和尺寸算,不用前端的 `window.screenX`:
/// ① WebView 里那套值不一定准;
/// ② 它是「开始录制那一刻」的一次快照,而 Tauri 的窗口是**贴合内容**的
///    —— 录制列表一出现,窗口就变高/上移,「结束」按钮就跑出了那张快照,
///    点「结束」自己会被记成一次点击。
///
/// 换算成**逻辑点**、左上角为原点,和 CGEvent 报的位置同一套坐标系。
pub fn window_exclude_rect(app: &tauri::AppHandle) -> Option<[f64; 4]> {
    use tauri::Manager;
    let win = app.get_webview_window("main")?;
    let scale = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some(rect_from_physical(
        pos.x as f64,
        pos.y as f64,
        size.width as f64,
        size.height as f64,
        scale,
    ))
}

/// 由窗口的**物理**位置/尺寸算出排除矩形,换算成**逻辑点**、左上角为原点。
///
/// 为什么必须换算:CGEvent 报的位置是**逻辑点**、左上角为原点;
/// 而 Tauri 报的窗口位置/尺寸是**物理像素**。不除以缩放系数的话,
/// Retina 屏(缩放 2)上矩形会大一倍 —— 半个屏幕的点击都会被当成"点在自己身上"。
///
/// `scale <= 0` 视为 1(缩放系数拿不到时不要把矩形算成空)。
pub fn rect_from_physical(x: f64, y: f64, width: f64, height: f64, scale: f64) -> [f64; 4] {
    let s = if scale > 0.0 { scale } else { 1.0 };
    let left = x / s;
    let top = y / s;
    [left, top, left + width / s, top + height / s]
}

/// 开始录制(监听左键点击)。
///
/// 「点自己界面上的按钮不算一次点击」靠**排除矩形**实现:
/// 矩形用原生窗口位置算好,并在窗口每次移动/变高时刷新(见 lib.rs 的窗口事件)。
#[tauri::command]
pub fn start_recording(app: tauri::AppHandle) -> Result<bool, String> {
    let rect = window_exclude_rect(&app);
    rec::set_exclude_rect(rect);
    rec::start_recording(rect)
}

/// 停止录制。
#[tauri::command]
pub fn stop_recording() -> bool {
    rec::stop_recording()
}

/// 已录到的点击:`[{x, y, timestamp}]`,timestamp 是距录制开始的秒数。
#[tauri::command]
pub fn get_recording_clicks() -> Vec<serde_json::Value> {
    rec::get_recording_clicks()
        .into_iter()
        .map(|c| serde_json::json!({ "x": c.x, "y": c.y, "timestamp": c.timestamp }))
        .collect()
}

/// 清空已录到的点击。
#[tauri::command]
pub fn clear_recording_clicks() -> bool {
    rec::clear_recording_clicks()
}

/// 删掉第 index 次点击(单条删除)。
#[tauri::command]
pub fn remove_recording_click(index: usize) -> bool {
    rec::remove_click(index)
}

/// 是否正在录制。
#[tauri::command]
pub fn is_recording() -> bool {
    rec::is_recording()
}

/// 事件监听有没有失败(通常是「辅助功能」权限没给)。
#[tauri::command]
pub fn tap_failed() -> bool {
    rec::tap_failed()
}
