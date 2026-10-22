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
                    // 窗口实际层级(Electron 用的是 screen-saver = 1000;
                    // Tauri 的 alwaysOnTop 默认只有 floating = 3)
                    "level": native_window_level(&app),
                }),
            );
            // 全局快捷键:注册成功没有(Electron 版有 ⌃⇧A / ⌃⇧D 两个)
            obj.insert(
                "shortcuts".to_string(),
                serde_json::json!({
                    "registered": registered_shortcuts(),
                    "defaultExecute": SHORTCUT_DEFAULT_EXECUTE,
                    "paste": SHORTCUT_PASTE,
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
            // 原生能力状态:能不能发合成点击/按键(辅助功能权限)
            // 录制相关走 `native::rec` —— macOS 是真实现,其它平台是占位实现。
            obj.insert(
                "native".to_string(),
                serde_json::json!({
                    "accessibilityTrusted": commands::native::accessibility_trusted(),
                    "recording": commands::native::rec::is_recording(),
                    "recordingClicks": commands::native::rec::get_recording_clicks().len(),
                    "tapFailed": commands::native::rec::tap_failed(),
                }),
            );
            // 最近一次回放:执行了几条、为什么没执行
            obj.insert(
                "playback".to_string(),
                match commands::play::last_status() {
                    Some(st) => serde_json::json!({
                        "file": st.file,
                        "clicks": st.clicks,
                        "executed": st.executed,
                        "startedAtMs": st.started_at_ms,
                        "finishedAtMs": st.finished_at_ms,
                        "error": st.error,
                    }),
                    None => serde_json::json!(null),
                },
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

/// 把窗口层级提到 **screen-saver**(与 Electron 的 `setAlwaysOnTop(true,'screen-saver')` 同口径)。
///
/// 层级常量(CoreGraphics):
/// - kCGFloatingWindowLevel = 3 —— Tauri `alwaysOnTop: true` 的默认层级
/// - kCGScreenSaverWindowLevel = 1000 —— Electron 用的那一档
///
/// 不提上去的差别:全屏 App(演示、视频)会盖住这个面板。
#[cfg(target_os = "macos")]
fn set_screen_saver_level(app: &tauri::AppHandle) {
    use objc2_app_kit::NSWindow;
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let Ok(ptr) = w.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    unsafe {
        let ns_window: &NSWindow = &*(ptr as *const NSWindow);
        ns_window.setLevel(1000);
    }
}

/// macOS 应用菜单。
///
/// Electron 版用的是**系统默认菜单**(⌘Q 退出、⌘C/⌘V 编辑、⌘M 最小化都在里面)。
/// Tauri 默认**没有任何菜单** → 用户没有 ⌘Q 可按;而窗口关闭我们又改成了
/// "隐藏"(为了保住 Safari 复制修复这类常驻能力)—— 结果就是**没法退出**。
/// 这里按 macOS 惯例把默认菜单补回来。
#[cfg(target_os = "macos")]
fn setup_macos_menu(app: &tauri::AppHandle) {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};

    let built = (|| -> tauri::Result<()> {
        let app_menu = SubmenuBuilder::new(app, "模拟输入-Tauri")
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        let edit_menu = SubmenuBuilder::new(app, "编辑")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let window_menu = SubmenuBuilder::new(app, "窗口")
            .minimize()
            .fullscreen()
            .separator()
            .close_window()
            .build()?;

        let menu = MenuBuilder::new(app)
            .items(&[&app_menu, &edit_menu, &window_menu])
            .build()?;
        app.set_menu(menu)?;
        Ok(())
    })();
    if let Err(e) = built {
        eprintln!("[menu] 建菜单失败: {}", e);
    }
}



/// 窗口的实际层级(macOS 才有)。
/// Electron 用的是 screen-saver(1000);Tauri 的 `alwaysOnTop` 默认只有 floating(3)。
#[cfg(target_os = "macos")]
fn native_window_level(app: &tauri::AppHandle) -> Option<i64> {
    use objc2_app_kit::NSWindow;
    let w = app.get_webview_window("main")?;
    let ptr = w.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    unsafe {
        let ns_window: &NSWindow = &*(ptr as *const NSWindow);
        Some(ns_window.level() as i64)
    }
}

#[cfg(not(target_os = "macos"))]
fn native_window_level(_app: &tauri::AppHandle) -> Option<i64> {
    None
}

/// 已注册的全局快捷键(自检用)。
static REGISTERED_SHORTCUTS: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> =
    std::sync::OnceLock::new();

fn registered_shortcuts() -> Vec<String> {
    REGISTERED_SHORTCUTS
        .get()
        .and_then(|m| m.lock().ok().map(|v| v.clone()))
        .unwrap_or_default()
}

#[tauri::command]
fn window_quit(app: tauri::AppHandle) {
    // 退出前注销全局快捷键(Electron 版 before-quit 里 unregisterAll 同口径),
    // 不然系统里可能还占着这个组合键一阵子,用户重新注册别的软件会失败。
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let _ = app.global_shortcut().unregister_all();
    }
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

/// 窗口贴合内容:把窗口**高度**收到前端报上来的内容实际高度。
///
/// 为什么要有这条:窗口比可见面板大一圈时,那一圈**看不见的地方照样吃鼠标事件**
/// (macOS 的透明窗口整块矩形都收事件,下面的 App 就点不动了),也白占着桌面。
/// 收窄之后,屏幕上就只剩"一块浮着的白色面板"——和 Electron 版的观感一致。
///
/// **只调高度**:宽度由布局定死(卡片 448px),动宽度会和前端测量互相追着跑
/// (窗口变窄 → 卡片变窄 → 再报一个更窄的宽度 → 无限缩小)。
///
/// 高度不许超过**屏幕**:超了窗口底边就跑到屏幕外,面板还是被切掉
/// (内容多的页面实测会要 747px,笔记本可用高度不够)。
/// 内容多到屏幕装不下时,界面那边会自己滚动,窗口停在这儿正好。
///
/// 差值小于 2px 就不动,免得和前端的测量抖动互相打转。
#[tauri::command]
fn window_fit_to_content(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    if !height.is_finite() || height <= 0.0 {
        return Err("高度不合法".to_string());
    }
    let w = app.get_webview_window("main").ok_or("找不到主窗口")?;
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let cur = w.inner_size().map_err(|e| e.to_string())?;
    let cur_logical = cur.height as f64 / scale;
    // 屏幕(逻辑像素)高度:窗口最高只能到这儿,再多底边就出屏了
    let screen_h = w
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / scale)
        .unwrap_or(f64::MAX);
    let want = height.round().min(screen_h);
    if (want - cur_logical).abs() < 2.0 {
        return Ok(());
    }
    let size = tauri::LogicalSize::new(cur.width as f64 / scale, want);
    w.set_size(size).map_err(|e| e.to_string())
}

/// 打开「系统设置 → 隐私与安全性 → 辅助功能」。
///
/// 界面上的小问号点一下就该把人送到能改的地方,而不是让人自己找路径。
#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开系统设置失败:{}", e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("只有 macOS 有「辅助功能」设置页".to_string())
    }
}

