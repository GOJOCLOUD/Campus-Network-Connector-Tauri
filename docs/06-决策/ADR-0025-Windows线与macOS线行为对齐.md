# ADR-0025:Windows 线与 macOS 线行为对齐(同一功能,行为必须一致)

- 状态:**已定**(用户 2026-10-24 明确指令「确保 Windows 和 macOS 的是逻辑一样的,并且没有明显错误」)
- 日期:2026-10-24
- 适用分支:`win`(本文档落在 Windows 线;`mac` 分支的对应改动由 mac 侧另行搬运)
- 相关:**ADR-0012**(平台功能范围——macOS 全量、Windows 精简)、
  `docs/00-概览/两条发布线.md`、
  以及 mac 分支上的 **ADR-0021**(固不做系统级合成输入事件)、
  **ADR-0023**(按键与修饰键乱序)、**ADR-0024**(快捷键改成 Control+S/D 与 latch 触发许可)
  —— 后三篇目前**只存在于 `mac` 分支**,本文按编号与标题引用,待文档同步到本分支后改成链接。

## 背景

`docs/00-概览/两条发布线.md` 里原本写着「两条线不再同步推进,也不再保持一模一样」。
那句话指的是**实现 / 打包 / 文档措辞各自演化**(各分支有自己的打包配置与 CI),
但它**不等于**「同一个功能在两个平台上的行为可以不一样」。

用户 2026-10-24 的原话:**「确保 Windows 和 macOS 的是逻辑一样的,并且没有明显错误」。**

⇒ 于是把口径拆成两半,写进本文档:

- **要求(必须一致)**:同一个功能在 Windows 与 macOS 上**行为一致** ——
  同样的快捷键与触发规则、同样的 latch 语义、同样的错误处理与提示、
  同样的界面结构与文案、同样的门禁。
- **允许(可以不同)**:实现方式、打包配置、平台专属能力(辅助功能 / 输入源 / Safari)各自不同。

**引用 ADR-0012 作为「哪些功能在 Windows 上根本不做」的依据**:
录制、keepalive、设为当前输入源在 Tauri Windows 侧**不做** ——
那是**定稿决策**,不是缺口,不要去补。

## 决策

### 一、快捷键:两个平台都是 ⌃S / ⌃D

| | 组合键 | 动作 |
| --- | --- | --- |
| 默认执行(回放选中的录制文件) | **⌃S**(`Control+S`) | `trigger_default_execute` |
| 剪贴板直输(把剪贴板内容逐字敲进去) | **⌃D**(`Control+D`) | `trigger_pinyin_from_clipboard` |

判定规则(**两个平台一字不差**):

- **只认 Control** —— 不认 Command / Windows 键;
- **不要求 Shift**,但**带 Shift 照样触发**(容错);
- 其余修饰键(Alt 之类)一律忽略。

规则实现在**平台无关**的 `tauri-app/src-tauri/src/commands/native/hotkey_core.rs` 里
(`match_hotkey`),macOS 与 Windows **跑的是同一份代码**。

### 二、latch(触发许可):两个平台是**同一份状态机**

用户的要求:

> 「触发之后 Ctrl+D 整个按键就不再会继续影响它了,除非下一次重新按住 Ctrl,再点击相应的字母」

规则:

- 触发 ⇒ `armed = false` 且 `blocked = true`;
- **Control 松开** ⇒ `blocked = false`、`armed = true`(彻底解锁);
- Control 按下 ⇒ **只有 `blocked == false` 时**才武装。

最后一条是关键:主键的 keydown 可能**先于**修饰键事件到达(见 ADR-0023 的乱序场景)。
那时的顺序是「先触发、后收到 Control 按下」—— 如果这一下「按下」能把 latch 解开,
用户按住 Ctrl 连按就会连着触发,而「默认执行」是**回放**,触发多次就是往屏幕上乱点。
所以 `blocked` **只能由 Control 松开来清**。

状态机本体在 `hotkey_core::Latch`,单测也在那个文件里(`#[cfg(test)] mod tests`),
**单测不碰系统**(纯函数,任何平台都能跑)。

### 三、平台差异:观察方式不同,行为规则相同

