//! 全局快捷键触发的两个动作 —— 与 Electron 版 `main.js` 里的
//! `triggerDefaultExecute` / `triggerPinyinFromClipboard` **同口径**。
//!
//! - ⌃⇧A:触发「默认执行」—— 回放选中的录制文件(没选中就回放名字最大的那个)
//! - ⌃⇧D:读剪贴板(或输入框里固定的那段文本)并逐字键入(只有 macOS 有输入源切换这套打法)
//!
//! 走的是**后端**这条路,不是界面上那条:快捷键在界面没打开时也要能用。

use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;

/// 最近若干次快捷键命中的记录(给运行自检看)。
///
/// 为什么要有:**"按了没反应"有好几种完全不同的原因**
/// (系统没把组合键送来 / 送来了但动作失败 / 动作做完了但打进了中文输入法的候选框里),
/// 光看"注册成功"根本分不出来。这里每次命中都记一笔:
/// 命中了哪个键、动作结果是什么、当时系统输入源是谁。
static HITS: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/// 每条命中的自增编号(回填输入源时按编号找回来)。
static HIT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 记一次快捷键命中。
///
/// ⚠️ **这里绝不能同步读输入源。**
///
/// 这个函数会被**事件 tap 的回调线程**(线程名 `cnc-hotkey`)调到 ——
/// 那是"按键被吞掉"的第一现场。两个坑:
/// ① tap 回调里做慢活,系统会直接把这个 tap 关掉(快捷键间歇性失灵);
/// ② 读输入源(Carbon TIS)在那个线程上会**把整个 App 崩掉**
///    (2026-10-23 真机事故:EXC_BREAKPOINT/SIGTRAP,栈底
///    `TSMGetInputSourceProperty` ← `processEventTapData`)。
///
/// 所以:先把命中记下来(输入源那一栏先空着),
/// 再把"读输入源"丢给主线程**异步**做,读完回填。
pub fn record_shortcut_hit(key: &str, outcome: &str) {
    record_shortcut_hit_detail(key, outcome, None)
}

/// 记一次快捷键命中(带诊断信息)。
///
/// `flags` 是那一下按键的事件标志位(只有事件 tap 回调拿得到)——
/// 记下来是为了回答"到底什么样的事件被当成了快捷键"。
pub fn record_shortcut_hit_detail(key: &str, outcome: &str, flags: Option<u64>) {
    let id = push_hit(key, outcome, flags);
    crate::commands::native::run_on_main_thread_detached(move || {
        let label = crate::commands::native::current_input_source_info()
            .map(|info| {
                format!(
                    "{}({})",
                    info.name,
                    if info.is_ascii { "ASCII" } else { "非ASCII" }
                )
            })
            .unwrap_or_else(|e| format!("读不到:{}", e));
        fill_hit_input_source(id, &label);
    });
}

/// 先落一条命中(输入源待回填),返回它的编号。
fn push_hit(key: &str, outcome: &str, flags: Option<u64>) -> u64 {
    let id = HIT_SEQ.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut v) = HITS.lock() {
        v.push(serde_json::json!({
            "id": id,
            "at": crate::commands::app::now_ms(),
            "key": key,
            "outcome": outcome,
            // 事件标志位(十六进制)——只有事件 tap 回调拿得到。
            "flags": flags.map(|f| format!("0x{:x}", f)),
            // 主线程读完输入源后回填这一栏。
            "inputSource": "",
        }));
        if v.len() > 20 {
            let drop = v.len() - 20;
            v.drain(..drop);
        }
    }
    id
}

/// 回填某条命中的输入源(在主线程上跑)。
fn fill_hit_input_source(id: u64, label: &str) {
    if let Ok(mut v) = HITS.lock() {
        for e in v.iter_mut() {
            if e.get("id").and_then(|x| x.as_u64()) == Some(id) {
                if let Some(obj) = e.as_object_mut() {
                    obj.insert("inputSource".to_string(), serde_json::json!(label));
                }
                break;
            }
        }
    }
}

/// 最近 20 次快捷键命中(运行自检用)。
pub fn shortcut_hits() -> Vec<Value> {
    HITS.lock().map(|v| v.clone()).unwrap_or_default()
}

