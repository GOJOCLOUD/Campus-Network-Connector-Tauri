//! keepalive:每 3 分钟发一次 HTTPS 请求,避免网络被当成空闲连接断掉。
//!
//! 与 Electron 版 `main.js` 同口径:
//!   - `pingNetwork()` → GET `https://www.baidu.com`,超时 5 秒
//!   - 每 `180000ms` 一次
//!   - 开关落盘(settings.json 的 `keepaliveEnabled`),**默认 true**
//!
//! Windows 线按 ADR-0012 **不做 keepalive**,所以这个模块只在 macOS 上编译,
//! `ureq` 依赖也只挂在 macOS target 上(Windows 包里不带)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde_json::json;
use tauri::AppHandle;

use super::app as appcmd;

const PING_URL: &str = "https://www.baidu.com";
const PING_INTERVAL_MS: u64 = 180_000;
const PING_TIMEOUT_SECS: u64 = 5;

/// 后台线程是否已经起来了(避免重复起)。
static RUNNING: AtomicBool = AtomicBool::new(false);

/// 发一次保活请求,成功返回 true。
fn ping_network() -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(PING_TIMEOUT_SECS))
        .timeout_read(Duration::from_secs(PING_TIMEOUT_SECS))
        .timeout_write(Duration::from_secs(PING_TIMEOUT_SECS))
        .build();
    agent.get(PING_URL).call().is_ok()
}

/// keepalive 当前是不是开着(Electron 版默认 true)。
pub fn is_enabled(app: &AppHandle) -> bool {
    appcmd::get_settings(app.clone())
        .ok()
        .and_then(|v| v.get("keepaliveEnabled").and_then(|x| x.as_bool()))
        .unwrap_or(true)
}

/// 改 keepalive 开关(落盘)。
pub fn set_enabled(app: &AppHandle, enabled: bool) -> bool {
    let _ = appcmd::set_settings(app.clone(), json!({ "keepaliveEnabled": enabled }));
    true
}

/// 起后台保活线程(整个 App 生命周期只起一次)。
pub fn start(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = thread::Builder::new()
        .name("cnc-keepalive".to_string())
        .spawn(move || loop {
            thread::sleep(Duration::from_millis(PING_INTERVAL_MS));
            if !is_enabled(&app) {
                continue;
            }
            let _ = ping_network();
        });
    if spawned.is_err() {
        RUNNING.store(false, Ordering::SeqCst);
    }
}
