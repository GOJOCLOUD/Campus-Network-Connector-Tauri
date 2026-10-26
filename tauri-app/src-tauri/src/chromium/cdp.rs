//! 最小 CDP 客户端（Chrome DevTools Protocol over WebSocket）。
//!
//! 这是 Electron 线 `src/features/chromium-repair/cdp.js` 的 Rust 移植，
//! **只实现我们需要的那几件事**：
//!   - 连上浏览器的调试端口（`ws://127.0.0.1:<port>/devtools/browser/<id>`）
//!   - 发命令、收结果（按 id 配对）
//!   - 收事件（按 method 分发给订阅者）
//!   - 带 sessionId 的**扁平会话**（`Target.attachToTarget {flatten:true}`）
//!     ⇒ 每个标签页、每个 iframe 都是一条独立会话，但共用同一条 WebSocket
//!
//! ## 为什么不用手写 WebSocket 帧解析
//!
//! 用 `tokio-tungstenite`（tokio 生态里最标准的选择）。
//! 自己解析帧 ⇒ 要处理掩码、分片、续帧、ping/pong —— 那不是本功能该承担的风险。
//!
//! ## 为什么**不需要** `--remote-allow-origins`
//!
//! `tungstenite` 的握手只发 `Host` / `Connection` / `Upgrade` / `Sec-WebSocket-Key` /
//! `Sec-WebSocket-Version`，**不发 `Origin` 头**；而 Chromium 的调试端口只在
//! 「**带了** Origin 且不在白名单」时才拒绝 ⇒ 不带 Origin 天然放行。
//!
//! ⚠️ 反过来说：产品里**绝不能**加 `--remote-allow-origins=*` ——
//! 那等于把调试端口对**任意网页**开放，谁都能连上来操控用户的浏览器。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// 一条命令的超时（与 Electron 版 DEFAULT_TIMEOUT_MS 一致）。
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// WebSocket 的流类型。
type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 一个 CDP 事件（方法名 + 参数 + 可选的会话 id）。
#[derive(Clone, Debug)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

/// 事件订阅者。`CdpClient::subscribe()` 会给一对（发送端、接收端）。
pub type EventSink = mpsc::UnboundedSender<CdpEvent>;

/// CDP 客户端。
///
/// - **写**：`out_tx` 把帧交给「拥有 WebSocket 的那个任务」发出去 ——
///   这样读与写互不抢锁（一条 WebSocket 上同时读写是允许的，
///   但用两个 Mutex 分开读写会死锁，所以这里用「一个任务持有连接」的做法）。
/// - **读**：同一个任务读帧，分发给订阅者、按 id 配对命令结果。
pub struct CdpClient {
    /// 往「持有连接的那个任务」发帧的通道。`None` = 已经关闭。
    out_tx: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    next_id: AtomicU64,
    /// 命令 id → 回信的通道。
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    /// 事件订阅者。
    subscribers: Mutex<Vec<EventSink>>,
    closed: AtomicBool,
}

impl CdpClient {
    /// 连上浏览器的调试端口。
    ///
    /// `url` 形如 `ws://127.0.0.1:12345/devtools/browser/<guid>`。
    pub async fn connect(url: &str) -> Result<Arc<CdpClient>, String> {
        // ⚠️ **绝不**给浏览器加 `--remote-allow-origins=*`：
        // 那等于把调试端口对任意网页开放。tungstenite 不发 Origin ⇒ 天然放行。
        let (ws, _resp) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| format!("连接 CDP 失败: {}", e))?;

        let (out_tx, out_rx) = mpsc::unbounded_channel::<Message>();
        let client = Arc::new(CdpClient {
            out_tx: Mutex::new(Some(out_tx)),
            next_id: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
        });

        let reader = client.clone();
        tauri::async_runtime::spawn(async move {
            connection_loop(ws, out_rx, reader).await;
        });

