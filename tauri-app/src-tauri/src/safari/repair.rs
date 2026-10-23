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

use rayon::prelude::*;
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
    /// **逐个作用域**的映射结果(scopeKey → 结果描述)。
    ///
    /// 只留"最后一次"是不行的:一个页面上常有五六个作用域
    /// (混淆字体、图标字体、各种普通字体栈),处理顺序一变,
    /// 真正出问题的那条就被后面的一条盖住了 —— 排查时等于什么都看不到。
    mapping_by_scope: std::collections::HashMap<String, String>,
}

/// ── 快通道（Electron 版 `fastTick` 的同口径实现）─────────────────────
///
/// ## 为什么必须有这条通道（2026-10-23 真机故障）
///
/// 主轮询里,目标站点的标签**每 2 轮**才处理一次(`SITE_TAB_EVERY_ROUNDS`),
/// 而一轮本身要:判活(1 次 Apple Event ≈110ms) + 列全部标签(≈110ms)
/// + 逐个标签处理 → **实际一圈 ~500ms 以上**,目标标签实际 **~1 秒**才被看一眼。
///
/// 用户切题后立刻复制,这一秒里映射还没下发 → **复制出来是密文**。
/// 表现是"两三次里错一次" —— 失败率 ≈50%,正好是"每 2 轮"的周期规律,
/// **不是随机故障**。
///
/// Electron 版有一条**独立**的快轮询(`coordinator.js` 的 `fastTick`):
/// 200ms 一次,只盯"出现过混淆字体的标签",**不判活、不列标签**,
/// 且不共用主轮次的 running 标志(它自己的注释写着:
/// 「否则主轮次一圈 1.4 秒会把快轮询饿死」)。这边照搬那个形状。
///
/// ## 与主通道的关系
///
/// - 同一个标签**只由一条通道处理**:登记进快通道后,主通道跳过它
///   （否则每次轮询都要多花两次 Apple Event,纯属浪费）。
/// - 快通道线程要是死了,主通道会**接管**回来:靠心跳判断快通道还活着没。
const FAST_POLL_INTERVAL_MS: u64 = 200;

/// 快通道盯着的标签 + 心跳。
struct CipherTabs {
    /// (窗口, 标签) → 登记时的 URL
    tabs: std::collections::HashMap<(u32, u32), String>,
    /// 快通道最近一次心跳（诊断用）
    heartbeats: u64,
    /// 快通道最近一次心跳的时刻（判断它是不是还活着）
    last_beat: std::time::Instant,
    /// 上一轮**干活**用了多久（毫秒）—— 干活 = 发 Apple Event 的那些时间
    last_work_ms: u64,
    /// 上一轮**整个周期**用了多久（毫秒）= 干活 + 轮间 sleep
    last_period_ms: u64,
}

static CIPHER_TABS: OnceLock<Mutex<CipherTabs>> = OnceLock::new();

fn cipher_tabs() -> &'static Mutex<CipherTabs> {
    CIPHER_TABS.get_or_init(|| {
        Mutex::new(CipherTabs {
            tabs: std::collections::HashMap::new(),
            heartbeats: 0,
            last_beat: std::time::Instant::now(),
            last_work_ms: 0,
            last_period_ms: 0,
        })
    })
}

/// 正在被处理的标签 —— 防止主通道与快通道同时处理同一个标签。
///
/// 两个线程同时对同一个标签注入/下发映射,后到的会把先到的覆盖掉,
/// 而先到的那次 Apple Event 还在等页面返回 —— 表现为偶发的"映射丢了"。
static BUSY_TABS: OnceLock<Mutex<std::collections::HashSet<(u32, u32)>>> = OnceLock::new();

fn busy_tabs() -> &'static Mutex<std::collections::HashSet<(u32, u32)>> {
    BUSY_TABS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 登记一个"出现过混淆字体"的标签（进快通道）。
