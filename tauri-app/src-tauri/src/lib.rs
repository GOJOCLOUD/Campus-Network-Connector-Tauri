//! 模拟输入 · Tauri 版
//!
//! 与 Electron 版（仓库根目录）**并存**：这是同一产品的第二套实现，
//! 目标是把安装包从 231MB 压到个位数 MB。
//!
//! 字形引擎（`glyph`）是 TS 版的逐行移植，阈值与口径**必须两边同步**。
//! 用 `tauri-app/verify-engine.sh` 对拍验证过：与 TS 引擎映射表逐条一致。

pub mod commands;
pub mod glyph;
pub mod safari;

use commands::app as appcmd;
use commands::native as nativecmd;
use tauri::Manager;

/// 运行时自检:把前端看到的真实状态写进数据目录。
/// 用来回答"变量到底生效没有 / __TAURI__ 在不在"这类问题,而不是靠猜。
#[tauri::command]
fn diag_report(app: tauri::AppHandle, info: serde_json::Value) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let mut payload = info;
        // Rust 侧知道的窗口状态也一并写进去
        if let Some(obj) = payload.as_object_mut() {
            let always_on_top = app
                .get_webview_window("main")
                .and_then(|w| w.is_always_on_top().ok());
            obj.insert(
                "nativeWindow".to_string(),
                serde_json::json!({
                    "transparent": native_window_transparent(&app),
                    "alwaysOnTop": always_on_top,
                }),
            );
            // Safari 修复的实际状态(失败原因最关键:权限/开关问题都体现在这里)
            #[cfg(target_os = "macos")]
            obj.insert(
                "safariRepair".to_string(),
                serde_json::json!({
                    "enabled": safari::repair::is_enabled(),
                    "injected": safari::repair::is_injected(),
                    "lastError": safari::repair::last_error(),
                    "poll": safari::repair::poll_diagnostics(),
                }),
            );
        }
        let _ = std::fs::write(
            dir.join("diag.json"),
            serde_json::to_string_pretty(&payload).unwrap_or_default(),
        );
    }
}

/// 问原生窗口"你到底透不透明"。
///
/// 配置里 `transparent: true` 只是**要求**透明,真正透不透明得问 NSWindow。
/// 少了这个探针,就只能靠"看着像不像"来判断白圈有没有回来。
#[cfg(target_os = "macos")]
fn native_window_transparent(app: &tauri::AppHandle) -> Option<bool> {
    use objc2_app_kit::NSWindow;
    let w = app.get_webview_window("main")?;
    let ptr = w.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    unsafe {
        let ns_window: &NSWindow = &*(ptr as *const NSWindow);
        Some(!ns_window.isOpaque())
    }
}

#[cfg(not(target_os = "macos"))]
fn native_window_transparent(_app: &tauri::AppHandle) -> Option<bool> {
    None
}



#[tauri::command]
fn window_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn window_minimize(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
fn window_maximize(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.maximize();
    }
}

/// Safari 复制修复 —— 只有 macOS 有(靠 Apple Events)。
/// 命令照样注册,Windows 上明确报"不支持",而不是让前端报"命令不存在"。
#[tauri::command]
fn safari_repair_check_now(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        safari::repair::check_now(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Safari 复制修复只有 macOS 有".to_string())
    }
}

#[tauri::command]
fn safari_repair_set_enabled(enabled: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        safari::repair::set_enabled(enabled);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
    }
    true
}

#[tauri::command]
fn safari_repair_get_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        serde_json::json!({
            "enabled": safari::repair::is_enabled(),
            "injected": safari::repair::is_injected(),
            "supported": true,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        serde_json::json!({
            "enabled": false,
            "injected": false,
            "supported": false,
        })
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            diag_report,
            window_quit,
            window_minimize,
            window_maximize,
            appcmd::get_activation_snapshot,
            appcmd::start_trial,
            appcmd::save_license,
            appcmd::clear_license,
            appcmd::migrate_legacy_activation,
            appcmd::get_settings,
            appcmd::set_settings,
            appcmd::list_files,
            appcmd::save_file,
            appcmd::rename_file,
            appcmd::delete_file,
            appcmd::read_file,
            appcmd::get_features,
            appcmd::get_feature_status,
            appcmd::set_feature_enabled,
            appcmd::get_native_status,
            nativecmd::mouse_click,
            nativecmd::mouse_get_position,
            nativecmd::send_text,
            nativecmd::send_key,
            nativecmd::get_current_input_source,
            nativecmd::select_input_source,
            nativecmd::clipboard_read_text,
            safari_repair_check_now,
            safari_repair_set_enabled,
            safari_repair_get_status,
        ])
        .setup(|app| {
            // Safari 修复轮询只跟 macOS 有关(靠 osascript 驱动 Safari)
            #[cfg(target_os = "macos")]
            {
                safari::repair::spawn_poller(app.handle().clone());
                // 恢复上次的开关状态(Electron 版也是落盘的,重启后仍保持开启)
                if appcmd::feature_enabled(app.handle(), "safari-repair") {
                    safari::repair::set_enabled(true);
                }
            }
            // macOS:窗口不是 key window 时,`performDragOperation`(Tauri 的拖窗实现)
            // 会**直接失效** → 表现为"拖不动"。启动时主动抢一次焦点即可。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
