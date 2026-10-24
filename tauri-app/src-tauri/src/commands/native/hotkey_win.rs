//! Windows 的全局快捷键:**latch** + 「Control 按下/松开」的观察源。
//!
//! ## 为什么 Windows 要单独写一套
//!
//! macOS 那边是自己用事件监听(CGEventTap)实现的 —— 事件流里既有主键的
//! keydown,也有修饰键的 `FlagsChanged`,所以「Control 松开了没有」是**事件驱动**的。
//!
//! Windows 这边没有等价的事件流:全局热键是系统的 `RegisterHotKey`
//! (tauri-plugin-global-shortcut 用的就是它),它只告诉你
//! 「⌃S 被按下了」,**不告诉你 Control 什么时候松开**。
//! 而 latch 的规则里,「Control 松开」是**唯一**能解开锁的那一下 ——
//! 没有它,latch 一旦锁上就再也解不开,快捷键直接失灵。
//!
//! ## 观察源:`GetAsyncKeyState(VK_CONTROL)` 轮询
//!
//! 选它而不是别的,理由:
//!
//! 1. **不受 `RegisterHotKey` 影响** —— 系统热键只通知「组合键按下了」,
//!    管不着单个修饰键的状态;`GetAsyncKeyState` 读的是**物理按键的真实状态**。
//! 2. **拿到的是真实物理状态** —— 别的应用抢走组合键也不影响它。
//! 3. **没有 `WH_KEYBOARD_LL` 那个风险** —— 低级键盘钩子有
//!    `LowLevelHooksTimeout`(钩子回调太慢会被系统直接摘掉),
//!    而且回调在系统 DLL 的上下文里,出问题很难查。
//!
//! 代价:轮询有间隔(20ms),**极短促的按下/松开有可能被漏掉**。
//! 漏掉的只是「松开」那一下 ⇒ latch 多锁一次 ⇒ 下一次「Control 按下」
//! 也不会解锁(规则就是这样),要等再下一次「松开」。
//! 属于「宁可多锁一次,不可乱触发」的取舍。
//!
//! ## 轮询只做**边沿检测**
//!
//! 每 20ms 都会拿到一次「Control 现在按着没有」,但只有**状态变了**那一下
//! 才值得通知 latch —— 否则 latch 会被反复喂同一个状态。
//! 边沿检测本身是纯逻辑,在 `hotkey_core::CtrlEdgeDetector` 里(任何平台都能单测)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};

use super::hotkey_core::{CtrlEdgeDetector, Hotkey, Latch};

/// 轮询间隔。20ms ≈ 50Hz,CPU 占用可以忽略。
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// 观察源与 latch 的当前状态。
struct State {
    /// 触发许可(与 macOS 线**同一份**状态机,见 `hotkey_core::Latch`)。
    latch: Latch,
    /// Control 的边沿检测器。
    edge: CtrlEdgeDetector,
    /// 观察线程活着吗
    alive: bool,
    /// 起不来的原因(空串 = 没有问题)
    error: String,
    /// 观察源可用吗?
    ///
    /// `false` = 拿不到 Control 的按下/松开 ⇒ **latch 降级为不生效**
    /// (见 `try_fire`)—— 宁可没有 latch,也不能让快捷键永远锁死。
    observer_ok: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            latch: Latch::new(),
            edge: CtrlEdgeDetector::new(),
            alive: false,
            error: String::new(),
            observer_ok: false,
        }
    }
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| Mutex::new(State::default()))
}

/// Control 现在按着没有?
///
/// `GetAsyncKeyState` 返回值的高位(0x8000)=「当前按着」。
/// 这是**只读**的 —— 不发任何系统级输入事件。
fn ctrl_is_down() -> bool {
    // 注意:0x8000 放不进 i16,所以先转成 u16 再取位。
    (unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } as u16) & 0x8000 != 0
}

