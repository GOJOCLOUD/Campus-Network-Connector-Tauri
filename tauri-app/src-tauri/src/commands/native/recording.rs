//! macOS 录制:CGEventTap 监听左键点击。
//!
//! 忠实移植 Electron 版的 `mac-coregraphics/src/main.mm`:
//!   - `kCGSessionEventTap` + `kCGHeadInsertEventTap` + `kCGEventTapOptionDefault`
//!   - 只监听 `kCGEventLeftMouseDown`
//!   - 排除自身窗口矩形(不然"点开始录制"这个动作自己也会被录进去)
//!   - 每次点击记 `{x, y, timestamp}`,timestamp 是**距录制开始的秒数**
//!   - tap 建不起来 / 被系统禁用 → tapFailed
//!
//! ## 与 C++ 版的一处有意差异
//!
//! C++ 版 `startRecording` 立刻返回 `true`,tap 到底建没建起来要靠轮询 `tapFailed`
//! 才知道 —— 界面于是显示"录制已开始",但其实一个点击都录不到(**静默失败**)。
//!
//! 这里改成**同步等 tap 建好再返回**:建不起来就直接报错,让界面显示真实原因
//! (最常见的是系统没给「辅助功能」权限)。
//!
//! ## 为什么不用 `.node` 插件
//!
//! Tauri 没有 Node,也就没有 N-API;这块能力整个用 Rust 重写,
//! 不再需要 asarUnpack(见 ADR-0003)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use core_foundation::runloop::CFRunLoop;
use core_foundation_sys::runloop::kCFRunLoopDefaultMode;
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};

/// 一次点击。
#[derive(Clone, Copy, Debug)]
pub struct ClickEvent {
    /// 屏幕全局坐标 x
    pub x: f64,
    /// 屏幕全局坐标 y
    pub y: f64,
    /// 距录制开始的秒数
    pub timestamp: f64,
}

struct Recorder {
    clicks: Mutex<Vec<ClickEvent>>,
    recording: AtomicBool,
    tap_failed: AtomicBool,
    /// 自身窗口矩形 `[left, top, right, bottom]`(屏幕全局坐标,
    /// **逻辑点**、左上角为原点),落在这个范围里的点击不记。
    ///
    /// **这个矩形必须始终是最新的**,不能只在开始录制时拍一张快照:
    /// ① Tauri 的窗口是**贴合内容**的 —— 录制列表一出现,内容变高,
    ///    窗口就**向上长**(Cocoa 的 setContentSize 固定的是左下角),
    ///    顶边跟着往上跑,「结束」按钮于是跑出了开始时那张快照;
    /// ② 窗口还能被用户拖走。
    /// 结果就是:点自己界面上的按钮(尤其「结束」)被当成一次外部点击记下来。
    ///
    /// 现在由 App 层在窗口**每次移动/变高**时刷新(见 lib.rs 的 on_window_event),
    /// 点击判定用的永远是当前这一张。
    exclude: Mutex<Option<[f64; 4]>>,
    start: Mutex<Option<Instant>>,
    /// 最近一次「点自己界面上的按钮会不会被记成一次点击」自检的结果
    diag_result: Mutex<Option<serde_json::Value>>,
    /// 录制线程的 run loop —— 停止录制时从别的线程叫醒它
    run_loop: Mutex<Option<CFRunLoop>>,
}

fn recorder() -> &'static Arc<Recorder> {
    static REC: OnceLock<Arc<Recorder>> = OnceLock::new();
    REC.get_or_init(|| {
        Arc::new(Recorder {
            clicks: Mutex::new(Vec::new()),
            recording: AtomicBool::new(false),
            tap_failed: AtomicBool::new(false),
            exclude: Mutex::new(None),
            start: Mutex::new(None),
            diag_result: Mutex::new(None),
            run_loop: Mutex::new(None),
        })
    })
}

/// 点是否落在排除矩形内。
///
/// 边界按**闭区间**算(和 Electron 版 `CGRectContainsPoint` 一致):
/// 正好点在窗口边上也算「在窗口里」,不记。
pub fn in_exclude(rect: &Option<[f64; 4]>, x: f64, y: f64) -> bool {
    match rect {
        Some(r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3],
        None => false,
    }
}

