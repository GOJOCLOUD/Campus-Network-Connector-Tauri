# Electron 对照调研（Tauri 版）

> 这份文档记的是一次**完整调研**的结果，不是零散改动记录。
>
> 起因：Tauri 版此前是"边做边对齐"——每次只搬一点（阴影、边距、卡片宽度），
> 结果既有**自己另发明一套**的实现（CSS 变量层），也有**照搬错了**的地方
> （返回形状对不上 → 界面上"保存/重命名/删除"永远显示失败）。
>
> 这次的做法：先把 Electron 版**怎么做的**完整读一遍（运行时契约、生命周期、
> 界面结构、Safari 修复支线），形成对照表，再按表整体对齐。
>
> 口径：两个仓库是**同一个产品的两个正式版本**，同等优先、互不回流。
> 本表只描述"Electron 怎么做 / Tauri 现在怎么做"，**改动要搬必须显式搬**。

---

## 一、界面层：逐文件比对的结果

> **2026-10-22 更新**：界面层已按 **ADR-0013**（界面层逐字照搬 Electron，不另写界面逻辑）
> 重做。下面这张表是**重做之后**的最终状态。

`electron/src` 与 `tauri/src` 的同名文件里，**只剩 4 处差异**，其余**逐字相同**：

| 文件 | 剩余差异 | 为什么允许 |
| --- | --- | --- |
| `components/Stepper.jsx` | 3 处 `data-tauri-drag-region` | Tauri 必需（Electron 靠 CSS `-webkit-app-region`，WKWebView 不认） |
| `App.jsx` | 根容器 1 处 `data-tauri-drag-region` + 授权小问号 props + Windows 显示键盘输入页 | 拖拽是 Tauri 必需；小问号与 Windows 键盘页是**已定产品差异**（ADR-0012） |
| `panels/KeyboardPanel.jsx` | 「辅助功能」授权小问号 | 保留（Electron 根本没有这个提示，没有可照搬的对象；这是 Tauri 侧主动补的） |
| `main.jsx` | 多一行 `import './tauri-bridge.js'` | 保留（必需） |
| `index.css` | **无差异**（逐字相同） | — |

### 内容区高度上限：用 Electron 那一行，不另发明

Electron 的内容区是 `overflowY: 'auto'` + **`maxHeight: '65vh'`** —— 内容多了就在**中间滚动**，
卡片高度有上限，底部的按钮行永远在窗口里。

Tauri 曾把 `maxHeight` 删掉（当时注释的理由是"窗口会跟着内容长"）——**那个理由是错的**：
内容不压缩 + 根容器 `overflow-hidden` = 超出部分不是滚动，是**被一刀切掉**，而且没有滚动条能翻到。
现在**逐字用回 Electron 的 `maxHeight: '65vh'`**。

### 卡片为什么不会被压扁

卡片是 flex 项，默认 `flex-shrink: 1`；如果卡片自己带 `overflow-hidden`，
它的**自动最小尺寸（auto）会被算成 0** —— 窗口一旦比内容矮，卡片就被压扁（实测 440 → 272），
量出来的底边永远等于「窗口底 − 8px」，于是**窗口一直长、内容一直缺**。

Electron 的卡片没有 `overflow-hidden`，`min-height: auto` 天然就压不扁；
两边 `index.css` 逐字相同 ⇒ Tauri 现在也一样（**不再额外写 `shrink-0`**）。

### 拖拽机制：语义相同、实现不同

| | Electron | Tauri |
| --- | --- | --- |
| 标记方式 | CSS `-webkit-app-region: drag`（`.app-drag` / `.app-nodrag`） | 属性 `data-tauri-drag-region`（`deep` = 子树、`false` = 禁用） |
| 继承 | Chromium 把 drag 区域往下传给子孙 | `"deep"` 就是子树语义 |
| 退出拖拽 | CSS `no-drag` 写在按钮/输入框规则里 | Tauri **自带**规则：可点击元素自动阻止拖拽 |

两边对「哪些地方能拖、哪些不能」的标注是**一一对应**的（footer、步骤圆点 =
`app-nodrag` = `="false"`；步骤条 = `app-drag` = `="deep"`）。

---

## 二、运行时契约：接口名字都对上了，语义有 12 处不一致

命令名**没有一处错配**（前端叫 A、Rust 注册 B 这种问题不存在）。
不一致的是**返回形状**与**失败语义**。

