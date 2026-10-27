//! 门禁：浏览器连不上时**绝不能**疯狂重开 Edge。
//!
//! ## 它盯的是什么（2026-10-27 真机踩出来的 bug）
//!
//! 现象：用户窗口里 Edge 一个一个弹出来（每 29 秒一个空白标签页），
//! 而且**再也没连回那个一直在跑的 Edge** ⇒ 新标签页没守卫、
//! 网页上复制出来还是密文。
//!
//! 根因链：
//!   1. CDP 的浏览器级 WebSocket 断了；
//!   2. 恢复流程只认 Chromium 自己写的 `DevToolsActivePort` 文件；
//!   3. 但**同 profile 的第二个浏览器是「转发启动」**（Chromium 单例）：
//!      它不开自己的调试端口，退出时还会把 `DevToolsActivePort` **删掉**；
//!   4. ⇒ 恢复流程永远找不到「上次那个还在跑的浏览器」⇒ 无限重开。
//!
//! ## 两条断言
//!
//!   ① **源码层**：恢复的顺序必须是「自己记的端口 → DevToolsActivePort →
//!      扫进程命令行 → 才允许起新的」。
//!   ② **真跑一遍**：起一个真的 Edge → 把连接关掉 → 把 DevToolsActivePort
//!      删掉 → 再 ensure() 一次
//!      ⇒ 必须**连回同一个浏览器**（端口不变、那个 profile 下只有一个浏览器进程）。
//!
//! ## 跑法
//!
//!   cd tauri-app/src-tauri && cargo test --test cdp_browser_recovery -- --nocapture
//!
//! 只在 Windows 上跑（其它平台整个文件被 cfg 掉）。
#![cfg(target_os = "windows")]

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use simuinput_tauri::chromium::browser::ManagedBrowser;

/// 扫进程列表，数一下「用这个 profile 的浏览器」有几个（顺带把 pid / 端口列出来）。
///
/// 只看**没有** `--type=` 的那些 —— Chromium 的渲染进程/工具进程都带 `--type=`，
/// 只有浏览器主进程才是我们要数的那一个。
fn browsers_for_profile(profile_dir: &PathBuf) -> Vec<(u32, u16)> {
    let script = r#"
$p = $env:CR_PROFILE
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object {
    $port = 0
    if ($_.CommandLine -match '--remote-debugging-port=(\d+)') { $port = $Matches[1] }
    "$($_.ProcessId) $port"
  }
"#;
    let mut command = std::process::Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    command.env("CR_PROFILE", profile_dir);
    let Ok(output) = command.output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .filter_map(|line| {
            let mut parts = line.trim().split_whitespace();
            let pid: u32 = parts.next()?.parse().ok()?;
            let port: u16 = parts.next().unwrap_or("0").parse().unwrap_or(0);
            Some((pid, port))
        })
        .collect()
}

#[test]
fn source_level_recovery_order_is_find_first_launch_last() {
    let source = include_str!("../src/chromium/browser.rs");

    assert!(
        source.contains("read_remembered_port"),
        "browser.rs 缺少 read_remembered_port（自己记的端口）"
    );
    assert!(
        source.contains("remember_port"),
        "browser.rs 缺少 remember_port（记住我们起的那个端口）"
    );
    assert!(
        source.contains("find_running_ports"),
        "browser.rs 缺少 find_running_ports（扫进程命令行兜底）"
    );

    // ensure() 里的顺序：三个候选都在 launch() **之前**
    let Some(ensure_start) = source.find("pub async fn ensure(") else {
        panic!("browser.rs 里找不到 ensure()");
    };
    let Some(ensure_end) = source[ensure_start..].find("async fn launch(") else {
        panic!("browser.rs 里找不到 ensure() 的结尾");
    };
    let ensure = &source[ensure_start..ensure_start + ensure_end];

    let i_remembered = ensure.find("read_remembered_port");
    let i_devtools = ensure.find("read_endpoint_from_profile");
    let i_scan = ensure.find("find_running_ports");
    let i_launch = ensure.find("self.launch(");

    assert!(i_remembered.is_some(), "ensure() 里没有试「自己记的端口」");
    assert!(i_devtools.is_some(), "ensure() 里没有试 DevToolsActivePort");
    assert!(i_scan.is_some(), "ensure() 里没有扫进程命令行");
    assert!(i_launch.is_some(), "ensure() 里没有 launch()");
    assert!(
        i_launch > i_remembered && i_launch > i_devtools && i_launch > i_scan,
        "ensure() 必须**先找、最后才起**新的浏览器（同 profile 的第二个是「转发启动」，起了等于白起）"
    );
}

