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
    /// 自身窗口矩形 `[left, top, right, bottom]`,落在这个范围里的点击不记
    exclude: Mutex<Option<[f64; 4]>>,
    start: Mutex<Option<Instant>>,
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
            run_loop: Mutex::new(None),
        })
    })
}

/// 点是否落在排除矩形内。
fn in_exclude(rect: &Option<[f64; 4]>, x: f64, y: f64) -> bool {
    match rect {
        Some(r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3],
        None => false,
    }
}

/// 设置排除矩形(自身窗口的屏幕坐标范围)。
///
/// 由 App 层在窗口移动/变高时调用,保证矩形始终是当前的。
///
/// 为什么不能只在开始录制时拍一张:窗口是**贴合内容**的 —— 录制列表一出现,
/// 窗口就变高/上移,「结束」按钮于是跑出了开始时那张矩形 ⇒ 点「结束」自己
/// 会被记成一次点击(用户报的 bug)。
pub fn set_exclude_rect(rect: Option<[f64; 4]>) {
    *recorder().exclude.lock().unwrap() = rect;
}

/// 删掉已录到的第 index 次点击(单条删除)。
///
/// 越界就什么都不做,返回有没有删掉。
pub fn remove_click(index: usize) -> bool {
    let mut clicks = recorder().clicks.lock().unwrap();
    if index >= clicks.len() {
        return false;
    }
    clicks.remove(index);
    true
}

/// 开始录制。
///
/// `exclude_rect` 是自身窗口的 `[left, top, right, bottom]`(屏幕全局坐标),
/// 用来避免把"点开始录制"这个动作也录进去。
pub fn start_recording(exclude_rect: Option<[f64; 4]>) -> Result<bool, String> {
    let rec = recorder().clone();
    if rec.recording.load(Ordering::SeqCst) {
        return Err("已经在录制中".to_string());
    }

    *rec.exclude.lock().unwrap() = exclude_rect;
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
