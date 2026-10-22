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

/// 注入页面守卫（幂等：守卫内部有哨兵，重复注入不会叠加监听器）。
pub fn inject_guard(tab_index: Option<u32>, window_index: Option<u32>, guard_js: &str) -> Result<String, String> {
    let t = target(tab_index, window_index);
    run_js_in(&t, guard_js)
}

/// 把映射表写回页面。
pub fn set_mapping(
    tab_index: Option<u32>,
    window_index: Option<u32>,
    scope_key: &str,
    mapping: &serde_json::Value,
) -> Result<String, String> {
    let t = target(tab_index, window_index);
    let js = format!(
        "(function(){{ if(!window.__copyRepairSetMapping) return 'NO-GUARD'; return window.__copyRepairSetMapping({}, {}); }})()",
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
/// 返回 (标签列表, 原始行数)。
///
/// 原始行数 = 0 说明**连 Safari 的窗口都读不到** —— 那不是"没有目标标签",
/// 而是很可能没有 Apple Events 自动化权限（macOS 对无权限的属性读取会静默
/// 返回空/0）。这两种情况必须分开，否则用户只会看到"什么也没发生"。
pub fn list_tabs() -> Result<(Vec<(u32, u32, String)>, usize), String> {
    let script = r#"tell application "Safari"
      set out to ""
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
    let mut first_error: Option<String> = None;
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
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
    Ok((out, raw_lines))
}

/// Safari 是否在运行(**带错误**)。
///
/// 与 `safari_running()` 的区别:这里把"问不到"(Safari 没开)和
/// "问不了"(没有自动化权限 / Apple Events 被拒)分开 —— 两者都返回 false
/// 的话,用户会以为是 Safari 没运行,其实是没有权限。
pub fn safari_running_checked() -> Result<bool, String> {
    let out = osa_async(
        r#"tell application "System Events" to return (name of processes) contains "Safari""#,
        5,
    )?;
    Ok(out == "true")
}

/// Safari 是否在运行(拿不到就当没运行,只看"在不在"的地方用这个)。
pub fn safari_running() -> bool {
    safari_running_checked().unwrap_or(false)
}

