//! Safari 自动化桥：通过 Apple Events 控制 Safari、执行页面 JavaScript。
//!
//! 这是 `src/features/safari-repair/bridge.js` 的 Rust 移植。
//! 四个坑（都是本机实测踩出来的，移植时必须原样保留）：
//!  1. AppleScript 读文件按**系统本地编码**解码（中文区域 = GBK），
//!     注入的 JS 里的中文会变乱码 → 注入内容一律 ASCII 化（非 ASCII 转 \uXXXX）。
//!  2. JS 不要内联进 AppleScript 字符串 → 一律走临时文件。
//!  3. **必须异步**：osascript 启动 + 执行要 50~150ms。
//!  4. 返回值里的中文同样会被本地编码破坏 → 返回也做 ASCII 化。

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

static TMP_SEQ: AtomicU32 = AtomicU32::new(0);

/// 把 JS 源码里的非 ASCII 字符转成 \uXXXX 转义（保证注入内容是纯 ASCII）。
pub fn to_ascii_js(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    for ch in source.chars() {
        if (ch as u32) < 0x80 {
            out.push(ch);
        } else {
            out.push_str(&format!("\\u{:04x}", ch as u32));
        }
    }
    out
}

/// 异步执行一段 AppleScript，返回 stdout（trim）。
///
/// **超时是真的会生效的**：macOS 弹「想要控制 Safari」时，osascript 会一直
/// 阻塞等用户点按。不设超时的话，调用线程（轮询线程）会被永久挂死，
/// 表现就是"这个功能从此一直失效"。
pub fn osa_async(script: &str, timeout_secs: u64) -> Result<String, String> {
    let mut child = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("osascript 启动失败: {}", e))?;

    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_secs(timeout_secs.max(1));
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = child.wait_with_output().ok();
                let stdout = out
                    .as_ref()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default();
                if !status.success() {
                    let stderr = out
                        .as_ref()
                        .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
                        .unwrap_or_default();
                    return Err(if stderr.is_empty() {
                        format!("AppleScript 执行失败（status {:?}）", status.code())
                    } else {
                        stderr
                    });
                }
                return Ok(stdout);
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let waited = started.elapsed().as_secs_f64();
                    return Err(format!(
                        "AppleScript 超时（等了 {:.1} 秒还没返回）。可能是这一页正忙、也可能是 macOS 在等「允许控制 Safari」",
                        waited
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待 osascript 失败: {}", e)),
        }
    }
}

/// 在目标位置执行一段 JS（走临时文件，避免 AppleScript 的引号/换行/编码问题）。
pub fn run_js_in(target: &str, js: &str) -> Result<String, String> {
    let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
    let file: PathBuf = std::env::temp_dir().join(format!("cnc-sr-{}-{}.js", std::process::id(), seq));
    std::fs::write(&file, to_ascii_js(js)).map_err(|e| format!("写临时文件失败: {}", e))?;
    let script = format!(
        "tell application \"Safari\"\n  set jsCode to (read POSIX file \"{}\") as «class utf8»\n  do JavaScript jsCode in {}\nend tell",
        file.display(),
        target
    );
    // 注入守卫 / 下发映射都可能真的需要十几秒(页面在忙),超时给够
    let result = osa_async(&script, 30);
    let _ = std::fs::remove_file(&file);
    result
}

/// Safari 里的目标位置描述。
pub fn target(tab_index: Option<u32>, window_index: Option<u32>) -> String {
    let win = match window_index {
        Some(w) => format!("window {}", w),
        None => "front window".to_string(),
    };
    match tab_index {
        Some(t) => format!("tab {} of {}", t, win),
        None => format!("front tab of {}", win),
    }
}

