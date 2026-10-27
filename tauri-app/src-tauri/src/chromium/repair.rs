//! Windows 的「浏览器复制修复」—— **软件自己起 Edge + CDP 注入页面守卫**。
//!
//! ## 为什么不再是「注册表装扩展」
//!
//! 上一版（ADR-0028）走的是「注册表外部扩展」这条路，**真机上是不通的**：
//!
//! | 卡点 | 实证 |
//! | --- | --- |
//! | 浏览器只在**启动时**读那份清单 | 改了注册表必须**重启一次浏览器**才生效（用户要动手） |
//! | .crx 装上后被**验证器禁用** | 真机实测 `disable_reasons=[256]`（DISABLE_NOT_VERIFIED）；用户点「启用」也开不了 |
//!
//! ⇒ 而用户的底线是**零点击**（唯一人工动作 = 扫码登录超星），重启浏览器这件事本身就不合格。
//!
//! ## 现在的形态（ADR-0030）
//!
//! 1. 用户拨一下开关 → **本软件自己拉起一个 Edge**（带**自己的 profile 目录**
//!    + `--remote-debugging-port`）。
//! 2. 通过 CDP 连上它，给**每个标签页**在 **document_start** 注入页面守卫
//!    （`Page.addScriptToEvaluateOnNewDocument`）。
//! 3. 守卫发现页面里的混淆字体 → 上报 → App 侧用参考字形库算出「密文 → 明文」
//!    → 下发回页面 → 用户按 Ctrl+C 时守卫在 copy 事件里把明文写进剪贴板。
//!
//! **页面侧那套（守卫 + 帧桥）一行都没改** —— `resources/page-guard.js` 与
//! `resources/frame-bridge.js` 是两条线共用的资产。
//!
//! ## 边界
//!
//! - 用户要在**本软件开的那个 Edge 窗口**里用 —— 这是零点击的代价，
//!   界面上**必须把这句话说出来**（见 `HINT_ON`）。
//! - 调试端口只监听 127.0.0.1 + 随机端口；**绝不能**加
//!   `--remote-allow-origins=*`（那等于把调试端口对任意网页开放）。
//!   这**不是安全边界**（与 ADR-0028 同样定性）。

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::json;

use crate::chromium::browser::ManagedBrowser;
use crate::chromium::coordinator::Coordinator;

/// 页面守卫脚本（构建时从 resources 嵌进来，保证与 Electron 版同一份）。
const GUARD_JS: &str = include_str!("../../resources/page-guard.js");

/// iframe 桥脚本（同样构建期内嵌，与 Electron 版 `vendor/frame-bridge.js` 同一份）。
const FRAME_BRIDGE_JS: &str = include_str!("../../resources/frame-bridge.js");

/// 界面上的提示文案 —— 必须说**确实会发生**的事：
/// 本软件会开一个自己的浏览器窗口，用户要在那个窗口里用。
pub const HINT_ON: &str = "本软件已打开一个自己的 Edge 窗口 —— 请在这个窗口里上网、答题；关掉它之后本软件**不会**自动再开一个（下面有「重新打开浏览器」按钮）。首次使用需要扫码登录一次。";

struct GlobalState {
    /// 开关（运行态）。
    enabled: bool,
    /// 最近一次失败原因 —— 必须能透出给界面。
    last_error: String,
    /// 协调器（建不起来时是 `None`，那时开关会如实报错）。
    coordinator: Option<Arc<Coordinator>>,
}

static STATE: OnceLock<Mutex<GlobalState>> = OnceLock::new();

fn state() -> &'static Mutex<GlobalState> {
    STATE.get_or_init(|| {
        Mutex::new(GlobalState {
            enabled: false,
            last_error: String::new(),
            coordinator: None,
        })
    })
}

/// 记一次失败原因（空串 = 清空）。
pub fn set_last_error(message: &str) {
    if let Ok(mut s) = state().lock() {
        s.last_error = message.to_string();
    }
}

/// 最近一次失败的原因（空串 = 没有失败）。
pub fn last_error() -> String {
    state()
        .lock()
        .map(|s| s.last_error.clone())
        .unwrap_or_default()
}

/// 开关是不是开着。
pub fn is_enabled() -> bool {
    state().lock().map(|s| s.enabled).unwrap_or(false)
}

/// 浏览器 profile 目录：数据目录下的 `browser-profile`。
fn profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取不到数据目录: {}", e))?;
    Ok(dir.join("browser-profile"))
}