/// 由窗口的**物理**位置/尺寸算出排除矩形,换算成**逻辑点**、左上角为原点。
///
/// 为什么必须换算:CGEvent 报的位置是**逻辑点**、左上角为原点;
/// 而 Tauri 报的窗口位置/尺寸是**物理像素**。不除以缩放系数的话,
/// Retina 屏(缩放 2)上矩形会大一倍 —— 半个屏幕的点击都会被当成"点在自己身上"。
///
/// `scale <= 0` 视为 1(缩放系数拿不到时不要把矩形算成空)。
pub fn rect_from_physical(x: f64, y: f64, width: f64, height: f64, scale: f64) -> [f64; 4] {
    let s = if scale > 0.0 { scale } else { 1.0 };
    let left = x / s;
    let top = y / s;
    [left, top, left + width / s, top + height / s]
}

/// 设置排除矩形(自身窗口的屏幕坐标范围)。
///
/// 由 App 层在窗口移动/变高时调用,保证矩形始终是当前的。
pub fn set_exclude_rect(rect: Option<[f64; 4]>) {
    *recorder().exclude.lock().unwrap() = rect;
}

/// 当前的排除矩形(诊断用:界面上看不出来,只能从这里查)。
pub fn exclude_rect() -> Option<[f64; 4]> {
    *recorder().exclude.lock().unwrap()
}

/// 从列表里删掉第 index 条(越界就什么都不做,返回有没有删掉)。
///
/// 单条删除:界面上每一条点击旁边有个「×」,点它只删这一条。
pub fn remove_at(clicks: &mut Vec<ClickEvent>, index: usize) -> bool {
    if index >= clicks.len() {
        return false;
    }
    clicks.remove(index);
    true
}

/// 删掉已录到的第 index 次点击。
pub fn remove_click(index: usize) -> bool {
    let mut clicks = recorder().clicks.lock().unwrap();
    remove_at(&mut clicks, index)
}

/// 开始录制。
///
/// 排除矩形(自身窗口的范围)**不在这里传**:它由 App 层用原生窗口位置算好,
/// 并在窗口每次移动/变高时刷新(见 `set_exclude_rect` 与 lib.rs 的窗口事件)。
/// 在这里拍快照的话,窗口一动快照就过期了 —— 见 `Recorder::exclude` 的说明。
pub fn start_recording() -> Result<bool, String> {
    let rec = recorder().clone();
    if rec.recording.load(Ordering::SeqCst) {
        return Err("已经在录制中".to_string());
    }

    rec.clicks.lock().unwrap().clear();
    *rec.start.lock().unwrap() = Some(Instant::now());
    rec.tap_failed.store(false, Ordering::SeqCst);

    // tap 必须挂在一个 run loop 上,所以录制跑在**独立线程**里(与 C++ 版一致)。
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let thread_rec = rec.clone();

    let handle = thread::Builder::new()
        .name("cnc-recorder".to_string())
        .spawn(move || {
            let tap = CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                // **ListenOnly**:只读监听,不改也不吞事件。
                // 这一档**不需要「辅助功能」权限**(会话级只读鼠标事件监听是例外),
                // 所以"开始录制"不用先授权就能用 —— 比 Electron 版少一道坎。
                // (要发合成点击/按键的「模拟输入」仍然需要辅助功能权限。)
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::LeftMouseDown],
                {
                    let rec = thread_rec.clone();
                    move |_proxy, etype, event| {
                        match etype {
                            CGEventType::LeftMouseDown => {
                                let loc = event.location();
                                let excluded =
                                    in_exclude(&rec.exclude.lock().unwrap(), loc.x, loc.y);
                                if !excluded {
                                    let elapsed = rec
                                        .start
                                        .lock()
                                        .unwrap()
                                        .map(|s| s.elapsed().as_secs_f64())
                                        .unwrap_or(0.0);
                                    rec.clicks.lock().unwrap().push(ClickEvent {
                                        x: loc.x,
                                        y: loc.y,
                                        timestamp: elapsed,
                                    });
                                }
                            }
                            // 系统把 tap 关了(超时 / 用户输入):后续事件收不到了,
                            // 必须把"失败"记下来,否则界面会一直以为还在录。
                            CGEventType::TapDisabledByTimeout
                            | CGEventType::TapDisabledByUserInput => {
                                rec.recording.store(false, Ordering::SeqCst);
                                rec.tap_failed.store(true, Ordering::SeqCst);
                                CFRunLoop::get_current().stop();
                            }
                            _ => {}
                        }
                        // 返回 None = 原样放行(既不吞事件也不改事件)
                        None
                    }
                },
            );

            let tap = match tap {
                Ok(t) => t,
                Err(_) => {
                    thread_rec.recording.store(false, Ordering::SeqCst);
                    thread_rec.tap_failed.store(true, Ordering::SeqCst);
                    let _ = tx.send(Err(
                        "无法创建事件监听(通常是系统没给「辅助功能」权限:\
                         系统设置 → 隐私与安全性 → 辅助功能 → 勾上本应用)"
                            .to_string(),
                    ));
                    return;
                }
            };

            let rl = CFRunLoop::get_current();
            let source = match tap.mach_port.create_runloop_source(0) {
                Ok(s) => s,
                Err(_) => {
                    thread_rec.recording.store(false, Ordering::SeqCst);
                    thread_rec.tap_failed.store(true, Ordering::SeqCst);
                    let _ = tx.send(Err("事件监听启动失败".to_string()));
                    return;
                }
            };
            rl.add_source(&source, unsafe { kCFRunLoopDefaultMode });
            *thread_rec.run_loop.lock().unwrap() = Some(rl.clone());
            tap.enable();

            // tap 起来了 → 告诉调用方"可以开始录了"
            let _ = tx.send(Ok(()));
            CFRunLoop::run_current();

            // run loop 退出 = 录制结束
            thread_rec.recording.store(false, Ordering::SeqCst);
            thread_rec.run_loop.lock().unwrap().take();
        })
        .map_err(|e| format!("启动录制线程失败: {}", e))?;

    // 等 tap 建好再返回 —— 建不起来就报错,不要"假装开始录制"
    let outcome = match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(r) => r,
        Err(_) => Err("事件监听启动超时".to_string()),
    };

    match outcome {
        Ok(()) => {
            rec.recording.store(true, Ordering::SeqCst);
            // 线程要一直活着(它跑着 run loop)。
            // Rust 里**丢弃 JoinHandle 就是脱离等待**,线程继续在后台跑,不会 join。
            drop(handle);
            Ok(true)
        }
        Err(e) => {
            let _ = handle.join();
            Err(e)
        }
    }
}