/// 一轮状态采集：**一次 Apple Event 拿到全部信息**。
///
/// 返回 `{ guard, pending, frames, unrepaired, collect, url }`。
pub fn poll_state(tab_index: Option<u32>, window_index: Option<u32>) -> Result<serde_json::Value, String> {
    let t = target(tab_index, window_index);
    let js = r#"(function(){
      var g = window.__copyRepairGuard;
      var out = {
        guard: !!g,
        pending: null,
        collect: 'none',
        frames: [],
        unrepaired: [],
        url: String(location.href || ''),
      };
      if (g) {
        if (window.__copyRepairCollect) {
          try { out.collect = String(window.__copyRepairCollect()); } catch (e) { out.collect = 'error'; }
        }
        if (g.pending && g.pending.groups && g.pending.groups.length > 0) {
          out.pending = { groups: g.pending.groups };
          g.pending = null;
        }
        if (window.__copyRepairBridge && typeof window.__copyRepairBridge.take === 'function') {
          try {
            var taken = window.__copyRepairBridge.take();
            out.frames = taken.pending || [];
            out.unrepaired = taken.unrepaired || [];
          } catch (e) { out.frames = []; out.unrepaired = []; }
        }
      }
      return JSON.stringify(out).replace(/[^\x00-\x7F]/g, function (c) {
        return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      });
    })()"#;
    let raw = run_js_in(&t, js)?;
    serde_json::from_str(&raw).map_err(|e| format!("解析 pollState 失败: {}", e))
}

/// 拼出「注入守卫 + 注入 iframe 桥」这一段脚本（**纯函数**，便于测试）。
///
/// ## 守卫源码必须先做 JSON 字符串编码，再嵌进 JS 字面量
///
/// 守卫源码里全是 `"` 和 `\`（它本身是一份 JS 文件）。
/// 直接把它塞进 `{ guardSource: "..." }` 的字面量里，第一个引号就把字符串
/// 提前闭合 —— **整段脚本变成 JavaScript 语法错误**，
/// `do JavaScript` 整段失败，守卫一次都装不上。
///
/// 而这个错误当时是被 `let _ =` 吞掉的，界面只显示「已开启」，
/// 表现就是"功能开着但什么也不发生"（真机实测：18 个标签一个都没装上守卫）。
///
/// Electron 版用的是 `JSON.stringify(...)`，这里用 serde_json 做**同一件事**
/// —— 两边的注入脚本必须逐字同口径。
pub fn build_inject_script(guard_js: &str, frame_bridge_js: &str) -> String {
    // 先把非 ASCII 转成 \uXXXX（AppleScript 按本地编码解码，不能有非 ASCII），
    // 再用 JSON 字符串编码转义引号/反斜杠 —— 顺序不能反。
    let guard_literal = serde_json::to_string(&to_ascii_js(guard_js))
        .unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "{}\n;\n{}\n;\ntry {{ window.__copyRepairInstallFrameBridge({{ guardSource: {} }}); }} catch (e) {{ window.__copyRepairInjectError = String(e); }}",
        guard_js,
        frame_bridge_js,
        guard_literal
    )
}

/// 注入页面守卫（幂等：守卫内部有哨兵，重复注入不会叠加监听器）。
///
/// **同时注入 iframe 桥**（与 Electron 版 `bridge.injectGuard` 同口径）：
/// 目标站点把题目放在同源 iframe 里，不装桥的话 iframe 里既没有守卫、
/// 收不到上报，映射也发不进去。
pub fn inject_guard(
    tab_index: Option<u32>,
    window_index: Option<u32>,
    guard_js: &str,
    frame_bridge_js: &str,
) -> Result<String, String> {
    let t = target(tab_index, window_index);
    let combined = build_inject_script(guard_js, frame_bridge_js);
    run_js_in(&t, &combined)
}

/// 把映射表写回页面（按作用域隔离，并**分发到同源 iframe**）。
pub fn set_mapping(
    tab_index: Option<u32>,
    window_index: Option<u32>,
    scope_key: &str,
    mapping: &serde_json::Value,
) -> Result<String, String> {
    let t = target(tab_index, window_index);
    // 有 iframe 桥就交给它分发到所有同源 frame；没有才回落到顶层守卫。
    // （Electron 版 bridge.setMapping 同口径）
    let js = format!(
        "(function(){{
          var b = window.__copyRepairBridge;
          if (b && typeof b.setMapping === 'function') return 'FRAMES:' + b.setMapping({}, {});
          var g = window.__copyRepairGuard;
          if (!g) return 'NO-GUARD';
          if (!window.__copyRepairSetMapping) return 'NO-API';
          return window.__copyRepairSetMapping({}, {});
        }})()",
        serde_json::to_string(scope_key).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(mapping).unwrap_or_else(|_| "{}".into()),
        serde_json::to_string(scope_key).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(mapping).unwrap_or_else(|_| "{}".into())
    );
    run_js_in(&t, &js)
}

