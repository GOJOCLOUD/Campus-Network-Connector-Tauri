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

fn event_source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "创建事件源失败(系统可能未授权辅助功能)".to_string())
}

/// 鼠标点击(左键按下+抬起)。
pub fn mouse_click(x: f64, y: f64) -> Result<bool, String> {
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
pub fn get_current_input_source() -> Result<String, String> {
    unsafe {
        let src = tis::TISCopyCurrentKeyboardInputSource();
        if src.is_null() {
            return Ok(String::new());
        }
        let id = tis::TISGetInputSourceProperty(src, tis::kTISPropertyInputSourceID);
        Ok(input_source_id(id).unwrap_or_default())
    }
}

/// 切换输入源(传输入源 id,如 "com.apple.keylayout.ABC")。
pub fn select_input_source(source_id: String) -> Result<bool, String> {
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