/// ⌃⇧A:触发「默认执行」。
///
/// 口径(Electron 版 `triggerDefaultExecute`):
/// 1. 用设置里选中的录制文件;没选中就取**名字最大的**那个
/// 2. 读文件里的 clicks,按每步自带的 input_text 逐个补字
/// 3. 间隔 0.5 秒
pub fn trigger_default_execute(app: &AppHandle) -> Result<(), String> {
    let settings = crate::commands::app::get_settings(app.clone()).unwrap_or(serde_json::json!({}));
    let mut file_name = settings
        .get("selectedJson")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if file_name.is_empty() {
        let files = crate::commands::app::list_files(app.clone()).unwrap_or_default();
        let mut names: Vec<String> = files
            .iter()
            .filter_map(|f| f.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
            .collect();
        names.sort();
        // 一个录制文件都没有 → 什么都不做(和 Electron 版一样,静默返回)
        match names.pop() {
            Some(n) => file_name = n,
            None => {
                record_shortcut_hit("⌃⇧A", "一个录制文件都没有");
                return Ok(());
            }
        }
    }

    let data = crate::commands::app::read_file(app.clone(), file_name.clone())?
        .ok_or_else(|| format!("读取录制文件失败: {}", file_name))?;
    let clicks: Vec<Value> = data
        .get("clicks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if clicks.is_empty() {
        record_shortcut_hit("⌃⇧A", &format!("{} 里没有可执行的点击", file_name));
        return Ok(());
    }
    let inputs = crate::commands::play::resolve_inputs(&clicks, None);
    // 重入保护在这里生效:上一次回放还没结束时,这次**不重复执行**
    // (2026-10-23 T0 事故:回放互相触发 ⇒ 无限循环 ⇒ 机器卡死)。
    if crate::commands::play::spawn_playback(file_name.clone(), clicks, 0.5, inputs) {
        record_shortcut_hit("⌃⇧A", &format!("开始回放 {}", file_name));
    } else {
        record_shortcut_hit("⌃⇧A", "上一次回放还没结束,这次没有重复执行");
    }
    Ok(())
}

/// ⌃⇧D:读剪贴板(或输入框里固定的那段文本)并逐字键入。
///
/// 只有 macOS 有这套打法(要切输入源);Windows 那边是直接送 Unicode 字符,
/// 没有等价物 —— 和 Electron 版一样,那边不注册这个快捷键。
#[cfg(target_os = "macos")]
pub fn trigger_pinyin_from_clipboard(app: &AppHandle) -> Result<(), String> {
    let settings = crate::commands::app::get_settings(app.clone()).unwrap_or(serde_json::json!({}));
    let source = settings
        .get("pinyinSources")
        .and_then(|v| v.get("shortcut"))
        .and_then(|v| v.as_str())
        .unwrap_or("clipboard");
    let text = if source == "textbox" {
        settings
            .get("pinyinText")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } else {
        crate::commands::native::clipboard_read_text().unwrap_or_default()
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        record_shortcut_hit("⌃⇧D", "剪贴板是空的");
        return Ok(());
    }

    let auto_switch_ime = settings
        .get("autoSwitchIme")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if auto_switch_ime {
        // 切到 ASCII 输入源(配了才切),然后等一小会儿让切换生效
        if let Some(ascii_id) = settings.get("ascii_id").and_then(|v| v.as_str()) {
            if !ascii_id.is_empty() {
                let _ = crate::commands::native::select_input_source(ascii_id.to_string());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }

    match crate::commands::native::send_text(text.clone()) {
        Ok(_) => {
            record_shortcut_hit("⌃⇧D", &format!("已键入 {} 个字符", text.chars().count()));
            Ok(())
        }
        Err(e) => {
            record_shortcut_hit("⌃⇧D", &format!("键入失败: {}", e));
            Err(e)
        }
    }
}

/// Windows 那边没有等价动作(直接送 Unicode 字符就行,不需要"剪贴板直输"这套流程)。
#[cfg(not(target_os = "macos"))]
pub fn trigger_pinyin_from_clipboard(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
