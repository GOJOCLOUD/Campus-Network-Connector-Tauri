//! Safari 复制修复：把页面里被字体混淆的文字还原成可见文字。
//!
//! 流程（与 Electron 版 coordinator.js 同构）：
//!   1. 往目标标签注入页面守卫（page-guard.js，幂等）
//!   2. 一次 Apple Event 取回「待处理的作用域组」：每组含 scopeKey / chars / font
//!   3. 用 **Rust 字形引擎**（glyph 模块）把字体里的密文码位还原成明文
//!   4. 把映射表写回页面（`__copyRepairSetMapping`）
//!   5. 页面在 copy 事件里查表改写剪贴板内容
//!
//! 与 Electron 版的唯一区别：第 3 步在 Rust 里跑（省掉 Node 运行时）。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use ttf_parser::Face;

use crate::glyph::db::{FastGlyphMatcher, GlyphDb};
use crate::glyph::font::coverage_for_char;
use crate::glyph::policy::{pick_candidate, Thresholds};
use crate::glyph::raster::{quantize, RasterWindow};
use crate::safari::bridge;

/// 页面守卫脚本（构建时从 resources 嵌进来，保证与 Electron 版同一份）。
const GUARD_JS: &str = include_str!("../../resources/page-guard.js");

/// 每隔多少轮强制补一次注入（与 Electron 版 FORCE_INJECT_EVERY 一致）。
const FORCE_INJECT_EVERY: u32 = 5;

/// 目标站点（与 Electron 版 `SITE_FILTER` 一致）。
const SITE_FILTER: [&str; 1] = ["chaoxing.com"];

static STATE: OnceLock<Mutex<RepairState>> = OnceLock::new();

#[derive(Default)]
struct RepairState {
    enabled: bool,
    injected: bool,
    /// 轮询是否在跑(最近一次轮询的时间戳与当时的开关值)
    poll_count: u64,
    last_poll_enabled: bool,
    /// Safari 返回的标签原始内容摘要(诊断用)
    last_probe: String,
    /// 最近一次失败原因 —— 必须能透出给界面,
    /// 否则"开启了但没反应"在用户看来就等于"坏了",也没法判断是不是缺权限。
    last_error: String,
}

/// 轮询诊断信息(自检用)。
pub fn poll_diagnostics() -> serde_json::Value {
    let s = state().lock().map(|s| (s.poll_count, s.last_poll_enabled, s.last_probe.clone()));
    match s {
        Ok((count, enabled, probe)) => serde_json::json!({
            "pollCount": count,
            "lastPollEnabled": enabled,
            "lastProbe": probe,
        }),
        Err(_) => serde_json::json!({ "error": "状态锁不可用(线程可能 panic 过)" }),
    }
}

/// 记录最近一次失败原因。
pub fn set_last_error(message: &str) {
    if let Ok(mut s) = state().lock() {
        s.last_error = message.to_string();
    }
}

/// 最近一次失败原因(空串 = 没有错误)。
pub fn last_error() -> String {
    state().lock().map(|s| s.last_error.clone()).unwrap_or_default()
}

/// 各标签的注入计数（用于"每隔几轮补一次注入"）。
static state_once: OnceLock<Mutex<u32>> = OnceLock::new();

fn state() -> &'static Mutex<RepairState> {
    STATE.get_or_init(|| Mutex::new(RepairState::default()))
}

pub fn is_enabled() -> bool {
    state().lock().map(|s| s.enabled).unwrap_or(false)
}

pub fn set_enabled(enabled: bool) {
    if let Ok(mut s) = state().lock() {
        s.enabled = enabled;
        if !enabled {
            s.injected = false;
        }
    }
}

pub fn is_injected() -> bool {
    state().lock().map(|s| s.injected).unwrap_or(false)
}

/// 参考库（懒加载，gzip 解压一次）。
fn reference_db(app: &tauri::AppHandle) -> Result<std::sync::Arc<GlyphDb>, String> {
    use std::io::Read;
    use std::path::PathBuf;
    use tauri::Manager;

    // **只缓存成功的结果** —— 失败也缓存的话,一次读不到就永久读不到
    // (正是"启动失败就一直失效"的那种死法)。
    static DB: OnceLock<std::sync::Arc<GlyphDb>> = OnceLock::new();
    if let Some(db) = DB.get() {
        return Ok(db.clone());
    }

    // 参考库必须**运行时从应用包里读**。
    // 用 `env!("CARGO_MANIFEST_DIR")` 拼出来的是**构建机上的路径**,
    // 打成包发到别的机器上就不存在了 —— 云端打包的包就是这么坏的:
    // 标签读得到、守卫注入得到,但一解码就报"读参考库失败"。
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        // 打包后:Contents/Resources/resources/glyph-db-48.crdb.gz
        candidates.push(dir.join("resources").join("glyph-db-48.crdb.gz"));
        candidates.push(dir.join("glyph-db-48.crdb.gz"));
    }
    // 开发时:src-tauri/resources/...
    candidates.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/glyph-db-48.crdb.gz"
    )));

    let mut last_err = String::new();
    for path in candidates {
        let raw = match std::fs::read(&path) {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("{}: {}", path.display(), e);
                continue;
            }
        };
        let mut d = flate2::read::GzDecoder::new(&raw[..]);
        let mut out = Vec::new();
        d.read_to_end(&mut out).map_err(|e| format!("解压参考库失败: {}", e))?;
        let db = std::sync::Arc::new(GlyphDb::deserialize(&out)?);
        let _ = DB.set(db.clone());
        return Ok(db);
    }
    Err(format!("读参考库失败: {}", last_err))
}

