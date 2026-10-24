//! macOS 全局快捷键:自己用事件监听(CGEventTap)实现,**不用系统全局热键**。
//!
//! ## 为什么不用系统的全局热键(Carbon `RegisterEventHotKey`)
//!
//! 用户反馈(两个版本都有):「快捷键的模糊区间比较小,必须按的非常精准才能生效,
//! 有时候很容易多打出一个 D 来」。
//!
//! 根因就在系统热键的匹配规则上:
//!
//! 1. **修饰键必须一模一样**:手上多带一个 Fn / ⌥ / ⌘,组合就对不上。
//!    对不上 ⇒ 系统热键不触发 ⇒ **按键没被吃掉** ⇒ 那个 D 就漏进了当前应用
//!    (用户看到"多打出一个 D");同时动作也没执行(看起来就是"快捷键失灵")。
//! 2. **热键注册之后还在不在、会不会被别的进程抢走,都不归我们管** ——
//!    这正是"用了几次之后快捷键就失效了"这类现象的可能来源。
//!
//! ## 自己监听能拿到什么
//!
//! - 匹配只看"**有没有** Control",多余的修饰键(Fn、⌥、Shift)一律忽略 ⇒ 容错变大;
//! - **把按键吃掉** ⇒ 别的应用收不到,绝不漏出 D;
//! - 被系统禁用(超时)后自己重建 tap ⇒ 不会"用着用着就没了";
//! - 不依赖系统热键注册表 ⇒ 不会被别的进程抢走。
//!
//! 口径与 Electron 版 / Windows 线一致:**⌃S** = 默认执行,**⌃D** = 读剪贴板并键入
//! (只认 Control;判定与 latch 状态机都在**平台无关**的
//! `super::hotkey_core` 里,两个平台跑的是同一份 —— 见 ADR-0025)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use core_foundation::runloop::CFRunLoop;
use core_foundation_sys::runloop::kCFRunLoopDefaultMode;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, EventField,
};

use super::hotkey_core::{self, Hotkey, PrimaryKey, MOD_ALT, MOD_CONTROL, MOD_META, MOD_SHIFT};

/// macOS **虚拟键码**(不是字符):S=1、D=2。
const KEY_S: i64 = 1;
const KEY_D: i64 = 2;

/// macOS 的事件标志位 → **平台无关**的修饰键掩码。
fn flags_to_mods(flags: CGEventFlags) -> u8 {
    let mut mods = 0u8;
    if flags.contains(CGEventFlags::CGEventFlagShift) {
        mods |= MOD_SHIFT;
    }
    if flags.contains(CGEventFlags::CGEventFlagControl) {
        mods |= MOD_CONTROL;
    }
    if flags.contains(CGEventFlags::CGEventFlagAlternate) {
        mods |= MOD_ALT;
    }
    if flags.contains(CGEventFlags::CGEventFlagCommand) {
        mods |= MOD_META;
    }
    mods
}

/// macOS 的虚拟键码 → **平台无关**的主键。
fn primary_of(keycode: i64) -> PrimaryKey {
    match keycode {
        KEY_S => PrimaryKey::S,
        KEY_D => PrimaryKey::D,
        _ => PrimaryKey::Other,
    }
}

#[derive(Default)]
struct TapState {
    /// tap 是否活着
    alive: bool,
    /// 起不来的原因
    error: String,
    /// 已经吞掉 keydown 的键码 —— 对应的 keyup 也要吞,不然应用会收到"没有 keydown 的 keyup"
    pending_keyups: Vec<i64>,
}

/// tap 的状态(运行自检用)。
static STATE: OnceLock<Mutex<TapState>> = OnceLock::new();

fn state() -> &'static Mutex<TapState> {
    STATE.get_or_init(|| Mutex::new(TapState::default()))
}

/// tap 是否活着。
pub fn is_alive() -> bool {
    state().lock().map(|s| s.alive).unwrap_or(false)
}

/// 起不来的原因(空串 = 没有问题)。
pub fn last_error() -> String {
    state().lock().map(|s| s.error.clone()).unwrap_or_default()
}

/// 事件是不是我们要的组合键。
///
/// 判定本身在**平台无关**的 `super::hotkey_core::match_hotkey` 里
/// (只认 Control:不多要 Shift、不认 Command),这里只负责把
/// macOS 的键码与事件标志翻译成平台无关的表示。
fn match_hotkey(event: &CGEvent) -> Option<Hotkey> {
    let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
    hotkey_core::match_hotkey(primary_of(keycode), flags_to_mods(event.get_flags()))
}

