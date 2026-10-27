//! Windows:⌃D 的**优先级** —— 低级键盘钩子(`WH_KEYBOARD_LL`)。
//!
//! ## 为什么需要它
//!
//! 2026-10-27 真人反馈:**在微信里**按 ⌃D 是微信自己的动作,我们的「读剪贴板并键入」
//! 不触发;别的软件里一切正常。
//!
//! 当场查过(不是猜):微信**没有**用系统热键 —— 我们自己的 `RegisterHotKey(Ctrl+D)`
//! 是**注册成功**的 ⇒ 微信用的是**低级键盘钩子**(`WH_KEYBOARD_LL`)。
//! Windows 的输入顺序是
//!
//! ```text
//! 低级钩子 → 系统热键 → 目标窗口
//! ```
//!
//! ⇒ 微信在**系统热键之前**就把 Ctrl+D 处理掉了 ⇒ 我们的 `WM_HOTKEY` 根本没来过。
//!
//! ## 怎么赢
//!
//! Windows 的规则:**后安装的钩子先被调用** ⇒ 我们自己装一个 `WH_KEYBOARD_LL`,
//! 看到 Ctrl+D 就**吞掉它**(返回 1)⇒ 微信收不到、系统热键也收不到 ⇒ 只有我们响应。
//!
//! ⚠️ 诚实说明:这**不是**绝对保证 —— 对方**后启动**的话,它的钩子会先被调用,
//! 我们就收不到。这是 Windows 的机制,用户这边绕不过去(见 ADR-0033)。
//!
//! ## 为什么用**原始 FFI**而不是 `windows` crate
//!
//! `windows` crate 的 Win32 包装在不同版本里改过类型
//! (`SetWindowsHookExW` 的 `idHook` 参数、`HOOKPROC` 的签名都动过)
//! ⇒ 升/降一次依赖就编不过,而这里只用到**四个** Win32 函数,
//! 它们的签名二十年没变 ⇒ 直接 extern 声明最稳、最好读。
//!
//! ## 与 latch 的关系
//!
//! latch(触发一次必须松开 Control 才重新武装)仍然由 `hotkey_win` 的**只读**
//! Control 观察器(`GetAsyncKeyState` 轮询)负责 —— 本钩子只负责「认键」。
//!
//! ## 线程分工
//!
//! - **钩子线程**:装钩子 + 消息循环(低级钩子**必须**有消息循环才会被调用)。
//!   回调里只做两件事:置标志、把事件丢进通道 —— 必须尽快返回
//!   (回调太慢会被系统直接摘掉:`LowLevelHooksTimeout`)。
//! - **动作线程**:从通道里取事件,做动作(读剪贴板 → 逐字键入)。

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use super::hotkey_core::Hotkey;
use super::hotkey_win;

/// 'D' 的虚拟键码。
const VK_D: u32 = 0x44;
/// Control 的虚拟键码(`GetAsyncKeyState` 要的是 `i32`)。
const VK_CONTROL: i32 = 0x11;
/// 低级键盘钩子的 id。
const WH_KEYBOARD_LL: i32 = 13;
/// `HC_ACTION` —— 钩子收到了正常的键盘消息。
const HC_ACTION: i32 = 0;

const WM_KEYDOWN: usize = 0x0100;
const WM_KEYUP: usize = 0x0101;
const WM_SYSKEYDOWN: usize = 0x0104;
const WM_SYSKEYUP: usize = 0x0105;

/// 钩子回调的签名。
///
/// ⚠️ 这里是**安全**函数指针(不是 `unsafe extern fn`):Win32 只看 ABI,
/// 「unsafe」是 Rust 侧的类型标记而已。写成安全签名 ⇒ 回调体里的 `unsafe {}`
/// 就是**必需**的,不会触发 `unused_unsafe` 告警。
type HookProc = extern "system" fn(i32, usize, isize) -> isize;

