//! Windows 线的注入协调器 —— mac 线 `safari/repair.rs` 与
//! Electron 线 `chromium-repair/coordinator.js` 的 Windows 对位物。
//!
//! ## 它管什么
//!
//!   1. 让浏览器保持可用（我们自己起的那个），断开了就重连/重开
//!   2. 每个标签页装上页面守卫（CDP document_start 注入 + 已开页面当场注入）
//!   3. 收页面上报的字体作用域 → App 侧算「密文 → 明文」映射 → 下发回页面
//!   4. 用户按下 Ctrl+C 时，页面守卫在 copy 事件里把明文写进剪贴板
//!
//! ## 和 mac 版的差别（只有这一处是本质的）
//!
//! mac 的「标签页」是 Safari 的「第几个标签、第几个窗口」；
//! Windows 的「标签页」是 CDP 的 target（一个 target = 一个标签页）。
//! 其余逻辑（阈值、只对**真建出映射**的作用域下发、换题后重报、
//! 带混淆字体的标签走快轮询）**逐条照抄**，保持两条线行为一致。
//!
//! ## 为什么快轮询要单独拎出来
//!
//! 换题后站点会换一套新的加密字体，新字体的映射需要「发现 → 解析 → 下发」一圈。
//! 主轮次一圈要轮询所有标签（每个标签一次 CDP 往返），用户「切完题立刻复制」
//! 时映射还没就绪 → 剪贴板里是原始密文。
//! 所以带混淆字体的标签走独立的快轮询（~200ms 一轮）。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::chromium::browser::ManagedBrowser;
use crate::chromium::bridge::{build_injection_source, CdpBridge};
use crate::glyph::db::FastGlyphMatcher;
use crate::safari::repair::{analyze_font, build_mapping, fetch_font, group_font_source};

/// 主轮询间隔（Electron 版 coordinator.js 同口径：300ms）。
pub const DEFAULT_INTERVAL_MS: u64 = 300;

/// 带混淆字体的标签走快轮询（200ms 一轮）。
pub const CIPHER_TAB_POLL_MS: u64 = 200;

/// 同一个标签连续几轮没有守卫就强制重新注入。
pub const FORCE_INJECT_EVERY: u32 = 5;

/// 一个标签的处理结果。
#[derive(Clone, Copy, Debug, Default)]
pub struct TabOutcome {
    /// 这一轮下发了几份映射。
    pub mapped: usize,
}

/// 一轮调度的结果。
#[derive(Clone, Debug, Default)]
pub struct TickOutcome {
    pub tabs: usize,
    pub mapped: usize,
    pub errors: Vec<String>,
}

/// 状态快照（给界面看）。
#[derive(Clone, Debug, Default)]
pub struct CoordinatorStatus {
    pub enabled: bool,
    pub injected: bool,
    pub browser_running: bool,
    pub browser_label: String,
    pub mappings: usize,
    pub watched_tabs: usize,
    pub ticks: u64,
    pub injections: u64,
    pub last_error: String,
}

/// 每个标签的「本轮记要」。
#[derive(Clone, Debug, Default)]
struct Watched {
    url: String,
    ticks_since_inject: u32,
    /// 已经喊过一次「重报」了吗。
    resynced: bool,
}

#[derive(Default)]
struct CoordState {
    /// 开关（运行态）。
    enabled: bool,
    watched: HashMap<u32, Watched>,
    /// 带混淆字体的标签 → 登记时的 URL（走快轮询）。
    cipher_tabs: HashMap<u32, String>,
    /// 逐个作用域的映射结果（诊断用）。
    mapping_by_scope: HashMap<String, String>,
    ticks: u64,
    injections: u64,
    mappings: usize,
    injected: bool,
    last_error: String,
    /// 浏览器在不在跑（每轮更新一次，状态查询是同步的）。
    browser_running: bool,
    browser_label: String,
}

