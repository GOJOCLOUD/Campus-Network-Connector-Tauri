//! macOS 原生实现:CoreGraphics 模拟鼠标 / 键盘,Carbon TIS 读写输入源。
//!
//! 对应 Electron 版的 `mac-coregraphics` 原生模块(Objective-C++),
//! 这里用 core-graphics(CoreGraphics/ApplicationServices)直接实现 ——
//! 换掉 Node 运行时,这块能力**完全保留**,且不再需要 .node 插件与 asarUnpack。
//!
//! 坐标是**屏幕全局坐标**(与 Electron 版一致)。

use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, CGKeyCode,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;

// ── 辅助功能权限 ─────────────────────────────────────────
//
// 发合成点击/按键(CGEventPost)需要 macOS 的「辅助功能」权限。
// **没有权限时系统会静默丢弃事件**:命令照样返回 true,屏幕上却什么都没发生。
// 所以必须把这个状态查出来报到界面上,免得用户以为程序坏了
// (Electron 版就是没报 → 失败是"静默"的)。

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// 当前进程是否被授予「辅助功能」权限。
pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// 发合成事件前的权限闸门。
///
/// 没有「辅助功能」权限时,`CGEventPost` 会被系统**静默丢弃**:
/// 命令返回成功,屏幕上却什么都没发生 —— 用户只会觉得"软件坏了"。
/// 所以这里直接报错,把原因带回去(界面会显示出来)。
fn require_accessibility(what: &str) -> Result<(), String> {
    if accessibility_trusted() {
        return Ok(());
    }
    Err(format!(
        "{}需要「辅助功能」权限:系统设置 → 隐私与安全性 → 辅助功能 → 勾选本应用(改完要重开软件)",
        what
    ))
}

fn event_source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "创建事件源失败(系统可能未授权辅助功能)".to_string())
}

/// 鼠标点击(左键按下+抬起)。
pub fn mouse_click(x: f64, y: f64) -> Result<bool, String> {
    require_accessibility("模拟点击")?;
    let point = CGPoint::new(x, y);
    let down = CGEvent::new_mouse_event(
        event_source()?,
        CGEventType::LeftMouseDown,
        point,
        CGMouseButton::Left,
    )
    .map_err(|_| "创建鼠标事件失败".to_string())?;
    let up = CGEvent::new_mouse_event(
        event_source()?,
        CGEventType::LeftMouseUp,
        point,
        CGMouseButton::Left,
    )
    .map_err(|_| "创建鼠标事件失败".to_string())?;
    down.post(CGEventTapLocation::HID);
    up.post(CGEventTapLocation::HID);
    Ok(true)
}

/// 当前鼠标位置(全局坐标)。
pub fn mouse_get_position() -> Result<(f64, f64), String> {
    let event = CGEvent::new(event_source()?).map_err(|_| "读取鼠标位置失败".to_string())?;
    let p = event.location();
    Ok((p.x, p.y))
}

/// 发送文本(按 Unicode 逐字敲入,跨输入法可用)。
pub fn send_text(text: String) -> Result<bool, String> {
    if text.is_empty() {
        return Ok(true);
    }
    require_accessibility("键入文本")?;
    for ch in text.chars() {
        let mut buf = [0u16; 2];
        let mut utf16 = [0u16; 2];
        let mut n = 0usize;
        for unit in ch.encode_utf16(&mut utf16) {
            buf[n] = *unit;
            n += 1;
        }
        // 按 keydown 写字符串 + 一次 keyup
        let event = CGEvent::new_keyboard_event(event_source()?, 0, true)
            .map_err(|_| "创建键盘事件失败".to_string())?;
        event.set_string_from_utf16_unchecked(&buf[..n]);
        event.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(event_source()?, 0, false)
            .map_err(|_| "创建键盘事件失败".to_string())?;
        up.set_string_from_utf16_unchecked(&buf[..n]);
        up.post(CGEventTapLocation::HID);
    }
    Ok(true)
}

