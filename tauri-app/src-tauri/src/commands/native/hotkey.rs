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
//! - **把按键吃掉**(把事件改成 `Null` 类型再交回去)⇒ 别的应用收不到,绝不漏出 D;
//!   ⚠️ 2026-10-23 定位:老代码写的是「返回 None = 吞掉」,而 core-graphics 里
//!   `None` 是**放行** —— 快捷键**从来没被吞过**,每一下都漏给了前台应用。
//! - 被系统禁用(超时)后自己重建 tap ⇒ 不会"用着用着就没了";
//! - 不依赖系统热键注册表 ⇒ 不会被别的进程抢走。
//!
//! 口径与 Electron 版一致:**⌃S** = 默认执行,**⌃D** = 读剪贴板并键入
//! (只认 Control、不认 Command;详见 ADR-0024)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use core_foundation::runloop::CFRunLoop;
use core_foundation_sys::runloop::kCFRunLoopDefaultMode;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, EventField,
};

// **平台无关**的行为核心:「什么算命中」+「触发后要不要等松开 Control」。
//
// macOS 的事件 tap 与 Windows 的全局热键只是"怎么知道键被按下了"不一样,
// 这两件事必须**一字不差** ⇒ 下沉到 `super::hotkey_core`,两个平台跑同一份代码。
use super::hotkey_core::{
    self, Hotkey, Latch, PrimaryKey, MOD_ALT, MOD_CONTROL, MOD_META, MOD_SHIFT,
};

/// macOS **虚拟键码**(不是字符):S=1、D=2。
const KEY_S: i64 = 1;
const KEY_D: i64 = 2;

/// 命中的快捷键 `Hotkey` —— **定义在平台无关的核心里**(两个平台同一份),
/// 这里只做 macOS 侧的适配(见 `flags_to_mods` / `primary_of`)。

struct TapState {
    /// tap 是否活着
    alive: bool,
    /// 起不来的原因
    error: String,
    /// 已经吞掉 keydown 的键码 —— 对应的 keyup 也要吞,不然应用会收到"没有 keydown 的 keyup"
    pending_keyups: Vec<i64>,
    /// **当前按住的修饰键**(由 `FlagsChanged` 累积而来)。
    ///
    /// 为什么不能只看主键 keydown 自带的 flags:那只是"事件到达那一刻"的快照。
    /// 三个键按下有先后、有偏差时,主键的事件完全可能**先于**修饰键的
    /// `FlagsChanged` 到 —— 那一刻 flags 还是空的 ⇒ 匹配不上 ⇒ 那一键
    /// 还漏给前台应用(用户看到"多打出一个 D")。
    /// 跟踪状态就没有顺序问题。
    modifiers: CGEventFlags,
    /// **当前按住的非修饰键**(+ 按下的时刻)。
    ///
    /// 有了它,修饰键**后补齐**时能回头把先按下的那个键认成快捷键
    /// ("先按 S,再补 ⌃"也能触发)。
    ///
    /// 记时刻是为了**只认"刚刚"按下的那个键** —— 否则"按住 A 打字好几秒,
    /// 后来又按了 ⌃"会被误判成快捷键,白白触发一次回放。
    pressed_keys: Vec<(i64, Instant)>,
    /// **触发许可(latch)** —— 见 `Latch`。
    latch: Latch,
}

/// 快捷键的**触发许可(latch)** —— 实现在**平台无关**的核心里
/// (`super::hotkey_core::Latch`),两个平台跑的是**同一份**状态机。
///
/// 规则(与 Electron 版同口径):
/// - 触发 ⇒ `armed = false` 且 `blocked = true`;
/// - **Control 松开** ⇒ `blocked = false`、`armed = true`(彻底解锁);
/// - Control 按下 ⇒ **只有 `blocked == false` 时**才武装。
///
/// 最后一条是关键:主键的 keydown 可能**先于**修饰键的 `FlagsChanged`
/// 到达(见 ADR-0023)。那时的顺序是「先触发、后收到 Control 按下」——
/// 如果这一下"按下"能把 latch 解开,用户按住 Ctrl 连按就会连着触发,
/// 正好是 latch 要防的事。所以 `blocked` 只能由 **Control 松开**来清。
///
/// 为什么抽成纯函数:这段状态机是**行为的核心**,必须能被单测直接验 ——
/// 而单测不能碰系统(ADR-0021)。

