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
//! - 匹配只看"**有没有** ⌃⇧ / ⌘⇧",多余的修饰键(Fn、⌥)一律忽略 ⇒ 容错变大;
//! - **把按键吃掉**(返回 None)⇒ 别的应用收不到,绝不漏出 D;
//! - 被系统禁用(超时)后自己重建 tap ⇒ 不会"用着用着就没了";
//! - 不依赖系统热键注册表 ⇒ 不会被别的进程抢走。
//!
//! 口径与 Electron 版一致:⌃⇧A = 默认执行,⌃⇧D = 读剪贴板并键入。

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

/// macOS **虚拟键码**(不是字符):A=0、D=2。
const KEY_A: i64 = 0;
const KEY_D: i64 = 2;

/// 命中的快捷键。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Hotkey {
    /// ⌃⇧A / ⌘⇧A:默认执行(回放选中的录制文件)
    Execute,
    /// ⌃⇧D / ⌘⇧D:读剪贴板并键入
    Paste,
}

impl Hotkey {
    fn label(&self) -> &'static str {
        match self {
            Hotkey::Execute => "⌃⇧A",
            Hotkey::Paste => "⌃⇧D",
        }
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

/// **自检模式**:命中了也**不执行**真动作。
///
/// 为什么要有:自检要真的按一次 ⌃⇧A,而 ⌃⇧A 的动作是"回放选中的录制文件"
/// —— 那会在用户屏幕上真的点来点去。自检不能有这种副作用。
static DIAG_MODE: AtomicBool = AtomicBool::new(false);

/// 最近一次「按快捷键会不会把 App 搞崩」的自检结果(给 diag.json 看)。
static DIAG_RESULT: OnceLock<Mutex<Option<serde_json::Value>>> = OnceLock::new();

fn diag_result_slot() -> &'static Mutex<Option<serde_json::Value>> {
    DIAG_RESULT.get_or_init(|| Mutex::new(None))
}

/// 打开/关闭自检模式。
pub fn set_diag_mode(v: bool) {
    DIAG_MODE.store(v, Ordering::SeqCst);
}

/// 现在是不是自检模式。
pub fn diag_mode() -> bool {
    DIAG_MODE.load(Ordering::SeqCst)
}

/// 记下最近一次自检结果。
pub fn set_diag_result(value: serde_json::Value) {
    if let Ok(mut slot) = diag_result_slot().lock() {
        *slot = Some(value);
    }
}

/// 最近一次自检结果。
pub fn diag_result() -> Option<serde_json::Value> {
    diag_result_slot().lock().ok().and_then(|s| s.clone())
}

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
/// 只看"有没有 ⌃⇧ / ⌘⇧":多带 Fn、⌥ 之类的一律忽略 —— 这正是系统热键做不到、
/// 也是"必须按得极其精准"的来源。
fn match_hotkey(event: &CGEvent) -> Option<Hotkey> {
    let flags = event.get_flags();
    let shift = flags.contains(CGEventFlags::CGEventFlagShift);
    let ctrl = flags.contains(CGEventFlags::CGEventFlagControl);
    let cmd = flags.contains(CGEventFlags::CGEventFlagCommand);
    if !shift || !(ctrl || cmd) {
        return None;
    }
    let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
    match keycode {
        KEY_A => Some(Hotkey::Execute),
        KEY_D => Some(Hotkey::Paste),
        _ => None,
    }
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
                        // 事件的标志位一起记下来:下次再出"什么事件被当成了快捷键",
                        // 不用再靠猜(2026-10-23 那次事故就靠它定位到了 tap 回调)。
                        let flags = event.get_flags().bits();
                        if diag_mode() {
                            // 自检模式:只记命中,**不执行**真动作
                            // (回放录制文件会在用户屏幕上乱点,自检不能有那种副作用)
                            crate::commands::shortcuts::record_shortcut_hit_detail(
                                hotkey.label(),
                                "命中(自检模式,没执行动作)",
                                Some(flags as u64),
                            );
                            return None;
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
                        crate::commands::shortcuts::record_shortcut_hit_detail(
                            hotkey.label(),
                            "命中(按键已吞掉)",
                            Some(flags as u64),
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

/// 自检:「按一次快捷键会不会把 App 搞崩」。
///
/// 2026-10-23 真机事故的复现脚本。分两步:
/// ① 从**非主线程**读一次当前输入源 —— 这正是当时崩掉的那一步
///    (Carbon TIS 在非主线程上调 → AppKit `dispatch_assert_queue` → SIGTRAP,
///     整个 App 当场消失);
/// ② 在**非主线程**记一次命中 —— 事件 tap 的回调线程走的就是这条路。
///
/// ⚠️ **这个自检不发任何系统级键盘/鼠标事件。**
///
/// 上一版自检往系统里 post 了一个**真的 ⌃⇧A**,结果:
/// 它被用户的前台 App 和 App 自己的界面一起接住 → 触发「默认执行」→
/// 回放录制文件 → 合成点击点回自己的「默认执行」按钮 → **无限自激循环** →
/// 疯狂敲键盘 → 整台机器卡死(用户被迫强制关机,2026-10-23 T0 事故)。
///
/// 自检必须**零副作用**:只在自己进程内走一遍那条会崩的代码路径。
///
/// 结果写进 diag.json 的 `shortcuts.hotkeyTriggerCheck`。
pub fn diagnose_hotkey_trigger() -> Result<serde_json::Value, String> {
    // ① 非主线程读输入源 —— 崩溃那一步的原样复现。
    //    修好之后这里应该**正常返回**(编排到主线程去读),不再把进程带走。
    let probe = thread::spawn(|| crate::commands::native::current_input_source_info())
        .join()
        .map_err(|_| "读输入源的那个线程死了(旧版就是这个症状:整个 App 崩)".to_string())?;
    // ② 非主线程记一次命中 —— tap 回调线程走的正是这条路。
    //    (同上:**只在自己进程内走一遍**,不发任何系统事件。)
    let hit = thread::spawn(|| {
        crate::commands::shortcuts::record_shortcut_hit_detail(
            "⌃⇧A",
            "自检:非主线程记命中",
            None,
        );
    })
    .join()
    .map_err(|_| "记命中那个线程死了(旧版就是这个症状:整个 App 崩)".to_string());
    // 等主线程把输入源那一栏回填完
    thread::sleep(Duration::from_millis(300));
    let hits = crate::commands::shortcuts::shortcut_hits();
    Ok(serde_json::json!({
        "probeThreadRead": probe.is_ok(),
        "probeError": probe.as_ref().err().cloned(),
        "hitRecorded": hit.is_ok(),
        "lastHit": hits.last().cloned(),
        "tapAlive": is_alive(),
        "sideEffects": "无:不发任何系统级键盘/鼠标事件,只在自己进程内走一遍会崩的代码路径",
    }))
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