/// 启动协调器（程序启动时调一次）。
///
/// 开关是**落盘**的 ⇒ 启动时要把上次的状态恢复回来（Electron 版同口径）。
pub fn spawn_poller(app: tauri::AppHandle) {
    let profile_dir = match profile_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            set_last_error(&e);
            return;
        }
    };
    let matcher = match crate::safari::repair::fast_matcher(&app) {
        Ok(matcher) => matcher,
        Err(e) => {
            set_last_error(&e);
            return;
        }
    };
    let injection_source = Coordinator::default_injection_source(GUARD_JS, FRAME_BRIDGE_JS);
    let browser = Arc::new(ManagedBrowser::new(profile_dir));
    let coordinator = Coordinator::new(browser, matcher, injection_source);
    {
        let mut s = state().lock().unwrap();
        s.coordinator = Some(coordinator);
    }
    if crate::commands::app::feature_enabled(&app, "chromium-repair") {
        let _ = set_enabled(&app, true);
    }
}

/// 拨开关。
pub fn set_enabled(_app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    {
        let mut s = state().lock().unwrap();
        s.enabled = enabled;
    }
    let coordinator = state().lock().unwrap().coordinator.clone();
    match coordinator {
        Some(coordinator) => {
            coordinator.set_enabled(enabled);
            set_last_error("");
            Ok(())
        }
        None if !enabled => {
            // 关开关永远成功（哪怕协调器没起来）。
            set_last_error("");
            Ok(())
        }
        None => {
            let message = "浏览器复制修复还没准备好（读不到字形参考库？）".to_string();
            set_last_error(&message);
            Err(message)
        }
    }
}

/// 现在的状态 —— 界面靠它显示「已接管 / 失败原因」。
///
/// 字段与 Electron 版 `chromiumRepair:getStatus` 对齐。
pub fn status(_app: &tauri::AppHandle) -> serde_json::Value {
    let (enabled, global_error, coordinator) = {
        let s = state().lock().unwrap();
        (s.enabled, s.last_error.clone(), s.coordinator.clone())
    };
    let coordinator_status = coordinator.map(|c| c.status());
    let injected = coordinator_status.as_ref().map(|s| s.injected).unwrap_or(false);
    let browser_running = coordinator_status
        .as_ref()
        .map(|s| s.browser_running)
        .unwrap_or(false);
    let browser_label = coordinator_status
        .as_ref()
        .map(|s| s.browser_label.clone())
        .unwrap_or_default();
    let mappings = coordinator_status.as_ref().map(|s| s.mappings).unwrap_or(0);
    let watched_tabs = coordinator_status
        .as_ref()
        .map(|s| s.watched_tabs)
        .unwrap_or(0);
    let last_error = coordinator_status
        .as_ref()
        .map(|s| s.last_error.clone())
        .filter(|e| !e.is_empty())
        .unwrap_or(global_error);
    let browser_closed_by_user = coordinator_status
        .as_ref()
        .map(|s| s.browser_closed_by_user)
        .unwrap_or(false);
    let auto_reopen = coordinator_status.as_ref().map(|s| s.auto_reopen).unwrap_or(true);

    json!({
        "enabled": enabled,
        "supported": cfg!(target_os = "windows"),
        // 「已接管」= **确实有守卫在场**（不是"处理过至少一个标签"）。
        "injected": injected,
        "running": enabled,
        "browserRunning": browser_running,
        "browserLabel": browser_label,
        "mappings": mappings,
        "watchedTabs": watched_tabs,
        // 界面把「浏览器没开」当中性状态处理；Windows 线上是**我们自己开的**浏览器，
        // 所以这里不暴露 safariRunning 那个字段（那是 mac 线的口径）。
        "hint": if enabled { HINT_ON } else { "" },
        "lastError": last_error,
        // 浏览器**被用户关掉了** ⇒ 界面显示「重新打开浏览器」按钮，
        // 而不是让软件偷偷再弹一个（2026-10-27 用户口径）。
        "browserClosedByUser": browser_closed_by_user,
        "autoReopen": auto_reopen,
    })
}

/// 用户点了「重新打开浏览器」⇒ 清掉状态并立刻起一个。
pub async fn reopen_browser(_app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let coordinator = state().lock().unwrap().coordinator.clone();
    match coordinator {
        Some(coordinator) => {
            let outcome = coordinator.reopen_browser().await?;
            Ok(json!({
                "tabs": outcome.tabs,
                "mapped": outcome.mapped,
                "errors": outcome.errors,
            }))
        }
        None => Err("浏览器复制修复还没准备好（读不到字形参考库？）".to_string()),
    }
}

/// 用户自己关掉浏览器窗口之后，要不要自动重开。
pub fn set_auto_reopen(_app: &tauri::AppHandle, auto_reopen: bool) -> bool {
    let coordinator = state().lock().unwrap().coordinator.clone();
    match coordinator {
        Some(coordinator) => coordinator.set_auto_reopen(auto_reopen),
        None => auto_reopen,
    }
}

/// 逐个作用域的映射结果（诊断用）。
pub fn mapping_results(_app: &tauri::AppHandle) -> serde_json::Value {
    let coordinator = state().lock().unwrap().coordinator.clone();
    match coordinator {
        Some(coordinator) => coordinator.mapping_results(),
        None => json!({}),
    }
}
