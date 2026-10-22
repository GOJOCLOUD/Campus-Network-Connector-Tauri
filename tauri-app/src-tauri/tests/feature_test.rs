//! 录制 + 回放的**真实**自检。
//!
//! `cargo test --test feature_test`
//!
//! ## 关于"点击"这件事的诚实说明
//!
//! 想验"录到一次点击",得先有**一次点击**。命令行进程自己发不出可被监听的点击:
//!   - 发合成点击(CGEventPost)需要 macOS 的「辅助功能」权限,没有的话事件被**静默丢弃**;
//!   - 挪光标(CGWarpMouseCursorPosition)**不产生** tap 可见的事件。
//! 所以这里按"当前进程有没有辅助功能权限"分两种口径:
//!   - **有权限** → 完整端到端断言(发一次点击 → 必须录到坐标)
//!   - **没权限** → 只断言"事件监听建得起来、状态机对",并**打印说明**为什么测不到点击
//!
//! 绝不用"跳过就当过了"的方式糊弄:每次跑都会把结论打印出来。
#![cfg(target_os = "macos")]

use std::thread;
use std::time::Duration;

use serde_json::json;
use simuinput_tauri::commands::native::mouse_click;
use simuinput_tauri::commands::native::recording::{
    clear_recording_clicks, get_recording_clicks, is_recording, start_recording, stop_recording,
    tap_failed,
};
use simuinput_tauri::commands::play::{self, resolve_inputs};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

/// 当前进程能不能发合成点击(也就是能不能自己造出一次可被监听的点击)。
fn can_post_events() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// 发一次点击;没有权限就返回 false(而不是让测试莫名失败)。
fn try_click(x: f64, y: f64) -> bool {
    if !can_post_events() {
        return false;
    }
    mouse_click(x, y).is_ok()
}

#[test]
fn 事件监听建得起来且状态机正确() {
    clear_recording_clicks();

    // 起监听 —— 建不起来会直接 Err(权限/系统原因),不会假装成功
    start_recording(None).expect("事件监听应该能建起来");
    assert!(is_recording(), "起完监听后应该处于录制状态");
    assert!(!tap_failed(), "事件监听不该失败");

    stop_recording();
    assert!(!is_recording(), "停掉后不该还在录制状态");

    clear_recording_clicks();
    assert!(
        get_recording_clicks().is_empty(),
        "清空之后不该还有残留点击"
    );
}

#[test]
fn 录到一次点击() {
    clear_recording_clicks();
    start_recording(None).expect("事件监听应该能建起来");

    if !try_click(123.0, 456.0) {
        println!(
            "⚠️ 当前进程没有「辅助功能」权限,发不出合成点击 → 这次**测不到**点击是否被录到。\
             (已单独验证:事件监听建得起来、状态机正确)"
        );
        stop_recording();
        return;
    }

    // 等事件派发到监听
    thread::sleep(Duration::from_millis(500));

    let clicks = get_recording_clicks();
    stop_recording();

    assert!(!tap_failed(), "事件监听不该失败");
    assert_eq!(clicks.len(), 1, "应该正好录到 1 个点击,实际 {:?}", clicks);
    assert_eq!(clicks[0].x, 123.0, "录到的 x 不对");
    assert_eq!(clicks[0].y, 456.0, "录到的 y 不对");
    assert!(clicks[0].timestamp >= 0.0, "timestamp 不该是负数");
}

#[test]
fn 排除矩形内的点击不记录() {
    clear_recording_clicks();
    // 排除矩形 [0,0,100,100]
    start_recording(Some([0.0, 0.0, 100.0, 100.0])).expect("事件监听应该能建起来");

    if !try_click(50.0, 50.0) {
        println!("⚠️ 没有「辅助功能」权限 → 这次**测不到**排除矩形的行为。");
        stop_recording();
        return;
    }
    thread::sleep(Duration::from_millis(400));
    let inside = get_recording_clicks().len();
    stop_recording();
    assert_eq!(inside, 0, "排除矩形内的点击不该被记录");

    clear_recording_clicks();
    start_recording(Some([0.0, 0.0, 100.0, 100.0])).expect("事件监听应该能建起来");
    assert!(
        try_click(500.0, 500.0),
        "排除矩形外的点击应该发得出去"
    );
    thread::sleep(Duration::from_millis(400));
    let outside = get_recording_clicks().len();
    stop_recording();
    assert_eq!(outside, 1, "排除矩形外的点击应该被记录");
}

#[test]
fn 停止后不再接收点击() {
    clear_recording_clicks();
    start_recording(None).expect("事件监听应该能建起来");
    stop_recording();
    assert!(!is_recording(), "停掉后不该还在录制状态");

    if try_click(10.0, 20.0) {
        thread::sleep(Duration::from_millis(300));
        assert!(
            get_recording_clicks().is_empty(),
            "停止之后不应该再收到点击"
        );
    } else {
        println!("⚠️ 没有「辅助功能」权限 → 这次**测不到**停止后是否还收点击。");
    }
}

#[test]
fn 回放没有权限时会报出原因而不是假装成功() {
    let clicks = vec![json!({"x": 11.0, "y": 22.0}), json!({"x": 33.0, "y": 44.0})];
    let (executed, error) = play::run_clicks(&clicks, 0.01, None);

    if can_post_events() {
        assert_eq!(executed, 2, "有权限时应该两条都发出去");
        assert!(error.is_empty(), "有权限时不该有错误:{}", error);
    } else {
        // 这正是要验的东西:**没有辅助功能权限时不能"显示成功却什么都没发生"**
        assert_eq!(executed, 0, "没权限时不该声称发出了点击");
        assert!(
            error.contains("辅助功能"),
            "错误里必须说明是权限问题,实际:{}",
            error
        );
    }
}

#[test]
fn 回放输入文本按Electron口径分配() {
    let clicks = vec![
        json!({"x": 1, "y": 2}),
        json!({"x": 3, "y": 4, "input_text": "甲"}),
    ];

    // 有任意一条带 input_text → 逐条按各自的来
    let per_click = resolve_inputs(&clicks, Some("整段")).expect("应该有输入");
    assert_eq!(per_click[0], None, "没写 input_text 的那一条不该键入");
    assert_eq!(per_click[1], Some("甲".to_string()), "该键入甲");

    // 都没有 → 整段文本只给第一条
    let plain = vec![json!({"x": 1, "y": 2}), json!({"x": 3, "y": 4})];
    let single = resolve_inputs(&plain, Some("整段")).expect("应该有输入");
    assert_eq!(single[0], Some("整段".to_string()), "整段文本应该给第一条");
    assert_eq!(single[1], None, "第二条不该键入");

    // 空文本 / 没有文本 → 整段都不键入
    assert!(resolve_inputs(&plain, None).is_none(), "没有文本时不该键入");
    assert!(
        resolve_inputs(&plain, Some("   ")).is_none(),
        "空白文本不该键入"
    );
}