/// 启动快捷键监听(独立线程 + 自己的 run loop,和录制那一套一样)。
///
/// 返回 `Ok(true)` = tap 已经建好并且在跑。
pub fn start(app: tauri::AppHandle) -> Result<bool, String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let handle = thread::Builder::new()
        .name("cnc-hotkey".to_string())
        .spawn(move || {
            loop {
                let tap = match build_tap(app.clone()) {
                    Ok(t) => t,
                    Err(e) => {
                        if let Ok(mut s) = state().lock() {
                            s.alive = false;
                            s.error = e.clone();
                        }
                        let _ = tx.send(Err(e));
                        return;
                    }
                };
                let rl = CFRunLoop::get_current();
                let source = match tap.mach_port.create_runloop_source(0) {
                    Ok(s) => s,
                    Err(_) => {
                        let _ = tx.send(Err("快捷键监听启动失败".to_string()));
                        return;
                    }
                };
                rl.add_source(&source, unsafe { kCFRunLoopDefaultMode });
                tap.enable();
                if let Ok(mut s) = state().lock() {
                    s.alive = true;
                    s.error.clear();
                }
                let _ = tx.send(Ok(()));
                CFRunLoop::run_current();

                // run loop 退出 = 系统把 tap 关了(超时/用户输入)⇒ 重建它。
                // 不重建的话,快捷键就"用着用着没了"。
                if let Ok(mut s) = state().lock() {
                    s.alive = false;
                }
                thread::sleep(Duration::from_millis(300));
            }
        })
        .map_err(|e| format!("启动快捷键监听线程失败: {}", e))?;

    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => {
            // 线程要一直活着(它跑着 run loop);丢弃 JoinHandle = 脱离等待。
            drop(handle);
            Ok(true)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("快捷键监听启动超时".to_string()),
    }
}

/// 建 tap(带回调)。
fn build_tap(app: tauri::AppHandle) -> Result<CGEventTap<'static>, String> {
    CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        // **Default = 主动监听**:可以**吞掉事件**。
        // 只有主动 tap 才能做到"按键不漏进别的应用"(系统热键是系统替你吞,
        // 一旦匹配不上就漏出去了)。主动 tap 需要「辅助功能」权限 —— 本应用有。
        CGEventTapOptions::Default,
        vec![CGEventType::KeyDown, CGEventType::KeyUp],
        move |_proxy, etype, event| {
            match etype {
                CGEventType::KeyDown => {
                    // 长按时的自动重复:同一组合键不该反复触发
                    if event
                        .get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT)
                        != 0
                    {
                        return None;
                    }
                    let keycode =
                        event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                    if let Some(hotkey) = match_hotkey(event) {
                        // 记住 keyup 也要吞
                        if let Ok(mut s) = state().lock() {
                            s.pending_keyups.push(keycode);
                        }
                        // 动作另起线程跑:tap 回调里不能做慢活,
                        // 超时系统会直接把这个 tap 关掉。
                        let app = app.clone();
                        thread::spawn(move || match hotkey {
                            Hotkey::Execute => {
                                let _ = crate::commands::shortcuts::trigger_default_execute(&app);
                            }
                            Hotkey::Paste => {
                                let _ = crate::commands::shortcuts::trigger_pinyin_from_clipboard(&app);
                            }
                        });
                        crate::commands::shortcuts::record_shortcut_hit(
                            hotkey.label(),
                            "命中(按键已吞掉)",
                        );
                        // 返回 None = **吞掉这个按键** ⇒ 别的应用收不到,不会多打出 D
                        return None;
                    }
                    None
                }
                CGEventType::KeyUp => {
                    let keycode =
                        event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                    if let Ok(mut s) = state().lock() {
                        if let Some(pos) = s.pending_keyups.iter().position(|k| *k == keycode) {
                            s.pending_keyups.remove(pos);
                            return None; // 配套的 keyup 也要吞
                        }
                    }
                    None
                }
                // 系统把 tap 关了(超时/用户输入):退出 run loop,外层重建
                CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                    CFRunLoop::get_current().stop();
                    None
                }
                _ => None,
            }
        },
    )
    .map_err(|_| "无法创建快捷键事件监听(通常是系统没给「辅助功能」权限)".to_string())
}

/// 停止监听(退出 App 时用)。
pub fn stop() {
    if let Ok(mut s) = state().lock() {
        s.alive = false;
    }
}

/// 供运行自检读:当前状态。
pub fn diagnostics() -> serde_json::Value {
    serde_json::json!({
        "alive": is_alive(),
        "error": last_error(),
    })
}

/// 原子开关(给上层看"我们期望它在跑")。
static EXPECTED: AtomicBool = AtomicBool::new(false);

/// 记录"我们期望监听在跑"(启动时置 true)。
pub fn set_expected(v: bool) {
    EXPECTED.store(v, Ordering::SeqCst);
}

/// 是否期望监听在跑。
pub fn expected() -> bool {
    EXPECTED.load(Ordering::SeqCst)
}