| | macOS | Windows |
| --- | --- | --- |
| 快捷键怎么发现 | 自己监听事件(CGEventTap),把按键**吃掉** | 系统的全局热键(`RegisterHotKey`) |
| Control 按下/松开怎么观察 | 事件流里的 `FlagsChanged` | `GetAsyncKeyState(VK_CONTROL)` 轮询(只做**边沿检测**) |
| latch 状态机 | `hotkey_core::Latch` | `hotkey_core::Latch`(**同一份**) |

Windows 为什么用轮询而不是 `WH_KEYBOARD_LL`:低级键盘钩子有 `LowLevelHooksTimeout`
(钩子回调太慢会被系统直接摘掉),而且回调跑在系统 DLL 的上下文里,出问题极难查。
`GetAsyncKeyState` 是**只读**的,不碰系统输入,也没有那个超时风险。

**代价(如实记下)**:轮询有间隔(20ms),**极短促的按下/松开有可能被漏掉**。
漏掉的只是「松开」那一下 ⇒ latch 多锁一次 ⇒ 要等再下一次「松开」才恢复。
属于「宁可多锁一次,不可乱触发」的取舍。

**观察源起不来时**:`hotkey_win::try_fire` 会**降级为不生效**(一律放行),
并在诊断里写明 `latchAvailable: false` —— 宁可没有 latch,也不能让快捷键永远锁死。

### 四、⌃D 在 Windows 上要**真的做事**

Windows 之前把 `trigger_pinyin_from_clipboard` 写成 `#[cfg(not(target_os="macos"))]` 的**空实现**
⇒ 用户按了**什么都不发生**,而快捷键却注册着 —— 这是一个**明显错误**,必须修。

现在两个平台**同构**:

1. 看设置里「快捷键用哪段文本」—— `clipboard`(剪贴板)还是 `textbox`(输入框里固定的那段);
2. 取文本、去掉首尾空白;
3. 空的就**什么都不做**(记一笔「剪贴板是空的」);
4. `send_text` 逐字键入(Unicode,跨输入法可用)。

**唯一的平台差异:不切输入源。** macOS 切得到输入源(Carbon TIS),所以多一步
「切到 ASCII 输入源再等 300ms」;**Windows 直接送 Unicode 字符,没有输入源概念** ⇒ 那一步整个跳过。

**与 ADR-0012「Windows 保留拼音自动键入」不冲突**:ADR-0012 说的是「键盘输入」那一页 ——
用户**手动敲**内容;⌃D 是另一件事:把**剪贴板里已有的文本**直接敲进去,不用手动敲。
一个是「从键盘输入」,一个是「从剪贴板输入」——两条不同的路,不是同一件事做了两遍。

### 五、诊断:两个平台的形状一样

`diag.json` 的 `shortcuts` 下,两个平台都有:

- `tap`:macOS 是 `native::hotkey::diagnostics()`,Windows 是 `native::hotkey_win::diagnostics()`,
  **形状一致**:`alive` / `error` / **`latchArmed`**;
- Windows 另有两栏特有的:`ctrlObserver`(观察源是什么)、`latchAvailable`(latch 是不是真的生效)。

`latchArmed` 的用途:「按了快捷键没反应」有两种完全不同的原因 ——
① 系统没把事件送来 / 修饰键不对 ⇒ latch 是**武装**的,但压根没匹配上;
② latch 还**锁着**(Control 一直没松开)⇒ **这是设计如此**,等用户松开 Control。
有了这一栏,一眼就能分清是哪一种。

### 六、界面:结构与文案一致,只少一页

- 步骤:激活 → 默认执行 →(**模拟点击/录制 —— Windows 不做**)→ 键盘输入;
- 「辅助功能」小问号:Windows 没有这个概念(`SendInput` 不需要授权)⇒ **不显示**,
  但要**显式**传 `showAccessibilityBadge={false}`,而不是「没传那个 prop」——
  这样两个平台的代码形状一致,以后不会漏;
- Safari 复制修复相关:Windows 没有 Safari ⇒ 不显示;
- 录制:Windows 按 ADR-0012 **不做**;界面上的「开始/结束录制」那一步在 Windows 上不出现,
  但**原生侧的命令仍然占位**(返回一句明确的「不支持」),不是「命令不存在」。

### 七、门禁:两个平台跑**同一套**

