//! 全局快捷键的**平台无关**核心 —— macOS 与 Windows 跑的是**同一份**判定与状态机。
//!
//! ## 这个文件为什么单独拎出来
//!
//! 快捷键的行为有两半:
//!
//! 1. **判定**:「这次按键算不算 ⌃S / ⌃D」—— 纯逻辑,不碰系统;
//! 2. **观察**:「系统把这次按键告诉咱们了没有」—— 平台专属
//!    (macOS 是 CGEventTap 的只读事件,Windows 是 `RegisterHotKey` + 轮询 `GetAsyncKeyState`)。
//!
//! 第 1 半是**行为的核心**,必须能被单测直接验 —— 而单测不能碰系统
//! (CI 上没有「辅助功能」权限,构造事件源都可能失败,断言一旦依赖环境就会漂;
//!  2026-10-23 踩过这个坑)。所以第 1 半放这里,第 2 半各平台自己写。
//!
//! ## ⚠️ 这个文件**不许**出现平台专属的东西
//!
//! - 不许 `core_graphics`(macOS 的 CGEvent / CGEventFlags);
//! - 不许 `windows`(Win32 的 `GetAsyncKeyState` / `RegisterHotKey`);
//! - 不许 `#[cfg(target_os = ...)]`。
//!
//! 平台差异要表达成**数据**:各平台把自己的键码与修饰键翻译成这里的
//! [`PrimaryKey`] 与 [`Modifiers`],再交给这里的纯函数。
//!
//! 搬运说明(把本文件原样搬到 `mac` 分支时 mac 那边要改哪几行)见
//! `docs/06-决策/ADR-0025-Windows线与macOS线行为对齐.md`。

use std::time::{Duration, Instant};

// ── 修饰键 ─────────────────────────────────────────────────────────

/// 修饰键掩码的位定义。
///
/// **故意与 Electron 版 `sendKey` 的 flags 位一致**(1=shift 2=control 4=alt 8=meta),
/// 这样「界面发的按键」与「快捷键的判定」用的是同一套约定,不用记两套。
pub const MOD_SHIFT: u8 = 1;
/// Control(⌃)。**快捷键只认它。**
pub const MOD_CONTROL: u8 = 2;
/// Alt / Option(⌥)。
pub const MOD_ALT: u8 = 4;
/// Command / Windows 键(⌘ / ⊞)。
pub const MOD_META: u8 = 8;

/// 两个修饰键集合取**并集**。
///
/// 为什么要取并集:
/// - **跟踪到的** ⇒ 解决「按下有先后、有偏差」的问题;
/// - **事件自带的** ⇒ 覆盖「App 启动之前用户就已经按着修饰键」的情况
///   (那一下我们根本没收到,跟踪不到)。
///
/// 两者取并集,**按键顺序就不再是问题**。
pub fn merge_mods(a: u8, b: u8) -> u8 {
    a | b
}

// ── 主键 ───────────────────────────────────────────────────────────

/// 平台无关的「主键」—— 只有字母 **S** 与 **D** 是快捷键。
///
/// 各平台把自己的键码翻译成这三个值(macOS: CGKeyCode;Windows: VK_*),
/// 核心逻辑只认这三个值,不用知道任何平台细节。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrimaryKey {
    /// 字母 S —— 默认执行(回放选中的录制文件)
    S,
    /// 字母 D —— 读剪贴板并逐字键入
    D,
    /// 其它键:不是快捷键
    Other,
}

// ── 命中的快捷键 ───────────────────────────────────────────────────

/// 命中的快捷键。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hotkey {
    /// ⌃S:默认执行(回放选中的录制文件)
    Execute,
    /// ⌃D:读剪贴板并逐字键入
    Paste,
}

impl Hotkey {
    /// 界面/诊断里用的名字(⌃S / ⌃D)。
    pub fn label(&self) -> &'static str {
        match self {
            Hotkey::Execute => "⌃S",
            Hotkey::Paste => "⌃D",
        }
    }
}

/// 这次按键算不算快捷键(**纯判定**)。
///
/// ## 规则(与 Electron 版、macOS 线同口径)
///
/// **只看「有没有 Control」**:
/// - 不要求 Shift —— 原来要「⌃⇧ + 字母」三根手指一起按,太别扭
///   (2026-10-23 用户要求:「只要按住 Ctrl 再点一下字母」);
/// - 多带一个 Shift **照样触发**(容错);
/// - 不认 Command / Windows 键 —— 界面文案写的就是 `Control+…`,以它为准;
/// - 其余修饰键(Alt 之类)一律忽略。
///
/// 拆成纯函数是为了让单测**不碰系统**。
pub fn match_hotkey(key: PrimaryKey, mods: u8) -> Option<Hotkey> {
    if mods & MOD_CONTROL == 0 {
        return None;
    }
    match key {
        PrimaryKey::S => Some(Hotkey::Execute),
        PrimaryKey::D => Some(Hotkey::Paste),
        PrimaryKey::Other => None,
    }
}