/// 停止录制。
pub fn stop_recording() -> bool {
    let rec = recorder();
    // 没在录就别等 run loop(否则会白等 1 秒)
    if !rec.recording.swap(false, Ordering::SeqCst) {
        return true;
    }

    // run loop 是录制线程起来之后才登记的;
    // 万一 stop 比 start 先到(界面连点),这里等一小会儿再放弃。
    for _ in 0..100 {
        let rl = rec.run_loop.lock().unwrap().take();
        match rl {
            Some(rl) => {
                rl.stop();
                break;
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    }
    true
}

/// 已录到的点击。
pub fn get_recording_clicks() -> Vec<ClickEvent> {
    recorder().clicks.lock().unwrap().clone()
}

/// 清空已录到的点击。
pub fn clear_recording_clicks() -> bool {
    recorder().clicks.lock().unwrap().clear();
    true
}

/// 是否正在录制。
pub fn is_recording() -> bool {
    recorder().recording.load(Ordering::SeqCst)
}

/// 事件监听有没有失败(权限不足 / 被系统禁用)。
pub fn tap_failed() -> bool {
    recorder().tap_failed.load(Ordering::SeqCst)
}

/// 往指定位置发一个**合成**的左键点击(自检用)。
///
/// 返回有没有真的发出去 —— 发不出去(系统没给「辅助功能」权限)时,
/// 这次自检**测不了**(别把它当成"通过")。
pub fn post_synthetic_click(x: f64, y: f64) -> bool {
    use core_graphics::event::{CGEvent, CGMouseButton, CGEventType};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;

    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let point = CGPoint::new(x, y);
    let down = match CGEvent::new_mouse_event(
        source.clone(),
        CGEventType::LeftMouseDown,
        point,
        CGMouseButton::Left,
    ) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let up = match CGEvent::new_mouse_event(
        source,
        CGEventType::LeftMouseUp,
        point,
        CGMouseButton::Left,
    ) {
        Ok(e) => e,
        Err(_) => return false,
    };
    down.post(CGEventTapLocation::HID);
    up.post(CGEventTapLocation::HID);
    true
}

/// 自检:「点自己界面上的按钮,会不会被记成一次点击」。
///
/// 做的是一组**对照**,同一个位置、同一个合成点击,只换排除矩形:
/// ① 把排除矩形**关掉** → 这个点击**应该**被记下来
///    (证明事件监听确实收到了合成点击;没收到 = 这次测不了,不是"通过");
/// ② 把排除矩形设成**当前窗口** → 这个点击**不应该**被记下来。
///
/// 返回:
/// - `control`  = ①记下来的条数(正常 1;0 = 合成点击没被监听到,测不了)
/// - `excluded` = ②记下来的条数(正常 0)
/// - `posted`   = 合成点击有没有真的发出去(需要「辅助功能」权限)
/// - `conclusive` = 这次自检**有没有结论**(control > 0 才有)
pub fn diagnose_exclusion(rect: Option<[f64; 4]>, point: (f64, f64)) -> serde_json::Value {
    let rec = recorder();

    // ① 对照组:不排除 —— 合成点击应该被记下来
    set_exclude_rect(None);
    let _ = start_recording();
    thread::sleep(Duration::from_millis(120));
    let posted1 = post_synthetic_click(point.0, point.1);
    thread::sleep(Duration::from_millis(250));
    let control = rec.clicks.lock().unwrap().len();
    stop_recording();
    rec.clicks.lock().unwrap().clear();

    // ② 实验组:排除矩形 = 当前窗口 —— 合成点击不应该被记下来
    set_exclude_rect(rect);
    let _ = start_recording();
    thread::sleep(Duration::from_millis(120));
    let posted2 = post_synthetic_click(point.0, point.1);
    thread::sleep(Duration::from_millis(250));
    let excluded = rec.clicks.lock().unwrap().len();
    stop_recording();
    rec.clicks.lock().unwrap().clear();
    set_exclude_rect(rect);

    serde_json::json!({
        "control": control,
        "excluded": excluded,
        "posted": posted1 && posted2,
        "conclusive": control > 0,
        "rect": rect,
        "point": [point.0, point.1],
    })
}

/// 最近一次自检的结果(写进 diag.json,好让「界面上看不出来」的事有据可查)。
pub fn set_diag_result(value: serde_json::Value) {
    *recorder().diag_result.lock().unwrap() = Some(value);
}

/// 最近一次自检的结果。
pub fn diag_result() -> Option<serde_json::Value> {
    recorder().diag_result.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(x: f64, y: f64) -> ClickEvent {
        ClickEvent {
            x,
            y,
            timestamp: 0.0,
        }
    }

    #[test]
    fn 物理像素要换算成逻辑点() {
        // 缩放 1:原样
        assert_eq!(rect_from_physical(10.0, 20.0, 300.0, 400.0, 1.0), [10.0, 20.0, 310.0, 420.0]);
        // 缩放 2(Retina):物理像素是一倍,逻辑点不变
        assert_eq!(rect_from_physical(20.0, 40.0, 600.0, 800.0, 2.0), [10.0, 20.0, 310.0, 420.0]);
        // 缩放系数拿不到(0 或负数)时按 1 算,不能算成空矩形
        assert_eq!(rect_from_physical(10.0, 20.0, 300.0, 400.0, 0.0), [10.0, 20.0, 310.0, 420.0]);
    }

    #[test]
    fn 窗口范围内的点击要被排除() {
        let rect = Some([100.0, 200.0, 300.0, 400.0]);
        // 窗口里面
        assert!(in_exclude(&rect, 150.0, 250.0));
        // 正好在边上(闭区间,和 Electron 的 CGRectContainsPoint 一致)
        assert!(in_exclude(&rect, 100.0, 200.0));
        assert!(in_exclude(&rect, 300.0, 400.0));
        // 窗口外面
        assert!(!in_exclude(&rect, 99.0, 250.0));
        assert!(!in_exclude(&rect, 150.0, 401.0));
        // 没有矩形(拿不到窗口位置)时一律不排除
        assert!(!in_exclude(&None, 150.0, 250.0));
    }

    #[test]
    fn 单条删除只删那一条() {
        let mut clicks = vec![click(1.0, 1.0), click(2.0, 2.0), click(3.0, 3.0)];
        assert!(remove_at(&mut clicks, 1));
        assert_eq!(clicks.len(), 2);
        assert_eq!(clicks[0].x, 1.0);
        assert_eq!(clicks[1].x, 3.0);
        // 越界不删,也不能崩
        assert!(!remove_at(&mut clicks, 9));
        assert_eq!(clicks.len(), 2);
        // 空列表
        let mut empty: Vec<ClickEvent> = Vec::new();
        assert!(!remove_at(&mut empty, 0));
    }
}