/// 列出所有窗口所有标签的 URL（一次 Apple Event）。
///
/// **分隔符必须是 `ASCII character 9`（真制表符）**：
/// AppleScript 里写 `& tab &` 会被当成**字面量字符串 "tab"**，
/// 于是下游按 '\t' 切分一条都切不出来 → 表现成"没有标签"。
/// （Electron 版用的是 "|" 分隔，所以一直没踩这个坑。）
///
/// 逐个标签的读取错误**不再被 try 吞掉**，而是写进返回值里
/// （形如 `ERR:-1743:Not authorized to send Apple events to Safari`）——
/// 吞掉的话，权限问题会表现成"标签列表是空的"，完全看不出原因。
/// 返回 (标签列表, 原始行数, 前台标签)。
///
/// 原始行数 = 0 说明**连 Safari 的窗口都读不到** —— 那不是"没有目标标签",
/// 而是很可能没有 Apple Events 自动化权限（macOS 对无权限的属性读取会静默
/// 返回空/0）。这两种情况必须分开，否则用户只会看到"什么也没发生"。
pub fn list_tabs() -> Result<(Vec<(u32, u32, String)>, usize, Option<(u32, u32)>), String> {
    let script = r#"tell application "Safari"
      set out to ""
      try
        set frontW to (index of front window) as text
        set frontT to (index of front tab of front window) as text
      on error
        set frontW to "0"
        set frontT to "0"
      end try
      set out to out & "FRONT" & (ASCII character 9) & frontW & (ASCII character 9) & frontT & linefeed
      repeat with wi from 1 to (count of windows)
        repeat with ti from 1 to (count of tabs of window wi)
          try
            set tabUrl to (URL of tab ti of window wi) as text
            set out to out & (wi as text) & (ASCII character 9) & (ti as text) & (ASCII character 9) & tabUrl & linefeed
          on error errMsg number errNum
            set out to out & (wi as text) & (ASCII character 9) & (ti as text) & (ASCII character 9) & "ERR:" & errNum & ":" & errMsg & linefeed
          end try
        end repeat
      end repeat
      return out
    end tell"#;
    let raw = osa_async(script, 8)?;
    let mut out = Vec::new();
    let mut front: Option<(u32, u32)> = None;
    let mut first_error: Option<String> = None;
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            if parts[0] == "FRONT" {
                // 前台窗口/前台标签 —— 与 Electron 版同口径:
                // 前台标签**每轮都处理**(不只目标站点),
                // 这样"在别的网站上用了混淆字体"也能还原。
                if let (Ok(w), Ok(t)) = (parts[1].parse::<u32>(), parts[2].parse::<u32>()) {
                    if w > 0 && t > 0 {
                        front = Some((w, t));
                    }
                }
                continue;
            }
            if let (Ok(w), Ok(t)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                if parts[2].starts_with("ERR:") && first_error.is_none() {
                    first_error = Some(parts[2].to_string());
                }
                out.push((w, t, parts[2].to_string()));
            }
        }
    }
    let raw_lines = raw.lines().filter(|l| !l.trim().is_empty()).count();
    if out.is_empty() {
        if let Some(err) = first_error {
            return Err(err);
        }
    }
    Ok((out, raw_lines, front))
}

/// 判活查询用的 AppleScript(提成常量:便于测试钉死口径,也便于复查)。
///
/// **不许改回 `tell application "System Events" …`** —— 那要另一份自动化授权,
/// 用户从没被提示过 → 查不到 → 被判成"Safari 未运行" → 功能静默停掉。
/// `application "Safari" is running` 不需要任何授权,也不会把 Safari 拉起来。
const SAFARI_RUNNING_PROBE: &str = r#"application "Safari" is running"#;