// ── latch(触发许可)─────────────────────────────────────────────────

/// 快捷键的**触发许可**(latch)。
///
/// ## 为什么要有
///
/// 用户的要求:
/// > 「触发之后 Ctrl+D 整个按键就不再会继续影响它了,
/// > 除非下一次重新按住 Ctrl,再点击相应的字母」
///
/// 也就是说:**触发一次就被"消费掉"** —— 之后 Control 还按着、字母再按
/// 也不触发;**必须松开 Control 再重新按住**,才重新武装。
///
/// (不这么做的话,按住 Ctrl 连按 D 会连着触发好几次 —— 而「默认执行」
/// 是**回放**,触发多次就是往屏幕上乱点。)
///
/// ## 规则(**Electron 版 / macOS 线同口径**)
///
/// - 触发 ⇒ `armed = false` 且 `blocked = true`;
/// - **Control 松开** ⇒ `blocked = false`、`armed = true`(彻底解锁);
/// - Control 按下 ⇒ **只有 `blocked == false` 时**才武装。
///
/// 最后一条是关键:主键的 keydown 可能**先于**修饰键事件到达
/// (ADR-0023 记的就是这个乱序)。那时的顺序是「先触发、后收到 Control 按下」——
/// 如果这一下"按下"能把 latch 解开,用户按住 Ctrl 连按就会连着触发,
/// 正好是 latch 要防的事。所以 `blocked` 只能由 **Control 松开**来清。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Latch {
    /// 当前允许触发吗
    armed: bool,
    /// 触发过了,在等 Control 松开
    blocked: bool,
}

impl Latch {
    /// 新建:初始是**允许**触发的(用户第一次按住 Control 就该能触发)。
    pub fn new() -> Self {
        Latch {
            armed: true,
            blocked: false,
        }
    }

    /// Control 的状态变了(按下 / 松开)。
    pub fn on_ctrl_change(&mut self, ctrl_down: bool) {
        if ctrl_down {
            // 按下:有阻塞就不武装(迟到的"按下"不能解除 latch)。
            if !self.blocked {
                self.armed = true;
            }
        } else {
            // 松开:彻底解锁 —— 必须松开再重按,才能再触发。
            self.blocked = false;
            self.armed = true;
        }
    }

    /// 试一次触发:匹配得上 **且** 已武装 ⇒ 触发,并**消费掉**这次许可。
    ///
    /// 返回 `None` = 不触发(没匹配上,或者还锁着)。
    pub fn try_fire(&mut self, matched: Option<Hotkey>) -> Option<Hotkey> {
        let hotkey = matched?;
        if !self.armed {
            return None;
        }
        self.armed = false;
        self.blocked = true;
        Some(hotkey)
    }

    /// 当前是不是允许触发(诊断用)。
    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// 当前是不是「触发过了,在等 Control 松开」(诊断用)。
    pub fn is_blocked(&self) -> bool {
        self.blocked
    }
}

impl Default for Latch {
    fn default() -> Self {
        Latch::new()
    }
}

// ── Control 的边沿检测 ─────────────────────────────────────────────

/// Control 的**边沿检测**。
///
/// ## 为什么要有
///
/// Windows 那边观察 Control 只能**轮询**(`GetAsyncKeyState` 给的是
/// 「现在按着没有」,不是「刚刚按下/松开」)。轮询每 20ms 一次,
/// 而 latch 只关心**状态变化**那一下 —— 每次轮询都回调一次的话,
/// latch 会被反复喂同一个状态(逻辑上没错,但白忙;更重要的是
/// 「松开」那一下必须被当成一次真正的松开,不能被漏掉)。
///
/// 所以这里把「采样 → 是不是边沿」做成**纯函数**:状态没变返回 `None`,
/// 变了才返回 `Some(新状态)`。
///
/// 同样是纯逻辑,所以单测可以在**任何平台**上验(Windows 那边的单测
/// 本机跑不了,但这段逻辑跟 Windows 无关)。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CtrlEdgeDetector {
    /// 上一次采样到的状态(初始 = 没按着)。
    last: bool,
}

impl CtrlEdgeDetector {
    /// 新建:假设 Control 没按着。
    pub fn new() -> Self {
        CtrlEdgeDetector { last: false }
    }