fn register_cipher_tab(window_index: u32, tab_index: u32, url: &str) {
    if let Ok(mut c) = cipher_tabs().lock() {
        c.tabs.insert((window_index, tab_index), url.to_string());
    }
}

/// 把标签从快通道摘掉（标签被关掉/换位了）。
fn unregister_cipher_tab(window_index: u32, tab_index: u32) {
    if let Ok(mut c) = cipher_tabs().lock() {
        c.tabs.remove(&(window_index, tab_index));
    }
}

/// 快通道盯着的标签快照。
fn cipher_tab_snapshot() -> Vec<(u32, u32)> {
    cipher_tabs()
        .lock()
        .map(|c| c.tabs.keys().copied().collect())
        .unwrap_or_default()
}

/// 快通道是不是还活着（心跳在 2 秒以内）。
///
/// 主通道靠它决定"要不要接管快通道的标签"——
/// 快通道线程要是 panic 死了,不能就此不再管那些标签。
fn fast_alive() -> bool {
    cipher_tabs()
        .lock()
        .map(|c| c.last_beat.elapsed() < std::time::Duration::from_secs(2))
        .unwrap_or(false)
}

/// 快通道诊断信息。
pub fn fast_diagnostics() -> serde_json::Value {
    match cipher_tabs().lock() {
        Ok(c) => serde_json::json!({
            "cipherTabs": c.tabs.len(),
            "heartbeats": c.heartbeats,
            "alive": c.last_beat.elapsed() < std::time::Duration::from_secs(2),
            "intervalMs": FAST_POLL_INTERVAL_MS,
            // **这一轮真正花了多久** —— 名义间隔只是名义值,
            // 实际周期 = 干活时间 + 轮间 sleep(Apple Event 往返 ≈90ms/次)。
            "workMs": c.last_work_ms,
            "periodMs": c.last_period_ms,
        }),
        Err(_) => serde_json::json!({ "error": "快通道状态锁不可用" }),
    }
}

/// 抢一个标签的处理权。抢不到说明别的线程正在处理它 → 这一轮跳过。
fn try_lock_tab(key: (u32, u32)) -> bool {
    match busy_tabs().lock() {
        Ok(mut set) => set.insert(key),
        Err(_) => true, // 锁坏了就别互相挡着(宁可重复也不要不处理)
    }
}

fn unlock_tab(key: (u32, u32)) {
    if let Ok(mut set) = busy_tabs().lock() {
        set.remove(&key);
    }
}

/// 启动快通道线程（200ms 一轮）。
pub fn spawn_fast_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            let t_round = std::time::Instant::now();
            if is_enabled() {
                if let Ok(mut c) = cipher_tabs().lock() {
                    c.heartbeats += 1;
                    c.last_beat = std::time::Instant::now();
                }
                // Safari 在不在跑:读**主通道**的状态(它每轮都在问)——
                // 不额外发 Apple Event(一次就是 110ms,而这条通道 200ms 才走一轮)。
                if safari_running_state().unwrap_or(false) {
                    fast_tick(&app);
                }
            }
            // **量这一轮真正花了多久** —— 名义间隔是名义值:
            // 实际周期 = 干活(Apple Event 往返)+ 轮间 sleep。
            // 这个数以前没人量过,文档里写的"200ms 一轮"其实对不上。
            let work_ms = t_round.elapsed().as_millis() as u64;
            // **睡到下一轮的名义时刻**（不是"干完再睡 200ms"）。
            //
            // Electron 版是 `setInterval(fastTick, 200)` —— 那是**两次开始之间** 200ms，
            // 干活的时间算在里面。这边照搬同一个口径（ADR-0016 说"照搬形状"），
            // 否则周期 = 干活 + 200ms（工作 110ms 时实测 310ms；修 state_once 之前
            // 工作 240ms 时是 450ms），比 Electron 慢一截，
            // 而用户等的就是这几百毫秒。
            let sleep_ms = FAST_POLL_INTERVAL_MS.saturating_sub(work_ms);
            std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
            if let Ok(mut c) = cipher_tabs().lock() {
                c.last_work_ms = work_ms;
                c.last_period_ms = t_round.elapsed().as_millis() as u64;
            }
        }
    });
}