/// Safari 复制修复 —— 只有 macOS 有(靠 Apple Events)。
/// 命令照样注册,Windows 上明确报"不支持",而不是让前端报"命令不存在"。
#[tauri::command]
fn safari_repair_check_now(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        safari::repair::check_now(&app, 0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Safari 复制修复只有 macOS 有".to_string())
    }
}

/// Safari 修复开关 —— **只改运行态**(与 Electron 版 `safariRepair:setEnabled` 同语义)。
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

/// Safari 修复开关 —— **只落盘**(与 Electron 版 `safariRepair:setEnabledSetting` 同语义)。
///
/// 之前这里和 `setEnabled` 指向同一条命令:结果就是"只落盘"的那个接口其实改了
/// 运行态、而"该落盘"的那次调用没落盘 —— 开关重启后就丢了。
#[tauri::command]
fn safari_repair_set_enabled_setting(app: tauri::AppHandle, enabled: bool) -> bool {
    let _ = commands::app::set_feature_enabled_state(&app, "safari-repair", enabled);
    true
}

#[tauri::command]
fn safari_repair_get_status() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        serde_json::json!({
            "enabled": safari::repair::is_enabled(),
            "injected": safari::repair::is_injected(),
            "running": safari::repair::is_enabled(),
            // 问不到 Safari 状态时按"在跑"处理(与 Electron 版同口径)
            "safariRunning": safari::repair::safari_running_state().unwrap_or(true),
            "lastError": safari::repair::last_error(),
            "supported": true,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        serde_json::json!({
            "enabled": false,
            "injected": false,
            "running": false,
            "safariRunning": false,
            "lastError": "",
            "supported": false,
        })
    }
}

/// keepalive 开关状态(Electron 版默认 true)。
#[tauri::command]
fn keepalive_get_status(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(commands::keepalive::is_enabled(&app))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("keepalive 只有 macOS 实现".to_string())
    }
}

/// 改 keepalive 开关(落盘)。
#[tauri::command]
fn keepalive_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(commands::keepalive::set_enabled(&app, enabled))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
        Err("keepalive 只有 macOS 实现".to_string())
    }
}