/// 回头认的**时间窗**:主键按下后多久之内补齐修饰键还算数。
///
/// 两秒足够覆盖"三个键连着按"(人手的手指间隔远小于这个量级)。
const RECOGNIZE_WINDOW: Duration = Duration::from_millis(2000);

/// "当前按住的键"最多记多少个(兜底:万一漏了 keyup,不至于无限涨)。
const MAX_PRESSED_KEYS: usize = 16;

impl Default for TapState {
    fn default() -> Self {
        TapState {
            alive: false,
            error: String::new(),
            pending_keyups: Vec::new(),
            modifiers: CGEventFlags::empty(),
            pressed_keys: Vec::new(),
            latch: Latch::new(),
        }
    }
}

/// tap 的状态(运行自检用)。
static STATE: OnceLock<Mutex<TapState>> = OnceLock::new();

/// **自检模式**:命中了也**不执行**真动作。
///
/// 为什么要有:自检要真的按一次 ⌃S,而 ⌃S 的动作是"回放选中的录制文件"
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

/// 把事件**丢弃** —— 别的应用收不到它。
///
/// ## ⚠️ 为什么不能直接 `return None`
///
/// core-graphics 的 tap 回调返回 `Option<CGEvent>`,语义是:
/// - `None` = **原样放行**(不是"丢弃"!)
/// - `Some(e)` = 用 `e` **替换**这个事件
///
/// 这个 API **没有"丢弃"这个选项**。想吞掉一个事件,得把它的类型
/// 改成 `CGEventType::Null` 再交回去 —— 系统收到一个 null 事件,
/// 就当什么都没发生过。
///
/// ## 这曾经是个真 bug(2026-10-23 定位)
///
/// 老代码的注释写着「返回 None = **吞掉**这个按键 ⇒ 别的应用收不到,
/// 不会多打出 D」—— **这句是错的**:`None` 在 core-graphics 里是**放行**。
/// 于是快捷键**从来没被吞过**:每一次按键(当时还是 ⌃⇧A / ⌃⇧D,**现已改成 ⌃S / ⌃D**)都完整漏给了前台应用。
/// 用户看到的症状就是「多打出一个 D」(修饰键没被识别时前台收到的是 ⇧D,
/// 直接打出大写 D)—— 这条原始投诉一直**没有**被真正修掉。
fn swallow(event: &CGEvent) -> Option<CGEvent> {
    let dead = event.clone();
    dead.set_type(CGEventType::Null);
    Some(dead)
}

/// CGEventFlags → **平台无关**的修饰键位掩码。
///
/// 共享核心在 u8 位掩码空间里工作(两个平台同一份),
/// macOS 的 `CGEventFlags` 只是一个位集合,转过去即可。
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

/// 事件是不是我们要的组合键(**纯函数版**)。
///
/// 判定规则本身在**平台无关**的核心里(`hotkey_core::match_hotkey`)——
/// macOS 的事件 tap 与 Windows 的全局热键跑的是**同一份**判定。
/// 这里只负责把 macOS 的 `CGEventFlags` / 虚拟键码翻译过去。
///
/// 拆成纯函数也是为了让单测**不碰系统**:单测在 CI 上没有「辅助功能」权限,
/// 连构造事件源都可能失败,断言一旦依赖环境就会漂(2026-10-23 踩过这个坑)。
fn match_hotkey_raw(keycode: i64, flags: CGEventFlags) -> Option<Hotkey> {
    hotkey_core::match_hotkey(primary_of(keycode), flags_to_mods(flags))
}

/// **有效**的修饰键 = 自己跟踪到的 ∪ 事件自带的。
///
/// 为什么取并集:
/// - **跟踪到的**(`FlagsChanged` 累积)⇒ 解决"按下有先后、有偏差"的问题;
/// - **事件自带的**⇒ 覆盖"App 启动之前用户就已经按着修饰键"的情况
///   (那个 `FlagsChanged` 我们根本没收到,跟踪不到)。
///
/// 两者取并集,**按键顺序就不再是问题**。
fn effective_modifiers(tracked: CGEventFlags, from_event: CGEventFlags) -> CGEventFlags {
    tracked | from_event
}

