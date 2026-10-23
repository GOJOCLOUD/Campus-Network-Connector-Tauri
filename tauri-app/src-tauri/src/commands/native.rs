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

// ── 主线程编排(Carbon TIS 的硬性要求)────────────────────────────
//
// ⚠️ **Carbon 的文字输入源 API 只能在主线程调。**
//
// `TISCopyCurrentKeyboardInputSource` / `TISGetInputSourceProperty` /
// `TISSelectInputSource` 内部会走到 AppKit 的 `islGetInputSourceListWithAdditions`,
// 那儿有一句 `dispatch_assert_queue`:不在主线程就直接
// `dispatch_assert_queue_fail` → **SIGTRAP** → 整个 App 当场崩掉
// (不是 Rust 的 panic,是进程直接消失)。
//
// **2026-10-23 真机事故就是这个**:全局快捷键的**事件 tap 回调线程**
// (线程名 `cnc-hotkey`)在记命中时顺手读了一下当前输入源 → App 崩。
// 崩溃报告(`~/Library/Logs/DiagnosticReports/simuinput-tauri-*.ips`):
// `EXC_BREAKPOINT / SIGTRAP`,栈底 `TSMGetInputSourceProperty`
// ← `processEventTapData`,faulting thread = `cnc-hotkey`。
//
// 所以这一层提供统一的"到主线程去跑"编排:
// - 已经在主线程 → 直接跑(派发过去再等 = **自锁**);
// - 不在主线程 → 派发到主线程,最多等一段时间,超时报错不无限等。
//
// 另外提供 `run_on_main_thread_detached`:派发过去**不等**。
// 事件 tap 回调这种地方**绝对不能阻塞** —— tap 回调慢一点,系统会直接把
// 这个 tap 关掉(快捷键就间歇性失灵了)。

/// 启动时记住的 AppHandle(派发到主线程用)。
static APP_HANDLE: std::sync::OnceLock<std::sync::Mutex<Option<tauri::AppHandle>>> =
    std::sync::OnceLock::new();

/// 主线程的线程号(`init_main_thread` 时记下)。
static MAIN_THREAD: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

/// 启动时调用:记住 AppHandle 和**主线程的线程号**。
///
/// 必须在 `setup()` 的**第一行**调 —— `setup()` 本身就跑在主线程上,
/// 这里记下来的才是真的主线程。记错了会导致"在主线程上派发到主线程再等"的自锁。
pub fn init_main_thread(app: &tauri::AppHandle) {
    let _ = MAIN_THREAD.set(std::thread::current().id());
    if let Ok(mut slot) = APP_HANDLE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    {
        *slot = Some(app.clone());
    }
}

/// 当前是不是主线程。
pub fn is_main_thread() -> bool {
    MAIN_THREAD
        .get()
        .map(|id| *id == std::thread::current().id())
        .unwrap_or(false)
}

/// 拿全局 AppHandle。
pub fn app_handle() -> Option<tauri::AppHandle> {
    APP_HANDLE
        .get()
        .and_then(|slot| slot.lock().ok().and_then(|s| s.clone()))
}

/// 到主线程去跑一个闭包并**等结果**。
///
/// 已经在主线程 → 直接跑(派发过去再等 = 自锁)。
/// 不在主线程 → 派发到主线程,最多等 `timeout`;超时报错,不无限等。
pub fn run_on_main_thread<F, R>(f: F, timeout: std::time::Duration) -> Result<R, String>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    if is_main_thread() {
        return Ok(f());
    }
    let app = app_handle().ok_or_else(|| "还没有 AppHandle,到不了主线程".to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<R>();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("派发到主线程失败: {}", e))?;
    rx.recv_timeout(timeout)
        .map_err(|e| format!("等主线程的结果失败: {}", e))
}

/// 到主线程去跑一个闭包,**不等结果**。
///
/// 用于事件 tap 回调这种"绝对不能阻塞"的地方。
pub fn run_on_main_thread_detached<F>(f: F)
where
    F: FnOnce() + Send + 'static,
{
    if is_main_thread() {
        f();
        return;
    }
    if let Some(app) = app_handle() {
        let _ = app.run_on_main_thread(f);
    }
}

/// 点 `(x, y)` 是否落在矩形 `rect` 里(闭区间)。
///
/// `rect` 是 `[左, 上, 右, 下]`(逻辑点、左上角为原点)——
/// 见 `rec::rect_from_physical`。
///
/// **两处要用它,必须是同一份判定**:录制时排除自己窗口上的点击、
/// 回放时不把点击打到自己窗口上。写成两套迟早会写出两套不一样的边界。
pub fn in_exclude(rect: &Option<[f64; 4]>, x: f64, y: f64) -> bool {
    match rect {
        Some(r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3],
        None => false,
    }
}

