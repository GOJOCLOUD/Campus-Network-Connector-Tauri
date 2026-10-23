//! 回放:把录制文件里的点击序列按顺序执行一遍。
//!
//! 与 Electron 版 `main.js` 的 `play:playFile` / `play:playData` 逐步对齐:
//!
//! ```text
//! Electron main.js:511 playClicks
//!   for (i, c) in clicks:
//!       mouseClick(c.x, c.y)
//!       sleep(100)
//!       if (inputs[i]) { sleep(100); sendText(inputs[i]) }
//!       if (i < len-1) sleep(max(50, interval*1000))
//! ```
//!
//! 输入文本的取法也和 Electron 一致:
//!   - 只要**任意一条**点击带 `input_text` → 逐条按各自的 `input_text` 键入
//!   - 否则把调用方传进来的整段文本当作**第一条**点击的输入
//!
//! 回放是**异步**的:命令立刻返回"开始执行",真正的点击在后台线程里跑
//! (Electron 版也是这么做的 —— 不然界面会被长回放卡住)。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;

use super::app as appcmd;
use super::native;

/// 一次点击在回放里的等待时间(与 Electron 版一致)。
const AFTER_CLICK_MS: u64 = 100;
const BEFORE_TEXT_MS: u64 = 100;
const MIN_GAP_MS: u64 = 50;

/// 回放是否正在进行(重入保护)。
///
/// ⚠️ **这是 2026-10-23 T0 事故的第二道闸,不能去掉。**
///
/// 事故经过:回放时发出的**合成点击**如果落在 App 自己的窗口上,
/// 就会点到自己界面上的「默认执行」按钮 → 又起一次回放 → 再点自己 →
/// **无限自激循环** → 疯狂敲键盘 → 整台机器卡死(用户被迫强制关机)。
///
/// 这道闸保证:**同一时刻最多一个回放**。不管多少触发源(界面按钮、
/// 全局快捷键、界面里的 ⌃S),后来的那些一律**拒绝**,不再起线程。
static PLAYING: AtomicBool = AtomicBool::new(false);

/// 因为"已经在放了"而被拒绝的回放次数(诊断用)。
static REJECTED: AtomicU64 = AtomicU64::new(0);

/// 回放期间让窗口**穿透**(不接收鼠标事件),返回有没有成功。
///
/// ## 为什么必须有它
///
/// App 的窗口是 always-on-top 的小面板,**常常正好盖在目标网站的输入框上面**。
/// 回放要点击的位置如果落在自己窗口上:
/// - 不穿透 ⇒ 那个点击变成**点自己** ⇒ 点中自己的「默认执行」⇒ 又一次回放
///   ⇒ **无限自激循环**(2026-10-23 T0)⇒ 疯狂键入 ⇒ 机器卡死;
/// - 而"跳过落在自己窗口上的点击"也不行 ⇒ 那些点击往往**正是要点的输入框**,
///   跳过了回放就点不进去(功能缺失)。
///
/// 穿透成功 ⇒ 点击**正常落到下面的应用** ⇒ 既不自激,回放也完整。
/// 穿透失败(平台不支持 / 没权限)⇒ 退回"跳过落在自己窗口上的点击"。
fn set_window_passthrough(app: &Option<AppHandle>, ignore: bool) -> bool {
    let Some(app) = app else {
        return false;
    };
    use tauri::Manager;
    match app.get_webview_window("main") {
        Some(w) => w.set_ignore_cursor_events(ignore).is_ok(),
        None => false,
    }
}

/// 回放进行中吗(诊断/界面用)。
pub fn is_playing() -> bool {
    PLAYING.load(Ordering::SeqCst)
}

/// 被拒绝的回放次数(诊断用)。
pub fn rejected_count() -> u64 {
    REJECTED.load(Ordering::SeqCst)
}

/// 回放线程结束时自动把 `PLAYING` 复位、窗口恢复可点(哪怕线程 panic 了)。
struct PlayingGuard {
    /// 回放用的 AppHandle(恢复穿透时要用)
    app: Option<AppHandle>,
}

impl Drop for PlayingGuard {
    fn drop(&mut self) {
        PLAYING.store(false, Ordering::SeqCst);
        // 窗口恢复可点 —— 不恢复的话,用户会以为界面坏了。
        set_window_passthrough(&self.app, false);
    }
}