/// 发送按键(keycode + 修饰键标志)。
///
/// flags 位:1=shift 2=control 4=option/alt 8=command
/// keycode 是 **macOS 虚拟键码**(CGKeyCode)。
pub fn send_key(key_code: u16, flags: u32) -> Result<bool, String> {
    require_accessibility("发送按键")?;
    let mut cg_flags = CGEventFlags::empty();
    if flags & 1 != 0 {
        cg_flags |= CGEventFlags::CGEventFlagShift;
    }
    if flags & 2 != 0 {
        cg_flags |= CGEventFlags::CGEventFlagControl;
    }
    if flags & 4 != 0 {
        cg_flags |= CGEventFlags::CGEventFlagAlternate;
    }
    if flags & 8 != 0 {
        cg_flags |= CGEventFlags::CGEventFlagCommand;
    }
    let code: CGKeyCode = key_code as CGKeyCode;
    let down =
        CGEvent::new_keyboard_event(event_source()?, code, true).map_err(|_| "创建键盘事件失败".to_string())?;
    down.set_flags(cg_flags);
    down.post(CGEventTapLocation::HID);
    let up =
        CGEvent::new_keyboard_event(event_source()?, code, false).map_err(|_| "创建键盘事件失败".to_string())?;
    up.set_flags(cg_flags);
    up.post(CGEventTapLocation::HID);
    Ok(true)
}

// ── 输入源(Carbon TIS)────────────────────────────────
//
// objc2-carbon 没有 TIS 绑定,直接对 Carbon 框架做 FFI。

mod tis {
    use core::ffi::{c_int, c_void};

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        pub fn TISCopyCurrentKeyboardInputSource() -> *const c_void;
        pub fn TISSelectInputSource(input_source: *const c_void) -> c_int;
        pub fn TISGetInputSourceProperty(
            input_source: *const c_void,
            property_key: *const c_void,
        ) -> *const c_void;
        pub fn TISCopyInputSourceForLanguage(language: *const c_void) -> *const c_void;
        pub static kTISPropertyInputSourceID: *const c_void;
        // 名称属性是 `kTISPropertyLocalizedName`(**不是** kTISPropertyInputSourceLocalizedName
        // —— 后者在 Carbon 里根本没有这个符号,链接期会报 undefined)。
        pub static kTISPropertyLocalizedName: *const c_void;
        pub static kTISPropertyInputSourceIsASCIICapable: *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFBooleanGetValue(boolean: *const c_void) -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFStringGetCString(
            the_string: *const c_void,
            buffer: *mut u8,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
    }

    pub const K_CF_STRING_UTF8_ENCODING: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external_representation: u8,
        ) -> *const c_void;
    }
}

fn input_source_id(ptr: *const core::ffi::c_void) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    unsafe {
        let mut buf = [0u8; 512];
        let ok = tis::CFStringGetCString(
            ptr,
            buf.as_mut_ptr(),
            buf.len() as isize,
            tis::K_CF_STRING_UTF8_ENCODING,
        );
        if ok == 0 {
            return None;
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        String::from_utf8(buf[..end].to_vec()).ok()
    }
}

/// 当前输入源(拼音/ABC 等)。
///
/// 返回 `{ id, name, isASCII }` —— 与 Electron 版原生模块同一形状。
///
/// ⚠️ Carbon TIS **只能在主线程调**(跑错线程不会报错,会**直接把 App 崩掉**,
/// 见 `commands/native.rs` 里的说明)。这里统一走主线程编排,谁调用都安全。
pub fn current_input_source_info() -> Result<crate::commands::native::InputSourceInfo, String> {
    crate::commands::native::run_on_main_thread(
        current_input_source_info_on_main,
        std::time::Duration::from_secs(2),
    )
    // 编排本身失败(到不了主线程)与"读到的结果是错误"是两回事 ⇒ 两层都要往外传。
    .and_then(|r| r)
}

