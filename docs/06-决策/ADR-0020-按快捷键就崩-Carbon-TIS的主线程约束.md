# ADR-0020:按快捷键就崩 —— Carbon TIS 的主线程约束

- 状态:已定
- 日期:2026-10-23
- 相关:ADR-0012(平台功能范围)、ADR-0013(界面层逐字照搬 Electron)、ADR-0019(上一轮三条修复)

## 背景

用户反馈:

> 「现在老版本不知道,反正新版本使用快捷键就会导致错误退出,然后无法再使用」

即:**按一次全局快捷键(⌃⇧A / ⌃⇧D),App 整个崩掉**;
崩完之后再打开,按快捷键又崩 —— 这条功能等于完全不可用。

这是原生层的问题(不是界面层),所以**只有 Tauri 线有**;Electron 线不受影响(见文末)。

---

## 一、定位:崩溃报告直接指到「事件 tap 回调线程」

macOS 把崩溃报告写在 `~/Library/Logs/DiagnosticReports/simuinput-tauri-*.ips`。
当天有两份(用户按快捷键时产生的):

```
exception = EXC_BREAKPOINT / SIGTRAP
faulting thread = cnc-hotkey            ← 我们自己的快捷键监听线程

libdispatch.dylib : _dispatch_assert_queue_fail
libdispatch.dylib : dispatch_assert_queue
HIToolbox         : islGetInputSourceListWithAdditions
HIToolbox         : isValidateInputSourceRef
HIToolbox         : TSMGetInputSourceProperty     ← Carbon 文字输入源 API
simuinput-tauri   : (4 帧,符号被剥掉)
SkyLight          : processEventTapData(...)       ← CGEventTap 的回调
```

三条关键信息:

1. **不是 Rust 的 panic**,是 `SIGTRAP` —— 进程被系统直接打死,
   所以界面上什么都来不及显示,App 就消失了。
2. **崩在 `cnc-hotkey` 线程** —— 就是 `native/hotkey.rs` 里
   `thread::Builder::new().name("cnc-hotkey")` 起的那条事件监听线程。
3. **崩在 `TSMGetInputSourceProperty`** —— Carbon 的文字输入源 API。
   它内部走到 AppKit 的 `islGetInputSourceListWithAdditions`,那儿有一句
   `dispatch_assert_queue`:不在**主线程**就直接 `dispatch_assert_queue_fail`。

也就是说:**在非主线程上读了一次当前输入法,App 当场崩。**

### 1.1 代码里那条路

事件 tap 的回调里(旧版 `hotkey.rs`):

```rust
if let Some(hotkey) = match_hotkey(event) {
    // ……
    crate::commands::shortcuts::record_shortcut_hit(hotkey.label(), "命中(按键已吞掉)");
    return None;   // 吞掉这个按键
}
```

而旧版 `commands/shortcuts.rs` 的 `record_shortcut_hit` 是这样的:

```rust
pub fn record_shortcut_hit(key: &str, outcome: &str) {
    let source = crate::commands::native::get_current_input_source()   // ← 读输入源
        .map(|v| format!("{}({})", …))
        .unwrap_or_else(|e| format!("读不到:{}", e));
    // ……
}
```

`get_current_input_source` → `imp::current_input_source_info()` → 直接调
`TISCopyCurrentKeyboardInputSource` / `TISGetInputSourceProperty`。

**这条调用链整个跑在 `cnc-hotkey` 线程上** ⇒ Carbon 的主线程断言失败 ⇒ 崩。

顺带还有第二条同病相轻的路:⌃⇧D 的动作线程里
`select_input_source()` 也是直接调 `TISSelectInputSource`(同样是主线程限定)。

---

## 二、为什么「记录输入源」这种小事会要命

`record_shortcut_hit` 记的 `inputSource` 那一栏,是给「按了没反应」做诊断用的
(判断是不是打进了中文输入法的候选框)。它不是功能必需,是**诊断信息** ——
但它把整个 App 的可用性押在了一条线程约束上。

规矩本来是知道的:代码里到处写着「tap 回调里不能做慢活」
(`hotkey.rs` 的注释、`recording.rs` 的做法都是另起线程跑动作)。
**只是没想到「读一次输入法」在 Carbon 那儿等于「在别的线程碰 AppKit」。**

---

## 三、修法:把「必须在主线程」变成**结构上不可能违反**

不靠"记得别这么写",而是让代码**没有别的路可走**。

### 3.1 主线程编排(`commands/native.rs`)

新增一个平台无关的小层:

| 函数 | 作用 |
| --- | --- |
| `init_main_thread(app)` | 启动时(`setup()` 第一行)记住 AppHandle 和**主线程的线程号** |
| `is_main_thread()` | 现在是不是主线程 |
| `run_on_main_thread(f, timeout)` | 到主线程跑并**等结果**;已在主线程就直接跑(派发过去再等=自锁) |
| `run_on_main_thread_detached(f)` | 到主线程跑但**不等**(给 tap 回调用) |

`run_on_main_thread_detached` 是专门给事件 tap 回调准备的:
**tap 回调绝对不能阻塞** —— 慢一点系统会直接把这个 tap 关掉(快捷键间歇性失灵),
所以那里只"派发",不"等"。

