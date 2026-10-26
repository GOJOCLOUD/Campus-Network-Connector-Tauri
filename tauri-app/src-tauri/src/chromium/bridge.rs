//! CDP 版「桥」—— mac 线 `safari/bridge.rs` 的 Windows 对位物。
//!
//! ## 两条线各自怎么驱动页面
//!
//! |                | mac                                | Windows                        |
//! | -------------- | ---------------------------------- | ------------------------------ |
//! | 在页面里执行 JS | Apple Events（`runJsIn`）            | CDP `Runtime.evaluate`         |
//! | 列出标签页      | Apple Events 问 Safari             | CDP `Target.getTargets`        |
//! | 注入守卫        | 在顶层文档 eval，再由 frame-bridge 递归 | `Page.addScriptToEvaluateOnNewDocument`（document_start，**每个 frame 都装**）|
//!
//! ## 页面侧那套（守卫 + frame-bridge）是**共用资产**，一行都没改
//!
//! `frame-bridge.js` 只在页面里干活（`report/take/setMapping/resync`），
//! 不依赖任何传输方式 —— 它本来就是给「主进程在页面里执行 JS」用的。
//! 所以 Windows 线只换「谁来执行 JS」，页面侧那套照抄。
//!
//! ## 一个刻意的设计：frame-bridge **只装顶层**
//!
//! 守卫在**每个 frame** 都装（CDP 的 document_start 注入天然如此），
//! 但 frame-bridge 只装顶层 —— 这样子 frame 的守卫上报时，
//! 会顺着 parent 一路找到**顶层**那个 bridge（和 mac 上一样）。
//! 若每个 frame 都装，子 frame 的上报会停在它自己那一层，顶层反而收不到。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::chromium::cdp::{CdpClient, CdpEvent};

/// 一个标签页（一个 CDP target = 一个标签页）。
#[derive(Clone, Debug)]
pub struct TabInfo {
    /// 数字序号（1 起），给上层当「标签页号」用。
    pub ordinal: u32,
    pub url: String,
    pub title: String,
    pub target_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug)]
struct TargetInfo {
    target_id: String,
    ordinal: u32,
    url: String,
    title: String,
    kind: String,
    session_id: String,
}

/// 把 targetInfo 里的 url/title 抄进目标记录（空值不改）。
fn update_url_and_title(target: &mut TargetInfo, info: &Value) {
    if let Some(url) = info.get("url").and_then(|v| v.as_str()) {
        if !url.is_empty() {
            target.url = url.to_string();
        }
    }
    if let Some(title) = info.get("title").and_then(|v| v.as_str()) {
        if !title.is_empty() {
            target.title = title.to_string();
        }
    }
}

/// 读一个标签页的状态（对应 mac 的 pollState）。
#[derive(Clone, Debug, Default)]
pub struct PollState {
    pub guard: bool,
    pub guard_version: u64,
    pub pending: Option<Value>,
    pub collect: String,
    pub frames: Vec<Value>,
    pub unrepaired: Vec<Value>,
    pub url: String,
}

/// 顶层页面里取状态的那段脚本（对应 mac 的 pollState / Electron 的 buildPollScript）。
fn build_poll_script(resync: bool) -> String {
    let resync_block = if resync {
        r#"  try {
    var rb = window.__copyRepairBridge;
    if (rb && typeof rb.resync === 'function') { out.resync = rb.resync(); }
    else if (typeof window.__copyRepairResync === 'function') { window.__copyRepairResync(); out.resync = 1; }
  } catch (e) { }
"#
    } else {
        ""
    };
    format!(
        r#"(function(){{
  var g = window.__copyRepairGuard;
  var out = {{
    guard: !!g,
    guardVersion: g ? (g.version || 0) : 0,
    pending: null,
    collect: 'none',
    frames: [],
    unrepaired: [],
    resync: 0,
    url: String(location.href || ''),
  }};
{resync_block}  if (g) {{
    if (window.__copyRepairCollect) {{
      try {{ out.collect = String(window.__copyRepairCollect()); }} catch (e) {{ out.collect = 'error'; }}
    }}
    if (g.pending && g.pending.groups && g.pending.groups.length > 0) {{
      out.pending = {{ groups: g.pending.groups }};
      g.pending = null;
      g.lastCollectedText = '';
      g.lastCollectedScope = '';
    }}
    if (window.__copyRepairBridge && typeof window.__copyRepairBridge.take === 'function') {{
      try {{
        var taken = window.__copyRepairBridge.take();
        out.frames = taken.pending || [];
        out.unrepaired = taken.unrepaired || [];
      }} catch (e) {{ out.frames = []; out.unrepaired = []; }}
    }}
  }}
  return JSON.stringify(out);
}})()"#
    )
}