/// 取字体字节：data: URL 直接解 base64；http(s) 用 curl 取。
fn fetch_font(source: &str) -> Result<Vec<u8>, String> {
    if let Some(idx) = source.find("base64,") {
        let b64 = &source[idx + 7..];
        return b64_decode(b64).ok_or("字体 data URL 解析失败".into());
    }
    if source.starts_with("http://") || source.starts_with("https://") {
        let out = std::process::Command::new("curl")
            .args(["-sL", "--max-time", "20", source])
            .output()
            .map_err(|e| format!("取字体失败: {}", e))?;
        if out.status.success() && !out.stdout.is_empty() {
            return Ok(out.stdout);
        }
    }
    Err("不认识的字体来源".into())
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        rev[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for b in s.bytes() {
        if b == b'=' {
            break;
        }
        if b == b'\n' || b == b'\r' {
            continue;
        }
        let v = rev[b as usize];
        if v == 255 {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// 从一组里取出字体来源（守卫可能给字符串，也可能给对象）。
fn group_font_source(group: &serde_json::Value) -> Option<String> {
    let font = group.get("font")?;
    if let Some(s) = font.as_str() {
        return Some(s.to_string());
    }
    for key in ["url", "src", "source", "href", "data"] {
        if let Some(s) = font.get(key).and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

/// 对一组作用域算映射表：密文 char → 明文 char。
fn build_mapping(
    db: &GlyphDb,
    matcher: &FastGlyphMatcher,
    font_bytes: &[u8],
    chars: &[char],
) -> HashMap<char, char> {
    let t = Thresholds::default();
    let window = RasterWindow::CANONICAL;
    let Ok(face) = Face::parse(font_bytes, 0) else {
        return HashMap::new();
    };

    // 逐字：自身距离 → 最近邻 → 常用字先验
    let mut per_char: Vec<(char, Option<u32>, f32, f32, f32)> = Vec::new();
    for ch in chars {
        let Some(coverage) = coverage_for_char(&face, *ch, 48, window) else {
            continue;
        };
        let coverage = quantize(&coverage);
        let cp = *ch as u32;
        let self_distance = match db.index_of_codepoint(cp) {
            Some(idx) => db.distance_to_index(idx, &coverage),
            None => 1.0,
        };
        if self_distance < t.replace_self_distance {
            per_char.push((*ch, None, 0.0, 0.0, self_distance));
            continue;
        }
        let raw = matcher.lookup(&coverage, t.max_candidates);
        let picked = pick_candidate(&raw, &t);
        per_char.push((*ch, picked.codepoint, picked.score, picked.margin, self_distance));
    }

    // 字体级闸门：多数字形对得上常用字，才认定是混淆字体
    let fit = per_char
        .iter()
        .filter(|item| {
            let (cp, plain, score, margin, self_d) = **item;
            match plain {
                Some(p) => {
                    p != cp as u32
                        && score >= t.min_prefetch_score
                        && margin >= t.replace_min_margin
                        && self_d >= t.replace_self_distance
                }
                None => false,
            }
        })
        .count();
    let ratio = if per_char.is_empty() {
        0.0
    } else {
        fit as f32 / per_char.len() as f32
    };
    if ratio < t.min_font_fit_ratio {
        return HashMap::new();
    }

    // 逐字闸门
    let mut out = HashMap::new();
    for (ch, plain, score, margin, self_d) in per_char {
        let Some(plain) = plain else { continue };
        if plain == ch as u32 {
            continue;
        }
        if self_d < t.replace_self_distance || score < t.replace_min_score || margin < t.replace_min_margin {
            continue;
        }
        if let Some(p) = char::from_u32(plain) {
            out.insert(ch, p);
        }
    }
    out
}

/// 对某个标签跑一轮：注入 → 取作用域 → 算映射 → 写回。
pub fn check_tab(app: &tauri::AppHandle, window_index: u32, tab_index: u32) -> Result<usize, String> {
    let db = reference_db(app)?;
    let matcher = FastGlyphMatcher::new((*db).clone());

    // 1) 先采集状态
    //
    // 顺序必须和 Electron 版一致（先采集、缺守卫才注入）：
    // 注入是一次"等页面 JS 返回"的 Apple Event，每轮都重注入会把页面拖住，
    // AppleScript 一直等 → 8 秒超时。Electron 版只注入一次，所以不会卡。
    let state = bridge::poll_state(Some(tab_index), Some(window_index))?;

    // 2) 守卫不在才注入（每 FORCE_INJECT_EVERY 轮再强制补一次，对齐 Electron）
    let guard_present = state.get("guard").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut inject_count = 0u32;
    if let Some(cell) = state_once.get() {
        if let Ok(mut slot) = cell.lock() {
            *slot += 1;
            inject_count = *slot;
        }
    }
    if !guard_present || inject_count % FORCE_INJECT_EVERY == 0 {
        // 注入超时不当作硬错误:Apple Event 是在等页面里的 JS 返回,
        // 页面忙的时候它会超时,但**守卫其实已经装上了**。当错误抛出去的话,
        // 这一轮整个标签的处理都会被跳过 —— 界面还一直挂着一条其实无害的报错。
        // 真正的失败由紧随其后的 poll_state 判定。
        let _ = bridge::inject_guard(Some(tab_index), Some(window_index), GUARD_JS);
    }
    let Some(groups) = state
        .get("pending")
        .and_then(|p| p.get("groups"))
        .and_then(|g| g.as_array())
    else {
        return Ok(0);
    };

    // 3) 逐组算映射
    let mut total = 0usize;
    for group in groups {
        let Some(scope_key) = group.get("scopeKey").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(font_source) = group_font_source(group) else {
            continue;
        };
        let chars: Vec<char> = group
            .get("chars")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .filter_map(|s| s.chars().next())
                    .collect()
            })
            .unwrap_or_default();
        if chars.is_empty() {
            continue;
        }
        let Ok(font_bytes) = fetch_font(&font_source) else {
            continue;
        };
        let mapping = build_mapping(matcher.db(), &matcher, &font_bytes, &chars);
        if mapping.is_empty() {
            continue;
        }
        let json: serde_json::Map<String, serde_json::Value> = mapping
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string(),
                    serde_json::Value::String(v.to_string()),
                )
            })
            .collect();
        bridge::set_mapping(
            Some(tab_index),
            Some(window_index),
            scope_key,
            &serde_json::Value::Object(json),
        )?;
        total += mapping.len();
    }
    Ok(total)
}

/// 扫所有匹配站点的标签，各跑一轮。
pub fn check_now(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    // 区分"Safari 没运行"和"没有权限问 Safari"——后者是权限问题,得说清楚
    match bridge::safari_running_checked() {
        Ok(false) => {
            set_last_error("Safari 未运行");
            return Ok(serde_json::json!({ "tabs": 0, "mapped": 0, "error": "Safari 未运行" }));
        }
        Ok(true) => {}
        Err(e) => {
            set_last_error(&e);
            return Err(e);
        }
    }
    let (tabs, raw_lines) = match bridge::list_tabs() {
        Ok(t) => t,
        Err(e) => {
            set_last_error(&e);
            return Err(e);
        }
    };
    {
        // 0 行 = 连窗口都读不到(多半是没给自动化权限);>0 行但没匹配目标站点 = 正常
        let probe = if raw_lines == 0 {
            "读不到 Safari 的窗口(通常是没有「自动化 → Safari」权限)".to_string()
        } else if tabs.is_empty() {
            format!("Safari 共 {} 个标签,但没有目标站点的标签", raw_lines)
        } else {
            format!("共 {} 个标签,首个 {}", tabs.len(), tabs.first().map(|t| t.2.clone()).unwrap_or_default())
        };
        if let Ok(mut s) = state().lock() {
            s.last_probe = probe;
        }
    }
    let mut checked = 0usize;
    let mut mapped = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for (w, t, url) in tabs {
        if !SITE_FILTER.iter().any(|s| url.contains(s)) {
            continue;
        }
        checked += 1;
        match check_tab(app, w, t) {
            Ok(n) => mapped += n,
            Err(e) => {
                // **单个标签的超时不算致命**:这一页可能正忙(Apple Event 等页面里的
                // JS 返回),守卫其实已经装上了,下一轮就好。Electron 版也是这么
                // 处理的(错误被 catch 掉)—— 这条不该在界面上报红。
                // 真致命的问题(Safari 没开 / 没有自动化权限 / 参考库缺失)走别的路径,
                // 照样会显示出来。
                let msg = format!("w{}t{}: {}", w, t, e);
                if e.contains("AppleScript 超时") {
                    if let Ok(mut s) = state().lock() {
                        s.last_probe = format!("（{} 不影响其它标签）", msg);
                    }
                } else {
                    errors.push(msg);
                }
            }
        }
    }
    if let Ok(mut s) = state().lock() {
        s.injected = checked > 0;
        if errors.is_empty() {
            s.last_error.clear();
        } else {
            // 逐个标签的错误也要能透出,否则界面只看到"已开启"却什么都没发生
            s.last_error = errors.join("; ");
        }
    }
    Ok(serde_json::json!({
        "tabs": checked,
        "mapped": mapped,
        "errors": errors,
    }))
}

/// 后台轮询线程：启用时每 2 秒扫一轮。
pub fn spawn_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let enabled = is_enabled();
        {
            if let Ok(mut s) = state().lock() {
                s.poll_count += 1;
                s.last_poll_enabled = enabled;
            }
        }
        if enabled {
            let _ = check_now(&app);
        }
        std::thread::sleep(std::time::Duration::from_millis(2000));
    });
}