/// 读当前输入源(跨平台统一入口;macOS 走 Carbon TIS)。
///
/// macOS 上这个调用**内部会到主线程去跑**(Carbon 的硬性要求),
/// 所以谁调用都不会崩 —— 包括事件 tap 的回调线程。
pub fn current_input_source_info() -> Result<InputSourceInfo, String> {
    imp::current_input_source_info()
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
    #[cfg(not(target_os = "macos"))]
    {
        Err("剪贴板读取目前只有 macOS 实现".to_string())
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
/// ① WKWebView 里那套值不一定准;
/// ② 它是「开始录制那一刻」的一次快照,而 Tauri 的窗口是**贴合内容**的
///    —— 录制列表一出现,窗口就往上长,「结束」按钮就跑出了那张快照,
///    点「结束」自己会被记成一次点击。
///
/// 换算成**逻辑点**、左上角为原点,和 CGEvent 报的位置同一套坐标系
/// (见 `rec::rect_from_physical`)。
#[cfg(target_os = "macos")]
pub fn window_exclude_rect(app: &tauri::AppHandle) -> Option<[f64; 4]> {
    use tauri::Manager;
    let win = app.get_webview_window("main")?;
    let scale = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some(rec::rect_from_physical(
        pos.x as f64,
        pos.y as f64,
        size.width as f64,
        size.height as f64,
        scale,
    ))
}

#[cfg(not(target_os = "macos"))]
pub fn window_exclude_rect(_app: &tauri::AppHandle) -> Option<[f64; 4]> {
    None
}

/// 开始录制(监听左键点击)。
///
/// 「点自己界面上的按钮不算一次点击」靠**排除矩形**实现:
/// 矩形用原生窗口位置算好,并在窗口每次移动/变高时刷新(见 lib.rs 的窗口事件)。
#[tauri::command]
pub fn start_recording(app: tauri::AppHandle) -> Result<bool, String> {
    rec::set_exclude_rect(window_exclude_rect(&app));
    rec::start_recording()
}

/// 停止录制,并把已录到的点击交回去。
///
/// 返回数组而不是 bool:界面要显示"返回 N 个点击",
/// 而且停止那一刻录到的最后一次点击只有这里拿得到(界面那边是 100ms 轮询,
/// 可能差最后一次)。
#[tauri::command]
pub fn stop_recording() -> Vec<serde_json::Value> {
    rec::stop_recording();
    rec::get_recording_clicks()
        .into_iter()
        .map(|c| serde_json::json!({ "x": c.x, "y": c.y, "timestamp": c.timestamp }))
        .collect()
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

/// 当前排除矩形(诊断用:界面上看不出来)。
#[tauri::command]
pub fn recording_exclude_rect() -> Option<Vec<f64>> {
    rec::exclude_rect().map(|r| vec![r[0], r[1], r[2], r[3]])
}

/// 自检:「点自己界面上的按钮,会不会被记成一次点击」。
///
/// 往**自己窗口内**发一个合成点击(落在左侧透明边距上,不碰任何按钮),
/// 看它会不会被记成一次点击。带一组对照,详见 `rec::diagnose_exclusion`。
#[tauri::command]
pub fn diagnose_recording_exclusion(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let rect = window_exclude_rect(&app).ok_or("拿不到窗口位置")?;
    // 窗口左侧那条透明边距(根容器有 px-2,红绿灯在 y=12 附近)——
    // 点这里没有任何副作用,又确实在窗口范围内。
    let point = (rect[0] + 4.0, rect[1] + 60.0);
    let result = rec::diagnose_exclusion(Some(rect), point);
    rec::set_diag_result(result.clone());
    Ok(result)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 单测进程里**没有**注册主线程 ⇒ `is_main_thread()` 必须是 false。
    ///
    /// 记错主线程的后果是:在主线程上"派发到主线程再等"= 自锁。
    #[test]
    fn 单测进程里不算主线程() {
        assert!(!is_main_thread());
    }

    /// 没有 AppHandle 时,"到主线程去跑"必须**干脆报错**,不能挂死。
    ///
    /// (单测进程里没有 Tauri App。这条用例保证那条路径是"失败得快",
    ///  而不是等一个永远不会来的结果。)
    #[test]
    fn 没有AppHandle时到主线程会报错() {
        let r = run_on_main_thread(|| 42u32, std::time::Duration::from_millis(200));
        assert!(r.is_err(), "没有 AppHandle 时必须干脆报错,不能挂死: {:?}", r);
    }
}
