//! 门禁：Windows 线的「软件自己起浏览器 + CDP 注入守卫」端到端跑通。
//!
//! ## 它盯的是什么
//!
//! 整条链路，一个环节都不能断：
//!
//!   ① 起浏览器（自己的 profile + 调试端口）
//!   ② CDP 连上 → 每个标签页 document_start 注入页面守卫
//!   ③ 守卫采到混淆字体作用域 → App 侧**真字形识别**算出「密文 → 明文」
//!   ④ 映射下发回页面
//!   ⑤ 用户按 Ctrl+C → 剪贴板里是**明文**而不是密文
//!
//! 用的全是**仓库里的生产模块**（`chromium::browser` / `chromium::bridge` /
//! `chromium::coordinator` / `safari::repair` 的字形引擎），
//! 不是另写一份玩具实现 —— 所以这条门禁红了 ⇒ 装出来的包也是坏的。
//!
//! ## 为什么必须真跑浏览器
//!
//! 前面几层（守卫能不能拦到 copy 事件、映射能不能送到页面）**静态检查抓不到**：
//! 它们取决于浏览器的真实行为。2026-10-26 的实测就抓到过两条：
//!   - `Input.dispatchKeyEvent{commands:['copy']}` 不触发 DOM copy 事件（Windows 上）
//!     ⇒ 必须用**真实按键序列**
//!   - 页面自己拦复制（超星式）时，守卫必须赢过它
//!
//! ## 跑法
//!
//!   cd tauri-app/src-tauri && cargo test --test cdp_copy_repair
//!
//! 只在 Windows 上跑（其它平台整个文件被 cfg 掉）。
#![cfg(target_os = "windows")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use simuinput_tauri::chromium::bridge::build_injection_source;
use simuinput_tauri::chromium::browser::ManagedBrowser;
use simuinput_tauri::chromium::coordinator::Coordinator;
use simuinput_tauri::glyph::db::FastGlyphMatcher;
use simuinput_tauri::safari::repair::open_db_gz;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 页面里显示的是**密文**（DOM 里的字），混淆字体把它画成明文。
const CIPHERTEXT: &str = "天地玄黄宇宙洪荒日月盈昃";
/// 用户真正看到、也真正该复制到的**明文**。
const PLAINTEXT: &str = "人工智能正在改变世界科技";

/// 仓库里那份**真的**页面守卫与帧桥（构建时嵌进 App 的就是这两份）。
const GUARD_JS: &str = include_str!("../resources/page-guard.js");
const FRAME_BRIDGE_JS: &str = include_str!("../resources/frame-bridge.js");

/// 仓库根（`tauri-app/src-tauri` → 上两级）。
fn repo_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

/// 起一个本地夹具服务：混淆字体 + 密文文本。
async fn start_fixture_server(ttf: Vec<u8>) -> u16 {
    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>CDP 门禁夹具</title>
<style>
  body {{ font: 16px/1.9 "Microsoft YaHei", sans-serif; margin: 24px; }}
  @font-face {{ font-family: "ObfA"; src: url("/fonts/obf-same-style.ttf") format("truetype"); }}
  #target {{ font-family: "ObfA"; font-size: 26px; display: inline-block;
            background: #eef3ff; border: 1px solid #88aaff; padding: 10px 14px; }}
</style></head>
<body><p id="target">{}</p></body></html>"#,
        CIPHERTEXT
    );
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("应该能起本地夹具服务");
    let port = listener.local_addr().expect("应该拿得到端口").port();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let ttf = ttf.clone();
            let html = html.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    let Ok(n) = socket.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&buf).to_string();
                let path = request
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();
                let (content_type, body): (&str, Vec<u8>) = if path.starts_with("/fonts/") {
                    ("font/ttf", ttf)
                } else {
                    ("text/html; charset=utf-8", html.into_bytes())
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                    content_type,
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&body).await;
                let _ = socket.flush().await;
            });
        }
    });
    port
}

/// 跑一条 PowerShell（`-STA`：剪贴板 API 要单线程单元）。
fn run_powershell(script: &str, env: Option<(&str, &str)>) -> std::process::Output {
    let mut command = std::process::Command::new("powershell.exe");
    command.args(["-NoProfile", "-STA", "-Command", script]);
    if let Some((key, value)) = env {
        command.env(key, value);
    }
    command.output().expect("应该能起 powershell")
}