        Ok(client)
    }

    /// 连接是否已经断了。
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// 主动断开（连接任务会因此收工，WebSocket 被关掉）。
    pub fn close(&self) {
        self.out_tx.lock().unwrap().take();
        self.fail_pending("CDP 连接已关闭");
    }

    /// 订阅事件。返回（往哪儿发、往哪儿收）。
    pub fn subscribe(&self) -> (EventSink, mpsc::UnboundedReceiver<CdpEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        self.subscribers.lock().unwrap().push(tx.clone());
        (tx, rx)
    }

    /// 发一条命令。
    ///
    /// - `method`：CDP 方法名
    /// - `params`：参数对象
    /// - `session_id`：扁平会话 id（浏览器级命令不用传）
    pub async fn send(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, String> {
        if self.is_closed() {
            return Err("CDP 连接已关闭".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let mut payload = json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = session_id {
            payload["sessionId"] = Value::String(sid.to_string());
        }
        let text = payload.to_string();
        let sender = self.out_tx.lock().unwrap().clone();
        let sent = match sender {
            Some(sender) => sender.send(Message::Text(text.into())).is_ok(),
            None => false,
        };
        if !sent {
            self.pending.lock().unwrap().remove(&id);
            return Err("CDP 连接已断开".into());
        }

        match tokio::time::timeout(COMMAND_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("CDP 命令没有回音: {}", method)),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("CDP 命令超时: {}", method))
            }
        }
    }

    /// 连接断了：把所有还在等的命令叫醒（别让调用方傻等到超时）。
    fn fail_pending(&self, reason: &str) {
        self.closed.store(true, Ordering::Relaxed);
        let mut pending = self.pending.lock().unwrap();
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(reason.to_string()));
        }
    }

    /// 收到一帧。
    fn handle_frame(&self, msg: Message) {
        // ⚠️ **不要逐个列举 Message 的变体** —— tungstenite 各版本不一样
        // (0.21 起 `Text` 装的是 `Utf8Bytes` 不是 `String`;`Frame` 变体是后加的)。
        // 只认我们关心的三个,其余(Ping/Pong/…)一律忽略。
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Close(_) => {
                self.fail_pending("CDP 连接已关闭");
                return;
            }
            _ => return,
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return;
        };

        // ① 命令结果：按 id 配对。
        if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
            let waiter = self.pending.lock().unwrap().remove(&id);
            if let Some(tx) = waiter {
                let result = match value.get("error") {
                    Some(err) => {
                        let message = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("CDP 报错")
                            .to_string();
                        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                        Err(format!("{}（{}）", message, code))
                    }
                    None => Ok(value.get("result").cloned().unwrap_or(json!({}))),
                };
                let _ = tx.send(result);
            }
            return;
        }

        // ② 事件：分发给所有订阅者。
        let Some(method) = value.get("method").and_then(|m| m.as_str()) else {
            return;
        };
        let event = CdpEvent {
            method: method.to_string(),
            params: value.get("params").cloned().unwrap_or(json!({})),
            session_id: value
                .get("sessionId")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string()),
        };
        let subscribers = self.subscribers.lock().unwrap().clone();
        for sink in subscribers {
            let _ = sink.send(event.clone());
        }
    }
}

/// 持有连接的任务：读帧 + 把排队的帧发出去。
///
/// 读与写**共用同一条 WebSocket**，所以不能简单地「一个任务读、另一个任务写」。
/// 这里用「读一次 / 发一次」交替推进：写请求排队后，最迟在下一轮循环里发出去。
async fn connection_loop(
    mut ws: WsStream,
    mut out_rx: mpsc::UnboundedReceiver<Message>,
    client: Arc<CdpClient>,
) {
    let mut pending_write: Option<Message> = None;
    // `break` 不能写在 select! 的分支里 ⇒ 用这个标志代替。
    let mut finished = false;
    while !finished {
        tokio::select! {
            frame = ws.next() => {
                match frame {
                    Some(Ok(msg)) => client.handle_frame(msg),
                    Some(Err(e)) => {
                        client.fail_pending(&format!("CDP 连接出错: {}", e));
                        finished = true;
                    }
                    None => {
                        client.fail_pending("CDP 连接已关闭");
                        finished = true;
                    }
                }
            }
            msg = out_rx.recv(), if pending_write.is_none() => {
                match msg {
                    Some(m) => pending_write = Some(m),
                    None => finished = true,
                }
            }
        }

        // select 的分支处理完之后才写 —— 这样读帧的借用已经结束,不会跟写抢连接。
        if let Some(msg) = pending_write.take() {
            if let Err(e) = ws.send(msg).await {
                client.fail_pending(&format!("CDP 发送失败: {}", e));
                finished = true;
            }
        }
    }
    client.fail_pending("CDP 连接已关闭");
}