/// 把守卫与 frame-bridge 拼成一份「document_start 脚本」。
///
/// 与 Electron 版 `buildInjectionSource` 同口径，差别只有一处：
/// 这里**返回**一段 JSON 状态（`ok` / `guardError` / `bridgeError`），
/// 这样「当场补注入」那一步能**如实报出**注入失败的原因
/// （Electron 版返回 undefined，注入失败是看不见的）。
pub fn build_injection_source(guard_source: &str, frame_bridge_source: &str) -> String {
    // 守卫源码里全是引号与反斜杠 ⇒ 必须先做 JSON 字符串编码再嵌进 JS 字面量
    // （否则第一个引号就把字符串提前闭合，整段脚本变成语法错误 ——
    //  这个坑在 mac 线上真机踩过，见 ADR-0014）。
    let guard_literal =
        serde_json::to_string(guard_source).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function(){{
  var out = {{ ok: true, guardError: '', bridgeError: '' }};
  try {{
{guard_source}
  }} catch (e) {{ out.guardError = String(e); }}
  try {{
    if (window.top === window) {{
{frame_bridge_source}
      window.__copyRepairInstallFrameBridge({{ guardSource: {guard_literal} }});
    }}
  }} catch (e) {{ out.bridgeError = String(e); }}
  return JSON.stringify(out);
}})()"#,
        guard_source = guard_source,
        frame_bridge_source = frame_bridge_source,
        guard_literal = guard_literal,
    )
}

/// 页面守卫 + 顶层帧桥的 CDP 桥。
pub struct CdpBridge {
    pub client: Arc<CdpClient>,
    injection_source: String,
    state: Mutex<BridgeState>,
}

#[derive(Default)]
struct BridgeState {
    /// targetId → 目标信息。
    targets: HashMap<String, TargetInfo>,
    /// 下一个序号（1 起）。
    next_ordinal: u32,
}