/// 快通道这一轮:把盯着的那几个标签各跑一遍。
fn fast_tick(app: &tauri::AppHandle) {
    for (w, t) in cipher_tab_snapshot() {
        match check_tab(app, w, t) {
            Ok(_) => {}
            Err(e) => {
                // **只在标签真的没了的时候**才摘掉它:
                // - `-1728` = "不能获得 tab N of window M" → 标签被关掉/换位了;
                // - 超时 = 页面忙,守卫其实已经装上了 → 不是"标签没了";
                // - 别的错(注入失败等)也留着 —— 下一轮就好。
                //
                // 摘错的代价:标签被关了却还盯着 → 快通道每 200ms 白打一次
                // Apple Event(≈100ms/次),一直打下去。
                if e.contains("-1728") {
                    unregister_cipher_tab(w, t);
                }
            }
        }
    }
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
///
/// **必须按标签分别计数**：Electron 版是 `tabState.ticksSinceInject`（每个标签一份），
/// 而这里原来是一个**全局**计数器 —— 一轮里要处理好几个标签，计数被摊薄，
/// 实际每 1~2 轮就强制重注入一次（一次 Apple Event ≈110ms），
/// 比 Electron 频繁 2.5 倍，白白吃掉一截轮次时间。
static STATE_ONCE: OnceLock<Mutex<std::collections::HashMap<(u32, u32), u32>>> = OnceLock::new();

/// 每个标签的「处理轮次」计数（强制重注入的节流用）。
///
/// **必须走这个函数拿**（`get_or_init`）——
/// 直接 `STATE_ONCE.get()` 永远是 `None`（OnceLock 从没被 `set` 过），
/// 计数就恒为 0 → `0 % FORCE_INJECT_EVERY == 0` 恒成立 →
/// **每轮都强制重注入一次**（一次 25KB 脚本的 Apple Event ≈110ms）。
/// 实测那会让快通道每轮多花一倍时间（工作 240ms、周期 450ms；
/// 修好后工作 ~110ms、周期 ~200ms）。
fn state_once() -> &'static Mutex<std::collections::HashMap<(u32, u32), u32>> {
    STATE_ONCE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 已经喊过"重报"的标签（每个标签只喊一次）。
///
/// **为什么必须喊**：守卫"页面里已经有映射就不上报"这条规则是按**页面**的状态算的，
/// 而 App 是另一个进程 —— App 重启后自己手里是空的，页面却还留着上一任 App
/// 下发的映射 → 守卫以为"不用报" → **App 永远学不到这个作用域** →
/// 也就不会登记这个标签 → **快通道根本不盯它** →
/// 换题之后只能等主通道那一圈（~1.2 秒）→ 用户"换题立刻复制"就复制出密文。
static RESYNCED_TABS: OnceLock<Mutex<std::collections::HashSet<(u32, u32)>>> = OnceLock::new();

fn resynced_tabs() -> &'static Mutex<std::collections::HashSet<(u32, u32)>> {
    RESYNCED_TABS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// 这个标签是不是**第一次**被处理？第一次的话要喊一声"重报"。
fn claim_resync(window_index: u32, tab_index: u32) -> bool {
    match resynced_tabs().lock() {
        Ok(mut set) => set.insert((window_index, tab_index)),
        Err(_) => false,
    }
}

/// 记下最近一次「映射没建起来」的原因（诊断用）。
pub fn set_mapping_note(note: &str) {
    if let Ok(mut s) = state().lock() {
        s.last_mapping_note = note.to_string();
    }
}

/// 记下**某个作用域**的映射结果（诊断用）。
///
/// 一个页面上常有好几个作用域(混淆字体、图标字体、几个普通字体栈),
/// 只留"最后一次"会把真正出问题的那条盖住 —— 必须逐条记。
pub fn set_mapping_result(scope_key: &str, note: &str) {
    if let Ok(mut s) = state().lock() {
        s.last_mapping_note = note.to_string();
        s.mapping_by_scope.insert(scope_key.to_string(), note.to_string());
        // 只留最近 12 条,免得诊断文件无限长
        if s.mapping_by_scope.len() > 12 {
            let oldest = s
                .mapping_by_scope
                .keys()
                .next()
                .cloned()
                .unwrap_or_default();
            s.mapping_by_scope.remove(&oldest);
        }
    }
}

/// 逐个作用域的映射结果(诊断用)。
pub fn mapping_results() -> serde_json::Value {
    state()
        .lock()
        .map(|s| {
            let mut map = serde_json::Map::new();
            for (k, v) in s.mapping_by_scope.iter() {
                map.insert(k.clone(), serde_json::Value::String(v.clone()));
            }
            serde_json::Value::Object(map)
        })
        .unwrap_or_else(|_| serde_json::json!({}))
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

/// 取**快速匹配器**（参考库 + 粗栅格解包 + 精确哈希索引）。
///
/// **必须缓存**：匹配器构造一次要
///   - 把粗栅格解包成 nibble 数组（21517 × 64 ≈ 1.4MB）
///   - 建精确哈希索引（21517 条）
/// 实测 release 下 **26ms**；而 `FastGlyphMatcher::new` 要**拿走** GlyphDb 的所有权,
/// 所以每次调用都得克隆整份库（9.7MB）—— 两者加起来 **36ms/次**。
///
/// 快通道每 200ms 跑一轮,每次都重建就是纯浪费(还会让整台机器发烫)。
/// Electron 版是 `engine.matchers` 这个 Map,本来就只建一次 —— 这边同口径。
fn fast_matcher(app: &tauri::AppHandle) -> Result<std::sync::Arc<FastGlyphMatcher>, String> {
    static M: OnceLock<std::sync::Arc<FastGlyphMatcher>> = OnceLock::new();
    if let Some(m) = M.get() {
        return Ok(m.clone());
    }
    let db = reference_db(app)?;
    let m = std::sync::Arc::new(FastGlyphMatcher::new((*db).clone()));
    let _ = M.set(m.clone());
    Ok(m)
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

/// 字体**解析/分析**失败的负缓存（key = URL 或字体内容哈希）。
///
/// ## 为什么要有（它和"下载失败负缓存"不是一回事）
///
/// 站点的 @font-face 经常指向一个**返回 HTML 错误页**的 URL：
/// 实测学习通的 `icomoon.ttf?ca3c1w` 返回 **529 字节的 HTML 文档**。
/// 这种 URL **下载是"成功"的**（curl 退出码 0、字节非空），
/// 所以"下载失败负缓存"根本抓不到它 ——
/// 于是每轮都要重新下载一次（实测 **130~160ms**）+ 再解析一遍，
/// 白白吃掉一整轮的时间：**快通道的实测周期从 205ms 变成 417ms**。
///
/// 记两份：
/// - **URL 级**：在下载之前就命中 → 连下载都省掉。
/// - **内容哈希级**：在解析之前命中 → 覆盖 `data:` 内嵌字体那条路。
///
/// 冷却时间沿用"下载失败负缓存"那档（10 分钟）。
static ANALYSIS_FAILS: OnceLock<Mutex<Vec<(String, FontFailure)>>> = OnceLock::new();

fn analysis_fail_cache() -> &'static Mutex<Vec<(String, FontFailure)>> {
    ANALYSIS_FAILS.get_or_init(|| Mutex::new(Vec::new()))
}

/// 记一次字体解析失败（key = URL 或内容哈希）。
fn remember_analysis_failure(key: &str, message: &str) {
    if let Ok(mut cache) = analysis_fail_cache().lock() {
        cache.retain(|(k, _)| k != key);
        cache.push((
            key.to_string(),
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

/// 取一次字体解析失败（冷却期内才有；过期了要重新试，因为可能是临时故障）。
fn analysis_failure(key: &str) -> Option<String> {
    let hit = analysis_fail_cache()
        .lock()
        .ok()
        .and_then(|c| c.iter().find(|(k, _)| k == key).map(|(_, f)| f.clone()))?;
    if crate::commands::app::now_ms() - hit.at < FONT_FAIL_COOLDOWN_MS {
        Some(hit.message)
    } else {
        None
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
    // **解析失败也要缓存**（按内容哈希）：不缓存的话，每轮都要重新解析一遍
    // （站点的图标字体 URL 常常返回 HTML 错误页 → 解析必失败 → 每轮白花时间）。
    if let Some(hit) = analysis_failure(&hash) {
        return Err(hit);
    }

    let face = match Face::parse(font_bytes, 0) {
        Ok(face) => face,
        Err(e) => {
            let msg = format!("字体解析失败: {}", e);
            remember_analysis_failure(&hash, &msg);
            return Err(msg);
        }
    };
    let t = Thresholds::default();
    let window = RasterWindow::CANONICAL;

    let mut per_char: HashMap<char, CharInfo> = HashMap::new();
    // 逐码位算判定结果 —— 各码位互不依赖,**并行算**。
    //
    // 一份混淆字体有上百个码位,每个都要:栅格化 → 与参考库比对 → 取最近邻。
    // **串行实测 11 秒**(2026-10-23,真实站点那份 font-cxsecret)。
    // 这 11 秒里页面上一份映射都没有 → 用户"换题后立刻复制"必然复制出密文
    // (这正是"第一次成功、后两次失败"的原因之一:
    //  第一份字体的结果被缓存了,换到新字体就是缓存不命中,又要等一遍)。
    //
    // 并行后按核数缩短(本机 10 核)。**判定口径一个字都没改**:
    // 每个码位独立算,谁也不依赖谁,谁也不看顺序。
    let codepoints = font_codepoints(&face);
    let computed: Vec<(char, CharInfo)> = codepoints
        .par_iter()
        .filter_map(|ch| {
            let ch = *ch;
            let Some(coverage) = coverage_for_char(&face, ch, 48, window) else {
                return None;
            };
            let coverage = quantize(&coverage);
            let cp = ch as u32;
            let self_distance = match db.index_of_codepoint(cp) {
                Some(idx) => db.distance_to_index(idx, &coverage),
                None => 1.0,
            };
            if self_distance < t.replace_self_distance {
                // 画的就是它自己 → 不用改
                return Some((
                    ch,
                    CharInfo {
                        plain: None,
                        score: 0.0,
                        margin: 0.0,
                        self_distance,
                    },
                ));
            }
            let raw = matcher.lookup(&coverage, t.max_candidates);
            let picked = pick_candidate(&raw, &t);
            Some((
                ch,
                CharInfo {
                    plain: picked.codepoint,
                    score: picked.score,
                    margin: picked.margin,
                    self_distance,
                },
            ))
        })
        .collect();
    for (ch, info) in computed {
        per_char.insert(ch, info);
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
///
/// **同一个标签只允许一条通道在处理**：主通道与快通道都调它,
/// 用「处理权」锁互斥 —— 否则两次注入/下发会互相覆盖,
/// 而先发的那次 Apple Event 还在等页面返回(表现为偶发的"映射丢了")。
pub fn check_tab(
    app: &tauri::AppHandle,
    window_index: u32,
    tab_index: u32,
) -> Result<(usize, bool), String> {
    let key = (window_index, tab_index);
    if !try_lock_tab(key) {
        // 别的线程正在处理这个标签 → 这一轮跳过(它会处理到)。
        return Ok((0, false));
    }
    let result = check_tab_inner(app, window_index, tab_index);
    unlock_tab(key);
    result
}

fn check_tab_inner(
    app: &tauri::AppHandle,
    window_index: u32,
    tab_index: u32,
) -> Result<(usize, bool), String> {
    // 匹配器**只建一次**(快通道 200ms 一轮,每次重建要 36ms —— 纯浪费)。
    let matcher = fast_matcher(app)?;

    // 1) 先采集状态
    //
    // 顺序必须和 Electron 版一致（先采集、缺守卫才注入）：
    // 注入是一次"等页面 JS 返回"的 Apple Event，每轮都重注入会把页面拖住，
    // AppleScript 一直等 → 8 秒超时。Electron 版只注入一次，所以不会卡。
    //
    // **第一次处理这个标签时要喊一声"重报"**：让页面把已知作用域重新报一遍，
    // 否则 App 学不到它们 → 不会登记这个标签 → 快通道是瞎的（见 resynced_tabs）。
    let resync = claim_resync(window_index, tab_index);
    let state = bridge::poll_state(Some(tab_index), Some(window_index), resync)?;

    // 2) 守卫不在才注入（每 FORCE_INJECT_EVERY 轮再强制补一次，对齐 Electron）
    let guard_present = state.get("guard").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut inject_count = 0u32;
    {
        let mut slots = state_once().lock().map_err(|_| "计数器锁坏了".to_string())?;
        let counter = slots.entry((window_index, tab_index)).or_insert(0);
        *counter += 1;
        inject_count = *counter;
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
                // 页面上的普通字体(没有可取的字体文件)—— 不是故障,但也要记一条,
                // 否则"这个作用域为什么没有映射"就没人答得上来了。
                set_mapping_result(scope_key, "该作用域没有可取的字体来源(普通字体,不需要映射)");
                continue;
            };
            // **先看"这个字体解析不出来"的负缓存**：连下载都省掉。
            //
            // 站点的图标字体 URL 常常返回 HTML 错误页（实测学习通 icomoon.ttf
            // 返回 529 字节 HTML）—— 那种下载是"成功"的，
            // "下载失败负缓存"抓不到 → 每轮白下载一次（130~160ms）。
            if kind == "url" {
                if let Some(hit) = analysis_failure(&value) {
                    set_mapping_result(scope_key, &format!("分析字体失败(负缓存): {}", hit));
                    continue;
                }
            }
            let Ok(font_bytes) = fetch_font(&kind, &value) else {
                set_mapping_result(scope_key, &format!("取字体失败({}): {}", kind, value));
                continue;
            };
            // 同一个字体只解析一次(按内容哈希缓存)
            let Ok(entries) = analyze_font(matcher.db(), &matcher, &font_bytes) else {
                // 解析失败也要记负缓存：否则每轮都重新解析一遍（白花时间）。
                if kind == "url" {
                    remember_analysis_failure(&value, &format!("解析失败: {}", value));
                }
                set_mapping_result(scope_key, &format!("分析字体失败: {}", value));
                continue;
            };
            let mapping = build_mapping(&entries);
            if mapping.is_empty() {
                set_mapping_result(
                    scope_key,
                    &format!("映射为空(字体 {} 个码位,都没认准)", entries.len()),
                );
                continue;
            }
            set_mapping_result(scope_key, &format!("映射建成了: {} 个字", mapping.len()));
            // **建出了映射 = 这个标签用了混淆字体** → 登记进快通道。
            //
            // 快通道 200ms 一轮地盯着它,用户切题后映射能在 ~300ms 内下发
            // (主通道是"每 2 轮"≈1 秒,用户往往等不到)。
            //
            // 只登记**真的建出映射**的标签:图标字体(icomoon 之类)建不出映射,
            // 它们不会换题,不需要快反应 —— 让它们进来只是白花 Apple Event。
            if let Some(url) = state.get("url").and_then(|v| v.as_str()) {
                register_cipher_tab(window_index, tab_index, url);
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

/// 快通道当前盯着的标签集合。
fn cipher_tab_set() -> std::collections::HashSet<(u32, u32)> {
    cipher_tabs()
        .lock()
        .map(|c| c.tabs.keys().copied().collect())
        .unwrap_or_default()
}

/// 这一轮主通道要处理哪些标签（**纯函数**，便于测试）。
///
/// 口径与 Electron 版 coordinator.js 的 `planJobs` 同构：
/// - 目标站点的标签：**每 2 轮**处理一次；
/// - 前台标签：每轮都处理；
/// - **快通道在盯的标签：主通道不重复处理**（快通道 200ms 一轮，
///   主通道"每 2 轮"≈1 秒 —— 两个都做就是每次轮询多花两次 Apple Event）。
///   但快通道心跳过期时（线程死了），主通道**自动接管**回来，
///   不能就此不再管那些标签。
fn select_targets(
    round: u64,
    tabs: &[(u32, u32, String)],
    front: Option<(u32, u32)>,
    cipher: &std::collections::HashSet<(u32, u32)>,
    fast_alive: bool,
) -> Vec<(u32, u32)> {
    let mut targets: Vec<(u32, u32)> = Vec::new();
    let skip = |k: (u32, u32)| fast_alive && cipher.contains(&k);
    if round % SITE_TAB_EVERY_ROUNDS == 0 {
        for (w, t, url) in tabs {
            if SITE_FILTER.iter().any(|s| url.contains(s)) {
                if skip((*w, *t)) {
                    continue;
                }
                targets.push((*w, *t));
            }
        }
    }
    // 前台标签:每轮都处理 —— 不这样的话,"在别的网站上用了混淆字体"永远不会被接管
    if let Some((w, t)) = front {
        if !targets.contains(&(w, t)) && !skip((w, t)) {
            targets.push((w, t));
        }
    }
    targets
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
    let mut targets: Vec<(u32, u32)> = select_targets(
        round,
        &tabs,
        front,
        &cipher_tab_set(),
        fast_alive(),
    );
    for (w, t) in targets.drain(..) {
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

    /// 字体**解析不出来**也要负缓存。
    ///
    /// 站点的图标字体 URL 常常返回 HTML 错误页（实测学习通的 icomoon.ttf
    /// 返回 529 字节 HTML）—— 那种下载是"成功"的（curl 退出码 0），
    /// 所以"下载失败负缓存"抓不到它 → 每轮都白下载一次（实测 130~160ms）
    /// 再解析一遍 → 快通道的实测周期从 205ms 变成 417ms。
    #[test]
    fn 解析失败进负缓存_冷却期内不再重复() {
        let key = "test://analysis-fail-key";
        if let Ok(mut cache) = analysis_fail_cache().lock() {
            cache.retain(|(k, _)| k != key);
        }
        assert!(
            analysis_failure(key).is_none(),
            "一开始不该有失败记录(否则这条用例会被上一轮跑过的残留污染)"
        );

        remember_analysis_failure(key, "字体解析失败: 假的");
        assert_eq!(
            analysis_failure(key).as_deref(),
            Some("字体解析失败: 假的"),
            "冷却期内应当能取到失败记录"
        );

        // 冷却过期 → 允许重试（失败也可能是临时故障）
        if let Ok(mut cache) = analysis_fail_cache().lock() {
            for (k, f) in cache.iter_mut() {
                if k == key {
                    f.at -= FONT_FAIL_COOLDOWN_MS + 1000;
                }
            }
        }
        assert!(analysis_failure(key).is_none(), "冷却过期后应当允许重试");
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

    /// **快通道的登记/摘除**。
    ///
    /// 快通道盯着的标签 = "出现过混淆字体"的标签。
    /// 登记错了 → 要么快通道白转(每 200ms 一次 Apple Event),
    /// 要么该快反应的标签没被盯上(回到"切题后 1 秒才有映射"的老毛病)。
    #[test]
    fn 快通道的登记与摘除() {
        let key = (7u32, 19u32);
        unregister_cipher_tab(key.0, key.1);
        assert!(
            !cipher_tab_set().contains(&key),
            "一开始不该在快通道里"
        );

        register_cipher_tab(key.0, key.1, "https://example.com/quiz");
        assert!(
            cipher_tab_set().contains(&key),
            "登记后必须在快通道里"
        );

        unregister_cipher_tab(key.0, key.1);
        assert!(
            !cipher_tab_set().contains(&key),
            "摘掉后必须不在快通道里"
        );
    }

    /// **同一个标签只允许一条通道在处理**。
    ///
    /// 主通道与快通道都会调 `check_tab`;两个线程同时对同一个标签
    /// 注入/下发映射 → 后到的覆盖先到的,而先发的那次 Apple Event
    /// 还在等页面返回 → 偶发的"映射丢了"。
    #[test]
    fn 同一个标签只允许一条通道处理() {
        let key = (3u32, 11u32);
        assert!(try_lock_tab(key), "第一次应该抢到处理权");
        assert!(!try_lock_tab(key), "第二次必须抢不到");
        unlock_tab(key);
        assert!(try_lock_tab(key), "释放之后应该能再抢到");
        unlock_tab(key);
    }

    /// **主通道要让位给快通道,但快通道死了要接管回来**。
    ///
    /// 这是这次故障的核心:目标标签"每 2 轮"才被主通道看一眼(≈1 秒),
    /// 用户切题后立刻复制 → 映射还没下发 → 复制出来是密文
    /// (2026-10-23 真机故障,表现是"两三次里错一次")。
    /// 快通道活着 → 主通道不重复处理(省两次 Apple Event);
    /// 快通道心跳过期 → 主通道**必须**接管,否则那些标签就再没人管了。
    #[test]
    fn 主通道让位给快通道_快通道死了要接管() {
        let tabs = vec![
            (1u32, 5u32, "https://mooc1.chaoxing.com/mycourse/studentstudy".to_string()),
            (1u32, 6u32, "https://www.bilibili.com/".to_string()),
        ];
        let cipher: std::collections::HashSet<(u32, u32)> = [(1u32, 5u32)].into_iter().collect();

        // 快通道活着 → 主通道跳过那个标签(但**只在这轮**处理目标站点标签)
        let targets = select_targets(SITE_TAB_EVERY_ROUNDS, &tabs, None, &cipher, true);
        assert!(
            !targets.contains(&(1, 5)),
            "快通道活着时,主通道不该重复处理它"
        );

        // 快通道死了(心跳过期) → 主通道接管回来
        let targets = select_targets(SITE_TAB_EVERY_ROUNDS, &tabs, None, &cipher, false);
        assert!(
            targets.contains(&(1, 5)),
            "快通道没了,主通道必须接管,否则那个标签就再没人管"
        );
    }

    /// **目标站点标签每 2 轮才进主通道**(Electron 版同口径)。
    ///
    /// 这条本身不是 bug,但它正是"切题后要等 1 秒"的来源 ——
    /// 有了快通道之后,主通道这条慢通道只负责"发现新标签"。
    #[test]
    fn 目标站点标签每两轮才进主通道() {
        let tabs = vec![(1u32, 5u32, "https://i.chaoxing.com/base".to_string())];
        let empty: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();

        let odd = select_targets(1, &tabs, None, &empty, true);
        assert!(odd.is_empty(), "不是 2 的倍数那轮不该处理目标站点标签");

        let even = select_targets(2, &tabs, None, &empty, true);
        assert_eq!(even, vec![(1, 5)], "第 2 轮必须处理目标站点标签");
    }
}
