//! 自己起一个浏览器，并连上它的调试端口。
//!
//! 这是 Electron 线 `src/features/chromium-repair/browser.js` 的 Rust 移植。
//!
//! ## 为什么是「自己起」而不是「接管用户平时那个」
//!
//! Chromium ≥136 对**默认 profile** 直接忽略调试端口与 pipe —— 想接管用户
//! 日常那个浏览器，就得改他的启动方式（那就不是「零点击」了）。
//! 所以本产品**自己起一个浏览器、用自己的 profile**：
//!
//!   - 绑定性满分：那个 profile 只有本程序碰得到，别人换不掉我们的守卫
//!   - 零点击：用户只要点一下开关，浏览器就带着守卫起来了
//!   - 代价：用户得在**这个**窗口里用；首次要扫码登录一次（用户已确认：只需扫码）
//!
//! ## 调试端口的连法
//!
//! - **主路**：问浏览器自己的 `/json/version`，它回 `webSocketDebuggerUrl`
//!   （Electron 线在同一台 CI runner 上就是这么连的，已验证跑通）。
//! - **旁路**：Chromium 自己会把调试端口写进 `<profile>/DevToolsActivePort`
//!   ⇒ 程序重启后能找回**上次那个还在跑的**浏览器，不用再开一个。
//! - **绝不能**加 `--remote-allow-origins=*`：那等于把调试端口对任意网页开放。
//!   `tungstenite` 的握手**不发 Origin 头**，Chromium 天然放行（已实测）。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::chromium::cdp::CdpClient;

/// 浏览器候选：优先 Edge（我们验证过），再退到 Chrome。
const BROWSERS: &[(&str, &str, &[&str])] = &[
    (
        "Edge",
        "Edge",
        &[
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe",
        ],
    ),
    (
        "Chrome",
        "Chrome",
        &[
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
        ],
    ),
];

/// 调试端口起来要多久（毫秒）。
const LAUNCH_TIMEOUT_MS: u64 = 30_000;

/// 问一次 `/json/version` 给多少时间（毫秒）—— 浏览器已经在了就不该久等。
const PROBE_TIMEOUT_MS: u64 = 5_000;

/// 找一台没人占用的本地端口。
fn find_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("找空闲端口失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读空闲端口失败: {}", e))?
        .port();
    drop(listener);
    Ok(port)
}

/// 把 `%VAR%` 展开成真实路径。
///
/// ⚠️ 拼剩下的那段**必须先把开头的分隔符去掉**再 join：
/// Windows 上 `Path::join` 遇到「有根无盘符」的路径（比如 `\Microsoft\Edge\...`）
/// 会**只保留盘符、丢掉前面的目录** ⇒ `%LOCALAPPDATA%` 那条候选路径
/// 会变成 `C:\Microsoft\Edge\Application\msedge.exe` ⇒ **永远找不到**。
fn expand_path(p: &str) -> PathBuf {
    if let Some(start) = p.find('%') {
        if let Some(end) = p[start + 1..].find('%') {
            let name = &p[start + 1..start + 1 + end];
            if let Ok(value) = std::env::var(name) {
                let rest = p[start + end + 2..].trim_start_matches(|c| c == '\\' || c == '/');
                return PathBuf::from(value).join(rest);
            }
        }
    }
    PathBuf::from(p)
}

/// 找出本机装着的浏览器（返回第一个存在的）。
fn find_browser() -> Option<(String, PathBuf)> {
    for (label, _, paths) in BROWSERS {
        for candidate in *paths {
            let full = expand_path(candidate);
            if full.is_file() {
                return Some(((*label).to_string(), full));
            }
        }
    }
    None
}

/// 从 profile 目录里读出上次那个浏览器的调试端口（Chromium 自己写的）。
fn read_port_from_profile(profile_dir: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(profile_dir.join("DevToolsActivePort")).ok()?;
    let first = raw.lines().next()?.trim();
    let port: u32 = first.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(port as u16)
}