/// 读**系统剪贴板**里的文字。
fn read_clipboard() -> String {
    let path = std::env::temp_dir().join(format!("cnc-clip-{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let script = concat!(
        "$ErrorActionPreference='SilentlyContinue'; ",
        "$p=$env:CNC_CLIP_FILE; ",
        "$t=Get-Clipboard -Raw; ",
        "if ($null -eq $t) { $t='' }; ",
        "[System.IO.File]::WriteAllText($p,$t,[System.Text.UTF8Encoding]::new($false))"
    );
    let output = run_powershell(
        script,
        Some(("CNC_CLIP_FILE", path.to_str().unwrap_or(""))),
    );
    if !output.status.success() {
        panic!(
            "读剪贴板失败: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    text
}

/// 往**系统剪贴板**里写一段文字（先写一个哨兵，
/// 这样「什么都没发生」和「写成了明文」能区分开）。
fn set_clipboard(text: &str) {
    let path = std::env::temp_dir().join(format!("cnc-clip-set-{}.txt", std::process::id()));
    std::fs::write(&path, text.as_bytes()).expect("应该写得下临时文件");
    let script = concat!(
        "$ErrorActionPreference='Stop'; ",
        "$p=$env:CNC_CLIP_FILE; ",
        "$t=[System.IO.File]::ReadAllText($p,[System.Text.Encoding]::UTF8); ",
        "Set-Clipboard -Value $t"
    );
    let output = run_powershell(
        script,
        Some(("CNC_CLIP_FILE", path.to_str().unwrap_or(""))),
    );
    let _ = std::fs::remove_file(&path);
    assert!(
        output.status.success(),
        "写剪贴板失败: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// 合成按键序列（**真实按键**，不是 `commands:['copy']` ——
/// 后者在 Windows 上**不触发** DOM copy 事件，2026-10-26 实测过）。
fn ctrl_c_keys() -> Vec<Value> {
    vec![
        json!({ "type": "rawKeyDown", "key": "Control", "code": "ControlLeft",
                "windowsVirtualKeyCode": 17, "nativeVirtualKeyCode": 17, "modifiers": 2 }),
        json!({ "type": "rawKeyDown", "key": "c", "code": "KeyC",
                "windowsVirtualKeyCode": 67, "nativeVirtualKeyCode": 67, "modifiers": 2 }),
        json!({ "type": "keyUp", "key": "c", "code": "KeyC",
                "windowsVirtualKeyCode": 67, "nativeVirtualKeyCode": 67, "modifiers": 2 }),
        json!({ "type": "keyUp", "key": "Control", "code": "ControlLeft",
                "windowsVirtualKeyCode": 17, "nativeVirtualKeyCode": 17, "modifiers": 0 }),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cdp_copy_repair_end_to_end() {
    let font_path =
        repo_path("src/features/safari-repair/test/fixtures/fonts/obf-same-style.ttf");
    let db_path = repo_path("tauri-app/src-tauri/resources/glyph-db-48.crdb.gz");
    let ttf = std::fs::read(&font_path).expect("应该读得到混淆字体夹具");
    let db = open_db_gz(&db_path).expect("应该读得到字形参考库");

    let port = start_fixture_server(ttf).await;
    let page_url = format!("http://127.0.0.1:{}/", port);

    // ① 生产模块：浏览器（自己的 profile）+ 匹配器 + 协调器。
    let profile_dir =
        std::env::temp_dir().join(format!("cnc-cdp-gate-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&profile_dir);
    let browser = Arc::new(ManagedBrowser::new(profile_dir.clone()));
    let matcher = Arc::new(FastGlyphMatcher::new(db));
    let injection_source = build_injection_source(GUARD_JS, FRAME_BRIDGE_JS);
    let coordinator = Coordinator::new(browser.clone(), matcher, injection_source);

    let cleanup = || {
        let _ = std::fs::remove_dir_all(&profile_dir);
    };

    // ② 起浏览器（生产模块 ManagedBrowser）。
    let client = browser
        .ensure()
        .await
        .expect("应该能起一个 Edge 并连上它的调试端口");

    // ③ 接上 + 注入（生产模块 CdpBridge）。
    let bridge = coordinator
        .ensure_bridge()
        .await
        .expect("应该能挂上 CDP 桥");

    // ④ 先开一个标签页 —— 它模拟「**功能打开之前**就已经开着的页面」。
    //    这种页面的导航在 addScriptToEvaluateOnNewDocument 注册之前就提交了
    //    ⇒ 只能靠协调器的 injectNow 补注入 ⇒ 这一条专门盯它。
    let created_before = client
        .send(
            "Target.createTarget",
            json!({ "url": page_url }),
            None,
        )
        .await
        .expect("应该能开标签页");
    let target_before = created_before
        .get("targetId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // ⑤ 拨开关 → 协调器自己接管（生产路径）。
    coordinator.set_enabled(true);

    // ⑥ 再开一个标签页 —— 它模拟「**功能打开之后**才开的页面」，
    //    走的是 document_start 注入那条路。
    let created_after = client
        .send(
            "Target.createTarget",
            json!({ "url": page_url }),
            None,
        )
        .await
        .expect("应该能开标签页");
    let target_after = created_after
        .get("targetId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 等两个标签页都挂上来、页面都加载完。
    let mut session_before = String::new();
    let mut session_after = String::new();
    for _ in 0..150 {
        for tab in bridge.list_tabs() {
            if tab.target_id == target_before {
                session_before = tab.session_id.clone();
            }
            if tab.target_id == target_after {
                session_after = tab.session_id.clone();
            }
        }
        if !session_before.is_empty() && !session_after.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(!session_before.is_empty(), "夹具页那个标签页没挂上来");
    assert!(!session_after.is_empty(), "第二个标签页没挂上来");

    // 页面必须加载完（否则 selectNodeContents 取不到东西）。
    for session in [&session_before, &session_after] {
        for _ in 0..100 {
            let ready = client
                .send(
                    "Runtime.evaluate",
                    json!({
                        "expression": "document.readyState === 'complete' && !!document.getElementById('target')",
                        "returnByValue": true
                    }),
                    Some(session.as_str()),
                )
                .await
                .unwrap_or(json!({}));
            let ok = ready
                .get("result")
                .and_then(|r| r.get("value"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if ok {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    // 合成按键要送达页面，页面必须「是前台」——
    // CDP 的 Input 事件不会去抢焦点，不开这个开关浏览器会直接忽略按键
    // （产品里不需要：用户是真的用鼠标点着页面的）。
    let _ = client
        .send(
            "Emulation.setFocusEmulationEnabled",
            json!({ "enabled": true }),
            Some(session_before.as_str()),
        )
        .await;

    // ⑦ 守卫装上了吗（document_start 注入 或 injectNow 补注入，二者必居其一）。
    let mut guard_installed = false;
    for _ in 0..100 {
        let r = client
            .send(
                "Runtime.evaluate",
                json!({ "expression": "!!window.__copyRepairGuard", "returnByValue": true }),
                Some(session_before.as_str()),
            )
            .await
            .unwrap_or(json!({}));
        let ok = r
            .get("result")
            .and_then(|x| x.get("value"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if ok {
            guard_installed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        guard_installed,
        "守卫没装上（document_start 注入与 injectNow 补注入都没生效）"
    );

    // ⑧ 选中密文 → 触发守卫采集 → App 侧真字形识别 → 映射下发。
    let _ = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": "(() => { const el = document.getElementById('target'); const s = window.getSelection(); const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); return s.toString(); })()",
                "returnByValue": true
            }),
            Some(session_before.as_str()),
        )
        .await;

    // 走**生产**的那条路：协调器自己扫、自己算映射、自己下发。
    let mut delivered = 0u64;
    for _ in 0..150 {
        let r = client
            .send(
                "Runtime.evaluate",
                json!({
                    "expression": "Object.keys((window.__copyRepairGuard && window.__copyRepairGuard.mappings) || {}).length",
                    "returnByValue": true
                }),
                Some(session_before.as_str()),
            )
            .await
            .unwrap_or(json!({}));
        delivered = r
            .get("result")
            .and_then(|x| x.get("value"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if delivered > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        delivered > 0,
        "映射没下发到页面（作用域没采到，或字形识别没出结果）"
    );

    // ⑨ 合成 Ctrl+C（**真实按键序列** —— commands:['copy'] 在 Windows 上不触发 DOM copy 事件）。
    set_clipboard("SENTINEL-<gate-ignore>");
    tokio::time::sleep(Duration::from_millis(300)).await;
    for key in ctrl_c_keys() {
        client
            .send("Input.dispatchKeyEvent", key, Some(session_before.as_str()))
            .await
            .expect("应该能发按键");
    }
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // ⑩ 剪贴板里必须是明文。
    let clip = read_clipboard();
    assert_eq!(
        clip.trim(),
        PLAINTEXT,
        "剪贴板里不是明文：{:?}",
        clip
    );

    let guard_log = client
        .send(
            "Runtime.evaluate",
            json!({
                "expression": "JSON.stringify((window.__copyRepairGuard && window.__copyRepairGuard.log) || [])",
                "returnByValue": true
            }),
            Some(session_before.as_str()),
        )
        .await
        .unwrap_or(json!({}));
    println!(
        "   守卫日志: {}",
        guard_log
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
    );

    let _ = browser.shutdown().await;
    cleanup();
}