### 已经修掉的（会直接让界面坏掉的那种）

| 接口 | 之前 | 现在（对齐 Electron） |
| --- | --- | --- |
| `saveFile` | Rust 要求 `filename` 必填，界面只传 clicks → **必失败** | `filename` 可缺省，自动取 `点击N.json`（Electron 同口径） |
| `saveFile` / `renameFile` / `deleteFile` | 返回 `true`，界面判的是 `data?.status === 'success'` → **永远显示"失败"** | 统一返回 `{status:'success'}` / `{status:'error', message}` |
| `readFile` | 读不到报 Err | 读不到返回 `null`（Electron 同口径） |
| `listFiles` | `[{id: 文件名, name, clicks}]` | `[{id: 序号, name}]` |
| `setFeatureEnabled` / `setFeatureEnabledSetting` | 两条命令**合并成一条**（运行态 + 落盘一起做） | 拆开：`setFeatureEnabled` 只改运行态、`setFeatureEnabledSetting` 只落盘（Electron 同口径，界面两个都调） |
| `safariRepair.setEnabledSetting` | 只改运行态、**不落盘** → 重启开关就丢 | 只落盘（Electron 同口径） |
| `getFeatureStatus` | 少 `safariRunning` 字段 → 界面"Safari 没开"的提示**永不出现** | 补齐；且**问不到时按"在跑"处理**（Electron 同口径，不误报） |
| `saveLicense` | 失败直接 Err，界面只能显示"激活失败" | 失败返回 `{ok:false, error}`，界面能显示原因 |
| `startTrial` | 已用过试用时 Err → 界面上是一次**没人处理的 rejection**（协议框关不掉、也没提示） | 返回当前快照（Electron 同口径） |
| `mouseGetPosition` | 返回 `[x, y]` 元组 | 返回 `{x, y}`（Electron 同形状） |
| `getInputSource` | 返回裸 id 字符串 | 返回 `{id, name, isASCII}`（Electron 同形状） |

> 输入源名称的属性名有个坑：Carbon 里**没有** `kTISPropertyInputSourceLocalizedName`
> 这个符号（链接期报 undefined），正确的是 `kTISPropertyLocalizedName`。

### 行为层：补上的 macOS 能力

| 行为 | Electron 怎么做 | Tauri 之前 | Tauri 现在 |
| --- | --- | --- | --- |
| **关窗口** | macOS 不退出，进程常驻（Safari 修复是常驻能力，关掉就等于把功能关了） | 走 Tauri 默认：**窗口一关进程就退** → Safari 修复与 keepalive 一起消失 | 拦截 `CloseRequested`：macOS 隐藏窗口、进程常驻；Windows 仍按 Electron 口径退出 |
| **Dock 点图标** | `activate` 时没有窗口就重建 | 无 | `RunEvent::Reopen` → 重新显示窗口 |
| **全局快捷键** | ⌃⇧A 默认执行、⌃⇧D 读剪贴板直入（**仅 macOS**） | **没有** | 引入 `tauri-plugin-global-shortcut`，两个键都按 Electron 口径实现（走后端，界面没打开也能用） |
| **单实例** | `requestSingleInstanceLock` + 二次启动叫回窗口 | **没有**（能起两份 → 两个轮询线程、两个事件 tap） | 引入 `tauri-plugin-single-instance` |
| **应用菜单** | 系统默认菜单（⌘Q / ⌘C / ⌘V / ⌘M） | **没有菜单**（加上"关窗口变成隐藏"之后，用户**没法退出**） | 用 Tauri 内置 menu 补回 macOS 默认菜单 |
| **置顶层级** | `setAlwaysOnTop(true, 'screen-saver')`（level 1000） | 只有布尔量（floating，level 3）→ 全屏 App 会盖住面板 | 直接把 NSWindow 的 level 设成 1000 |
| **退出清理** | `before-quit` 注销快捷键 | `app.exit(0)` 直接终止 | 退出前 `unregister_all()` 注销快捷键 |

### 数据目录：两个版本天生不是一个 → 已加迁移

| | Electron | Tauri |
| --- | --- | --- |
| 数据根目录 | `app.getPath('userData')` = package.json 的 `name`（那个仓库是 `xyw`）→ `Application Support/xyw/` | `app_data_dir()` = identifier → `Application Support/com.gojocloud.campus-network-connector.tauri/` |
| 录制文件 | `<根>/data/recordings/` | `<根>/recordings/`（**少一层 `data/`**） |
| 设置 | `<根>/settings.json` | `<根>/settings.json` |