/// 从 profile 目录里读出调试端口与 WebSocket 路径。
///
/// Chromium 写的 `DevToolsActivePort` 是两行：
/// ```text
/// 12345
/// /devtools/browser/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
/// ```
fn read_endpoint_from_profile(profile_dir: &Path) -> Option<(u16, String)> {
    let raw = std::fs::read_to_string(profile_dir.join("DevToolsActivePort")).ok()?;
    let mut lines = raw.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next().unwrap_or("").trim().to_string();
    if port == 0 || path.is_empty() {
        return None;
    }
    Some((port, path))
}

/// 在 `buf` 里找子串的位置（找 `\r\n\r\n` 用）。
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 问浏览器一个 HTTP 接口，返回解析好的 JSON。
///
/// 只够读 `/json/version` 那种小 JSON ⇒ 自己写，不引 HTTP 客户端
/// （也就不会拖进 TLS 栈）。
async fn http_get_json(port: u16, path: &str) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| format!("连不上 127.0.0.1:{}: {}", port, e))?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUser-Agent: cnc-cdp\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        path, port
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("写请求失败: {}", e))?;
    let _ = stream.flush().await;

    let mut buf: Vec<u8> = Vec::new();
    let sep = loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos;
        }
        let mut chunk = [0u8; 1024];
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("读响应失败: {}", e))?;
        if n == 0 {
            return Err("响应提前结束".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 4 * 1024 * 1024 {
            return Err("响应太大".into());
        }
    };

    let head = String::from_utf8_lossy(&buf[..sep]).to_string();
    let status = head.lines().next().unwrap_or("").trim().to_string();
    if !status.contains(" 200") {
        return Err(format!("接口回的不是 200: {}", status));
    }

    let body_start = sep + 4;
    let content_length = head
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .next();

    let body = match content_length {
        Some(len) => {
            while buf.len() < body_start + len {
                let mut chunk = [0u8; 4096];
                let n = stream
                    .read(&mut chunk)
                    .await
                    .map_err(|e| format!("读响应体失败: {}", e))?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let end = std::cmp::min(body_start + len, buf.len());
            buf[body_start..end].to_vec()
        }
        None => {
            let mut rest = Vec::new();
            stream
                .read_to_end(&mut rest)
                .await
                .map_err(|e| format!("读响应体失败: {}", e))?;
            let mut all = buf[body_start..].to_vec();
            all.extend_from_slice(&rest);
            all
        }
    };
    serde_json::from_slice::<Value>(&body).map_err(|e| format!("解析 JSON 失败: {}", e))
}

/// 等浏览器的调试端口起来，返回**完整的 WebSocket 地址**。
///
/// - 主路：`/json/version` 的 `webSocketDebuggerUrl`（Electron 线已验证）。
/// - 旁路：`DevToolsActivePort` 文件（Chromium 自己写的）。
async fn wait_for_endpoint(
    profile_dir: &Path,
    port: u16,
    timeout_ms: u64,
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(
            Duration::from_millis(PROBE_TIMEOUT_MS),
            http_get_json(port, "/json/version"),
        )
        .await
        {
            Ok(Ok(value)) => {
                if let Some(url) = value.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                    if !url.is_empty() {
                        return Ok(url.to_string());
                    }
                }
                last = format!("/json/version 里没有 webSocketDebuggerUrl: {}", value);
            }
            Ok(Err(e)) => last = e,
            Err(_) => last = "问 /json/version 超时".to_string(),
        }

        // 旁路：Chromium 自己写的那个文件。
        if let Some((file_port, path)) = read_endpoint_from_profile(profile_dir) {
            return Ok(format!("ws://127.0.0.1:{}{}", file_port, path));
        }

        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!(
        "浏览器调试端口没起来（127.0.0.1:{}）：{}",
        port, last
    ))
}

