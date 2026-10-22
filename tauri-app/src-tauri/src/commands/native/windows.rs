//! Windows 原生实现:SendInput 模拟鼠标 / 键盘。
//!
//! 与 Electron 版的 `win-input` 原生模块**同一套约定**,前端不用改:
//! - 坐标是屏幕像素(SetCursorPos)
//! - 修饰键位 1=shift 2=control 4=alt 8=win
//! - 文本按 Unicode 逐字敲入(KEYEVENTF_UNICODE),跨输入法可用
//!
//! 输入源(输入法切换)是 macOS 专属能力(Carbon TIS),Windows 没有等价实现,
//! 界面也已经把那两步去掉了,所以这里只给空实现。

use std::mem::size_of;

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS, MOUSEINPUT, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

fn send_batch(batch: &[INPUT]) -> Result<bool, String> {
    let sent = unsafe { SendInput(batch, size_of::<INPUT>() as i32) };
    if sent as usize != batch.len() {
        // 被拦下时 sent 会小于 batch.len();这通常是权限/安全软件/UIPI 造成的
        return Err(format!(
            "SendInput 只发出 {}/{} 个事件(可能被权限或安全软件拦下)",
            sent,
            batch.len()
        ));
    }
    Ok(true)
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// 鼠标点击(左键按下+抬起)。坐标是屏幕像素。
pub fn mouse_click(x: f64, y: f64) -> Result<bool, String> {
    unsafe {
        SetCursorPos(x.round() as i32, y.round() as i32).map_err(|_| "移动鼠标失败".to_string())?;
    }
    let batch = [
        mouse_input(MOUSEEVENTF_LEFTDOWN),
        mouse_input(MOUSEEVENTF_LEFTUP),
    ];
    send_batch(&batch)
}

/// 当前鼠标位置(屏幕像素)。
pub fn mouse_get_position() -> Result<(f64, f64), String> {
    let mut pt = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut pt) }.map_err(|_| "读取鼠标位置失败".to_string())?;
    Ok((pt.x as f64, pt.y as f64))
}

/// 发送文本(按 Unicode 逐字敲入,跨输入法可用)。
pub fn send_text(text: String) -> Result<bool, String> {
    if text.is_empty() {
        return Ok(true);
    }
    let mut batch: Vec<INPUT> = Vec::new();
    for unit in text.encode_utf16() {
        batch.push(key_input(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE));
        batch.push(key_input(
            VIRTUAL_KEY(0),
            unit,
            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
        ));
    }
    send_batch(&batch)
}

/// 发送按键(VK 虚拟键码 + 修饰键标志)。
///
/// flags 位:1=shift 2=control 4=alt 8=win
/// key_code 是 **Windows 虚拟键码**(VK_*),与 Electron 版 win-input 同一套约定。
pub fn send_key(key_code: u16, flags: u32) -> Result<bool, String> {
    let mut mods: Vec<VIRTUAL_KEY> = Vec::new();
    if flags & 1 != 0 {
        mods.push(VK_SHIFT);
    }
    if flags & 2 != 0 {
        mods.push(VK_CONTROL);
    }
    if flags & 4 != 0 {
        mods.push(VK_MENU);
    }
    if flags & 8 != 0 {
        mods.push(VK_LWIN);
    }

    let mut batch: Vec<INPUT> = Vec::new();
    for m in &mods {
        batch.push(key_input(*m, 0, KEYBD_EVENT_FLAGS(0)));
    }
    batch.push(key_input(VIRTUAL_KEY(key_code), 0, KEYBD_EVENT_FLAGS(0)));
    batch.push(key_input(VIRTUAL_KEY(key_code), 0, KEYEVENTF_KEYUP));
    for m in mods.iter().rev() {
        batch.push(key_input(*m, 0, KEYEVENTF_KEYUP));
    }
    send_batch(&batch)
}

/// 当前输入源 —— Windows 没有等价能力。
/// 当前输入源信息 —— Windows 没有输入源概念(那边直接送 Unicode 字符)。
pub fn current_input_source_info() -> Result<crate::commands::native::InputSourceInfo, String> {
    Ok(crate::commands::native::InputSourceInfo::default())
}

/// 切换输入源 —— Windows 没有等价能力。
pub fn select_input_source(_source_id: String) -> Result<bool, String> {
    Ok(true)
}