### 3.2 守卫(`commands/native/macos.rs`)

真正调 Carbon 的两个函数被拆成两半:

```rust
pub fn current_input_source_info() -> Result<InputSourceInfo, String> {
    run_on_main_thread(current_input_source_info_on_main, Duration::from_secs(2))
        .and_then(|r| r)
}

fn current_input_source_info_on_main() -> Result<InputSourceInfo, String> {
    // 守卫:不在主线程就**拒绝**,绝不硬调 Carbon。
    if !crate::commands::native::is_main_thread() {
        return Err("读输入源必须在主线程调用(Carbon TIS 的要求)".to_string());
    }
    /* 真正的 TIS 调用 */
}
```

`select_input_source` 同样处理。

**守卫的价值**:万一以后又有人从别的线程直接调 `_on_main` 版本,
得到的是一句报错,而不是把整个 App 带走。

### 3.3 tap 回调里不再同步读输入源(`commands/shortcuts.rs`)

`record_shortcut_hit` 改成:

1. 先把命中记下来(输入源那一栏先空着);
2. 再把"读输入源"**丢给主线程异步**做,读完回填。

```rust
pub fn record_shortcut_hit(key: &str, outcome: &str) {
    let id = push_hit(key, outcome);          // 先落一条
    run_on_main_thread_detached(move || {     // 读输入源丢给主线程
        let label = /* 在主线程上读 */;
        fill_hit_input_source(id, &label);     // 读完回填
    });
}
```

于是 tap 回调线程只做两件很快的事(加锁、往 Vec 里塞一条),**碰不到 Carbon**。

### 3.4 Electron 线为什么没事(不用改)

Electron 版的 TIS 调用都在**主进程的主线程**上:

- `globalShortcut.register('Ctrl+Shift+A', cb)` 的回调跑在主线程;
- `nativeCall('selectInputSource', …)` 是 **N-API 同步调用**,也在主线程。

所以同样的业务逻辑在 Electron 那边天然满足约束。
(两边口径不同是**有理由的**差异,符合 ADR-0013「差异只允许 Tauri 必需」。)

---

## 四、验证

### 4.1 「修复前」的对照构建(复现)

为了证明"修的确实是这件事",专门构了一个**只加自检脚本、不含修复**的构建
(`macos.rs`/`shortcuts.rs` 换回旧版,其余保留),在同一台机器上跑同一个自检:

| | 结果 |
| --- | --- |
| 修复前构建 + 自检按一次 ⌃⇧A | **崩溃**(`EXC_BREAKPOINT/SIGTRAP`),进程消失 |
| 新增崩溃报告 | `simuinput-tauri-2026-10-23-182847.ips` |

它的栈与用户那两份**逐帧一致**(同一线程名 `cnc-hotkey`、同一串
`dispatch_assert_queue → TSMGetInputSourceProperty → processEventTapData`):

| 崩溃报告 | 时间 | 来源 |
| --- | --- | --- |
| `…-145432.ips` | 14:54 | 用户按快捷键 |
| `…-180820.ips` | 18:08 | 用户按快捷键 |
| `…-182847.ips` | 18:28 | 自检脚本复现 |

### 4.2 「修复后」

见 `04-测试/测试与验收记录.md`。

### 4.3 「退出后无法再使用」到底是什么意思

崩完之后 App 本体**没有坏**:重开是正常的(进程活着、事件 tap `alive: true`、
辅助功能授权还在)。所以用户说的"无法再使用"指的是
**快捷键这条功能整体不可用** —— 按一次崩一次,重开再按又崩。

单实例插件那侧的"陈旧锁"嫌疑已排除:`tauri-plugin-single-instance` 的 macOS 实现
在连不上旧套接字时(`ECONNREFUSED`)会自己清掉再监听,实测崩完重开一切正常。

---

## 五、留下的东西

1. **自检**:`open -a /Applications/模拟输入-Tauri.app --args --diag-hotkey-trigger`
   - 往自己身上发一次 ⌃⇧A(自检模式下**不执行**真动作 ——
     ⌃⇧A 的动作是回放录制文件,那会在用户屏幕上真的点来点去);
   - 再从非主线程读一次输入源;
   - 结果写进 `diag.json` 的 `shortcuts.hotkeyTriggerCheck`。
2. **单测**:`commands/native/macos.rs` 两条 —— 非主线程读/切输入源必须**报错**。
3. **变异自检**:去掉守卫 → 单测转红(证明这条回归真抓得住缺陷)。

## 六、边界与提醒

- 这条约束是 **Carbon TIS 专属**。CoreGraphics 的事件/鼠标/键盘 API 没有这个限制,
  `recording.rs` 那套在别的线程上跑是安全的。
- 主线程编排有**超时**(读 2 秒 / 切 5 秒)。主线程被占住太久会超时失败,
  但**不会崩** —— 宁可"动作没做成",也不要整个 App 消失。
- 任何新增的 macOS 原生调用,先问一句:**它是不是碰 AppKit/Carbon?**
  是 ⇒ 必须走 `run_on_main_thread`。