/// 真正读输入源的实现 —— **只能在主线程调**。
///
/// 单独拆出来有两个原因:
/// ① 让"跑错线程"能被**拦下来**(报错),而不是把整个 App 崩掉;
/// ② 给单测留一个能直接调的入口(见文件末尾的用例)。
fn current_input_source_info_on_main() -> Result<crate::commands::native::InputSourceInfo, String> {
    use crate::commands::native::InputSourceInfo;
    // 守卫:不在主线程就**拒绝**,绝不硬调 Carbon。
    // (这道闸就是 2026-10-23 那次崩溃的闸门。)
    if !crate::commands::native::is_main_thread() {
        return Err("读输入源必须在主线程调用(Carbon TIS 的要求)".to_string());
    }
    unsafe {
        let src = tis::TISCopyCurrentKeyboardInputSource();
        if src.is_null() {
            return Ok(InputSourceInfo::default());
        }
        let id = tis::TISGetInputSourceProperty(src, tis::kTISPropertyInputSourceID);
        let name = tis::TISGetInputSourceProperty(src, tis::kTISPropertyLocalizedName);
        let ascii = tis::TISGetInputSourceProperty(src, tis::kTISPropertyInputSourceIsASCIICapable);
        Ok(InputSourceInfo {
            id: input_source_id(id).unwrap_or_default(),
            name: input_source_id(name).unwrap_or_default(),
            is_ascii: !ascii.is_null() && tis::CFBooleanGetValue(ascii) != 0,
        })
    }
}

/// 切换输入源(传输入源 id,如 "com.apple.keylayout.ABC")。
///
/// ⚠️ 同样只能在主线程调(Carbon TIS 的要求)—— 这里统一编排。
/// ⌃⇧D 的动作跑在**动作线程**上(不是主线程),没有这层编排就会崩。
pub fn select_input_source(source_id: String) -> Result<bool, String> {
    crate::commands::native::run_on_main_thread(
        move || select_input_source_on_main(source_id),
        std::time::Duration::from_secs(5),
    )
    .and_then(|r| r)
}

/// 真正切输入源的实现 —— **只能在主线程调**。
fn select_input_source_on_main(source_id: String) -> Result<bool, String> {
    if !crate::commands::native::is_main_thread() {
        return Err("切换输入源必须在主线程调用(Carbon TIS 的要求)".to_string());
    }
    unsafe {
        // 用 UTF-8 字节直接构造 CFString(避免依赖 core-foundation 的类型 API)
        let mut buf: Vec<u8> = source_id.as_bytes().to_vec();
        buf.push(0);
        let id = tis::CFStringCreateWithBytes(
            std::ptr::null_mut(),
            buf.as_ptr(),
            source_id.len() as isize,
            tis::K_CF_STRING_UTF8_ENCODING,
            0 as u8,
        );
        let src = tis::TISCopyInputSourceForLanguage(id as *const _);
        if src.is_null() {
            return Err(format!("找不到输入源 {}", source_id));
        }
        let status = tis::TISSelectInputSource(src);
        if status != 0 {
            return Err(format!("切换输入源失败(status {})", status));
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在**非主线程**读输入源,不能把进程搞崩。
    ///
    /// 2026-10-23 真机事故:事件 tap 的回调线程(`cnc-hotkey`)里直接读了输入源,
    /// Carbon TIS 内部 `dispatch_assert_queue` → SIGTRAP → 整个 App 当场崩
    /// (崩溃报告栈底:`TSMGetInputSourceProperty` ← `processEventTapData`)。
    ///
    /// 这条用例就是那道闸:**跑错线程必须报错**,不能去碰 Carbon。
    #[test]
    fn 非主线程读输入源不崩() {
        let r = std::thread::spawn(current_input_source_info_on_main)
            .join()
            .expect("线程本身不能崩");
        assert!(
            r.is_err(),
            "跑错线程必须报错,不能真去调 Carbon(否则就是 2026-10-23 那次崩溃): {:?}",
            r
        );
    }

    /// 切输入源同理 —— ⌃⇧D 的动作跑在**动作线程**上,不是主线程。
    #[test]
    fn 非主线程切输入源不崩() {
        let r = std::thread::spawn(|| {
            select_input_source_on_main("com.apple.keylayout.ABC".to_string())
        })
        .join()
        .expect("线程本身不能崩");
        assert!(r.is_err(), "跑错线程必须报错: {:?}", r);
    }
}