⇒ 老用户升级过来会"**自己的录制文件全没了**"（界面读的是新目录）。
已按 **Electron 自己那套口径**（`main.js` 的 `migrateLegacyDataFiles`）补上迁移：
**只补缺的、绝不覆盖、绝不删除**，两边各自留着自己那份。

| 数据 | 处理 |
| --- | --- |
| 录制文件 | 每次启动把老版缺的补过来（老版之后新录的，新版下次启动也能看到） |
| 设置 | **只做一次**（写 `.electron-settings-migrated` 标记），补顶层缺的字段（输入源选择 / 自动切输入法 / keepalive） |
| **激活状态** | **不搬** —— 那边是设备绑定的（Electron 落盘随机 UUID + HMAC，Tauri 机器指纹派生），搬过来只会把两边都弄坏。跨版本通用激活码见"四·1" |

自检里能直接看到文件清单（`diag.json` 的 `recordingFiles`），迁移没生效一眼就能看出来。

---

## 三、Safari 复制修复：这条线之前**整条是断的**

调研推演出来的结论，**逐行核实后属实**：

1. 守卫（`page-guard.js`）上报的字体来源是 `{ kind, value }`；
2. Rust 的 `group_font_source` 找的却是 `url/src/source/href/data` 那一堆键
   → **恒为 None** → `fetch_font` 根本不会被调用；
3. 就算把值取出来，`fetch_font` 找的是字符串里的 `"base64,"` 标记，
   而守卫给的是**裸 base64** → 仍然 `Err("不认识的字体来源")`。

**结果**：守卫装上了、`check_now` 也在跑，但映射表永远是空的 → 复制出来还是原始密文。

### 按 Electron 的做法修的

| Electron 怎么做 | Tauri 之前 | Tauri 现在 |
| --- | --- | --- |
| `fetchFont` 按 `font.kind` 分派（data → 裸 base64；url → 下载） | 一把抓 `"base64,"` | 按 `kind` 分派，两种老格式都兼容 |
| 映射**按整份字体**建（遍历字体 cmap 的**全部**码位） | **按选区字符**建（违反 ADR-0002） | 遍历全部码位 → 扩大选区后新出现的密文字也认得 |
| 字体级闸门的分母 = **字体的码位数** | 分母 = 选区字符数 → 选区只有一两个字时，图标字恰好像某个常用字 → **写出错字** | 分母是字体码位数（图标字体实测 3% → 判为普通字体，不建映射） |
| 结果按**字体内容哈希**缓存（最多 8 份） | 无 → 每轮重新解析字体 | 按 sha256 缓存 |
| 字体下载失败进**负缓存**（10 分钟冷却） | 无 → 每轮 curl 一次 | 加了负缓存 |
| 注入 `frame-bridge.js`，递归注入同源 frame | **完全没有** → iframe 里的密文字既不上报、也收不到映射 | `frame-bridge.js` 进 `src-tauri/resources/`，注入时一起装上、映射下发优先走 `__copyRepairBridge.setMapping` |
| 采集时合并 `state.frames` | 只读顶层 `pending` | 顶层 + 各层 frame 一起处理 |
| 主轮询 300ms、目标站点每 2 轮、**前台标签每轮** | 单一线程 2000ms、只处理目标站点 | 300ms / 每 2 轮 / 前台标签每轮 |

### 2026-10-22 又断了一次:注入脚本里的字面量没转义(ADR-0014)

上面那张表修的是「**守卫和映射这两份数据**」对不上。这次断的是更靠前的一环:
**守卫压根没装上**。

