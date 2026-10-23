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

/// iframe 桥脚本（同样构建期内嵌，与 Electron 版 `vendor/frame-bridge.js` 同一份）。
///
/// 目标站点把题目放在**同源 iframe** 里（真实页面选区在第 4 层嵌套 frame）。
/// 没有它：iframe 里没有守卫 → 那些密文字不上报；就算上报了，
/// 映射也只发到顶层 → iframe 里查不到表 → 复制出来还是密文。
const FRAME_BRIDGE_JS: &str = include_str!("../../resources/frame-bridge.js");

/// 每隔多少轮强制补一次注入（与 Electron 版 FORCE_INJECT_EVERY 一致）。
const FORCE_INJECT_EVERY: u32 = 5;

/// 目标站点（与 Electron 版 `SITE_FILTER` 一致）。
const SITE_FILTER: [&str; 1] = ["chaoxing.com"];

/// 主轮询间隔（Electron 版 coordinator.js 同口径：300ms）。
const POLL_INTERVAL_MS: u64 = 300;

/// 目标站点的标签多久处理一次（Electron 版：每 2 轮 = 600ms）。
const SITE_TAB_EVERY_ROUNDS: u64 = 2;

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
    /// Safari 在不在运行(None = 还没问过 / 问不到)。
    /// 界面用它显示"Safari 没开是中性状态"的提示 ——
    /// 问不到时按"在跑"处理(Electron 版同口径),免得误报。
    safari_running: Option<bool>,
    /// 最近一次**映射没建起来**的原因(取字体失败 / 分析失败 / 映射为空)。
    ///
    /// 这些分支原本全是 `continue` —— 静默跳过,界面只看得到"已开启"。
    /// 真出问题时(字体取不到、参考库不对)根本无从查起,必须把原因透出来。
    last_mapping_note: String,
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

/// 记下最近一次「映射没建起来」的原因（诊断用）。
pub fn set_mapping_note(note: &str) {
    if let Ok(mut s) = state().lock() {
        s.last_mapping_note = note.to_string();
    }
}

/// 最近一次「映射没建起来」的原因（空串 = 上一次是好的）。
pub fn mapping_note() -> String {
    state()
        .lock()
        .map(|s| s.last_mapping_note.clone())
        .unwrap_or_default()
}

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

/// Safari 在不在运行(None = 还没问过 / 问不到权限)。
/// 界面拿它显示"Safari 没开"的提示;问不到时按"在跑"处理(与 Electron 版同口径)。
pub fn safari_running_state() -> Option<bool> {
    state().lock().ok().and_then(|s| s.safari_running)
}

/// 读一个 gzip 压缩的参考库文件。
///
/// 拆出来是为了让**测试**能直接按路径加载同一份库
/// （运行时的加载还要走 AppHandle 找包内资源，测试里没有 App）。
fn open_db_gz(path: &std::path::Path) -> Result<GlyphDb, String> {
    use std::io::Read;
    let raw = std::fs::read(path).map_err(|e| format!("读文件失败: {}", e))?;
    let mut d = flate2::read::GzDecoder::new(&raw[..]);
    let mut out = Vec::new();
    d.read_to_end(&mut out).map_err(|e| format!("解压参考库失败: {}", e))?;
    GlyphDb::deserialize(&out)
}

/// 参考库（懒加载，gzip 解压一次）。
fn reference_db(app: &tauri::AppHandle) -> Result<std::sync::Arc<GlyphDb>, String> {
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
        match open_db_gz(&path) {
            Ok(db) => {
                let db = std::sync::Arc::new(db);
                let _ = DB.set(db.clone());
                return Ok(db);
            }
            Err(e) => {
                last_err = format!("{}: {}", path.display(), e);
                continue;
            }
        }
    }
    Err(format!("读参考库失败: {}", last_err))
}