/// 启动 Control 的观察线程。
///
/// 返回 `Ok(true)` = 观察源已经在跑(latch 生效)。
/// 返回 `Err` = 起不来(线程起不来 / 平台不支持)⇒ 调用方要**如实降级**。
pub fn start() -> Result<bool, String> {
    let handle = thread::Builder::new()
        .name("cnc-ctrl-observer".to_string())
        .spawn(|| {
            loop {
                let down = ctrl_is_down();
                // 边沿检测:状态没变就什么都不做。
                let edge = {
                    let Ok(mut s) = state().lock() else {
                        return;
                    };
                    s.edge.observe(down)
                };
                if let Some(down) = edge {
                    if let Ok(mut s) = state().lock() {
                        s.latch.on_ctrl_change(down);
                    }
                }
                thread::sleep(POLL_INTERVAL);
            }
        })
        .map_err(|e| format!("启动 Control 观察线程失败: {}", e))?;

    if let Ok(mut s) = state().lock() {
        s.alive = true;
        s.error.clear();
        s.observer_ok = true;
    }
    // 线程要一直活着;丢弃 JoinHandle = 脱离等待。
    drop(handle);
    Ok(true)
}

/// 观察源可用吗(latch 是不是真的生效)。
pub fn observer_available() -> bool {
    state().lock().map(|s| s.observer_ok).unwrap_or(false)
}

/// latch 当前是不是**武装着**(诊断用)。
///
/// 诊断口径与 macOS 线一致:「按了快捷键没反应」有两种完全不同的原因 ——
/// ① 系统没把事件送来 / 修饰键不对 ⇒ latch 是武装的,但压根没匹配上;
/// ② latch 还锁着(Control 一直没松开)⇒ **这是设计如此**,等用户松开 Control。
/// 有了这一栏,一眼就能分清是哪一种。
pub fn latch_armed() -> bool {
    state().lock().map(|s| s.latch.is_armed()).unwrap_or(false)
}

/// 这次命中**该不该执行**。
///
/// 规则(与 macOS 线一字不差):
/// - latch 武装着 ⇒ 执行,并**消费掉**这次许可(锁上,等 Control 松开);
/// - latch 还锁着 ⇒ **不执行**(用户按住 Control 连按不会连着触发)。
///
/// ## 降级
///
/// 观察源不可用(拿不到 Control 的按下/松开)⇒ latch **不生效**,一律放行。
/// 理由:没有观察源就永远解不开锁,快捷键会在第一次触发之后**彻底失灵**。
/// 这种情况下宁可没有 latch,也不能没有快捷键 —— 并且要在诊断里说明。
pub fn try_fire(hotkey: Hotkey) -> bool {
    let Ok(mut s) = state().lock() else {
        return true;
    };
    if !s.observer_ok {
        return true;
    }
    s.latch.try_fire(Some(hotkey)).is_some()
}

/// 供运行自检读:当前状态。
pub fn diagnostics() -> serde_json::Value {
    let (alive, error, latch_armed, observer_ok, blocked) = state()
        .lock()
        .map(|s| {
            (
                s.alive,
                s.error.clone(),
                s.latch.is_armed(),
                s.observer_ok,
                s.latch.is_blocked(),
            )
        })
        .unwrap_or((false, String::new(), false, false, false));
    serde_json::json!({
        "alive": alive,
        "error": error,
        // 与 macOS 线**同一个字段名**,同一个含义。
        "latchArmed": latch_armed,
        // Windows 特有的两栏:观察源是什么、latch 是不是真的生效。
        "ctrlObserver": "GetAsyncKeyState(VK_CONTROL)",
        "latchAvailable": observer_ok,
        "latchBlocked": blocked,
    })
}

/// 停止观察(退出 App 时用)。
pub fn stop() {
    if let Ok(mut s) = state().lock() {
        s.alive = false;
    }
}

/// 原子开关(给上层看"我们期望它在跑")。
static EXPECTED: AtomicBool = AtomicBool::new(false);

/// 记录"我们期望观察器在跑"(启动时置 true)。
pub fn set_expected(v: bool) {
    EXPECTED.store(v, Ordering::SeqCst);
}

/// 是否期望观察器在跑。
pub fn expected() -> bool {
    EXPECTED.load(Ordering::SeqCst)
}