/// 「反反复复拉起浏览器」那六个坑的源码层断言（2026-10-27 真机带出来的）。
#[test]
fn source_level_no_more_relaunch_loop() {
    let source = include_str!("../src/chromium/browser.rs");
    let coord = include_str!("../src/chromium/coordinator.rs");

    // ① 扫进程**不能**在 async 里同步做
    //    （早先在 ensure() 里直接 Command::output() ⇒ 把 Tokio 工作线程卡住最多 15 秒）
    assert!(
        source.contains("async fn find_running_ports(profile_dir: PathBuf) -> ProfileBrowsers"),
        "browser.rs 里的 find_running_ports 应该是异步的"
    );
    assert!(
        source.contains("tokio::task::spawn_blocking"),
        "browser.rs 缺少 spawn_blocking（扫进程不能同步阻塞 Tokio 工作线程）"
    );
    assert!(
        source.contains("find_running_ports(self.profile_dir.clone()).await"),
        "ensure() 里没有 await 异步版 find_running_ports"
    );

    // ② 连「已经在跑的浏览器」要快速失败
    assert!(
        source.contains("ATTACH_TIMEOUT_MS"),
        "browser.rs 缺少 ATTACH_TIMEOUT_MS（连已经在跑的浏览器不该等 5 秒）"
    );

    // ③ 起不来要有上限
    assert!(
        source.contains("MAX_LAUNCH_FAILURES"),
        "browser.rs 缺少 MAX_LAUNCH_FAILURES（起不来会无限重试）"
    );

    // ④ 退出码：0 = 用户关掉了窗口；非 0 = 崩了
    //    （本机实测：Browser.close ⇒ code=0；Stop-Process -Force ⇒ code=4294967295）
    assert!(
        source.contains("status.code() == Some(0)"),
        "browser.rs 里没有判「退出码 0 = 用户关掉了窗口」"
    );
    assert!(
        source.contains("refresh_exit_state"),
        "browser.rs 缺少 refresh_exit_state（判断之前要先刷新退出码）"
    );
    assert!(
        coord.contains("refresh_exit_state"),
        "coordinator.rs 判断「要不要重开」之前没有先刷新退出码"
    );

    // ⑤ 用户自己关掉的窗口不再自动弹一个
    assert!(
        coord.contains("auto_reopen"),
        "coordinator.rs 缺少 auto_reopen（用户关掉的窗口不该自动再弹一个）"
    );

    // ⑥ 起浏览器之前**必须再读一次**退出码
    //    （2026-10-27 Electron 线 CI 实测到的 race：判断发生在退出事件之前
    //      ⇒ 明明是用户关掉的，却还是弹了一个。Rust 线用 try_wait() 同步问，
    //      所以必须在 launch 之前**就地**再问一次，不能用 2 秒前读到的旧值。）
    let ensure_block = source
        .split("pub async fn ensure(")
        .nth(1)
        .expect("browser.rs 里找不到 ensure()");
    let reread_at = ensure_block
        .find("prev_child.as_mut()")
        .expect("ensure() 里没有用 prev_child 再读一次退出码");
    let decide_at = ensure_block
        .find("if !auto_reopen && closed_by_user")
        .expect("ensure() 里找不到「要不要弹」的判定");
    let launch_at = ensure_block
        .find("self.launch(")
        .expect("ensure() 里找不到 launch 调用");
    assert!(
        reread_at < decide_at && decide_at < launch_at,
        "退出码必须在判定之前、launch 之前**再读一次**（读 2 秒前的旧值 ⇒ 又会弹一个）"
    );

    // ⑦ **不许恢复上一次会话**（2026-10-27 真机踩过）
    //    `--restore-last-session` ⇒ 每次启动都把上次那堆标签页恢复出来，
    //    而上次那堆里又包含着上上次恢复出来的 ⇒ 标签页越滚越多
    //    （实测：一次启动就恢复出 21 个 `about:blank`）
    //    ⇒ 浏览器越起越慢 ⇒ 判定成「起不来」⇒ 又拉起一个
    //    ⇒ 用户原话：「不断的拉起浏览器，浏览器里面的页面超级多，
    //    而且这个浏览器根本就是无法使用的状态」。
    //    ⚠️ 只查**启动参数那一段**（注释里提到这个标志是解释，不算）。
    //    ⚠️ 按**字符**切，别按字节切 —— 切点很可能落在汉字中间
    //    （2026-10-27 CI 实测：panicked at "end byte index ... is not a char boundary"）。
    let Some(args_at) = source.find("let args: Vec<String> = vec![") else {
        panic!("browser.rs 里找不到启动参数数组");
    };
    let args_block: String = source[args_at..].chars().take(1200).collect();
    let args_code: String = args_block
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !args_code.contains("--restore-last-session"),
        "启动参数里还有 --restore-last-session ⇒ 标签页会越滚越多，浏览器最后没法用"
    );

    // ⑧ **连不上也要算一次失败**
    //    调试端口开了 ≠ WebSocket 连得上（标签页一多，浏览器忙，握手会超时）。
    //    早先这里直接抛，而 launch_failures 在下面才被清成 0 ⇒ 失败次数永远不涨
    //    ⇒ 「起不来上限」形同虚设 ⇒ 每 4 秒重试一次，每次都再拉起一个浏览器。
    let Some(connect_at) = source.find("CdpClient::connect(&url)") else {
        panic!("browser.rs 里找不到 CdpClient::connect(&url)");
    };
    let after_connect: String = source[connect_at..].chars().take(800).collect();
    assert!(
        after_connect.contains("fetch_add(1"),
        "CdpClient::connect 失败没有计入 launch_failures ⇒ 「起不来上限」不生效 ⇒ 会无限拉起浏览器"
    );

    // ⑨ **已经有浏览器在跑 ⇒ 绝不能再起一个**
    //    同 profile 再起一个 = Chromium 的「转发启动」：新进程不开自己的调试端口，
    //    只是给已经在跑的那个**再开一个标签页** ⇒ 页面越积越多。
    assert!(
        source.contains("浏览器已经在跑"),
        "browser.rs 没有「浏览器已经在跑就不许再起」的判定 ⇒ 会不停开新标签页"
    );
    let ensure_block2 = source
        .split("pub async fn ensure(")
        .nth(1)
        .expect("browser.rs 里找不到 ensure()");
    let busy_at = ensure_block2
        .find("浏览器已经在跑")
        .expect("ensure() 里找不到「浏览器已经在跑」的判定");
    let launch_at2 = ensure_block2
        .find("self.launch(")
        .expect("ensure() 里找不到 launch 调用");
    assert!(
        busy_at < launch_at2,
        "「浏览器已经在跑就不许再起」的判定必须在 launch() **之前**"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnects_to_the_same_browser() {
    let profile_dir =
        std::env::temp_dir().join(format!("cnc-cdp-recovery-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&profile_dir);
    let browser = Arc::new(ManagedBrowser::new(profile_dir.clone()));

    let client = browser
        .ensure()
        .await
        .expect("应该能起一个 Edge 并连上它的调试端口");
    let port = browser.port().await;
    assert!(port > 0, "应该记住调试端口");
    println!("   第一次: 端口 {}", port);

    // 模拟真机上同时发生的两件事：
    //   ① CDP 连接断了
    //   ② DevToolsActivePort 被「转发启动」的进程删掉了
    client.close();
    let _ = std::fs::remove_file(profile_dir.join("DevToolsActivePort"));

    let client_again = browser
        .ensure()
        .await
        .expect("恢复失败：ensure() 没拿到客户端");
    let port_again = browser.port().await;
    println!("   第二次: 端口 {}", port_again);
    assert_eq!(
        port_again, port,
        "恢复之后**必须还是同一个浏览器**（端口不该变）—— 变了说明又起了一个"
    );

    let list = browsers_for_profile(&profile_dir);
    assert_eq!(
        list.len(),
        1,
        "这个 profile 下只该有**一个**浏览器进程，实际有 {:?}",
        list
    );

    // 连得上才算数
    let targets = client_again
        .send("Target.getTargets", json!({}), None)
        .await
        .expect("应该能问 Target.getTargets");
    assert!(
        targets.get("targetInfos").and_then(|v| v.as_array()).is_some(),
        "连上了但 Target.getTargets 不对"
    );

    let _ = browser.shutdown().await;
    let _ = std::fs::remove_dir_all(&profile_dir);
}