pub fn run() {
    tauri::Builder::default()
        // 单实例:第二次启动不新开一份,而是把已有窗口叫回来。
        // (Electron 版 main.js 里 requestSingleInstanceLock + second-instance 同口径。
        //  没有它就能同时起两份 → 两个轮询线程、两个事件 tap,互相打架。)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // 全局快捷键:⌃⇧A 默认执行 / ⌃⇧D 剪贴板直输(macOS)。
        // 快捷键走的是**后端**这条路 —— 界面没打开时也要能用。
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    return;
                }
                let id = shortcut.id();
                if id == shortcut_id(SHORTCUT_DEFAULT_EXECUTE) {
                    if let Err(e) = commands::shortcuts::trigger_default_execute(app) {
                        eprintln!("[shortcut] 默认执行失败: {}", e);
                    }
                } else if id == shortcut_id(SHORTCUT_PASTE) {
                    // 剪贴板直输要切输入源,只有 macOS 有这套打法
                    // (Windows 直接送 Unicode 字符,不需要这个快捷键 —— 与 Electron 版一致)
                    #[cfg(target_os = "macos")]
                    if let Err(e) = commands::shortcuts::trigger_pinyin_from_clipboard(app) {
                        eprintln!("[shortcut] 剪贴板直输失败: {}", e);
                    }
                }
            })
            .build())
        .invoke_handler(tauri::generate_handler![
            diag_report,
            window_quit,
            window_minimize,
            window_maximize,
            window_fit_to_content,
            open_accessibility_settings,
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
            appcmd::set_feature_enabled_setting,
            appcmd::get_native_status,
            nativecmd::mouse_click,
            nativecmd::mouse_get_position,
            nativecmd::send_text,
            nativecmd::send_key,
            nativecmd::get_current_input_source,
            nativecmd::select_input_source,
            nativecmd::clipboard_read_text,
            nativecmd::start_recording,
            nativecmd::stop_recording,
            nativecmd::get_recording_clicks,
            nativecmd::clear_recording_clicks,
            nativecmd::is_recording,
            nativecmd::tap_failed,
            commands::play::play_file,
            commands::play::play_data,
            keepalive_get_status,
            keepalive_set_enabled,
            safari_repair_check_now,
            safari_repair_set_enabled,
            safari_repair_set_enabled_setting,
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
                // keepalive:每 3 分钟一次 HTTPS 保活(Electron 版同口径)
                commands::keepalive::start(app.handle().clone());
            }
            // macOS:窗口不是 key window 时,`performDragOperation`(Tauri 的拖窗实现)
            // 会**直接失效** → 表现为"拖不动"。启动时主动抢一次焦点即可。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            // 注册全局快捷键(与 Electron 版同口径:⌃⇧A 一定有,⌃⇧D 只有 macOS)
            register_global_shortcuts(app.handle());
            // macOS:菜单(⌘Q 退出 / 编辑菜单)与窗口层级(screen-saver)
            #[cfg(target_os = "macos")]
            {
                setup_macos_menu(app.handle());
                set_screen_saver_level(app.handle());
            }
            Ok(())
        })
        // 关窗口 ≠ 退出 App(macOS 惯例)。
        //
        // 为什么必须这样:**Safari 复制修复是常驻能力**(要一直盯着浏览器、随时接管复制),
        // keepalive 也是常驻的。窗口一关进程就退 → 这两样能力当场消失,
        // 表现出来就是"随手点一下关闭,复制就再也不修复了"。
        // Electron 版 main.js 的 window-all-closed 就是这么处理的(macOS 不退出)。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                #[cfg(not(target_os = "macos"))]
                {
                    // Windows 线没有常驻能力,关窗口就退出(和 Electron 版一致)
                    let _ = (window, api);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            // Dock 图标点一下 → 窗口已经被隐藏时重新显示(Electron 版 activate 同口径)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

/// 注册全局快捷键。
///
/// 与 Electron 版 `registerShortcuts()` 同口径:
/// - ⌃⇧A 触发「默认执行」—— 两个平台都有
/// - ⌃⇧D 读剪贴板并键入 —— **只有 macOS**(Windows 没有输入源切换这套打法)
fn register_global_shortcuts(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let gs = app.global_shortcut();
    let mut keys = vec![SHORTCUT_DEFAULT_EXECUTE];
    #[cfg(target_os = "macos")]
    keys.push(SHORTCUT_PASTE);

    let mut ok_list: Vec<String> = Vec::new();
    for key in keys {
        let Some(shortcut) = parse_shortcut(key) else {
            eprintln!("[shortcut] 解析不了: {}", key);
            continue;
        };
        match gs.register(shortcut) {
            Ok(()) => ok_list.push(key.to_string()),
            Err(e) => eprintln!("[shortcut] 注册失败 {}: {}", key, e),
        }
    }
    let slot = REGISTERED_SHORTCUTS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    if let Ok(mut v) = slot.lock() {
        *v = ok_list;
    }
}

/// 快捷键的组合键字符串。
const SHORTCUT_DEFAULT_EXECUTE: &str = "CmdOrControl+Shift+A";
const SHORTCUT_PASTE: &str = "CmdOrControl+Shift+D";

/// 把组合键字符串解析成插件的 Shortcut。
fn parse_shortcut(key: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    use std::str::FromStr;
    tauri_plugin_global_shortcut::Shortcut::from_str(key).ok()
}

/// 组合键的 id —— handler 里按 id 匹配(同一个键只有一个 id)。
fn shortcut_id(key: &str) -> u32 {
    parse_shortcut(key).map(|s| s.id()).unwrap_or(0)
}