extern "system" {
    fn SetWindowsHookExW(
        id_hook: i32,
        lpfn: Option<HookProc>,
        h_mod: *mut c_void,
        thread_id: u32,
    ) -> *mut c_void;
    fn CallNextHookEx(hhk: *mut c_void, n_code: i32, w_param: usize, l_param: isize) -> isize;
    fn UnhookWindowsHookEx(hhk: *mut c_void) -> i32;
    fn GetMessageW(lp_msg: *mut Msg, h_wnd: *mut c_void, min: u32, max: u32) -> i32;
    fn PostThreadMessageW(thread_id: u32, msg: u32, w_param: usize, l_param: isize) -> i32;
    fn GetModuleHandleW(module_name: *const u16) -> *mut c_void;
    fn GetAsyncKeyState(v_key: i32) -> i16;
    fn GetLastError() -> u32;
    fn GetCurrentThreadId() -> u32;
}

/// Win32 的 `MSG`(布局二十年没变)。
#[repr(C)]
#[allow(dead_code)] // 整个结构体是交给 Win32 填的,单个字段我们不读
struct Msg {
    hwnd: *mut c_void,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
}

/// Win32 的 `KBDLLHOOKSTRUCT`。
#[repr(C)]
#[allow(dead_code)] // 有几个字段我们没读(flags/scanCode/time/extraInfo)
struct KbdLlHookStruct {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    dw_extra_info: usize,
}

/// 钩子线程 → 动作线程的通知通道。
static SENDER: OnceLock<Mutex<Option<Sender<()>>>> = OnceLock::new();
/// Control 现在按着没有(自己跟,不用 `GetAsyncKeyState` ——
/// 它在钩子回调里的更新时机是「异步」的,偶尔会差一拍)。
static CTRL_DOWN: AtomicBool = AtomicBool::new(false);
/// 'D' 现在按着没有(用来挡自动重复)。
static D_DOWN: AtomicBool = AtomicBool::new(false);
/// 「D 的松开」也要吞(按下被吞了,松开不吞的话前台软件会看到一个凭空出现的松开)。
static SWALLOW_KEY_UP: AtomicBool = AtomicBool::new(false);
/// 钩子线程 id(停钩子时用它发 `WM_QUIT`)。
static THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// 钩子装上了没有(诊断用)。
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// 这次 'D' 的按下该不该**触发并吞掉**。
///
/// 纯逻辑(不碰 Win32)⇒ 任何平台都能单测(见本文件末尾的 `tests`)。
///
/// - `ctrl_down`:Control 现在按着没有;
/// - `d_was_down`:这次按下之前 'D' 是不是已经按着(自动重复就是 true)。
///
/// 规则:
/// - 没有 Control ⇒ 不是 ⌃D ⇒ 放行(别的键要正常用);
/// - 已经有 'D' 按着 ⇒ 这是**自动重复**(按住不放)⇒ 不重复触发。
pub fn should_trigger(ctrl_down: bool, d_was_down: bool) -> bool {
    ctrl_down && !d_was_down
}

/// 钩子回调:看到 ⌃D 就吞掉,并通知动作线程。
extern "system" fn low_level_keyboard_proc(
    n_code: i32,
    w_param: usize,
    l_param: isize,
) -> isize {
    if n_code == HC_ACTION && l_param != 0 {
        // SAFETY:`HC_ACTION` 时 `l_param` 指向一个有效的 `KBDLLHOOKSTRUCT`
        // (Win32 保证这个结构体在回调返回前一直有效)。
        let info = unsafe { &*(l_param as *const KbdLlHookStruct) };
        let down = w_param == WM_KEYDOWN || w_param == WM_SYSKEYDOWN;
        let up = w_param == WM_KEYUP || w_param == WM_SYSKEYUP;

        if info.vk_code == VK_CONTROL as u32 {
            CTRL_DOWN.store(down, Ordering::Relaxed);
        }

        if info.vk_code == VK_D {
            if down {
                let ctrl = CTRL_DOWN.load(Ordering::Relaxed);
                let was_down = D_DOWN.load(Ordering::Relaxed);
                if should_trigger(ctrl, was_down) {
                    D_DOWN.store(true, Ordering::Relaxed);
                    SWALLOW_KEY_UP.store(true, Ordering::Relaxed);
                    notify();
                    // 吞掉:微信收不到、系统热键也收不到 ⇒ 只有我们响应,不会重复触发。
                    return 1;
                }
                if ctrl {
                    // 自动重复(按住不放)⇒ 也要吞,免得漏进别的软件。
                    D_DOWN.store(true, Ordering::Relaxed);
                    SWALLOW_KEY_UP.store(true, Ordering::Relaxed);
                    return 1;
                }
                D_DOWN.store(false, Ordering::Relaxed);
            } else if up {
                D_DOWN.store(false, Ordering::Relaxed);
                if SWALLOW_KEY_UP.swap(false, Ordering::Relaxed) {
                    return 1;
                }
            }
        }
    }
    // SAFETY:`CallNextHookEx` 接受空句柄(=「没有这个钩子」也是允许的)。
    unsafe { CallNextHookEx(std::ptr::null_mut(), n_code, w_param, l_param) }
}