/// 已经按住的键里,有没有哪个**按现在的修饰键**凑成了快捷键。
///
/// 这是"顺序无关"的关键:修饰键**后补齐**时,回头把先按下的那个键认出来。
/// 返回 `(键码, 命中的快捷键)` —— 键码要留着,它的 keyup 也得吞。
///
/// `window` 是**时间窗**:只有"刚刚"(窗口内)按下的键才算 ——
/// 防止"按住 S 打字半分钟,后来按了 ⌃"被误判成快捷键。
///
/// 判定在**平台无关**的核心里(`hotkey_core::find_pending_hotkey`),
/// 这里只做 macOS 的键码/修饰键翻译。
fn find_pending_hotkey(
    pressed: &[(i64, Instant)],
    modifiers: CGEventFlags,
    now: Instant,
    window: Duration,
) -> Option<(i64, Hotkey)> {
    hotkey_core::find_pending_hotkey(
        pressed,
        primary_of,
        flags_to_mods(modifiers),
        now,
        window,
    )
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
                    // 重建的 tap 会**漏掉**中间发生的事件 —— 可能正好包括
                    // Control 的那一下"松开"。带着旧状态继续跑会有两个后果:
                    // - 修饰键状态过期(用户明明松开了,跟踪里还按着);
                    // - latch 卡在"锁着" ⇒ 快捷键**彻底失灵**,用户怎么按都没反应。
                    // 所以重建时把跟踪状态和 latch 一起清掉:
                    // 修饰键清空不影响"用户正按着 Control"的场景 ——
                    // 判定用的是「跟踪到的 ∪ 事件自带的」,事件自带的 flags 仍然算数。
                    s.modifiers = CGEventFlags::empty();
                    s.pressed_keys.clear();
                    s.pending_keyups.clear();
                    s.latch = Latch::new();
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

/// 命中之后:执行动作 + 记一笔。
///
/// ⚠️ 动作**另起线程**跑:tap 回调里不能做慢活,
/// 超时系统会直接把这个 tap 关掉(快捷键就间歇性失灵了)。
fn fire_hotkey(hotkey: Hotkey, app: &tauri::AppHandle, flags: u64) {
    if diag_mode() {
        // 自检模式:只记命中,**不执行**真动作
        // (回放录制文件会在用户屏幕上乱点,自检不能有那种副作用)
        crate::commands::shortcuts::record_shortcut_hit_detail(
            hotkey.label(),
            "命中(自检模式,没执行动作)",
            Some(flags),
        );
        return;
    }
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
        Some(flags),
    );
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
        // `FlagsChanged` 也要听:每次修饰键按下/松开都会发它。
        // **靠它跟踪修饰键状态,才能做到"按键顺序无关"**(见 `effective_modifiers`)。
        vec![
            CGEventType::KeyDown,
            CGEventType::KeyUp,
            CGEventType::FlagsChanged,
        ],
        move |_proxy, etype, event| {
            match etype {
                CGEventType::KeyDown => {
                    // 长按时的自动重复:同一组合键不该反复触发。
                    //
                    // ⚠️ **但这个事件照样要吞掉** —— 放行的话,长按 ⌃S 会一次次
                    // 把 A 漏给前台应用(和"多打出一个 D"是同一类泄漏)。
                    if event
                        .get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT)
                        != 0
                    {
                        return swallow(event);
                    }
                    let keycode =
                        event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                    let event_flags = event.get_flags();
                    // 用**跟踪到的**修饰键 ∪ 事件自带的来判定 ⇒ 顺序无关。
                    let (matched, hotkey, effective) = {
                        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
                        if !s.pressed_keys.iter().any(|(k, _)| *k == keycode) {
                            s.pressed_keys.push((keycode, Instant::now()));
                            if s.pressed_keys.len() > MAX_PRESSED_KEYS {
                                s.pressed_keys.remove(0);
                            }
                        }
                        let effective = effective_modifiers(s.modifiers, event_flags);
                        let matched = match_hotkey_raw(keycode, effective);
                        if matched.is_some() {
                            // 记住 keyup 也要吞
                            s.pending_keyups.push(keycode);
                            // 已经触发过了 ⇒ 从"正按着"里拿掉,
                            // 免得修饰键再变一次时**重复触发**。
                            s.pressed_keys.retain(|(k, _)| *k != keycode);
                        }
                        // **latch**:上一次触发后 Control 没松开过 ⇒ 不再触发。
                        // 匹配上了但锁着 ⇒ `hotkey` 是 None(不触发)。
                        let hotkey = s.latch.try_fire(matched);
                        (matched, hotkey, effective)
                    };
                    if matched.is_some() {
                        if let Some(hotkey) = hotkey {
                            // 标志位一起记下来:下次再出"什么事件被当成了快捷键",
                            // 不用再靠猜(2026-10-23 那次事故就靠它定位到了 tap 回调)。
                            fire_hotkey(hotkey, &app, effective.bits());
                        }
                        // **吞掉** —— 哪怕这次没触发(锁着)。
                        //
                        // 用户要的是「Ctrl+D 整个按键不再继续影响它」:
                        // 放行的话,按住 Ctrl 连按 D 会往前台丢一串 ⌃D。
                        return swallow(event);
                    }
                    None
                }
                CGEventType::KeyUp => {
                    let keycode =
                        event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                    // 配套的 keyup 也要吞 —— 否则别的应用会收到"没有 keydown 的 keyup"。
                    let swallow_it = {
                        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
                        // 这个键不再"按着"了
                        s.pressed_keys.retain(|(k, _)| *k != keycode);
                        match s.pending_keyups.iter().position(|k| *k == keycode) {
                            Some(pos) => {
                                s.pending_keyups.remove(pos);
                                true
                            }
                            None => false,
                        }
                    };
                    if swallow_it {
                        return swallow(event);
                    }
                    None
                }
                // 修饰键变了:更新状态,并**回头看**已经按下的键 ——
                // 这就是"顺序无关"的关键(先按 A、再补 ⌃⇧ 也能触发)。
                CGEventType::FlagsChanged => {
                    let flags = event.get_flags();
                    let fired = {
                        let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
                        // **Control 的按下/松开** ⇒ 更新 latch。
                        // 这是「必须松开 Control 再重按才能再触发」的实现点。
                        //
                        // 注意:按下时**不一定**能解锁 —— 若刚刚已经触发过
                        // (`blocked`),这多半是**迟到**的按下事件(主键先到),
                        // 这时绝不能把 latch 解开,否则按住 Ctrl 连按会连着触发。
                        let ctrl_now = flags.contains(CGEventFlags::CGEventFlagControl);
                        let ctrl_before = s.modifiers.contains(CGEventFlags::CGEventFlagControl);
                        s.modifiers = flags;
                        if ctrl_now != ctrl_before {
                            s.latch.on_ctrl_change(ctrl_now);
                        }
                        // 回头看已经按下的键(顺序无关)
                        let found = find_pending_hotkey(
                            &s.pressed_keys,
                            flags,
                            Instant::now(),
                            RECOGNIZE_WINDOW,
                        );
                        let mut fired = None;
                        if let Some((keycode, hotkey)) = found {
                            if s.latch.try_fire(Some(hotkey)).is_some() {
                                // 触发过了 ⇒ 从"正按着"里拿掉,避免重复触发;
                                // 它的 keyup 也要吞。
                                s.pressed_keys.retain(|(k, _)| *k != keycode);
                                s.pending_keyups.push(keycode);
                                fired = Some(hotkey);
                            }
                        }
                        fired
                    };
                    if let Some(hotkey) = fired {
                        fire_hotkey(hotkey, &app, flags.bits());
                    }
                    // `FlagsChanged` 本身不是按键,不用吞。
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

/// latch 当前是不是**武装着**(诊断用)。
///
/// 诊断口径:「按了快捷键没反应」有两种完全不同的原因 ——
/// ① 系统没把事件送来 / 修饰键不对 ⇒ latch 是武装的,但压根没匹配上;
/// ② latch 还锁着(Control 一直没松开)⇒ **这是设计如此**,等用户松开 Control。
/// 有了这一栏,一眼就能分清是哪一种。
pub fn latch_armed() -> bool {
    state().lock().map(|s| s.latch.is_armed()).unwrap_or(false)
}

/// 供运行自检读:当前状态。
pub fn diagnostics() -> serde_json::Value {
    serde_json::json!({
        "alive": is_alive(),
        "error": last_error(),
        "latchArmed": latch_armed(),
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
/// 上一版自检往系统里 post 了一个**真的快捷键组合**(当时是 ⌃⇧A,**现已改成 ⌃S**),结果:
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
            "⌃S",
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

#[cfg(test)]
mod tests {
    use super::*;

    const SHIFT: CGEventFlags = CGEventFlags::CGEventFlagShift;
    const CTRL: CGEventFlags = CGEventFlags::CGEventFlagControl;
    const CMD: CGEventFlags = CGEventFlags::CGEventFlagCommand;

    /// ⌃S / ⌃D 要认得出来 —— **只要 Control 在位**就行。
    #[test]
    fn 认得出两个快捷键() {
        assert_eq!(match_hotkey_raw(KEY_S, CTRL), Some(Hotkey::Execute));
        assert_eq!(match_hotkey_raw(KEY_D, CTRL), Some(Hotkey::Paste));
    }

    /// 多带一个 Shift 也照样触发(容错),但**光有 Shift 不算**。
    #[test]
    fn 只认Control_Shift可有可无() {
        assert_eq!(match_hotkey_raw(KEY_S, SHIFT | CTRL), Some(Hotkey::Execute));
        assert_eq!(match_hotkey_raw(KEY_D, SHIFT | CTRL), Some(Hotkey::Paste));
        assert_eq!(match_hotkey_raw(KEY_S, SHIFT), None);
        assert_eq!(match_hotkey_raw(KEY_D, SHIFT), None);
    }

    /// **不认 Command** —— ⌘S 是「保存」、⌘D 是「书签」,不能抢。
    #[test]
    fn 不认Command() {
        assert_eq!(match_hotkey_raw(KEY_S, CMD), None);
        assert_eq!(match_hotkey_raw(KEY_D, CMD), None);
        assert_eq!(match_hotkey_raw(KEY_S, CMD | SHIFT), None);
    }

    /// 一个修饰键都没有 ⇒ 不算。
    ///
    /// 这正是"多打出一个 D"的机制:修饰键没被识别时,前台收到的是裸 D,
    /// 直接打出来。我们的 tap 不能把它当快捷键 —— 但真正要解决的是
    /// **别让它漏出去**(见 `swallow`)。
    #[test]
    fn 没有修饰键的不算快捷键() {
        assert_eq!(match_hotkey_raw(KEY_S, CGEventFlags::empty()), None);
        assert_eq!(match_hotkey_raw(KEY_D, CGEventFlags::empty()), None);
    }

    /// 不是 S / D 的键一律不算(哪怕 Control 在位)。
    #[test]
    fn 别的键不算快捷键() {
        for keycode in [0i64, 8, 36, 49] {
            assert_eq!(
                match_hotkey_raw(keycode, CTRL),
                None,
                "键码 {} 不该被当成快捷键",
                keycode
            );
        }
    }

    /// **latch**:触发一次之后,Control 还按着也不许再触发;
    /// **必须松开 Control 再重新按住**才恢复。
    ///
    /// 用户原话:「触发之后 Ctrl+D 整个按键就不再会继续影响它了,
    /// 除非下一次重新按住 Ctrl,再点击相应的字母」。
    #[test]
    fn 触发一次后必须重新按住Control() {
        let mut latch = Latch::new();
        // 第一次:匹配上了 ⇒ 触发
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), Some(Hotkey::Paste));
        // Control 还按着,再按 D ⇒ **不触发**
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), None);
        // 别的字母也一样不触发
        assert_eq!(latch.try_fire(Some(Hotkey::Execute)), None);
        // Control 松开 ⇒ 彻底解锁
        latch.on_ctrl_change(false);
        assert!(latch.is_armed());
        // 重新按住 Control ⇒ 又是"武装"状态
        latch.on_ctrl_change(true);
        // 于是又可以触发了 —— 但仍然只能触发一次
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), Some(Hotkey::Paste));
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), None);
    }

    /// **迟到的「Control 按下」不能解除 latch。**
    ///
    /// 这正是 ADR-0023 描述的乱序场景:主键的 keydown **先于**修饰键的
    /// `FlagsChanged` 到达 ⇒ 顺序变成「先触发、后收到 Control 按下」。
    /// 如果那一下"按下"能把 latch 解开,用户按住 Control 连按就会连着触发
    /// —— 正好是 latch 要防的事(「默认执行」是回放,触发多次就是乱点)。
    #[test]
    fn 迟到的Control按下不解锁() {
        let mut latch = Latch::new();
        // 主键先到 ⇒ 触发
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), Some(Hotkey::Paste));
        // 修饰键的 FlagsChanged 随后才到 ⇒ **不能**重新武装
        latch.on_ctrl_change(true);
        assert!(!latch.is_armed(), "迟到的 Control 按下不该解除 latch");
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), None);
        // Control 松开 ⇒ 才能重新武装
        latch.on_ctrl_change(false);
        assert!(latch.is_armed());
        latch.on_ctrl_change(true);
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), Some(Hotkey::Paste));
    }

    /// 没匹配上就不触发(也不消费 latch)。
    #[test]
    fn 没匹配上不消费latch() {
        let mut latch = Latch::new();
        assert_eq!(latch.try_fire(None), None);
        assert!(latch.is_armed(), "没匹配上不该把许可消费掉");
        assert_eq!(latch.try_fire(Some(Hotkey::Execute)), Some(Hotkey::Execute));
    }

    /// **顺序无关**:主键先按下、Control 后补齐 —— 也要认成快捷键。
    ///
    /// 这就是用户说的「非得三个同时一起按」的解药:
    /// 按下的先后顺序、人手造成的微小偏差,都不再影响触发。
    #[test]
    fn 修饰键后补齐也能触发() {
        let now = Instant::now();
        // 先按下了 S(那一刻 Control 还没到位)
        let pressed = vec![(KEY_S, now)];
        // 还没补上 Control ⇒ 认不出来
        assert_eq!(
            find_pending_hotkey(&pressed, CGEventFlags::empty(), now, RECOGNIZE_WINDOW),
            None
        );
        // 补上 Control ⇒ 认出来了
        assert_eq!(
            find_pending_hotkey(&pressed, CTRL, now, RECOGNIZE_WINDOW),
            Some((KEY_S, Hotkey::Execute))
        );
        // D 同理
        let pressed_d = vec![(KEY_D, now)];
        assert_eq!(
            find_pending_hotkey(&pressed_d, CTRL, now, RECOGNIZE_WINDOW),
            Some((KEY_D, Hotkey::Paste))
        );
    }

    /// 太久以前按下的键不再认 —— 防止"按住 S 打字半分钟,后来按了 Control"
    /// 被误判成快捷键、白白触发一次回放。
    #[test]
    fn 太久的键不认() {
        let old = Instant::now();
        let pressed = vec![(KEY_S, old)];
        let later = old + RECOGNIZE_WINDOW + Duration::from_millis(1);
        assert_eq!(
            find_pending_hotkey(&pressed, CTRL, later, RECOGNIZE_WINDOW),
            None
        );
    }

    /// 有效修饰键 = 跟踪到的 ∪ 事件自带的。
    ///
    /// - **跟踪到的**:解决"按下有先后"的问题;
    /// - **事件自带的**:覆盖"App 启动前用户就已经按着 Control"
    ///   (那个 `FlagsChanged` 我们根本没收到,跟踪不到)。
    #[test]
    fn 有效修饰键取并集() {
        assert_eq!(effective_modifiers(CGEventFlags::empty(), CTRL), CTRL);
        assert_eq!(effective_modifiers(CTRL, CGEventFlags::empty()), CTRL);
        assert_eq!(effective_modifiers(SHIFT, CTRL), SHIFT | CTRL);
    }
}