    /// 采样一次。
    ///
    /// 返回 `Some(ctrl_down)` = **状态变了**(按下或松开);
    /// 返回 `None` = 没变,什么都不用做。
    pub fn observe(&mut self, ctrl_down: bool) -> Option<bool> {
        if ctrl_down == self.last {
            return None;
        }
        self.last = ctrl_down;
        Some(ctrl_down)
    }

    /// 上一次采样到的状态。
    pub fn last(&self) -> bool {
        self.last
    }
}

// ── 回头认(顺序无关)────────────────────────────────────────────────

/// 已经按住的键里,有没有哪个**按现在的修饰键**凑成了快捷键。
///
/// 这是"顺序无关"的关键:修饰键**后补齐**时,回头把先按下的那个键认出来
/// (「先按 S,再补 ⌃」也能触发)。
///
/// 返回 `(键码, 命中的快捷键)` —— 键码要留着,调用方拿它去处理配套的 keyup。
///
/// `window` 是**时间窗**:只有"刚刚"(窗口内)按下的键才算 ——
/// 防止"按住 S 打字半分钟,后来按了 ⌃"被误判成快捷键、白白触发一次回放。
///
/// `to_primary` 把平台键码翻译成 [`PrimaryKey`] —— 各平台自己实现。
pub fn find_pending_hotkey<K: Copy>(
    pressed: &[(K, Instant)],
    to_primary: fn(K) -> PrimaryKey,
    mods: u8,
    now: Instant,
    window: Duration,
) -> Option<(K, Hotkey)> {
    pressed
        .iter()
        .filter(|(_, at)| now.duration_since(*at) <= window)
        .find_map(|(key, _)| match_hotkey(to_primary(*key), mods).map(|hk| (*key, hk)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CTRL: u8 = MOD_CONTROL;
    const SHIFT: u8 = MOD_SHIFT;
    const CMD: u8 = MOD_META;

    // ── 判定 ───────────────────────────────────────────────────────

    /// ⌃S / ⌃D 要认得出来 —— **只要 Control 在位**就行。
    #[test]
    fn 认得出两个快捷键() {
        assert_eq!(match_hotkey(PrimaryKey::S, CTRL), Some(Hotkey::Execute));
        assert_eq!(match_hotkey(PrimaryKey::D, CTRL), Some(Hotkey::Paste));
    }

    /// 多带一个 Shift 也照样触发(容错),但**光有 Shift 不算**。
    #[test]
    fn 只认Control_Shift可有可无() {
        assert_eq!(
            match_hotkey(PrimaryKey::S, SHIFT | CTRL),
            Some(Hotkey::Execute)
        );
        assert_eq!(
            match_hotkey(PrimaryKey::D, SHIFT | CTRL),
            Some(Hotkey::Paste)
        );
        assert_eq!(match_hotkey(PrimaryKey::S, SHIFT), None);
        assert_eq!(match_hotkey(PrimaryKey::D, SHIFT), None);
    }

    /// **不认 Command** —— ⌘S 是「保存」、⌘D 是「书签」,不能抢。
    #[test]
    fn 不认Command() {
        assert_eq!(match_hotkey(PrimaryKey::S, CMD), None);
        assert_eq!(match_hotkey(PrimaryKey::D, CMD), None);
        assert_eq!(match_hotkey(PrimaryKey::S, CMD | SHIFT), None);
    }

    /// 一个修饰键都没有 ⇒ 不算。
    ///
    /// 这正是"多打出一个 D"的机制:修饰键没被识别时,前台收到的是裸 D,
    /// 直接打出来。
    #[test]
    fn 没有修饰键的不算快捷键() {
        assert_eq!(match_hotkey(PrimaryKey::S, 0), None);
        assert_eq!(match_hotkey(PrimaryKey::D, 0), None);
    }

    /// 别的键一律不算(哪怕 Control 在位)。
    #[test]
    fn 别的键不算快捷键() {
        assert_eq!(match_hotkey(PrimaryKey::Other, CTRL), None);
    }

    /// 修饰键取并集。
    #[test]
    fn 有效修饰键取并集() {
        assert_eq!(merge_mods(0, CTRL), CTRL);
        assert_eq!(merge_mods(CTRL, 0), CTRL);
        assert_eq!(merge_mods(SHIFT, CTRL), SHIFT | CTRL);
    }

    // ── latch ──────────────────────────────────────────────────────

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
    /// 这正是 ADR-0023 描述的乱序场景:主键的 keydown **先于**修饰键事件
    /// 到达 ⇒ 顺序变成「先触发、后收到 Control 按下」。
    /// 如果那一下"按下"能把 latch 解开,用户按住 Control 连按就会连着触发
    /// —— 正好是 latch 要防的事(「默认执行」是回放,触发多次就是乱点)。
    #[test]
    fn 迟到的Control按下不解锁() {
        let mut latch = Latch::new();
        // 主键先到 ⇒ 触发
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), Some(Hotkey::Paste));
        // 修饰键事件随后才到 ⇒ **不能**重新武装
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

    /// latch 刚建好时是**武装**的 —— 用户第一次按住 Control 就该能触发。
    #[test]
    fn 初始是武装的() {
        let latch = Latch::new();
        assert!(latch.is_armed());
        assert!(!latch.is_blocked());
    }

    // ── Control 边沿检测 ───────────────────────────────────────────

    /// 状态没变就**不**报边沿(轮询每次都回调的话 latch 会被白喂)。
    #[test]
    fn 状态没变不报边沿() {
        let mut d = CtrlEdgeDetector::new();
        assert_eq!(d.observe(false), None);
        assert_eq!(d.observe(false), None);
        assert_eq!(d.observe(true), Some(true));
        assert_eq!(d.observe(true), None);
        assert_eq!(d.observe(false), Some(false));
        assert_eq!(d.observe(false), None);
    }

    /// 边沿检测出来的顺序,正好是 latch 需要的顺序:
    /// 「松开」必须被当成一次真正的松开(否则 latch 永远解不开)。
    #[test]
    fn 边沿顺序喂给latch能解锁() {
        let mut d = CtrlEdgeDetector::new();
        let mut latch = Latch::new();
        // 触发一次
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), Some(Hotkey::Paste));
        assert!(!latch.is_armed());

        // Control 按下 ⇒ **第一次**是边沿(之后按住不动就不再是边沿了)
        assert_eq!(d.observe(true), Some(true));
        for _ in 0..10 {
            assert_eq!(d.observe(true), None, "按住不动不该再报边沿");
        }
        assert!(!latch.is_armed(), "Control 没松开,latch 不该解锁");

        // 松开 ⇒ 有边沿 ⇒ 喂给 latch ⇒ 解锁
        if let Some(down) = d.observe(false) {
            latch.on_ctrl_change(down);
        }
        assert!(latch.is_armed());
        // 于是又能触发了 —— 但仍然只能触发一次
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), Some(Hotkey::Paste));
        assert_eq!(latch.try_fire(Some(Hotkey::Paste)), None);
    }

    // ── 回头认(顺序无关)────────────────────────────────────────────

    /// **顺序无关**:主键先按下、Control 后补齐 —— 也要认成快捷键。
    ///
    /// 这就是用户说的「非得三个同时一起按」的解药:
    /// 按下的先后顺序、人手造成的微小偏差,都不再影响触发。
    #[test]
    fn 修饰键后补齐也能触发() {
        let now = Instant::now();
        let to_primary = |k: u8| match k {
            b'S' => PrimaryKey::S,
            b'D' => PrimaryKey::D,
            _ => PrimaryKey::Other,
        };
        // 先按下了 S(那一刻 Control 还没到位)
        let pressed = vec![(b'S', now)];
        // 还没补上 Control ⇒ 认不出来
        assert_eq!(find_pending_hotkey(&pressed, to_primary, 0, now, WINDOW), None);
        // 补上 Control ⇒ 认出来了
        assert_eq!(
            find_pending_hotkey(&pressed, to_primary, CTRL, now, WINDOW),
            Some((b'S', Hotkey::Execute))
        );
        // D 同理
        let pressed_d = vec![(b'D', now)];
        assert_eq!(
            find_pending_hotkey(&pressed_d, to_primary, CTRL, now, WINDOW),
            Some((b'D', Hotkey::Paste))
        );
    }

    /// 太久以前按下的键不再认 —— 防止"按住 S 打字半分钟,后来按了 Control"
    /// 被误判成快捷键、白白触发一次回放。
    #[test]
    fn 太久的键不认() {
        let to_primary = |k: u8| match k {
            b'S' => PrimaryKey::S,
            _ => PrimaryKey::Other,
        };
        let old = Instant::now();
        let pressed = vec![(b'S', old)];
        let later = old + WINDOW + Duration::from_millis(1);
        assert_eq!(find_pending_hotkey(&pressed, to_primary, CTRL, later, WINDOW), None);
    }

    /// 回头认的时间窗(两秒足够覆盖"三个键连着按")。
    const WINDOW: Duration = Duration::from_millis(2000);
}