/// 通知动作线程「⌃D 来了」。
///
/// 通道是**无界**的 ⇒ `send` 不会阻塞 ⇒ 钩子回调能尽快返回。
fn notify() {
    if let Some(slot) = SENDER.get() {
        if let Ok(guard) = slot.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(());
            }
        }
    }
}

/// 钩子装上了没有(诊断用)。
pub fn installed() -> bool {
    INSTALLED.load(Ordering::SeqCst)
}

/// 装上低级键盘钩子。
///
/// 返回 `Ok(true)` = 钩子装上了(⌃D 由我们收,微信那类**用钩子抢键**的软件压不过我们);
/// `Ok(false)` = 装不上 ⇒ **如实降级**:还有系统热键那一路,
/// 但那种情况下压不过用钩子的软件 —— 界面/日志要照实说。
pub fn start(app: AppHandle) -> Result<bool, String> {
    if INSTALLED.load(Ordering::SeqCst) {
        return Ok(true);
    }

    let (tx, rx) = channel::<()>();
    {
        let slot = SENDER.get_or_init(|| Mutex::new(None));
        let mut guard = slot
            .lock()
            .map_err(|_| "钩子的通知通道锁坏了".to_string())?;
        *guard = Some(tx);
    }

    // 动作线程:收到 ⌃D 就做动作。
    //
    // ⚠️ **不能**在钩子回调里做 —— 回调太慢会被系统直接摘掉
    //    (`LowLevelHooksTimeout`),而且会把按键处理卡住。
    thread::Builder::new()
        .name("cnc-ctrl-d-worker".to_string())
        .spawn(move || {
            while rx.recv().is_ok() {
                // latch:触发一次之后必须松开 Control 才重新武装。
                if !hotkey_win::try_fire(Hotkey::Paste) {
                    crate::commands::shortcuts::record_shortcut_hit(
                        "⌃D",
                        "latch 还锁着(Control 还没松开),这次没有重复执行",
                    );
                    continue;
                }
                if let Err(e) = crate::commands::shortcuts::trigger_pinyin_from_clipboard(&app) {
                    eprintln!("[shortcut] 剪贴板直输失败: {}", e);
                }
            }
        })
        .map_err(|e| format!("起动作线程失败: {}", e))?;

    let (ready_tx, ready_rx) = channel::<Result<bool, String>>();
    thread::Builder::new()
        .name("cnc-ctrl-d-hook".to_string())
        .spawn(move || {
            THREAD_ID.store(windows_thread_id(), Ordering::SeqCst);

            let hook = match install_hook_on_this_thread() {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[shortcut] {} ⇒ ⌃D 只剩「系统热键」那一级", e);
                    INSTALLED.store(false, Ordering::SeqCst);
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            // 起始状态取当前物理状态,别凭空造一个边沿。
            //
            // ⚠️ `GetAsyncKeyState` 返回 **i16**,而「当前按着」那个位是 0x8000
            // —— 那个字面量塞不进 i16 ⇒ 必须**先转成 u16** 再取位
            // (同 `hotkey_win` 里的写法)。
            CTRL_DOWN.store(
                (unsafe { GetAsyncKeyState(VK_CONTROL) } as u16) & 0x8000 != 0,
                Ordering::Relaxed,
            );
            let _ = ready_tx.send(Ok(true));

            // 消息循环:低级钩子**必须**有它,钩子回调才会被调用。
            let mut msg: Msg = unsafe { std::mem::zeroed() };
            loop {
                let r = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
                if r <= 0 {
                    break; // 0 = WM_QUIT,-1 = 出错
                }
            }

            unsafe { UnhookWindowsHookEx(hook) };
            INSTALLED.store(false, Ordering::SeqCst);
        })
        .map_err(|e| format!("起钩子线程失败: {}", e))?;

    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(result) => result,
        // 3 秒还没回音 ⇒ **如实**说装不上(界面/日志照实显示),
        // 别让人以为「优先级已经搞定了」。
        Err(_) => Ok(false),
    }
}