/// Safari 是否在运行(**带错误**)。
///
/// ## 不要再用 System Events 问（Electron 版用的是它）
///
/// System Events 的进程列表需要**另一份**自动化授权("自动化 → System Events")。
/// 用户从来没被提示过这份授权 —— 查询拿不到结果,而老口径把"问不到"当成
/// "没运行" → **整个功能静默停掉**:界面显示"已开启",实际一个标签都不处理。
///
/// 2026-10-23 真机故障就是这个:App 一直报"Safari 未运行"、
/// `lastProbe` 全空(一次都没成功读到过标签),而 Safari 明明开着 19 个标签。
///
/// 改用 `application "Safari" is running`:
/// - **不需要任何额外授权**(AppleScript 自己查进程表);
/// - **不会把 Safari 拉起来**（问 Safari 自己才会启动它；`is running` 只查状态）;
/// - 问不到时按"在跑"处理（与 Electron 版同口径）——
///   **问不到 ≠ 没运行**,不能因此把整个功能停掉。
pub fn safari_running_checked() -> Result<bool, String> {
    match osa_async(SAFARI_RUNNING_PROBE, 5) {
        Ok(out) => {
            let running = out.trim() == "true";
            set_running_probe(&format!("`application \"Safari\" is running` → {}", out.trim()));
            Ok(running)
        }
        Err(e) => {
            // 问不到 ≠ 没运行:按"在跑"处理(与 Electron 版同口径),
            // 真正的错误由紧随其后的 list_tabs 报出来(那里才有 -1743 这种准确原因)。
            set_running_probe(&format!("查询失败: {}", e));
            Ok(true)
        }
    }
}