Rust 侧把守卫源码**原样**拼进 `{ guardSource: "..." }` 的 JS 字符串字面量。
守卫源码本身是一份 JS 文件,里面全是 `"` 和 `\` ——
**第一个引号就把字面量提前闭合,整段脚本变成 JavaScript 语法错误**,
`do JavaScript` 整段失败,连前面那句合法的守卫代码也一起不执行。

而 Electron 版用的是 `JSON.stringify(...)` —— 两份守卫文件**逐字相同**,
**调用方却不一样**,所以行为不一样。

| Electron 怎么做 | Tauri 之前 | Tauri 现在 |
| --- | --- | --- |
| `JSON.stringify(toAsciiJs(guardSource))` 嵌守卫源码 | 直接拼源码 → 整段脚本语法错误 → 守卫一次没装上 | `serde_json::to_string(to_ascii_js(...))`,同口径 |
| 注入失败会抛出去 | `let _ = inject_guard(...)` **吞掉** → 界面只显示"已开启" | 除超时外一律冒到 `last_error` |
| 映射建不起来有原因 | 三条分支全是静默 `continue` | 记到 `safariRepair.mapping` |

真机对照(2026-10-22):修复前 18 个标签**一个都没装上守卫**
(`window.__copyRepairGuard` 全是 undefined);修复后样例页守卫在、
映射 132 个字、复制出来是明文。

> **教训**:「两个文件逐字相同」不等于「行为相同」——
> 移植时**调用方**也要一起对照,尤其是"怎么把一段源码塞进另一个语言"
> 这种地方。

### 新增的回归测试（Rust 侧第一次有）

之前 Rust 侧**一个单元测试都没有**：`npm test` 测的是 `src/features/safari-repair/*.js`
—— 那套 JS 在 Tauri 运行时**根本不执行**（死代码）。所以"链路断了"没人发现。

现在 `src-tauri/src/safari/repair.rs` 里有三个测试，直接盯整条链路：

- `守卫上报的字体来源能取到` —— 喂真实的 `{kind, value}` 形状
- `裸_base64_能解出字体字节` —— 裸 base64 与带前缀的老格式
- `混淆字体能整份还原` —— 用仓库里的真混淆字体
  （`obf-same-style.ttf` + 真值表 `obf-same-style.map.json`）跑完整链路，
  逐条与真值比对，**一个都不能错**

这三个测试同时也是"Rust 引擎与 TS 引擎判定一致"的**可复现证据**
（之前 `tauri-app/verify-engine.sh` 依赖的两个文件都不存在，结论无法复现）。

2026-10-22(ADR-0014)又加了 4 个,盯的是**注入脚本本身**能不能被 JS 解析:

- `注入脚本里的守卫源码是合法字符串字面量` —— 字面量能被 JSON 解析回原文
- `真实守卫文件能拼出合法字面量` —— 用仓库里真实那份守卫(引号最多)
- `真实注入脚本能被javascript解析` —— 把整段脚本丢给 `node --check`(没有 node 就明说跳过)
- `注入脚本里没有非ascii字符` —— AppleScript 按本地编码解码,非 ASCII 必须先转义

### 2026-10-23 又断了三处:判活查询、frame 名单、字体分析(ADR-0015)

ADR-0014 修掉了「守卫一次都没装上」。这一轮用户报的是**第一次成功、后两次失败**,
还怀疑「题目被写死过」。在真实学习通测验页上逐层拆,查出**另外三处断点** ——
**都不是"写死"**(全仓核对没有任何写死的字→字映射),
真实原因是第一份字体的分析结果被缓存,换新字体缓存不命中。

| # | 断点 | Electron 怎么做 | Tauri 之前 | Tauri 现在 |
| --- | --- | --- | --- | --- |
| 1 | **判活查询** | `tell application "System Events" to (name of processes) contains "Safari"` | **照搬了 Electron 的写法** → System Events 要**另一份**自动化授权,用户从没被提示过 → 查不到 → 被判成"没运行" → **整个功能静默停掉** | 改用 `application "Safari" is running`(不需任何授权、也不把 Safari 拉起来);**问不到 ≠ 没运行**;Safari 没开改成中性状态 |
| 2 | **iframe 桥的 frame 名单** | 同一份 `frame-bridge.ts`(逐字相同) | 名单**从不刷新**,站点在嵌套 frame 内部换 iframe 时顶层 MutationObserver 看不见 → 映射发到已经变成 `about:blank` 的旧 frame → **真正有题目的那层一份映射都收不到** | `take()`/`setMapping()` 开头都先 `scan()`;`scan()` 剔除非当前树里的旧 frame;`debug()` 的 pending 形状修正 |
| 3 | **字体分析耗时** | 串行 | 串行很慢(当时实测 11 秒) → 这段时间页面上没有映射 → 换题后立刻复制必然是密文 | rayon 并行,**判定口径一个字都没改**。⚠️ 后来查明那两个数是 **debug 构建**量的,release 下同一份真机字体只要 **13ms**(ADR-0016) |
| 4 | **快轮询通道**(2026-10-23 补上,ADR-0016) | 有:`fastTick` 名义间隔 200ms 一轮(真实周期 = 工作 + sleep),只盯"出现过混淆字体的标签",不判活、不列标签 | **没有**(只有一条串行通道:判活 → 列全部标签 → 目标标签每 2 轮处理一次 → 实际 ~1 秒才看一眼) | 已补上同形状的快通道:实测映射下发 **2.2 秒 → 0.32 秒** |

**第 1 条是两条线唯一的口径差异**:Tauri 线不再问 System Events,
Electron 线仍问(那条路要一份用户从没被授予过的授权)。
**第 2 条两边都改了** —— `frame-bridge` 是两个仓库共用的同一份源码,
修复必须**显式搬**(Electron 仓库提交 `88f466a`)。

真机对照(2026-10-23,题目在第 4 层同源 iframe `top>1>1>1`):
修复前那层映射数 = 0、守卫日志 `copy-no-mapping`;修复后 10 层 frame 全部拿到映射
(33 个字)、`copy-repaired`,剪贴板出明文。换题窗口实测:340ms 仍密文,**2065ms 已是明文**。
(这个窗口后来查明是**下发延迟**造成的 —— 不是分析慢;补了快通道后降到 **87~532ms**。见 ADR-0016。)

### 这一轮新增的回归测试

- `判活查询不依赖SystemEvents`(Rust)—— 钉死"不许出现 System Events / tell application"
- `tools/verify/verify-frame-bridge.cjs`(Node,6 个用例)—— 纯 node 造一棵假 frame 树,
  模拟"站点换掉 iframe",断言**新那层必须收到映射**。
  同一套用例跑两遍:**入库产物**(真正装进 App 的那份)与**源码现编**(真身)——
  产物是手工从 `vendor/` 复制过去的,没有东西保证它们同步。
  **把修复前的版本分别塞回去,各自那 3 个用例红 2 个**—— 不是假通过。
  已接进 CI 门禁(跑不过就不发包)。
- 诊断新增 `mappingScopes`(逐作用域记映射结果)、`safariRunning`、`runningProbe` 三个字段。

### 2026-10-23 末:换题后第 2 次复制出密文(ADR-0017)

用户复测:「换一题之后,第 1 次复制成功,第 2 次复制失败(复制出来是密文)」。
真机(真实学习通作业页,题目在第 4 层同源 iframe)把整条链路量了一遍,
查出**三处页面侧根因**(都在**两个仓库共用**的那份源码里)
+ **两处 App 侧性能缺陷**。

**三处页面侧根因两边是同一份文件**(`packages/browser-adapters/shared/src/page-guard.ts`),
所以**必须同时改、逐字保持一致**(两边文件 md5 相同):

| # | 根因 | 修法(两边同源) |
| --- | --- | --- |
| 1 | 「送到了就不重报」拿 `mappings` 判断"App 知不知道" → App 重启后页面以为"不用报" → App 永远学不到作用域 | 两本账分开:新增 `deliveredAt`;"App 知不知道"看它,"页面能不能修"仍看 `mappings` |
| 2 | 预热扫描只在 @font-face 签名变了才触发 → 站点"先注入字体、后渲染文字"→ 第一次扫到 0 个作用域 → **永远不再重扫** | 触发条件加上"DOM 变了"(MutationObserver 只置 `domDirty` 标志位) |
| 3 | 字体指纹用**取样哈希** → 混淆字体"结构相同、字形不同" → 撞车 → 旧映射套新字体 → **写出错字** | 改成**整份哈希**(18KB ≈0.1ms) |

**App 侧两边各自一份,本轮把口径拉齐**:

| # | 点 | Electron | Tauri | 现在 |
| --- | --- | --- | --- | --- |
| 1 | **resync**(App 重新认识页面上的作用域) | 本轮加:`bridge.js` 的 `pollState({resync})` | 本轮加:`bridge.rs` 的 `poll_state(tab, window, resync)`,**resync 段必须排在 collect/take 之前**,否则重报赶不上这一轮取数 | 两边都有 |
| 2 | **ack 口径** | 原先**空映射也 ack** | 原先**不 ack** | **两边统一**:只有真建出映射才 ack / 才登记快通道(负缓存的冷却才有意义、瞬时故障能自愈、图标字体不必进快通道) |
| 3 | **字体解析失败负缓存** | 本轮加(`engine.js`) | 本轮加(Rust 侧) | 两边都有(URL 级 + 内容哈希级,10 分钟冷却) |
| 4 | **强制重注入的计数** | `ticksSinceInject` **从来没生效**(键是字符串、取的是数字键) | `state_once` 那个 `OnceLock` **从来没 set** → 每轮都重注入 | Tauri 修好(快通道周期 **450ms → 205ms**);Electron 的偏差**单独立项**,本轮未修 |

**共用文件要显式搬**:两个仓库的 `page-guard.ts` / `frame-bridge.ts`
改完 md5 必须相同(否则两边行为会分叉)。

真机对照(2026-10-23 末):App 重启后页面上报时刻前进 **22 秒**(resync 生效),
换题后新作用域 **1498ms** 内被现并下发,复制 **0/4 密文**、常规 **0/6 密文**
(判定口径:**和参考明文比**)。回归:守卫 **Tauri 28/28 / Electron 24/24**、
`cargo test --lib` **17/17**、Electron e2e **10/10**;并做了**变异自检**
证明新用例真的抓得住(详见 ADR-0017)。

---

## 四、还没搬完的 / 需要拍板的

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | **激活码跨版本不通用**：Electron 的 `deviceUuid` 是**落盘随机 UUID**，Tauri 是**机器指纹派生**。两边的值不可能相同 → 同一张码在另一个版本上会报"设备不匹配"。代码注释与安装指南都写着"两边都能用"，**这句话目前是假的**。 | 需要拍板：改 Electron 对齐派生口径（会作废既有 Electron 用户的码，除非做"两种都认"的兼容），还是维持现状并改文档口径 |
| 2 | 激活状态**防篡改**：Electron 是 HMAC 封装 + 主副双写 + 时钟回拨检测；Tauri 是可手改的明文 JSON | 建议做，但要考虑既有用户状态文件的迁移 |
| 3 | 激活快照少 `firstSeenAt` / `lastSeenAt` / `clockRollbackDetected` | 与 #2 一并做 |
| 4 | `tauri/src/features/**`（与 Electron 逐字相同的 JS 引擎）**是死代码** | 留着会误导人（新人会以为功能开关由它驱动）。删还是留，需要拍板 |
| 5 | `tauri.windows.conf.json` **没有任何构建命令用上**（npm 脚本与 CI 都没带 `--config`） | Windows 打包实际走的是 `tauri.conf.json`。要改配置还是删文件，需要拍板 |
| 6 | Electron 的 Windows 线界面**没露出拼音自动键入**（原生 `win-input` 已有 `KEYEVENTF_UNICODE` 能力） | 按 ADR-0012 应该露出，属功能变更，需要拍板 |
| 7 | CI **没有产物校验门禁**（Electron 那边有 `verify-package.cjs` 硬门禁） | 建议补 |
| 8 | 录制文件 JSON 字段两边不同（Electron：`start_time`/`click_count`/`clicks`；Tauri 之前：`clicks`/`savedAt`） | 已按 Electron 口径改（`start_time`/`click_count`/`clicks`） |
| 9 | 输入源配置存储位置不同（Electron 独立文件；Tauri 混在 settings.json） | 功能等价，不影响使用，暂不动 |

---

## 五、怎么复核这份表

```bash
# 界面逐页对照(Electron 与 Tauri 各渲染一张透明背景截图 + 逐页量高)
node tools/lab/compare-panel-appearance.cjs

# 界面自检(两个平台一起跑;含"4 页都完整展示""窗口矮时不压扁")
node tools/verify/verify-ui-platforms.cjs

# 窗口跟随回归(真跑桥接代码,窗口高度真跟着变:换页跟不跟、底部那条在不在)
node tools/lab/probe-window-fit.cjs

# Rust 自检(含 Safari 修复那三个回归测试)
cd tauri-app/src-tauri && cargo test --lib -- --nocapture

# Windows 代码体检(只做类型检查,不打包)
./tools/windows-check.sh
```

两个仓库的界面文件要保持一致，**改了哪边另一边都要显式搬**；
搬完用上面的对照脚本量一遍，不一致的地方会直接显形。
**改动口径见 ADR-0013**：界面层只做逐字照搬，自写的逻辑要先能回答
「Electron 那边对应的是什么」。