/// 最近一次「两道闸」自检的结果(写进 diag.json)。
static GUARD_CHECK: OnceLock<Mutex<Option<serde_json::Value>>> = OnceLock::new();

/// 记下最近一次自检结果。
pub fn set_guard_check(v: serde_json::Value) {
    if let Ok(mut slot) = GUARD_CHECK.get_or_init(|| Mutex::new(None)).lock() {
        *slot = Some(v);
    }
}

/// 最近一次自检结果。
pub fn guard_check() -> Option<serde_json::Value> {
    GUARD_CHECK.get().and_then(|s| s.lock().ok().and_then(|v| v.clone()))
}

/// 最近一次回放的状态。
///
/// 为什么要有它:"点了默认执行,屏幕上什么都没动"这种问题,光看界面分不清
/// 是没开始、还是开始了但发不出事件。把事实记下来写进运行自检,才能判断。
#[derive(Clone, Debug, Default)]
pub struct PlaybackStatus {
    /// 回放的文件名(直接回放数据时为空)
    pub file: String,
    /// 计划执行的点击条数
    pub clicks: usize,
    /// 真正发出点击的条数(发不出去会计 0,并把原因写进 error)
    pub executed: usize,
    /// 因为**落点在自己窗口上**而被丢掉的条数(没发出去)
    pub skipped: usize,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    /// 出错原因(空 = 没出错)
    pub error: String,
}

static LAST_STATUS: OnceLock<Mutex<Option<PlaybackStatus>>> = OnceLock::new();

fn status_slot() -> &'static Mutex<Option<PlaybackStatus>> {
    LAST_STATUS.get_or_init(|| Mutex::new(None))
}

/// 最近一次回放的状态。
pub fn last_status() -> Option<PlaybackStatus> {
    status_slot().lock().ok().and_then(|s| s.clone())
}