/// 最近一次判活查询的原始结果(诊断用)。
pub fn safari_running_probe() -> String {
    RUNNING_PROBE
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

static RUNNING_PROBE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

fn set_running_probe(text: &str) {
    if let Ok(mut slot) = RUNNING_PROBE.lock() {
        *slot = text.to_string();
    }
}

/// Safari 是否在运行(拿不到就当在运行,只看"在不在"的地方用这个)。
pub fn safari_running() -> bool {
    safari_running_checked().unwrap_or(true)
}

// ── 回归测试 ─────────────────────────────────────────
//
// 盯的是**注入脚本本身能不能被 JS 解析**。
//
// 真机故障:守卫源码被原样塞进 JS 字符串字面量,第一个引号就把字面量提前闭合,
// 整段脚本变成语法错误 → `do JavaScript` 整段失败 → 守卫一次都装不上 →
// 界面显示"已开启"却什么也不发生(而且错误当时还被吞掉了)。
//
// 这组测试就是"别再断第二次"的护栏。

#[cfg(test)]
mod tests {
    use super::*;

    /// 从脚本里把 `guardSource:` 后面的那个 JS 字符串字面量**完整抠出来**（含首尾引号）。
    ///
    /// 不能用 `rfind(" }")` 之类的办法 —— 守卫源码本身就含 ` }`，
    /// 会抠到后面去。这里按"未被转义的引号才是结尾"来扫，和 JSON 的规则一致。
    fn extract_guard_literal(script: &str) -> String {
        let start = script
            .find("guardSource: ")
            .expect("脚本里必须有 guardSource:")
            + "guardSource: ".len();
        let bytes = script.as_bytes();
        assert_eq!(bytes[start], b'"', "字面量必须以引号开头");
        let mut i = start + 1;
        let mut escaped = false;
        while i < bytes.len() {
            let c = bytes[i];
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                return script[start..=i].to_string();
            }
            i += 1;
        }
        panic!("字面量没有结束引号");
    }

    /// 注入脚本里的守卫源码必须是**合法字符串字面量**（能被 JSON 解析回来）。
    ///
    /// 这条等价于"嵌进 JS 里不会把语法搞崩"，因为 JSON 字符串就是合法 JS 字符串。
    #[test]
    fn 注入脚本里的守卫源码是合法字符串字面量() {
        // 故意用带引号/反斜杠/中文的源码 —— 真实守卫文件就是这样的。
        let guard = r#"var a = "x"; var b = 'y'; var c = "中文字符"; // 反斜杠 \ 和引号 \""#;
        let script = build_inject_script(guard, "");
        let literal = extract_guard_literal(&script);

        let back: String = serde_json::from_str(&literal)
            .unwrap_or_else(|e| panic!("守卫源码字面量必须是合法 JSON 字符串: {}", e));
        assert_eq!(back, to_ascii_js(guard));
    }

    /// 真实守卫文件（仓库里那份）也必须过这一关。
    ///
    /// 用仓库里真实的那份，而不是造一个短的 —— 真实文件里才有大量引号。
    #[test]
    fn 真实守卫文件能拼出合法字面量() {
        let guard = include_str!("../../resources/page-guard.js");
        let frame = include_str!("../../resources/frame-bridge.js");
        let script = build_inject_script(guard, frame);
        let literal = extract_guard_literal(&script);

        let back: String = serde_json::from_str(&literal)
            .unwrap_or_else(|e| panic!("真实守卫源码的字面量必须是合法 JSON 字符串: {}", e));
        assert_eq!(back, to_ascii_js(guard));

        // 字面量里不能残留未转义的引号 —— 那正是当初把整段脚本搞崩的东西。
        let inner = &literal[1..literal.len() - 1];
        let mut escaped = false;
        for ch in inner.chars() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            assert_ne!(ch, '"', "守卫源码里的引号必须转义，否则整段脚本是语法错误");
        }
    }

    /// 非 ASCII 必须已经被转成 \uXXXX（AppleScript 按本地编码解码，中文会变乱码）。
    #[test]
    fn 注入脚本里没有非ascii字符() {
        let guard = "中文注释 with english";
        let script = build_inject_script(guard, "");
        // `run_js_in` 写临时文件前会对**整段脚本**做 to_ascii_js，
        // 所以断言的是最终真正写出去的那一份。
        assert!(to_ascii_js(&script).is_ascii(), "注入脚本必须是纯 ASCII");
    }

    /// 判活查询**不许用 System Events**。
    ///
    /// System Events 的进程列表要另一份自动化授权("自动化 → System Events"),
    /// 用户从来没被提示过这份授权 → 查不到 → 被判成"Safari 未运行" →
    /// 整个功能静默停掉(2026-10-23 真机故障:App 一直报"Safari 未运行",
    /// `lastProbe` 全空,一次都没处理过任何标签,而 Safari 明明开着 19 个标签)。
    ///
    /// `application "Safari" is running` 不需要任何授权,也不会把 Safari 拉起来。
    #[test]
    fn 判活查询不依赖SystemEvents() {
        assert!(
            !SAFARI_RUNNING_PROBE.contains("System Events"),
            "判活查询不许再问 System Events:它要另一份自动化授权,用户从没被提示过"
        );
        assert!(
            SAFARI_RUNNING_PROBE.contains("is running"),
            "判活查询必须是 `application \"Safari\" is running`(只查状态,不启动 Safari)"
        );
        assert!(
            !SAFARI_RUNNING_PROBE.contains("tell application"),
            "不能 `tell application \"Safari\"` —— 那会把 Safari 拉起来"
        );
    }

    /// **用真的 JS 解析器校验真实产物**（node 在就跑，不在就明说跳过）。
    ///
    /// 前面的测试只能证明"字面量是合法 JSON 字符串"，
    /// 这一条直接把拼出来的整段脚本丢给 JS 引擎解析 ——
    /// 当初那个把功能整个废掉的语法错误，就是这样才被抓住的。
    #[test]
    fn 真实注入脚本能被javascript解析() {
        let node = match std::process::Command::new("node")
            .arg("--version")
            .output()
        {
            Ok(o) if o.status.success() => "node",
            _ => {
                eprintln!("[跳过] 这台机器上没有 node，无法用 JS 解析器校验注入脚本");
                return;
            }
        };
        let guard = include_str!("../../resources/page-guard.js");
        let frame = include_str!("../../resources/frame-bridge.js");
        let script = build_inject_script(guard, frame);

        let path = std::env::temp_dir().join(format!("cnc-inject-check-{}.js", std::process::id()));
        std::fs::write(&path, &script).expect("写临时文件失败");
        let out = std::process::Command::new(node)
            .arg("--check")
            .arg(&path)
            .output()
            .expect("跑 node --check 失败");
        let _ = std::fs::remove_file(&path);
        assert!(
            out.status.success(),
            "注入脚本必须是合法 JavaScript:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