/// 取字体字节。
///
/// 按守卫上报的 `kind` 分派（与 Electron 版 `engine.fetchFont` 同口径）：
/// - `data`:守卫给的是**裸 base64**（`page-guard.js` 把 `data:...;base64,` 前缀
///   剥掉了），所以要直接解；也兼容带前缀的老格式。
/// - `url`:curl 下载。
///
/// 下载失败会记进**负缓存**：站点里常驻着一些取不到的 @font-face
/// （例如跨源的 icomoon.ttf，HTTP 404）。不缓存的话每轮调度都去请求一次，
/// 变成无谓的外部请求 + 日志噪声。
fn fetch_font(kind: &str, value: &str) -> Result<Vec<u8>, String> {
    match kind {
        "data" => {
            let b64 = match value.find("base64,") {
                Some(i) => &value[i + 7..],
                None => value,
            };
            b64_decode(b64).ok_or("字体 base64 解析失败".into())
        }
        "url" => {
            if let Some(hit) = font_fail_cache()
                .lock()
                .ok()
                .and_then(|c| c.iter().find(|(u, _)| u == value).map(|(_, f)| f.clone()))
            {
                if crate::commands::app::now_ms() - hit.at < FONT_FAIL_COOLDOWN_MS {
                    return Err(hit.message);
                }
            }
            let out = std::process::Command::new("curl")
                .args(["-sL", "--max-time", "20", value])
                .output()
                .map_err(|e| format!("取字体失败: {}", e))?;
            if out.status.success() && !out.stdout.is_empty() {
                return Ok(out.stdout);
            }
            let msg = format!("字体下载失败: {}", value);
            remember_font_failure(value, &msg);
            Err(msg)
        }
        other => Err(format!("不认识的字体来源类型: {}", other)),
    }
}

/// 字体下载失败的负缓存(冷却期内不再重复请求)。
static FONT_FAILS: OnceLock<Mutex<Vec<(String, FontFailure)>>> = OnceLock::new();

#[derive(Clone)]
struct FontFailure {
    at: i64,
    message: String,
}

/// 字体下载失败的冷却时间(10 分钟,与 Electron 版一致)。
const FONT_FAIL_COOLDOWN_MS: i64 = 10 * 60 * 1000;

fn font_fail_cache() -> &'static Mutex<Vec<(String, FontFailure)>> {
    FONT_FAILS.get_or_init(|| Mutex::new(Vec::new()))
}