/// 读一个文件的尾部（诊断用）。
fn tail_of(path: &Path, max_bytes: usize) -> String {
    let Ok(raw) = std::fs::read(path) else {
        return String::new();
    };
    let slice = if raw.len() > max_bytes {
        &raw[raw.len() - max_bytes..]
    } else {
        &raw[..]
    };
    String::from_utf8_lossy(slice)
        .replace('\r', "")
        .trim()
        .to_string()
}

/// profile 目录里有什么（诊断用）——
/// 目录是空的 ⇒ 浏览器压根没起来；里面有 `Default/` ⇒ 它起来了、只是端口没通。
fn describe_profile_dir(profile_dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(profile_dir) else {
        return format!("profile 目录读不了: {}", profile_dir.display());
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    let shown: Vec<&str> = names.iter().take(40).map(|s| s.as_str()).collect();
    format!("profile 目录里有: {}", shown.join(", "))
}

/// 浏览器进程还在不在（诊断用）。
fn describe_process(child: &mut Child) -> String {
    match child.try_wait() {
        Ok(Some(status)) => format!("浏览器进程已经退出（{}）", status),
        Ok(None) => "浏览器进程还活着".to_string(),
        Err(e) => format!("查浏览器进程状态失败: {}", e),
    }
}

/// 自己起的那台浏览器。
pub struct ManagedBrowser {
    profile_dir: PathBuf,
    inner: Mutex<Option<BrowserHandle>>,
}

struct BrowserHandle {
    client: Arc<CdpClient>,
    /// 是不是**本程序**起的（别人起的我们不关）。
    started_by_us: bool,
    port: u16,
    label: String,
    child: Option<Child>,
}

impl ManagedBrowser {
    /// 新建一个「自己起的浏览器」的管理者。
    pub fn new(profile_dir: PathBuf) -> Self {
        ManagedBrowser {
            profile_dir,
            inner: Mutex::new(None),
        }
    }

    /// profile 目录在哪。
    pub fn profile_dir(&self) -> &Path {
        &self.profile_dir
    }

    /// 确保有一台可用的浏览器，返回 CDP 客户端。
    pub async fn ensure(&self) -> Result<Arc<CdpClient>, String> {
        let mut guard = self.inner.lock().await;
        if let Some(handle) = guard.as_ref() {
            if !handle.client.is_closed() {
                return Ok(handle.client.clone());
            }
        }

        // 1) 先试上次那个还在跑的（程序重启、浏览器没关）。
        if let Some(client) = try_attach(&self.profile_dir).await {
            let label = "浏览器".to_string();
            let port = read_port_from_profile(&self.profile_dir).unwrap_or(0);
            *guard = Some(BrowserHandle {
                client: client.clone(),
                started_by_us: false,
                port,
                label,
                child: None,
            });
            return Ok(client);
        }

        // 2) 没有就自己起一个。
        self.launch(&mut guard).await
    }

    /// 浏览器还在吗（连接没断）。
    pub async fn is_running(&self) -> bool {
        let guard = self.inner.lock().await;
        match guard.as_ref() {
            Some(handle) => !handle.client.is_closed(),
            None => false,
        }
    }

    /// 浏览器叫什么（Edge / Chrome）。
    pub async fn browser_label(&self) -> String {
        let guard = self.inner.lock().await;
        guard
            .as_ref()
            .map(|h| h.label.clone())
            .unwrap_or_else(|| "浏览器".to_string())
    }

    /// 启动浏览器并连上。
    async fn launch(&self, guard: &mut Option<BrowserHandle>) -> Result<Arc<CdpClient>, String> {
        let Some((label, executable)) = find_browser() else {
            return Err("找不到 Edge 或 Chrome（本机没装，或装在了没覆盖到的位置）".into());
        };
        std::fs::create_dir_all(&self.profile_dir)
            .map_err(|e| format!("建浏览器 profile 目录失败: {}", e))?;

        // 上次那份 DevToolsActivePort 是**旧的**（浏览器已经不在了）⇒ 删掉，
        // 否则会一直读到上次的端口。
        let _ = std::fs::remove_file(self.profile_dir.join("DevToolsActivePort"));

        let port = find_free_port()?;
        let args: Vec<String> = vec![
            format!("--remote-debugging-port={}", port),
            format!("--user-data-dir={}", self.profile_dir.display()),
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
            "--no-default-apps".to_string(),
            "--restore-last-session".to_string(),
            "about:blank".to_string(),
        ];

        // 浏览器自己的输出落盘 —— 起不来时要能看出它到底出了什么事。
        let stdout_path = self.profile_dir.join("browser-stdout.log");
        let stderr_path = self.profile_dir.join("browser-stderr.log");
        let stdout_file = std::fs::File::create(&stdout_path).ok();
        let stderr_file = std::fs::File::create(&stderr_path).ok();

        // ⚠️ **绝不能**加 `--remote-allow-origins=*` ——
        // 那等于把调试端口对**任意网页**开放，谁都能连上来操控用户的浏览器。
        let mut command = Command::new(&executable);
        command.args(&args);
        command.stdin(Stdio::null());
        command.stdout(match stdout_file {
            Some(file) => Stdio::from(file),
            None => Stdio::null(),
        });
        command.stderr(match stderr_file {
            Some(file) => Stdio::from(file),
            None => Stdio::null(),
        });
        // 让浏览器**脱离本进程的控制台**（程序退出后它继续开着，那是用户的窗口了）。
        // ⚠️ 这组标志与 Node 的 `detached: true` 对齐（libuv 用的就是
        // `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`）—— Electron 线在 CI 上
        // 正是这么起浏览器、跑通整条链路的。
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动 {} 失败: {}", label, e))?;

        let url = match wait_for_endpoint(&self.profile_dir, port, LAUNCH_TIMEOUT_MS).await {
            Ok(url) => url,
            Err(e) => {
                let process = describe_process(&mut child);
                let _ = child.kill();
                return Err(format!(
                    "{}；{}；stderr 尾部: {}；{}",
                    e,
                    process,
                    tail_of(&stderr_path, 2000),
                    describe_profile_dir(&self.profile_dir)
                ));
            }
        };
        let client = match CdpClient::connect(&url).await {
            Ok(client) => client,
            Err(e) => {
                let _ = child.kill();
                return Err(format!("{}（{}）", e, url));
            }
        };

        *guard = Some(BrowserHandle {
            client: client.clone(),
            started_by_us: true,
            port,
            label,
            child: Some(child),
        });
        Ok(client)
    }

    /// 关掉连接（**不关浏览器** —— 那是用户的窗口了）。
    pub async fn disconnect(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(handle) = guard.as_mut() {
            handle.client.close();
        }
        *guard = None;
    }

    /// 把**自己起的**那台浏览器关掉（只在明确要求时调用）。
    pub async fn shutdown(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(handle) = guard.as_mut() {
            if handle.started_by_us {
                let _ = handle
                    .client
                    .send("Browser.close".into(), serde_json::json!({}), None)
                    .await;
                if let Some(mut child) = handle.child.take() {
                    let _ = child.kill();
                }
            }
            handle.client.close();
        }
        *guard = None;
    }
}

/// 试着连上「已经开着的那台」；连不上返回 `None`。
///
/// 端口从 profile 目录里的 `DevToolsActivePort` 读（Chromium 自己写的，
/// 不会过期：浏览器重启会把它重写），再问它自己的 `/json/version`
/// 拿 WebSocket 地址。
async fn try_attach(profile_dir: &Path) -> Option<Arc<CdpClient>> {
    let (port, _) = read_endpoint_from_profile(profile_dir)?;
    let url = wait_for_endpoint(profile_dir, port, 1500).await.ok()?;
    match CdpClient::connect(&url).await {
        Ok(client) => Some(client),
        Err(_) => None,
    }
}