/// 注入协调器。
pub struct Coordinator {
    browser: Arc<ManagedBrowser>,
    matcher: Arc<FastGlyphMatcher>,
    injection_source: String,
    bridge_cell: tokio::sync::Mutex<Option<Arc<CdpBridge>>>,
    state: std::sync::Mutex<CoordState>,
}

/// 一个作用域的映射结果。
struct ScopeResult {
    scope_key: String,
    mapping: HashMap<char, char>,
    note: String,
}

impl Coordinator {
    /// 新建一个协调器并把两条轮询通道跑起来。
    pub fn new(
        browser: Arc<ManagedBrowser>,
        matcher: Arc<FastGlyphMatcher>,
        injection_source: String,
    ) -> Arc<Self> {
        let coordinator = Arc::new(Coordinator {
            browser,
            matcher,
            injection_source,
            bridge_cell: tokio::sync::Mutex::new(None),
            state: std::sync::Mutex::new(CoordState::default()),
        });
        let main = coordinator.clone();
        tauri::async_runtime::spawn(async move { main.main_loop().await });
        let fast = coordinator.clone();
        tauri::async_runtime::spawn(async move { fast.fast_loop().await });
        coordinator
    }

    /// 用仓库里那份页面守卫与帧桥拼出注入源。
    pub fn default_injection_source(guard_js: &str, frame_bridge_js: &str) -> String {
        build_injection_source(guard_js, frame_bridge_js)
    }

    /// 开关（运行态）。
    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.state.lock().unwrap();
        state.enabled = enabled;
        if !enabled {
            state.injected = false;
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.state.lock().unwrap().enabled
    }

    /// 确保浏览器在跑、CDP 连着；返回 bridge。
    pub async fn ensure_bridge(&self) -> Result<Arc<CdpBridge>, String> {
        let mut cell = self.bridge_cell.lock().await;
        if let Some(bridge) = cell.as_ref() {
            if !bridge.client.is_closed() {
                return Ok(bridge.clone());
            }
        }
        let client = self.browser.ensure().await?;
        let bridge = CdpBridge::new(client, self.injection_source.clone());
        bridge.setup().await?;
        *cell = Some(bridge.clone());
        Ok(bridge)
    }