fn remember_font_failure(url: &str, message: &str) {
    if let Ok(mut cache) = font_fail_cache().lock() {
        cache.retain(|(u, _)| u != url);
        cache.push((
            url.to_string(),
            FontFailure {
                at: crate::commands::app::now_ms(),
                message: message.to_string(),
            },
        ));
        while cache.len() > 32 {
            cache.remove(0);
        }
    }
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

/// 从一组里取出字体来源：`{ kind, value }`。
///
/// **守卫上报的就是这个形状**（`page-guard.js` 的 `readFontSource`：
/// `{ kind: "data"|"url", value: ... }`）。
///
/// 之前这里找的是 `url/src/source/href/data` 那一堆键 —— 守卫从来没上报过它们，
/// 于是 `group_font_source` 恒为 `None` → **整条链路产不出任何映射**
/// （页面守卫装上了，但复制出来还是原始密文）。
fn group_font_source(group: &serde_json::Value) -> Option<(String, String)> {
    let font = group.get("font")?;
    if let Some(s) = font.as_str() {
        // 兜底:老格式直接给字符串
        if s.starts_with("http://") || s.starts_with("https://") {
            return Some(("url".to_string(), s.to_string()));
        }
        if let Some(i) = s.find("base64,") {
            return Some(("data".to_string(), s[i + 7..].to_string()));
        }
        return None;
    }
    let kind = font.get("kind").and_then(|v| v.as_str())?.to_string();
    let value = font.get("value").and_then(|v| v.as_str())?.to_string();
    if value.is_empty() {
        return None;
    }
    Some((kind, value))
}

/// 单字的判定结果（与 Electron 版 `engine.js` 里 `entries` 的每一项同形状）。
#[derive(Clone, Copy, Debug)]
struct CharInfo {
    /// 屏幕上真正显示的字（None = 没把握 / 不用改）
    plain: Option<u32>,
    /// 最近邻相似度
    score: f32,
    /// 最近邻与次近邻的差距
    margin: f32,
    /// 与"该字符自身参考字形"的距离
    self_distance: f32,
}

/// 字体解析结果缓存:按**字体内容**的哈希缓存(Electron 版同口径,最多 8 份)。
static FONT_CACHE: OnceLock<Mutex<Vec<(String, std::sync::Arc<HashMap<char, CharInfo>>)>>> =
    OnceLock::new();

fn font_cache() -> &'static Mutex<Vec<(String, std::sync::Arc<HashMap<char, CharInfo>>)>> {
    FONT_CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// 一次最多分析多少个码位(安全阀:挡住病态字体把 CPU 吃满)。
/// 真实场景的混淆字体只有几十个码位,4096 远远够用。
const MAX_FONT_CODEPOINTS: usize = 4096;

/// 字体里的全部码位（与 Electron 版遍历 cmap 的口径一致）。
fn font_codepoints(face: &Face<'_>) -> Vec<char> {
    let Some(table) = face.tables().cmap else {
        return Vec::new();
    };
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut out: Vec<char> = Vec::new();
    for subtable in table.subtables {
        // 只看 Unicode 兼容的子表（和 `Face::glyph_index` 的取法一致）
        if !subtable.is_unicode() {
            continue;
        }
        subtable.codepoints(|cp| {
            if cp < 0x20 || seen.contains(&cp) {
                return;
            }
            seen.insert(cp);
            if let Some(ch) = char::from_u32(cp) {
                out.push(ch);
            }
        });
        if out.len() >= MAX_FONT_CODEPOINTS {
            break;
        }
    }
    out
}

/// 解析字体 → 每个码位的判定结果。
///
/// **必须按整份字体建,不能只算选区里出现过的那些字**（ADR-0002）：
/// 按选区建映射的毛病是——用户扩大选区后新出现的密文字没有映射 → 复制还是密文
/// （实测:选区只含第 1 题时只解出 7 个字,换成 5 题后第 2~5 题全是密文）。
///
/// 结果按**字体内容的哈希**缓存:同一个字体只算一次(Electron 版同口径)。
fn analyze_font(
    db: &GlyphDb,
    matcher: &FastGlyphMatcher,
    font_bytes: &[u8],
) -> Result<std::sync::Arc<HashMap<char, CharInfo>>, String> {
    let hash = crate::commands::app::sha256_hex(font_bytes);
    if let Some(cached) = font_cache()
        .lock()
        .ok()
        .and_then(|c| c.iter().find(|(h, _)| h == &hash).map(|(_, m)| m.clone()))
    {
        return Ok(cached);
    }

    let face = Face::parse(font_bytes, 0).map_err(|e| format!("字体解析失败: {}", e))?;
    let t = Thresholds::default();
    let window = RasterWindow::CANONICAL;

    let mut per_char: HashMap<char, CharInfo> = HashMap::new();
    for ch in font_codepoints(&face) {
        let Some(coverage) = coverage_for_char(&face, ch, 48, window) else {
            continue;
        };
        let coverage = quantize(&coverage);
        let cp = ch as u32;
        let self_distance = match db.index_of_codepoint(cp) {
            Some(idx) => db.distance_to_index(idx, &coverage),
            None => 1.0,
        };
        if self_distance < t.replace_self_distance {
            // 画的就是它自己 → 不用改
            per_char.insert(
                ch,
                CharInfo {
                    plain: None,
                    score: 0.0,
                    margin: 0.0,
                    self_distance,
                },
            );
            continue;
        }
        let raw = matcher.lookup(&coverage, t.max_candidates);
        let picked = pick_candidate(&raw, &t);
        per_char.insert(
            ch,
            CharInfo {
                plain: picked.codepoint,
                score: picked.score,
                margin: picked.margin,
                self_distance,
            },
        );
    }

    // **字体级闸门**:分母是**字体的码位数**。
    // 之前按选区字符数算 —— 选区只有一两个字时,某个图标字恰好像某个常用字
    // → ratio=1.0 → 把图标字映射成汉字 → 复制出来是错字。
    // 混淆字体的特征是**几乎每个字形**都对得上一个常用字;
    // 图标字体(icomoon 之类)实测只有 3% → 判为普通字体,压根不建映射。
    let fit = per_char
        .iter()
        .filter(|(ch, info)| match info.plain {
            Some(p) => {
                p != (**ch) as u32
                    && info.score >= t.min_prefetch_score
                    && info.margin >= t.replace_min_margin
                    && info.self_distance >= t.replace_self_distance
            }
            None => false,
        })
        .count();
    let ratio = if per_char.is_empty() {
        0.0
    } else {
        fit as f32 / per_char.len() as f32
    };

    let entries: std::sync::Arc<HashMap<char, CharInfo>> = if ratio < t.min_font_fit_ratio {
        std::sync::Arc::new(HashMap::new())
    } else {
        std::sync::Arc::new(per_char)
    };

    // 缓存(最多 8 份,先进先出)
    if let Ok(mut cache) = font_cache().lock() {
        cache.retain(|(h, _)| h != &hash);
        cache.push((hash, entries.clone()));
        while cache.len() > 8 {
            cache.remove(0);
        }
    }
    Ok(entries)
}

/// 从字体级结果里挑出"该改的"那些字,组成映射表。
///
/// 逐字闸门用 `replace_min_score`（0.8）——**不是**更严的预热分(0.88):
/// 预热与选区必须用同一个阈值,否则"换题后立刻复制"时页面上只有预热那张表,
/// 那几个字查不到 → 复制出来一半是密文(这正是"换题就失败"的成因)。
fn build_mapping(entries: &HashMap<char, CharInfo>) -> HashMap<char, char> {
    let t = Thresholds::default();
    let mut out = HashMap::new();
    for (ch, info) in entries {
        let Some(plain) = info.plain else { continue };
        if plain == *ch as u32 {
            continue;
        }
        if info.self_distance < t.replace_self_distance {
            continue;
        }
        if info.score < t.replace_min_score {
            continue;
        }
        if info.margin < t.replace_min_margin {
            // 认不准:保持原样(宁可留错字,绝不写错字)
            continue;
        }
        if let Some(p) = char::from_u32(plain) {
            out.insert(*ch, p);
        }
    }
    out
}

/// 对某个标签跑一轮：注入 → 取作用域 → 算映射 → 写回。
pub fn check_tab(
    app: &tauri::AppHandle,
    window_index: u32,
    tab_index: u32,
) -> Result<(usize, bool), String> {
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
    // **这个标签到底有没有被接管**（界面上的「已接管」靠它）。
    //
    // 以前的口径是"这一轮处理过至少一个标签" → 哪怕守卫一次都没装上也显示"已接管",
    // 用户看到的是"绿色的问号 + 已接管",却什么也没发生(2026-10-22 的真故障)。
    // 现在必须**确实有守卫在场**(本来就在,或这一轮注入成功)。
    let mut guard_ok = guard_present;
    if !guard_present || inject_count % FORCE_INJECT_EVERY == 0 {
        // 注入超时不当作硬错误:Apple Event 是在等页面里的 JS 返回,
        // 页面忙的时候它会超时,但**守卫其实已经装上了**。当错误抛出去的话,
        // 这一轮整个标签的处理都会被跳过 —— 界面还一直挂着一条其实无害的报错。
        // 真正的失败由紧随其后的 poll_state 判定。
        //
        // **但别的错必须透出**:当初注入脚本是语法错误(守卫源码没转义)时,
        // 错误被 `let _ =` 吞掉 —— 守卫一次都没装上,界面却一直显示"已开启",
        // 这个功能就这么"开着但不工作"了很久。注入失败必须能被看见。
        match bridge::inject_guard(Some(tab_index), Some(window_index), GUARD_JS, FRAME_BRIDGE_JS) {
            Ok(_) => guard_ok = true,
            Err(e) => {
                if e.contains("AppleScript 超时") {
                    // 页面忙,不算致命:下一轮就好。
                    // 但**不能**因此说"已接管"—— 守卫到底装上没有,只有页面知道。
                } else {
                    return Err(format!("注入守卫失败: {}", e));
                }
            }
        }
    }

    // 3) 待处理队列:**顶层自己的 + 各层 frame 上报的**
    //
    // frame 里的题目也要能还原 —— 目标站点把题目放在**同源 iframe** 里
    // (真实页面选区在第 4 层嵌套 frame)。之前只读顶层的 pending,
    // iframe 里既没有守卫、就算上报了也不消费 → 那些字永远还原不了。
    let mut queue: Vec<&serde_json::Value> = Vec::new();
    if let Some(pending) = state.get("pending") {
        if !groups_of(pending).is_empty() {
            queue.push(pending);
        }
    }
    if let Some(frames) = state.get("frames").and_then(|f| f.as_array()) {
        for item in frames {
            if !groups_of(item).is_empty() {
                queue.push(item);
            }
        }
    }

    // 4) 逐组算映射(按**整份字体**建,不是按选区)
    let mut total = 0usize;
    for item in queue {
        for group in groups_of(item) {
            let Some(scope_key) = group.get("scopeKey").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some((kind, value)) = group_font_source(group) else {
                continue;
            };
            let Ok(font_bytes) = fetch_font(&kind, &value) else {
                set_mapping_note(&format!("取字体失败({}): {}", kind, value));
                continue;
            };
            // 同一个字体只解析一次(按内容哈希缓存)
            let Ok(entries) = analyze_font(matcher.db(), &matcher, &font_bytes) else {
                set_mapping_note(&format!("分析字体失败: {}", value));
                continue;
            };
            let mapping = build_mapping(&entries);
            if mapping.is_empty() {
                set_mapping_note(&format!(
                    "映射为空(字体 {} 个码位,都没认准)",
                    entries.len()
                ));
                continue;
            }
            set_mapping_note(&format!("映射建成了: {} 个字", mapping.len()));
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
    }
    Ok((total, guard_ok))
}

/// 取一个上报项里的作用域组。
fn groups_of(item: &serde_json::Value) -> Vec<&serde_json::Value> {
    item.get("groups")
        .and_then(|g| g.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

/// 扫所有匹配站点的标签，各跑一轮。
///
/// `round` 是第几轮:目标站点的标签**每 2 轮**处理一次(600ms),
/// 前台标签**每轮**都处理 —— 与 Electron 版 coordinator.js 同口径。
pub fn check_now(app: &tauri::AppHandle, round: u64) -> Result<serde_json::Value, String> {
    // 区分"Safari 没运行"和"没有权限问 Safari"——后者是权限问题,得说清楚
    match bridge::safari_running_checked() {
        Ok(false) => {
            // **Safari 没开是中性状态,不是错误**(与 Electron 版同口径):
            // 界面走 `safariRunning === false` 那条灰色提示。
            // 这里若把 lastError 写成"Safari 未运行",界面会一直挂一条红字,
            // 而真正的问题(权限/注入失败)就被它盖住了。
            if let Ok(mut s) = state().lock() {
                s.safari_running = Some(false);
                s.last_error.clear();
                s.injected = false;
            }
            return Ok(serde_json::json!({ "tabs": 0, "mapped": 0, "error": "" }));
        }
        Ok(true) => {
            if let Ok(mut s) = state().lock() {
                s.safari_running = Some(true);
            }
        }
        Err(e) => {
            set_last_error(&e);
            // 问不到 ≠ 没在跑:按"在跑"处理(与 Electron 版同口径),
            // 否则界面会一直提示"Safari 没开",而真实原因是缺权限。
            if let Ok(mut s) = state().lock() {
                s.safari_running = None;
            }
            return Err(e);
        }
    }
    let (tabs, raw_lines, front) = match bridge::list_tabs() {
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
            // **raw_lines 里含 FRONT 那一行**,拿它当标签数会显示成"共 1 个标签",
            // 看起来像"Safari 里只有 1 个标签",实际是"一个标签都没读到"。
            // 这两件事必须分开说,否则用户会照着错误的方向去查。
            "Safari 有窗口,但一个标签的 URL 都读不到".to_string()
        } else {
            format!("共 {} 个标签,首个 {}", tabs.len(), tabs.first().map(|t| t.2.clone()).unwrap_or_default())
        };
        if let Ok(mut s) = state().lock() {
            s.last_probe = probe;
        }
    }
    let mut checked = 0usize;
    let mut mapped = 0usize;
    /// 这一轮里**确实有守卫在场**的标签数（界面上的「已接管」靠它）。
    let mut taken_over = 0usize;
    let mut errors: Vec<String> = Vec::new();
    // 要处理的标签:**目标站点的标签 + 前台标签**。
    // 前台标签每轮都处理(Electron 版同口径)——
    // 不这样的话,"在别的网站上用了混淆字体"永远不会被接管。
    let mut targets: Vec<(u32, u32)> = Vec::new();
    // 目标站点的标签:每 2 轮处理一次(Electron 版同口径)
    if round % SITE_TAB_EVERY_ROUNDS == 0 {
        for (w, t, url) in &tabs {
            if SITE_FILTER.iter().any(|s| url.contains(s)) {
                targets.push((*w, *t));
            }
        }
    }
    // 前台标签:每轮都处理 —— 不这样的话,"在别的网站上用了混淆字体"永远不会被接管
    if let Some((w, t)) = front {
        if !targets.contains(&(w, t)) {
            targets.push((w, t));
        }
    }
    for (w, t) in targets {
        checked += 1;
        match check_tab(app, w, t) {
            Ok((n, guard_ok)) => {
                mapped += n;
                if guard_ok {
                    taken_over += 1;
                }
            }
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
        // **口径**:「已接管」= 这一轮**确实有标签的守卫在场**。
        // 以前是"处理过至少一个标签" → 守卫一次都没装上也显示"已接管"。
        s.injected = taken_over > 0;
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

/// 后台轮询线程。
///
/// 节奏与 Electron 版 `coordinator.js` 同口径:
/// - 主轮询 **300ms**
/// - 目标站点的标签**每 2 轮**(600ms)处理一次
/// - **前台标签每轮**都处理
///
/// （Electron 版换题后有约 1 秒的窗口期、复制出来还是密文；
///   这里的节奏对齐后，窗口期同样在 1 秒内。）
pub fn spawn_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut round: u64 = 0;
        loop {
            let enabled = is_enabled();
            {
                if let Ok(mut s) = state().lock() {
                    s.poll_count += 1;
                    s.last_poll_enabled = enabled;
                    round = s.poll_count;
                }
            }
            if enabled {
                let _ = check_now(&app, round);
            }
            std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
        }
    });
}

// ── 回归测试 ─────────────────────────────────────────
//
// 这些测试盯的是**整条链路**,不是单个函数:
// 守卫上报的形状 → 取字体 → 解析字体 → 建映射 → 与真值表比对。
//
// 之前这条链路**整条是断的**(取字体那一步的键名对不上),
// 而 Rust 侧**一个单元测试都没有** —— 只有 JS 侧那套测试在跑,
// 而 JS 那套是死代码(运行时根本不执行它)。
// 下面这组测试就是"别再断第二次"的护栏。

#[cfg(test)]
mod tests {
    use super::*;

    /// 仓库里的测试样本路径(tauri-app/src-tauri → 仓库根)。
    fn repo_path(relative: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(relative)
    }

    #[test]
    fn 守卫上报的字体来源能取到() {
        // page-guard.js 上报的就是 { kind, value } —— 之前这里找的是
        // url/src/source/href/data 那一堆键,永远取不到。
        let group = serde_json::json!({
            "scopeKey": "s1",
            "chars": ["天", "地"],
            "font": { "kind": "data", "value": "AAECAw==" },
        });
        let (kind, value) = group_font_source(&group).expect("应该取得到字体来源");
        assert_eq!(kind, "data");
        assert_eq!(value, "AAECAw==");

        let group = serde_json::json!({
            "scopeKey": "s2",
            "chars": ["天"],
            "font": { "kind": "url", "value": "https://example.com/f.woff" },
        });
        let (kind, value) = group_font_source(&group).expect("应该取得到字体来源");
        assert_eq!(kind, "url");
        assert_eq!(value, "https://example.com/f.woff");
    }

    #[test]
    fn 裸_base64_能解出字体字节() {
        // 守卫给的是**裸 base64**(前缀已被剥掉),不是 data: URL。
        let bytes = fetch_font("data", "AAECAw==").expect("应该解得开");
        assert_eq!(bytes, vec![0u8, 1, 2, 3]);

        // 带前缀的老格式也要认。
        let bytes = fetch_font("data", "data:font/woff2;base64,AAECAw==").expect("应该解得开");
        assert_eq!(bytes, vec![0u8, 1, 2, 3]);
    }

    /// 混淆字体要能**整份**还原(不只选区里那几个字)——
    /// 这正是 ADR-0002 的口径:按字体建映射,用户扩大选区后新字也认得。
    #[test]
    fn 混淆字体能整份还原() {
        let db_path = repo_path("tauri-app/src-tauri/resources/glyph-db-48.crdb.gz");
        let db = open_db_gz(&db_path).expect("应该读得到参考库");
        let matcher = FastGlyphMatcher::new(db);

        let font_path =
            repo_path("src/features/safari-repair/test/fixtures/fonts/obf-same-style.ttf");
        let font = std::fs::read(&font_path).expect("应该读得到字体样本");

        let truth_path =
            repo_path("src/features/safari-repair/test/fixtures/fonts/obf-same-style.map.json");
        let truth: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&truth_path).expect("应该读得到真值表"))
                .expect("真值表应该是 JSON");

        let entries = analyze_font(matcher.db(), &matcher, &font).expect("应该分析得出结果");
        let mapping = build_mapping(&entries);

        let truth = truth.as_object().expect("真值表应该是对象");
        assert!(!truth.is_empty(), "真值表不该是空的");

        let mut wrong: Vec<String> = Vec::new();
        for (k, v) in truth.iter() {
            let key = k.chars().next().expect("键应该是单字");
            match mapping.get(&key) {
                Some(got) if got.to_string() == *v => {}
                Some(got) => wrong.push(format!("{}->{} (应 {})", key, got, v)),
                None => wrong.push(format!("{} 没映射", key)),
            }
        }
        assert!(
            wrong.is_empty(),
            "还原结果不对(共 {} 个,前几条: {:?})",
            wrong.len(),
            &wrong[..wrong.len().min(5)]
        );
    }
}