/// 停掉钩子(退出 App 时用;可重复调用)。
pub fn stop() {
    let tid = THREAD_ID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe { PostThreadMessageW(tid, 0x0012, 0, 0) }; // WM_QUIT
    }
    INSTALLED.store(false, Ordering::SeqCst);
}

/// 当前线程的 Windows 线程 id。
fn windows_thread_id() -> u32 {
    unsafe { GetCurrentThreadId() }
}

/// 在**当前线程**上装低级键盘钩子,返回钩子句柄。
///
/// ⚠️ 低级钩子必须装在**将来会跑消息循环的那个线程**上
/// (回调就在那个线程的上下文里被调用)⇒ 生产代码里由钩子线程自己调,
/// 单测里也是另起一个线程来调。
fn install_hook_on_this_thread() -> Result<*mut c_void, String> {
    let h_mod = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hook =
        unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_keyboard_proc), h_mod, 0) };
    if hook.is_null() {
        let err = unsafe { GetLastError() };
        return Err(format!(
            "SetWindowsHookExW(WH_KEYBOARD_LL) 失败(错误码 {})",
            err
        ));
    }
    INSTALLED.store(true, Ordering::SeqCst);
    Ok(hook)
}

#[cfg(test)]
mod tests {
    use super::{install_hook_on_this_thread, should_trigger};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn 带Control的D才触发() {
        assert!(should_trigger(true, false), "⌃D 应当触发");
    }

    #[test]
    fn 不带Control的D不触发() {
        assert!(!should_trigger(false, false), "单独的 D 是普通按键,不该触发");
    }

    #[test]
    fn 按住不放不重复触发() {
        // 自动重复:第二次 keydown 时 'D' 已经按着了 ⇒ 不该再触发。
        assert!(!should_trigger(true, true), "按住不放不该连着触发");
    }

    /// 低级键盘钩子**真的装得上**。
    ///
    /// 这一条盯的是那几行**原始 FFI**(`SetWindowsHookExW` 的参数、句柄判空、
    /// 消息循环)—— 它们写错了编译也过、装的时候才炸,静态检查抓不到。
    /// CI 的 runner 是 Windows ⇒ 这里真的装一次、真的摘一次。
    #[test]
    fn 低级键盘钩子装得上也摘得掉() {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        std::thread::spawn(move || {
            let result = install_hook_on_this_thread().map(|hook| {
                // 消息循环转一小会儿(低级钩子必须跑消息循环才会被调用),
                // 然后发 WM_QUIT 退出。
                let mut msg: super::Msg = unsafe { std::mem::zeroed() };
                unsafe {
                    super::PostThreadMessageW(super::windows_thread_id(), 0x0012, 0, 0);
                }
                loop {
                    let r = unsafe { super::GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
                    if r <= 0 {
                        break;
                    }
                }
                unsafe { super::UnhookWindowsHookEx(hook) };
                super::INSTALLED.store(false, std::sync::atomic::Ordering::SeqCst);
            });
            let _ = tx.send(result);
        });
        let result = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("装钩子的线程应该回话");
        assert!(result.is_ok(), "低级键盘钩子应该装得上: {:?}", result.err());
    }
}