    /// 主轮询通道：300ms 一轮。
    async fn main_loop(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(Duration::from_millis(DEFAULT_INTERVAL_MS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if !self.is_enabled() {
                continue;
            }
            let _ = self.tick().await;
        }
    }

    /// 快轮询通道：200ms 一轮，只盯带混淆字体的标签。
    async fn fast_loop(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(Duration::from_millis(CIPHER_TAB_POLL_MS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if !self.is_enabled() {
                continue;
            }
            let tabs = self.cipher_tab_snapshot();
            if tabs.is_empty() {
                continue;
            }
            let bridge = match self.ensure_bridge().await {
                Ok(b) => b,
                Err(_) => continue,
            };
            for ordinal in tabs {
                let _ = self.process_tab(&bridge, ordinal).await;
            }
        }
    }

    /// 快通道当前盯着的标签。
    fn cipher_tab_snapshot(&self) -> Vec<u32> {
        self.state
            .lock()
            .unwrap()
            .cipher_tabs
            .keys()
            .copied()
            .collect()
    }

    /// 登记一个「出现过混淆字体」的标签，之后走快轮询。
    fn register_cipher_tab(&self, ordinal: u32, url: &str) {
        let mut state = self.state.lock().unwrap();
        state.cipher_tabs.insert(ordinal, url.to_string());
    }

    /// 这一轮要处理哪些标签页。
    ///
    /// ⚠️ **不过滤站点**（Electron 线现在的口径）：主轮询扫**全部**标签页。
    /// 理由：站点过滤会把「别的网站上用了混淆字体」这类场景整个漏掉
    /// （mac 线是「目标站点标签 + 前台标签」，Windows 线这里没有「前台」的概念）。
    fn plan_jobs(&self, bridge: &CdpBridge) -> Vec<u32> {
        bridge.list_tabs().into_iter().map(|tab| tab.ordinal).collect()
    }

    /// 一轮调度。
    pub async fn tick(&self) -> Result<TickOutcome, String> {
        {
            let mut state = self.state.lock().unwrap();
            state.ticks += 1;
        }
        let bridge = self.ensure_bridge().await?;
        {
            let running = self.browser.is_running().await;
            let label = self.browser.browser_label().await;
            let mut state = self.state.lock().unwrap();
            state.browser_running = running;
            state.browser_label = label;
        }
        let mut outcome = TickOutcome::default();
        for ordinal in self.plan_jobs(&bridge) {
            outcome.tabs += 1;
            match self.process_tab(&bridge, ordinal).await {
                Ok(result) => outcome.mapped += result.mapped,
                Err(e) => outcome.errors.push(e),
            }
        }
        if !outcome.errors.is_empty() {
            let message = outcome.errors.join("; ");
            self.state.lock().unwrap().last_error = message;
        }
        Ok(outcome)
    }

    /// 处理一个标签页：读状态 → 必要时注入 → 消费待处理队列并下发映射。
    pub async fn process_tab(
        &self,
        bridge: &Arc<CdpBridge>,
        ordinal: u32,
    ) -> Result<TabOutcome, String> {
        // **第一次**处理这个标签时喊一声「重报」：让页面把已知作用域重新报一遍，
        // 否则 App 重启后页面以为「App 已经知道」→ App 永远学不到 → 映射发不下去。
        let resync = {
            let mut state = self.state.lock().unwrap();
            let watched = state.watched.entry(ordinal).or_default();
            let resync = !watched.resynced;
            watched.resynced = true;
            resync
        };

        let poll = match bridge.poll_state(ordinal, resync).await {
            Ok(poll) => poll,
            Err(e) => {
                if e.starts_with("evaluate-failed") {
                    self.state.lock().unwrap().last_error =
                        "浏览器连接已断，正在重连…".into();
                }
                return Err(e);
            }
        };

        // 标签换了页面 → 之前的账本作废。
        let guard_version = guard_version_of(&self.injection_source);
        let (ticks, url) = {
            let mut state = self.state.lock().unwrap();
            let watched = state.watched.entry(ordinal).or_default();
            if !poll.url.is_empty() {
                if !watched.url.is_empty() && poll.url != watched.url {
                    watched.ticks_since_inject = 0;
                }
                watched.url = poll.url.clone();
            }
            watched.ticks_since_inject += 1;
            (watched.ticks_since_inject, watched.url.clone())
        };

        // 守卫不在 / 版本对不上 / 太久没注入 → 重新注入。
        let guard_stale = poll.guard
            && guard_version.is_some()
            && poll.guard_version != guard_version.unwrap_or(0);
        let force_inject = ticks >= FORCE_INJECT_EVERY;
        if !poll.guard || guard_stale || force_inject {
            {
                let mut state = self.state.lock().unwrap();
                if let Some(watched) = state.watched.get_mut(&ordinal) {
                    watched.ticks_since_inject = 0;
                }
            }
            // 注入失败要**如实报出去**（与 Electron 版同口径的字符串）：
            // 'OK' / 'NO-TARGET' / 'INJECT-ERROR:...' / 'FAILED:...'
            let result = bridge.inject_now(ordinal).await;
            if result != "OK" {
                self.state.lock().unwrap().last_error =
                    format!("注入失败: {}", result);
                return Err(format!("inject-failed: {}", result));
            }
            let mut state = self.state.lock().unwrap();
            state.injections += 1;
            state.injected = true;
        } else {
            self.state.lock().unwrap().injected = true;
        }

        // 待处理队列：顶层自己的 + 各层 frame 上报的。
        //
        // 同一个作用域可能**从两条路**进来（顶层守卫自己挂的 pending + 帧桥 take()
        // 收上来的），不去重就会把同一个作用域算两遍、下发两遍。
        // 作用域 key 里带着字体内容指纹 ⇒ 同一个 key 就是同一份映射 ⇒ 去重不会丢信息。
        let mut queue: Vec<Vec<Value>> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        if let Some(pending) = poll.pending.as_ref() {
            push_groups(pending, &mut queue, &mut seen);
        }
        for item in poll.frames.iter() {
            push_groups(item, &mut queue, &mut seen);
        }

        let mut outcome = TabOutcome::default();
        for groups in queue {
            for group in groups {
                let scope_key = group
                    .get("scopeKey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if scope_key.is_empty() {
                    continue;
                }
                let result = build_scope_mapping(self.matcher.clone(), group).await?;
                {
                    let mut state = self.state.lock().unwrap();
                    state
                        .mapping_by_scope
                        .insert(result.scope_key.clone(), result.note.clone());
                    while state.mapping_by_scope.len() > 12 {
                        if let Some(key) = state.mapping_by_scope.keys().next().cloned() {
                            state.mapping_by_scope.remove(&key);
                        }
                    }
                }
                // **只有真建出映射才下发**（和 mac 同口径）：
                // 建不出映射时不下发 → 页面会继续上报 → 字体恢复后能自动补上。
                if result.mapping.is_empty() {
                    continue;
                }
                let json = mapping_to_json(&result.mapping);
                // 下发结果要**原样带回**（'FRAMES:OK' / 'OK' / 'NO-GUARD' / 'NO-API'），
                // 出错时是 'FAILED:...' —— 与 Electron 版同一套字符串判断。
                let set_result = bridge.set_mapping(ordinal, &scope_key, &json).await;
                if set_result.starts_with("NO-") || set_result.starts_with("FAILED") {
                    self.state.lock().unwrap().last_error =
                        format!("映射下发失败: {}", set_result);
                }
                {
                    let mut state = self.state.lock().unwrap();
                    state.mappings = result.mapping.len();
                }
                // **建出了映射 = 这个标签用了混淆字体** → 登记进快通道。
                self.register_cipher_tab(ordinal, &url);
                outcome.mapped += 1;
            }
        }
        Ok(outcome)
    }

    /// 状态快照。
    pub fn status(&self) -> CoordinatorStatus {
        let state = self.state.lock().unwrap();
        CoordinatorStatus {
            enabled: state.enabled,
            injected: state.injected,
            browser_running: state.browser_running,
            browser_label: state.browser_label.clone(),
            mappings: state.mappings,
            watched_tabs: state.cipher_tabs.len(),
            ticks: state.ticks,
            injections: state.injections,
            last_error: state.last_error.clone(),
        }
    }

    /// 逐个作用域的映射结果（诊断用）。
    pub fn mapping_results(&self) -> Value {
        let state = self.state.lock().unwrap();
        let mut map = serde_json::Map::new();
        for (key, note) in state.mapping_by_scope.iter() {
            map.insert(key.clone(), Value::String(note.clone()));
        }
        Value::Object(map)
    }
}

/// 把一个上报项里的作用域组挑出来（去重）。
fn push_groups(item: &Value, queue: &mut Vec<Vec<Value>>, seen: &mut HashSet<String>) {
    let Some(groups) = item.get("groups").and_then(|v| v.as_array()) else {
        return;
    };
    let fresh: Vec<Value> = groups
        .iter()
        .filter(|group| {
            let key = group.get("scopeKey").and_then(|v| v.as_str()).unwrap_or("");
            if key.is_empty() || seen.contains(key) {
                return false;
            }
            seen.insert(key.to_string());
            true
        })
        .cloned()
        .collect();
    if !fresh.is_empty() {
        queue.push(fresh);
    }
}

/// 映射表 → JSON（键是密文字，值是明文字）。
fn mapping_to_json(mapping: &HashMap<char, char>) -> Value {
    let mut map = serde_json::Map::new();
    for (cipher, plain) in mapping {
        map.insert(cipher.to_string(), Value::String(plain.to_string()));
    }
    Value::Object(map)
}

/// 从注入源里读出「页面守卫是第几版」（`GUARD_VERSION = 10`）。
fn guard_version_of(injection_source: &str) -> Option<u64> {
    let idx = injection_source.find("GUARD_VERSION")?;
    let rest = injection_source[idx + "GUARD_VERSION".len()..].trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// 一个作用域：取字体 → 解析字体 → 建映射。
///
/// 字体解析是**CPU 密集**的（栅格化 + 与参考库比对，一份混淆字体要一秒上下），
/// 所以放在 `spawn_blocking` 里跑 —— 不占着异步线程。
async fn build_scope_mapping(
    matcher: Arc<FastGlyphMatcher>,
    group: Value,
) -> Result<ScopeResult, String> {
    let inner: Result<ScopeResult, String> = tauri::async_runtime::spawn_blocking(move || {
        let scope_key = group
            .get("scopeKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let Some((kind, value)) = group_font_source(&group) else {
            // 页面上的普通字体（没有可取的字体文件）—— 不是故障,但也要记一条,
            // 否则「这个作用域为什么没有映射」就没人答得上来了。
            return Ok(ScopeResult {
                scope_key,
                mapping: HashMap::new(),
                note: "该作用域没有可取的字体来源(普通字体,不需要映射)".to_string(),
            });
        };
        let font_bytes = match fetch_font(&kind, &value) {
            Ok(bytes) => bytes,
            Err(e) => {
                return Ok(ScopeResult {
                    scope_key,
                    mapping: HashMap::new(),
                    note: format!("取字体失败({}): {}", kind, e),
                })
            }
        };
        let entries = match analyze_font(matcher.db(), &matcher, &font_bytes) {
            Ok(entries) => entries,
            Err(e) => {
                return Ok(ScopeResult {
                    scope_key,
                    mapping: HashMap::new(),
                    note: format!("分析字体失败: {}", e),
                })
            }
        };
        let mapping = build_mapping(&entries);
        let note = if mapping.is_empty() {
            format!("映射为空(字体 {} 个码位,都没认准)", entries.len())
        } else {
            format!("映射建成了: {} 个字", mapping.len())
        };
        Ok(ScopeResult {
            scope_key,
            mapping,
            note,
        })
    })
    .await
    .map_err(|e| format!("字体分析任务失败: {}", e))?;
    inner
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 注入源里能读出守卫版本() {
        let source = build_injection_source("var GUARD_VERSION = 10;", "");
        assert_eq!(guard_version_of(&source), Some(10));
    }

    #[test]
    fn 守卫源码必须是合法字符串字面量() {
        // 守卫源码里全是引号与反斜杠 —— 直接塞进字面量会把整段脚本搞成语法错误
        // （真机踩过,见 ADR-0014）。
        let guard = r#"var a = "x"; var b = 'y'; // 反斜杠 \ 和引号 \""#;
        let source = build_injection_source(guard, "");
        assert!(source.contains("var a = \"x\""));
        let literal_start = source.find("guardSource: ").expect("必须有 guardSource:") + "guardSource: ".len();
        let bytes = source.as_bytes();
        assert_eq!(bytes[literal_start], b'"');
        let mut i = literal_start + 1;
        let mut escaped = false;
        let mut end = None;
        while i < bytes.len() {
            let c = bytes[i];
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                end = Some(i);
                break;
            }
            i += 1;
        }
        let end = end.expect("字面量必须有结束引号");
        let literal = &source[literal_start..=end];
        let back: String = serde_json::from_str(literal).expect("字面量必须是合法 JSON 字符串");
        assert_eq!(back, guard);
    }
}