impl CdpBridge {
    /// 新建一个桥，并开始处理 CDP 事件（自动挂接新标签页）。
    pub fn new(client: Arc<CdpClient>, injection_source: String) -> Arc<Self> {
        let bridge = Arc::new(CdpBridge {
            client,
            injection_source,
            state: Mutex::new(BridgeState::default()),
        });
        let (_tx, mut rx) = bridge.client.subscribe();
        let worker = bridge.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                worker.handle_event(event).await;
            }
        });
        bridge
    }

    /// 记住一个 target，并给它一个稳定的数字序号（**没见过**的才登记）。
    fn remember(&self, target_id: &str, session_id: &str, info: &Value) {
        let mut state = self.state.lock().unwrap();
        if let Some(existing) = state.targets.get_mut(target_id) {
            existing.session_id = session_id.to_string();
            update_url_and_title(existing, info);
            return;
        }
        // 序号只给**页面**标签页用：后台页/扩展/service worker 也占序号的话，
        // 序号会变得又大又稀 ⇒ 日志和「按站点找标签」都不好读。
        let kind = info
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let is_page = kind == "page";
        let ordinal = if is_page {
            state.next_ordinal += 1;
            state.next_ordinal
        } else {
            0
        };
        let mut target = TargetInfo {
            target_id: target_id.to_string(),
            ordinal,
            url: String::new(),
            title: String::new(),
            kind,
            session_id: session_id.to_string(),
        };
        update_url_and_title(&mut target, info);
        state.targets.insert(target_id.to_string(), target);
    }

    /// 只更新**已经记住的**那个 target 的 URL/标题。
    ///
    /// ⚠️ **不存在就当没听见**（Electron 版是 `if (!target) return;`）——
    /// 凭空插一条 session_id 为空的记录会造成两个后果：
    ///   1. 之后拿 `sessionId=""` 去发命令 ⇒ CDP 报「session not found」；
    ///   2. 那个假标签页会出现在 `list_tabs()` 里。
    fn refresh(&self, target_id: &str, info: &Value) {
        let mut state = self.state.lock().unwrap();
        let Some(existing) = state.targets.get_mut(target_id) else {
            return;
        };
        update_url_and_title(existing, info);
    }

    /// 给一个标签页装上守卫（document_start 注入）。
    async fn prepare_page(&self, session_id: &str) {
        let _ = self
            .client
            .send("Page.enable".into(), json!({}), Some(session_id))
            .await;
        let _ = self
            .client
            .send("Runtime.enable".into(), json!({}), Some(session_id))
            .await;
        let _ = self
            .client
            .send(
                "Page.addScriptToEvaluateOnNewDocument".into(),
                json!({ "source": self.injection_source }),
                Some(session_id),
            )
            .await;
        let _ = self
            .client
            .send(
                "Runtime.runIfWaitingForDebugger".into(),
                json!({}),
                Some(session_id),
            )
            .await;
    }

    /// 处理一个 CDP 事件。
    async fn handle_event(&self, event: CdpEvent) {
        match event.method.as_str() {
            "Target.attachedToTarget" => {
                let session_id = event
                    .params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if session_id.is_empty() {
                    return;
                }
                let info = event
                    .params
                    .get("targetInfo")
                    .cloned()
                    .unwrap_or(Value::Null);
                let target_id = info
                    .get("targetId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if target_id.is_empty() {
                    return;
                }
                let kind = info
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                self.remember(&target_id, &session_id, &info);
                if kind != "page" {
                    // 不是页面（后台页/扩展/service worker）⇒ 只要把它放行。
                    let _ = self
                        .client
                        .send(
                            "Runtime.runIfWaitingForDebugger".into(),
                            json!({}),
                            Some(&session_id),
                        )
                        .await;
                    return;
                }
                self.prepare_page(&session_id).await;
            }
            "Target.detachedFromTarget" => {
                let target_id = event
                    .params
                    .get("targetId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if target_id.is_empty() {
                    return;
                }
                self.state.lock().unwrap().targets.remove(&target_id);
            }
            "Target.targetInfoChanged" => {
                // 标签页的 URL 是在**导航之后**才变的（attach 时还是 about:blank），
                // 不订阅这个事件就永远只知道它叫 about:blank ⇒「按站点找标签」永远找不到。
                let info = event
                    .params
                    .get("targetInfo")
                    .cloned()
                    .unwrap_or(Value::Null);
                let target_id = info
                    .get("targetId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if target_id.is_empty() {
                    return;
                }
                // ⚠️ **没记住过的 target 直接忽略**（不许凭空插一条）。
                self.refresh(&target_id, &info);
            }
            _ => {}
        }
    }

    /// 装上监听：自动挂接新标签页 + 补挂已经存在的。
    pub async fn setup(&self) -> Result<(), String> {
        self.client
            .send(
                "Target.setAutoAttach".into(),
                json!({
                    "autoAttach": true,
                    "waitForDebuggerOnStart": true,
                    "flatten": true,
                }),
                None,
            )
            .await?;
        self.client
            .send("Target.setDiscoverTargets".into(), json!({ "discover": true }), None)
            .await?;
        // 已经开着的标签页（程序重启、浏览器没关）要补挂一次。
        let result = self.client.send("Target.getTargets".into(), json!({}), None).await?;
        let infos = result
            .get("targetInfos")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for info in infos {
            if info.get("type").and_then(|v| v.as_str()) != Some("page") {
                continue;
            }
            let target_id = info
                .get("targetId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if target_id.is_empty() {
                continue;
            }
            if self.state.lock().unwrap().targets.contains_key(&target_id) {
                continue;
            }
            let attached = match self
                .client
                .send(
                    "Target.attachToTarget".into(),
                    json!({ "targetId": target_id, "flatten": true }),
                    None,
                )
                .await
            {
                Ok(v) => v,
                Err(_) => continue,
            };
            let session_id = attached
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if session_id.is_empty() {
                continue;
            }
            self.remember(&target_id, &session_id, &info);
            self.prepare_page(&session_id).await;
        }
        Ok(())
    }

    /// 页面标签页列表（对应 mac 的 listTabs）。
    pub fn list_tabs(&self) -> Vec<TabInfo> {
        let state = self.state.lock().unwrap();
        let mut tabs: Vec<TabInfo> = state
            .targets
            .values()
            .filter(|t| t.kind == "page")
            .map(|t| TabInfo {
                ordinal: t.ordinal,
                url: t.url.clone(),
                title: t.title.clone(),
                target_id: t.target_id.clone(),
                session_id: t.session_id.clone(),
            })
            .collect();
        tabs.sort_by_key(|t| t.ordinal);
        tabs
    }

    fn session_by_ordinal(&self, ordinal: u32) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .targets
            .values()
            .find(|t| t.ordinal == ordinal && t.kind == "page")
            .map(|t| t.session_id.clone())
    }

    fn url_by_ordinal(&self, ordinal: u32) -> String {
        self.state
            .lock()
            .unwrap()
            .targets
            .values()
            .find(|t| t.ordinal == ordinal)
            .map(|t| t.url.clone())
            .unwrap_or_default()
    }

    /// 在标签页里执行一段 JS，返回它的返回值（按值取回）。
    ///
    /// `None` = 标签页不在了 / 页面没回话（对应 Electron 版的 `'NO-TARGET'`）。
    pub async fn evaluate(&self, ordinal: u32, expression: &str) -> Option<Value> {
        let session_id = self.session_by_ordinal(ordinal)?;
        let result = self
            .client
            .send(
                "Runtime.evaluate".into(),
                json!({ "expression": expression, "returnByValue": true }),
                Some(&session_id),
            )
            .await
            .ok()?;
        Some(
            result
                .get("result")
                .and_then(|r| r.get("value"))
                .cloned()
                .unwrap_or(Value::Null),
        )
    }

    /// 读一个标签页的状态（对应 mac 的 pollState）。
    pub async fn poll_state(&self, ordinal: u32, resync: bool) -> Result<PollState, String> {
        let Some(session_id) = self.session_by_ordinal(ordinal) else {
            return Err("NO-TARGET".into());
        };
        let result = self
            .client
            .send(
                "Runtime.evaluate".into(),
                json!({
                    "expression": build_poll_script(resync),
                    "returnByValue": true,
                }),
                Some(&session_id),
            )
            .await;
        let value = match result {
            Ok(v) => v
                .get("result")
                .and_then(|r| r.get("value"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            Err(e) => return Err(format!("evaluate-failed: {}", e)),
        };
        let Some(value) = value else {
            return Err("parse-failed".into());
        };
        let parsed: Value =
            serde_json::from_str(&value).map_err(|e| format!("解析状态失败: {}", e))?;
        let url = parsed
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // **把 URL 回写进 target 记录**（Electron 版同口径：
        // `if (parsed.url) target.url = parsed.url;`）——
        // 不回写的话标签页 URL 一直停在 about:blank，「按站点找标签」就废了。
        if !url.is_empty() {
            let mut state = self.state.lock().unwrap();
            if let Some(target) = state
                .targets
                .values_mut()
                .find(|t| t.ordinal == ordinal && t.kind == "page")
            {
                target.url = url.clone();
            }
        }
        let state = PollState {
            guard: parsed
                .get("guard")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            guard_version: parsed
                .get("guardVersion")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            pending: parsed.get("pending").cloned(),
            collect: parsed
                .get("collect")
                .and_then(|v| v.as_str())
                .unwrap_or("none")
                .to_string(),
            frames: parsed
                .get("frames")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default(),
            unrepaired: parsed
                .get("unrepaired")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default(),
            url,
        };
        Ok(state)
    }

    /// **立刻**把守卫装进当前这个文档。
    ///
    /// 为什么需要这一步：`Page.addScriptToEvaluateOnNewDocument` 只对**之后**的
    /// 导航生效 —— 已经打开的页面不会因为它而重新执行守卫。
    /// mac 上是 `runJsIn`（当场 eval），所以那边不需要这一步；CDP 这边必须补上，
    /// 否则「打开开关 → 已经在开着的标签页」这一路是失效的。
    ///
    /// 返回值与 Electron 版同口径：`'OK'` / `'NO-TARGET'` / `'INJECT-ERROR'` /
    /// `'FAILED:...'`。
    pub async fn inject_now(&self, ordinal: u32) -> String {
        if self.injection_source.is_empty() {
            return "FAILED:没有注入源".to_string();
        }
        let value = match self.evaluate(ordinal, &self.injection_source).await {
            Some(value) => value,
            None => return "NO-TARGET".to_string(),
        };
        let text = value.as_str().unwrap_or("");
        if text.is_empty() {
            return "FAILED:注入没有回音".to_string();
        }
        let parsed: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => return format!("FAILED:解析注入结果失败: {}", e),
        };
        let guard_error = parsed
            .get("guardError")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let bridge_error = parsed
            .get("bridgeError")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !guard_error.is_empty() {
            return format!("INJECT-ERROR:{}", guard_error);
        }
        if !bridge_error.is_empty() {
            return format!("INJECT-ERROR:{}", bridge_error);
        }
        "OK".to_string()
    }

    /// 下发映射（对应 mac 的 setMapping）。
    ///
    /// 返回**页面回的原话**（`'FRAMES:OK'` / `'OK'` / `'NO-GUARD'` / `'NO-API'`），
    /// 出错时是 `'FAILED:...'` —— 与 Electron 版同口径，上层按同一套字符串判断。
    pub async fn set_mapping(
        &self,
        ordinal: u32,
        scope_key: &str,
        mapping: &Value,
    ) -> String {
        let scope_literal =
            serde_json::to_string(scope_key).unwrap_or_else(|_| "\"\"".to_string());
        let mapping_literal =
            serde_json::to_string(mapping).unwrap_or_else(|_| "{}".to_string());
        let expression = format!(
            "(function(){{
      var b = window.__copyRepairBridge;
      if (b && typeof b.setMapping === 'function') return 'FRAMES:' + b.setMapping({scope}, {map});
      var g = window.__copyRepairGuard;
      if (!g) return 'NO-GUARD';
      if (!window.__copyRepairSetMapping) return 'NO-API';
      return window.__copyRepairSetMapping({scope}, {map});
    }})()",
            scope = scope_literal,
            map = mapping_literal,
        );
        let value = match self.evaluate(ordinal, &expression).await {
            Some(value) => value,
            None => return "NO-TARGET".to_string(),
        };
        match value.as_str() {
            Some(text) if !text.is_empty() => text.to_string(),
            _ => "FAILED".to_string(),
        }
    }

    /// 这个标签页当前的 URL（诊断用）。
    pub fn url_of(&self, ordinal: u32) -> String {
        self.url_by_ordinal(ordinal)
    }
}
