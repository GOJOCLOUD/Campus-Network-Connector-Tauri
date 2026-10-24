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
use std::time::Duration;

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

/// ── 剪贴板 ────────────────────────────────────────────────────────
///
/// macOS 那边走 NSPasteboard(`native.rs` 里直接调 objc2-app-kit);
/// Windows 这边走 Win32 的 `OpenClipboard` / `GetClipboardData`。
/// 两边返回的都是同一件事:**一段纯文本**。

/// 剪贴板格式 `CF_UNICODETEXT`(13)。
///
/// `windows` crate 把它放在 `Win32_System_Ole` 里 —— 那个 feature 会拖进
/// 一大片 COM/OLE 绑定,为了一个常量不值得,所以这里直接写值 + 注释。
/// (值是 Win32 定死的,不会变。)
const CF_UNICODETEXT: u32 = 13;

/// 读剪贴板里的文本(UTF-16)。
///
/// ## 为什么要有
///
/// ⌃D「剪贴板直输」要的就是这段文本 —— Windows 上没有输入源切换那套打法,
/// 直接把剪贴板里的字敲出去就完事了(见 ADR-0025)。
///
/// ## 几个坑
///
/// - 剪贴板是**全局**资源:别的进程可能正开着它 ⇒ `OpenClipboard` 会失败。
///   重试几次(剪贴板被占用通常是瞬时的)。
/// - `OpenClipboard` 成功之后**必须** `CloseClipboard` —— 忘了的话
///   别的程序再也打不开剪贴板(用户会看到"复制到别处全都不管用了")。
/// - 拿到的内存块要用 `GlobalLock` / `GlobalUnlock` 包起来,
///   且 `GlobalUnlock` 要在**同一个线程**上调用。
pub fn clipboard_read_text() -> Result<String, String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, OpenClipboard};

    // 打开剪贴板:可能正被别人占着,重试几次。
    let mut opened = false;
    for _ in 0..5 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !opened {
        return Err("打不开剪贴板(可能正被别的程序占用)".to_string());
    }

    let result = read_clipboard_unicode();

    // 无论如何都要关 —— 忘了会让别的程序再也用不了剪贴板。
    unsafe {
        let _ = CloseClipboard();
    }
    result
}

/// 已经在打开剪贴板的状态下,把文本读出来。
fn read_clipboard_unicode() -> Result<String, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    let handle = unsafe { GetClipboardData(CF_UNICODETEXT) }
        .map_err(|_| "剪贴板里没有文本".to_string())?;
    let hglobal = HGLOBAL(handle.0);
    let ptr = unsafe { GlobalLock(hglobal) };
    if ptr.is_null() {
        return Err("读剪贴板内容失败(GlobalLock 返回空)".to_string());
    }
    // 剪贴板里的文本是 UTF-16、以两个 0 结尾。
    let mut len = 0usize;
    unsafe {
        let mut p = ptr as *const u16;
        while *p != 0 {
            len += 1;
            p = p.add(1);
        }
        let slice = std::slice::from_raw_parts(ptr as *const u16, len);
        let text = String::from_utf16_lossy(slice);
        let _ = GlobalUnlock(hglobal);
        Ok(text)
    }
}
