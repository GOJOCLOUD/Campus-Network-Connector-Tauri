//! 诊断:事件监听到底能不能收到系统事件?
//!
//! 背景:「录到一次点击」这个用例里,合成点击(post 出去的)没被收到。
//! 有两种可能,必须分开:
//!   (a) tap 根本不工作(收不到任何系统事件)
//!   (b) tap 工作正常,但**合成**事件(post 出去的)它看不到 / 压根没投出去
//!
//! (a) 用「监听 MouseMoved + 用 CGWarpMouseCursorPosition 挪光标」来判:
//!     挪光标是**系统自己产生**的事件,不需要任何权限。
//!     (先确认光标真的动了 —— 这台机器如果锁屏/睡眠,挪光标是无效的)
//! (b) 用 AXIsProcessTrusted() 看当前进程有没有辅助功能权限:
//!     没有的话 CGEventPost 会被系统**静默丢弃** —— 那就不是代码缺陷,
//!     而是测试环境(命令行进程)拿不到权限。

#![cfg(target_os = "macos")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use core_foundation::runloop::CFRunLoop;
use core_foundation_sys::runloop::kCFRunLoopDefaultMode;
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn CGWarpMouseCursorPosition(x: f64, y: f64) -> i32;
}

/// 读当前光标位置。
fn cursor_pos() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let ev = CGEvent::new(src).ok()?;
    let p = ev.location();
    Some((p.x, p.y))
}

#[test]
fn 诊断_当前进程有没有辅助功能权限() {
    let trusted = unsafe { AXIsProcessTrusted() };
    println!("AXIsProcessTrusted = {}", trusted);
    // 不做断言:这个结果只用来解释上面的测试结果,本身不是被测功能。
}

#[test]
fn 诊断_tap能不能收到系统自己产生的事件() {
    let before = cursor_pos();
    println!("挪之前光标位置 = {:?}", before);

    let counter = Arc::new(AtomicUsize::new(0));
    let c2 = counter.clone();

    let rl = CFRunLoop::get_current();
    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![CGEventType::MouseMoved],
        move |_p, etype, _e| {
            if let CGEventType::MouseMoved = etype {
                c2.fetch_add(1, Ordering::SeqCst);
            }
            None
        },
    )
    .expect("tap 应该能建起来");

    let src = tap.mach_port.create_runloop_source(0).expect("source");
    rl.add_source(&src, unsafe { kCFRunLoopDefaultMode });
    tap.enable();

    // 在另一个线程挪光标 —— 挪光标是系统自己产生 MouseMoved,不需要任何权限
    let mover = thread::spawn(|| {
        thread::sleep(Duration::from_millis(200));
        for i in 0..10 {
            let rc = unsafe { CGWarpMouseCursorPosition(300.0 + i as f64 * 7.0, 400.0) };
            println!("warp rc = {}", rc);
            thread::sleep(Duration::from_millis(50));
        }
    });

    thread::sleep(Duration::from_millis(1200));
    rl.stop();
    let _ = mover.join();

    let after = cursor_pos();
    let n = counter.load(Ordering::SeqCst);
    println!("挪之后光标位置 = {:?}", after);
    println!("收到 MouseMoved 事件数 = {}", n);
    println!(
        "结论:光标{} → tap 收到 {} 个 MouseMoved",
        if before != after { "动了" } else { "没动" },
        n
    );
}
