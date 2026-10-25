//! 全局快捷键触发的两个动作 —— 与 Electron 版 `main.js` 里的
//! `triggerDefaultExecute` / `triggerPinyinFromClipboard` **同口径**。
//!
//! - ⌃S:触发「默认执行」—— 回放选中的录制文件(没选中就回放名字最大的那个)
//! - ⌃⇧D:读剪贴板(或输入框里固定的那段文本)并逐字键入
//!
//! 走的是**后端**这条路,不是界面上那条:快捷键在界面没打开时也要能用。

use serde_json::Value;
use std::sync::Mutex;
use tauri::AppHandle;

/// 最近若干次快捷键命中的记录(给运行自检看)。
///
/// 为什么要有:**"按了没反应"有好几种完全不同的原因**
/// (系统没把组合键送来 / 送来了但动作失败 / 动作做完了但打进了中文输入法的候选框里),
/// 光看"注册成功"根本分不出来。这里每次命中都记一笔:
/// 命中了哪个键、动作结果是什么、当时系统输入源是谁。
static HITS: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/// 记一次快捷键命中。
pub fn record_shortcut_hit(key: &str, outcome: &str) {
    let source = current_input_source_label();
    if let Ok(mut v) = HITS.lock() {
        v.push(serde_json::json!({
            "at": crate::commands::app::now_ms(),
            "key": key,
            "outcome": outcome,
            "inputSource": source,
        }));
        if v.len() > 20 {
            let drop = v.len() - 20;
            v.drain(..drop);
        }
    }
}

/// 命中那一刻的系统输入源(给诊断看)。
///
/// **Windows 没有输入源概念**(那边直接送 Unicode 字符),所以那一栏写清楚,
/// 别让人看着一个空值猜"是不是读失败了"。
fn current_input_source_label() -> String {
    #[cfg(target_os = "macos")]
    {
        crate::commands::native::get_current_input_source()
            .map(|v| {
                format!(
                    "{}({})",
                    v.get("name").and_then(|x| x.as_str()).unwrap_or("?"),
                    if v.get("isASCII").and_then(|x| x.as_bool()).unwrap_or(false) {
                        "ASCII"
                    } else {
                        "非ASCII"
                    }
                )
            })
            .unwrap_or_else(|e| format!("读不到:{}", e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        "无(该平台没有输入源概念)".to_string()
    }
}

/// 最近 20 次快捷键命中(运行自检用)。
pub fn shortcut_hits() -> Vec<Value> {
    HITS.lock().map(|v| v.clone()).unwrap_or_default()
}

/// ⌃S:触发「默认执行」。
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
                record_shortcut_hit("⌃S", "一个录制文件都没有");
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
        record_shortcut_hit("⌃S", &format!("{} 里没有可执行的点击", file_name));
        return Ok(());
    }
    let inputs = crate::commands::play::resolve_inputs(&clicks, None);
    // 重入保护在这里生效:上一次回放还没结束时,这次**不重复执行**
    // (2026-10-23 T0 事故:回放互相触发 ⇒ 无限循环 ⇒ 机器卡死)。
    if crate::commands::play::spawn_playback(file_name.clone(), clicks, 0.5, inputs) {
        record_shortcut_hit("⌃S", &format!("开始回放 {}", file_name));
    } else {
        record_shortcut_hit("⌃S", "上一次回放还没结束,这次没有重复执行");
    }
    Ok(())
}

/// ⌃⇧D:读剪贴板(或输入框里固定的那段文本)并逐字键入。
///
/// ## 两个平台是**同构**的
///
/// 流程一模一样:
/// 1. 看设置里「快捷键用哪段文本」——`clipboard`(剪贴板)还是 `textbox`(输入框里固定的那段);
/// 2. 取文本、去掉首尾空白;
/// 3. 空的就**什么都不做**(记一笔「剪贴板是空的」);
/// 4. `send_text` 逐字键入(Unicode,跨输入法可用)。
///
/// ## 唯一的平台差异:**不切输入源**
///
/// macOS 那边切得到输入源(Carbon TIS),所以多一步「切到 ASCII 输入源再等 300ms」。
/// **Windows 直接送 Unicode 字符,没有输入源概念** ⇒ 那一步整个跳过。
///
/// ## 与 ADR-0012「Windows 保留拼音自动键入」不冲突
///
/// ADR-0012 说的是「键盘输入」那一页:用户**手动敲**内容,Windows 用 Unicode 逐字键入。
/// ⌃⇧D 是另一件事:把**剪贴板里已有的文本**直接敲进去,不用手动敲。
/// 一个是「从键盘输入」,一个是「从剪贴板输入」——两条不同的路,不是同一件事做了两遍。
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

    // 切输入源:**只有 macOS 有这个能力**。
    // Windows 直接送 Unicode 字符,没有输入源概念,这一步整个不存在。
    #[cfg(target_os = "macos")]
    {
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