Windows 的 CI 现在与 mac 一样,在**打包之前**跑这几条硬门禁(跑不过就不发包):

- `node --test tools/verify/verify-frame-bridge.cjs`
- `node --test tools/verify/verify-page-guard.cjs`
- `node --test tools/verify/verify-panel-transition.cjs tools/verify/verify-recording-ui.cjs`
- `cargo test --lib`

**找 Chrome 的方式统一走 `tools/chrome-path.cjs`**(唯一入口):
Windows 上没有 `$HOME`(只有 `USERPROFILE` / `LOCALAPPDATA`),
各文件自己拼路径会拼成**相对路径**,必然找不到浏览器 ——
Electron 线踩过一次:门禁本身没毛病,是它找不到 Chrome。

## 取舍与风险

### ⚠️ 风险一:Windows 上全局注册 `Ctrl+S` / `Ctrl+D` 会**抢走其他应用的同名快捷键**

Windows 习惯用 Ctrl+S 保存、Ctrl+D 收藏书签;macOS 那边用 ⌘S,习惯不同所以影响小。
⇒ 在 Windows 上全局注册 `Ctrl+S` / `Ctrl+D`,**别的应用就收不到这两个键了**
(用户在浏览器里按 Ctrl+S 不会弹「保存网页」)。

这是「两边逻辑一致」**必然**带来的副作用,必须留档。

**如果将来用户反馈冲突**:改成 `Control+Shift+S` / `Control+Shift+D` **是一行的事**
(常量在 `tauri-app/src-tauri/src/lib.rs` 的 `SHORTCUT_DEFAULT_EXECUTE` / `SHORTCUT_PASTE`),
但那会**破坏**「只认 Control、带 Shift 照样触发」的容错规则,
所以改的时候要连 ADR-0024 的规则一起改,不能只改字符串。

### ⚠️ 风险二:Windows 的全局热键是**精确匹配**,macOS 是**宽松匹配**

macOS 自己监听事件,只看「有没有 Control」⇒ `Ctrl+Shift+S` **会**触发。
Windows 的 `RegisterHotKey` 是系统级精确匹配 ⇒ `Ctrl+Shift+S` **不会**触发
(系统只认注册时写的那一组修饰键)。

⇒ **同一个功能在两个平台上的触发范围有细微差别**:窗口**内**的前端快捷键两边一样
(`Ctrl+Shift+S` 两边都触发),**全局**快捷键在 Windows 上更严格。

要消掉这个差别得用 `WH_KEYBOARD_LL` 自己匹配 —— 但那会换来 `LowLevelHooksTimeout`
的稳定性风险(见上文),**本轮不换**。真要换,先在 ADR 里补一段实测数据再定。

### ⚠️ 风险三:轮询可能漏掉极短促的「松开」

见上文「平台差异」一节。表现是「按了快捷键没反应,再按一次(或松开重按)就好了」。

### 关于打包配置(`tauri.windows.conf.json`)

**Tauri v2 会自动合并平台专属配置**:CLI 的 `tauri build --help` 原文 ——
「a platform-specific file is looked up and merged with the default file by default
(tauri.macos.conf.json, tauri.linux.conf.json, **tauri.windows.conf.json**, …)」。

⇒ **不需要**在构建命令里加 `--config`;`tauri.windows.conf.json` **本来就在生效**
(之前文档里「当前没有任何构建命令用上它」那句话是**错的**,已更正)。
合并语义是 **JSON Merge Patch(RFC 7396)**:对象逐键合并,**数组整体替换**。

⇒ 合并后 Windows 的窗口最终是 `tauri.windows.conf.json` 里那个对象
(`title`/`width`/`height`/`minWidth`/`minHeight`/`resizable`/`alwaysOnTop`/
`decorations:false`/`transparent`/`shadow`/`acceptFirstMouse`/`backgroundColor`),
基础配置里的 `maxWidth` / `titleBarStyle` / `hiddenTitle` / `trafficLightPosition`
**不会**保留(数组整体替换)。`bundle.icon` 同理 ⇒ Windows 用的是 `icons/icon.ico`,
不是 mac 的 `.icns`;`bundle.targets` = `["nsis"]`;`bundle.windows.nsis` 的
`installMode` / `languages` 生效;`bundle.resources`(字形参考库)保留。