fn set_status(status: PlaybackStatus) {
    if let Ok(mut slot) = status_slot().lock() {
        *slot = Some(status);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 按 Electron 的口径取出"每条点击要键入的文本"。
///
/// 返回 `None` = 整段都不键入;返回 `Some(list)` = 第 i 条键入 `list[i]`。
pub fn resolve_inputs(clicks: &[Value], input_text: Option<&str>) -> Option<Vec<Option<String>>> {
    // Electron: clicks.map(c => c.input_text || null) —— 空串等同于没有
    let per_click: Vec<Option<String>> = clicks
        .iter()
        .map(|c| {
            c.get("input_text")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .collect();

    let has_per_click = per_click.iter().any(|t| t.is_some());
    if has_per_click {
        return Some(per_click);
    }
    // 否则:整段文本只给第一条
    match input_text.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => {
            let mut list = vec![None; clicks.len()];
            if let Some(first) = list.first_mut() {
                *first = Some(text.to_string());
            }
            Some(list)
        }
        None => None,
    }
}

/// 执行点击序列(在当前线程里跑)。
///
/// 返回 `(真正发出的点击数, 被丢掉的点击数, 出错原因)`;
/// 发不出去时把原因带回来(不能"假装成功")。
///
/// ⚠️ **落点在自己窗口里的点击会被丢掉、不发出去。**
/// 原因见 `PLAYING` 那段注释:回放打到自己的界面 = 自激循环 = 机器卡死。
/// 排除矩形用的是**录制那套实时维护的矩形**(窗口一移动/变高就刷新),
/// 所以窗口挪到哪儿,回放都知道。
pub fn run_clicks(
    clicks: &[Value],
    interval: f64,
    inputs: Option<&[Option<String>]>,
    skip_own_window: bool,
) -> (usize, usize, String) {
    run_clicks_with(clicks, interval, inputs, native::mouse_click, skip_own_window)
}

/// 同 `run_clicks`,但**点击怎么发由调用方决定**。
///
/// 为什么要留这个口子:**单测不能真的往屏幕上点**。
/// 直接用 `native::mouse_click` 的话,单测在**有**「辅助功能」权限的机器上
/// (比如 CI runner)会真的把点击发出去 —— 既污染环境,又让断言依赖环境
/// (「发不出去」这种假设在 CI 上不成立,2026-10-23 就踩过)。
/// 单测传一个假的发送器:零副作用、跨环境稳定。
fn run_clicks_with<F>(
    clicks: &[Value],
    interval: f64,
    inputs: Option<&[Option<String>]>,
    mut send: F,
    skip_own_window: bool,
) -> (usize, usize, String)
where
    F: FnMut(f64, f64) -> Result<bool, String>,
{
    let gap_ms = MIN_GAP_MS.max((interval.max(0.0) * 1000.0) as u64);
    let mut executed = 0usize;
    let mut skipped = 0usize;
    let mut error = String::new();
    for (i, c) in clicks.iter().enumerate() {
        let x = c.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = c.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        // 每一步都重新读一次矩形(窗口可能正在被用户拖动)。
        //
        // **只有在窗口没穿透时才需要跳过**:穿透了的话,点击会正常落到
        // 下面的应用上(那才是回放要点的目标),跳过反而会让回放少点几下
        // —— 而那些点击往往正是"点进输入框"的位置。
        let rect = if skip_own_window {
            native::rec::exclude_rect()
        } else {
            None
        };
        if native::in_exclude(&rect, x, y) {
            // 落点在自己窗口上 ⇒ **不发**。发出去就是点自己界面的按钮。
            skipped += 1;
        } else {
            match send(x, y) {
                Ok(_) => executed += 1,
                Err(e) => {
                    // 第一次失败就记下来,但**继续往下走** —— 后面的点击可能还是能发
                    if error.is_empty() {
                        error = e;
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(AFTER_CLICK_MS));

        if let Some(list) = inputs {
            if let Some(Some(text)) = list.get(i) {
                thread::sleep(Duration::from_millis(BEFORE_TEXT_MS));
                if let Err(e) = native::send_text(text.clone()) {
                    if error.is_empty() {
                        error = e;
                    }
                }
            }
        }

        if i + 1 < clicks.len() {
            thread::sleep(Duration::from_millis(gap_ms));
        }
    }
    (executed, skipped, error)
}

/// 后台起一个线程跑回放,立刻返回。
/// 在后台线程里跑回放。
/// 全局快捷键(⌃S)也要用它,所以是 `pub`。
///
/// 返回 `true` = 真的起了回放;`false` = **被拒绝**(上一次回放还没结束)。
/// 调用方要把"被拒绝"如实告诉用户,不能假装开始了。
pub fn spawn_playback(
    app: Option<AppHandle>,
    file: String,
    clicks: Vec<Value>,
    interval: f64,
    inputs: Option<Vec<Option<String>>>,
) -> bool {
    // **重入保护**:已经在放 ⇒ 这次直接拒绝,不另起线程。
    // 没有这道闸,一次自激就能起出成百上千个回放线程 ⇒ 机器卡死。
    if PLAYING.swap(true, Ordering::SeqCst) {
        REJECTED.fetch_add(1, Ordering::SeqCst);
        eprintln!(
            "[playback] 上一次回放还没结束,这次没有重复执行(已拒绝 {} 次)",
            REJECTED.load(Ordering::SeqCst)
        );
        return false;
    }
    // **窗口穿透**:回放期间让窗口不接收鼠标事件,
    // 这样回放的点击能落到下面的目标应用上(见 set_window_passthrough 的说明)。
    let penetrated = set_window_passthrough(&app, true);
    let planned = clicks.len();
    set_status(PlaybackStatus {
        file: file.clone(),
        clicks: planned,
        executed: 0,
        skipped: 0,
        started_at_ms: now_ms(),
        finished_at_ms: 0,
        error: String::new(),
    });
    let handle = thread::Builder::new()
        .name("cnc-playback".to_string())
        .spawn(move || {
            // 线程结束(哪怕 panic)都要把 PLAYING 复位 + 窗口恢复可点,
            // 否则回放再也起不来、而且窗口会一直"点不动"。
            let _guard = PlayingGuard { app: app.clone() };
            // 穿透失败才需要"跳过落在自己窗口上的点击"(兜底)。
            let (executed, skipped, error) =
                run_clicks_with(&clicks, interval, inputs.as_deref(), native::mouse_click, !penetrated);
            let mut st = last_status().unwrap_or_default();
            st.file = file;
            st.executed = executed;
            st.skipped = skipped;
            st.finished_at_ms = now_ms();
            st.error = error;
            set_status(st);
        });
    match handle {
        Ok(h) => {
            // 丢弃 JoinHandle = 脱离等待,回放线程继续在后台跑
            drop(h);
            true
        }
        Err(e) => {
            PLAYING.store(false, Ordering::SeqCst);
            eprintln!("[playback] 起回放线程失败: {}", e);
            false
        }
    }
}

/// 回放一个录制文件。
///
/// ⚠️ **失败一律返回 `{status:"error", message:…}`**,不用 `Err` ——
/// 与 Electron 版(`play:playFile`)**同一形状**(ADR-0013)。
/// 前端只看 `result.status` / `result.message`;返回 `Err` 的话
/// 前端的 `.then` 根本不会执行 ⇒ **用户看不到任何提示**。
#[tauri::command]
pub fn play_file(
    app: AppHandle,
    file_name: String,
    interval: Option<f64>,
    input_text: Option<String>,
) -> Result<Value, String> {
    // read_file 会把 app 拿走,这里先留一份给回放用(回放要靠它开窗口穿透)。
    let app_for_playback = app.clone();
    // read_file 读不到会返回 None(文件不存在 / 解析失败)→ 把原因带给界面
    let data = match appcmd::read_file(app, file_name.clone()) {
        Ok(Some(d)) => d,
        Ok(None) => {
            return Ok(json!({
                "status": "error",
                "message": format!("录制文件 {} 不存在或不是有效的 JSON", file_name),
            }))
        }
        Err(e) => return Ok(json!({ "status": "error", "message": e })),
    };
    let clicks = data
        .get("clicks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if clicks.is_empty() {
        // Electron 版这里会返回"开始执行"然后什么都不做 —— 静默无反应。
        // 这里改成明确报错,免得用户以为在跑。
        return Ok(json!({
            "status": "error",
            "message": format!("录制文件 {} 里没有可执行的点击", file_name),
        }));
    }

    let interval = interval.unwrap_or(0.5);
    let inputs = resolve_inputs(&clicks, input_text.as_deref());
    if !spawn_playback(Some(app_for_playback), file_name.clone(), clicks, interval, inputs) {
        // 被拒绝(上一次回放还没结束)⇒ 如实报错,不能让界面以为"开始执行了"。
        return Ok(json!({
            "status": "error",
            "message": "上一次回放还没结束,这次没有重复执行",
        }));
    }
    Ok(json!({ "status": "success", "message": "开始执行" }))
}

/// 直接回放一段点击数据(不经过文件)。
#[tauri::command]
pub fn play_data(app: AppHandle, clicks: Vec<Value>, interval: Option<f64>) -> Result<Value, String> {
    if clicks.is_empty() {
        return Ok(json!({ "status": "error", "message": "没有可执行的点击" }));
    }
    let interval = interval.unwrap_or(0.5);
    if !spawn_playback(Some(app), String::new(), clicks, interval, None) {
        return Ok(json!({
            "status": "error",
            "message": "上一次回放还没结束,这次没有重复执行",
        }));
    }
    Ok(json!({ "status": "success" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **重入保护**:已经在回放时,再来一次必须被**拒绝**。
    ///
    /// 2026-10-23 T0 事故:回放时发出的合成点击落到 App 自己的界面上 →
    /// 点到「默认执行」→ 又一次回放 → **无限自激循环** → 疯狂输入 →
    /// 整台机器卡死(用户被迫强制关机)。
    /// 这条用例锁住"同一时刻最多一个回放"这条底线。
    #[test]
    fn 回放期间不再起第二个回放() {
        let before = rejected_count();
        // 假装"已经在回放"
        PLAYING.store(true, Ordering::SeqCst);
        let clicks = vec![json!({"x": 10.0, "y": 20.0})];
        let started = spawn_playback(None, "测试".to_string(), clicks, 0.0, None);
        PLAYING.store(false, Ordering::SeqCst); // 复原,别影响别的用例
        assert!(!started, "已经在回放时,这次必须被拒绝");
        assert!(
            rejected_count() > before,
            "被拒绝的次数要记下来(诊断用): {} → {}",
            before,
            rejected_count()
        );
    }

    /// 落点在自己窗口上的点击**不发出去**(否则就是自激循环的燃料)。
    ///
    /// 用**假的发送器**:不真的往屏幕上点。
    /// (2026-10-23 踩过:原来直接调 `native::mouse_click`,在**有**辅助功能权限的
    /// 机器上 —— 比如 CI runner —— 会真的点出去,断言也跟着环境漂。)
    #[test]
    fn 落点在自己窗口的点击被丢掉() {
        // 假装自己窗口在 (100,100)-(200,200)
        native::rec::set_exclude_rect(Some([100.0, 100.0, 200.0, 200.0]));
        let clicks = vec![
            json!({"x": 150.0, "y": 150.0}), // 在窗口里 → 丢掉
            json!({"x": 500.0, "y": 500.0}), // 在窗口外 → 照常发
        ];
        let mut sent: Vec<(f64, f64)> = Vec::new();
        let (executed, skipped, _err) = run_clicks_with(&clicks, 0.0, None, |x, y| {
            sent.push((x, y));
            Ok(true)
        }, true);
        native::rec::set_exclude_rect(None);
        assert_eq!(skipped, 1, "落在自己窗口上的那一条必须被丢掉");
        assert_eq!(executed, 1, "窗口外的那一条要真的去发");
        assert_eq!(
            sent,
            vec![(500.0, 500.0)],
            "只有窗口外那一条真的发出去了,窗口内那条**一个字节都不能发**"
        );
    }
}

/// 自检:回放的两道安全闸(**零副作用**)。
///
/// 验两件事:
/// ① **排除自己窗口**:落点在自己窗口上的点击,回放时**不发出去**;
/// ② **重入保护**:回放还在跑时,再来一次必须被**拒绝**。
///
/// ⚠️ **绝不能拿真实点击去试**:那会点到用户屏幕上。
/// 所以这里的做法是:
/// - 造的落点**全部落在自己窗口内**(真跑起来会被丢掉);
/// - **先断言**这些落点确实会被丢掉 —— 断言不过就**直接返回错误、不起回放**,
///   免得排除逻辑坏了还把点击发出去;
/// - 回放线程里没有 input_text ⇒ 不会键入任何字符。
///
/// 结果写进 diag.json 的 `playback.guardCheck`。
#[tauri::command]
pub fn diagnose_playback_guard(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let rect = crate::commands::native::window_exclude_rect(&app).ok_or("拿不到窗口位置")?;
    let x = (rect[0] + rect[2]) / 2.0;
    let y = (rect[1] + rect[3]) / 2.0;
    // **先断言** —— 断言不过就**不起回放**(绝不让点击发到用户屏幕上)。
    if !crate::commands::native::in_exclude(&Some(rect), x, y) {
        return Err("排除判定没生效,拒绝起回放(否则会真的点到屏幕上)".to_string());
    }
    // **窗口穿透**能不能开?(只开关一下,不涉及任何点击)
    let passthrough_ok = set_window_passthrough(&Some(app.clone()), true);
    set_window_passthrough(&Some(app.clone()), false); // 立刻恢复
    // 20 条落点全在自己窗口内;间隔 50ms ⇒ 回放要跑 ~3 秒,
    // 第二次调用一定撞在它还在跑的时候 ⇒ 应该被拒绝。
    let clicks: Vec<Value> = (0..20).map(|_| json!({"x": x, "y": y})).collect();
    // 刻意传 `None`(不开穿透)⇒ 落点在自己窗口上的点击会被**丢掉**,
    // **一个字节都不会发到用户屏幕上**。
    // 直接用 spawn_playback(它返回"真的起了没有"),不去绕命令层的返回形状。
    let first = spawn_playback(None, "自检".to_string(), clicks.clone(), 0.05, None);
    let second = spawn_playback(None, "自检".to_string(), clicks, 0.05, None);
    // 等回放跑完(20 × (100 + 50) ms + 余量)
    thread::sleep(Duration::from_millis(20 * 150 + 500));
    let st = last_status();
    Ok(json!({
        "firstStarted": first,
        "secondRejected": !second,
        "executed": st.as_ref().map(|s| s.executed),
        "skipped": st.as_ref().map(|s| s.skipped),
        "rejected": rejected_count(),
        "playing": is_playing(),
        "passthroughOk": passthrough_ok,
        "sideEffects": "无:自检**不开**窗口穿透(传 None)⇒ 落点全在自己窗口内被丢掉;没有 input_text(不会键入)",
    }))
}
