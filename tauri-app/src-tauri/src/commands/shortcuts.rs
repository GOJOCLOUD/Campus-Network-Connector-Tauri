//! 全局快捷键触发的两个动作 —— 与 Electron 版 `main.js` 里的
//! `triggerDefaultExecute` / `triggerPinyinFromClipboard` **同口径**。
//!
//! - ⌃⇧A:触发「默认执行」—— 回放选中的录制文件(没选中就回放名字最大的那个)
//! - ⌃⇧D:读剪贴板(或输入框里固定的那段文本)并逐字键入(只有 macOS 有输入源切换这套打法)
//!
//! 走的是**后端**这条路,不是界面上那条:快捷键在界面没打开时也要能用。

use serde_json::Value;
use tauri::AppHandle;

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
            None => return Ok(()),
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
        return Ok(());
    }
    let inputs = crate::commands::play::resolve_inputs(&clicks, None);
    crate::commands::play::spawn_playback(file_name, clicks, 0.5, inputs);
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

    crate::commands::native::send_text(text).map(|_| ())
}

/// Windows 那边没有等价动作(直接送 Unicode 字符就行,不需要"剪贴板直输"这套流程)。
#[cfg(not(target_os = "macos"))]
pub fn trigger_pinyin_from_clipboard(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
