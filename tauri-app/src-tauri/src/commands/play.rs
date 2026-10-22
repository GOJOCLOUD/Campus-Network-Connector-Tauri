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
/// 返回真正发出点击的条数;发不出去时把原因带回来(不能"假装成功")。
pub fn run_clicks(
    clicks: &[Value],
    interval: f64,
    inputs: Option<&[Option<String>]>,
) -> (usize, String) {
    let gap_ms = MIN_GAP_MS.max((interval.max(0.0) * 1000.0) as u64);
    let mut executed = 0usize;
    let mut error = String::new();
    for (i, c) in clicks.iter().enumerate() {
        let x = c.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = c.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        match native::mouse_click(x, y) {
            Ok(_) => executed += 1,
            Err(e) => {
                // 第一次失败就记下来,但**继续往下走** —— 后面的点击可能还是能发
                if error.is_empty() {
                    error = e;
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
    (executed, error)
}

/// 后台起一个线程跑回放,立刻返回。
/// 在后台线程里跑回放。
/// 全局快捷键(⌃⇧A)也要用它,所以是 `pub`。
pub fn spawn_playback(
    file: String,
    clicks: Vec<Value>,
    interval: f64,
    inputs: Option<Vec<Option<String>>>,
) {
    let planned = clicks.len();
    set_status(PlaybackStatus {
        file: file.clone(),
        clicks: planned,
        executed: 0,
        started_at_ms: now_ms(),
        finished_at_ms: 0,
        error: String::new(),
    });
    let handle = thread::Builder::new()
        .name("cnc-playback".to_string())
        .spawn(move || {
            let (executed, error) = run_clicks(&clicks, interval, inputs.as_deref());
            let mut st = last_status().unwrap_or_default();
            st.file = file;
            st.executed = executed;
            st.finished_at_ms = now_ms();
            st.error = error;
            set_status(st);
        });
    if let Ok(h) = handle {
        // 丢弃 JoinHandle = 脱离等待,回放线程继续在后台跑
        drop(h);
    }
}

/// 回放一个录制文件。
#[tauri::command]
pub fn play_file(
    app: AppHandle,
    file_name: String,
    interval: Option<f64>,
    input_text: Option<String>,
) -> Result<Value, String> {
    // read_file 读不到会返回 None(文件不存在 / 解析失败)→ 把原因带给界面
    let data = appcmd::read_file(app, file_name.clone())
        .map_err(|e| format!("读取录制文件失败: {}", e))?
        .ok_or_else(|| format!("读取录制文件失败: 文件不存在或不是有效的 JSON: {}", file_name))?;
    let clicks = data
        .get("clicks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if clicks.is_empty() {
        // Electron 版这里会返回"开始执行"然后什么都不做 —— 静默无反应。
        // 这里改成明确报错,免得用户以为在跑。
        return Err(format!("录制文件 {} 里没有可执行的点击", file_name));
    }

    let interval = interval.unwrap_or(0.5);
    let inputs = resolve_inputs(&clicks, input_text.as_deref());
    spawn_playback(file_name.clone(), clicks, interval, inputs);
    Ok(json!({ "status": "success", "message": "开始执行" }))
}

/// 直接回放一段点击数据(不经过文件)。
#[tauri::command]
pub fn play_data(clicks: Vec<Value>, interval: Option<f64>) -> Result<Value, String> {
    if clicks.is_empty() {
        return Err("没有可执行的点击".to_string());
    }
    let interval = interval.unwrap_or(0.5);
    spawn_playback(String::new(), clicks, interval, None);
    Ok(json!({ "status": "success" }))
}
