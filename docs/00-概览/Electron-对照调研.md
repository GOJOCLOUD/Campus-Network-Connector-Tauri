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

`electron/src` 与 `tauri/src` 的同名文件里，**只有 5 个不同**，其余完全一致：

| 文件 | 差异 | 处置 |
| --- | --- | --- |
| `index.css` | Tauri 多了一整层 CSS 变量（`--panel-max` / `--card-bg` / `--card-radius` / `--card-border` / `--card-shadow`） | **删掉**。Electron 是直接用 Tailwind 类 + 两行 inline style，Tauri 也直接用同一套类名 |
| `components/Stepper.jsx` | Tauri 把 Electron 的类名翻译成变量又实现了一遍；多加了 `flex flex-col overflow-hidden` | **改回 Electron 原款**，只留 Tauri 必需的两处增补（见下） |
| `App.jsx` | Tauri 的根容器少 `pt-10`，改用一条额外的 40px 拖拽条 div | **改回 Electron 的 `pt-10`**，拖拽标记放回根容器 |
| `panels/KeyboardPanel.jsx` | Tauri 多了「辅助功能」授权小问号 | **保留**（Electron 根本没有这个提示，没有可照搬的对象；这是 Tauri 侧主动补的） |
| `main.jsx` | Tauri 多一行 `import './tauri-bridge.js'` | 保留（必需） |

### 为什么 `overflow-hidden` 必须拿掉

卡片是 flex 项，默认 `flex-shrink: 1`；而卡片自己带 `overflow-hidden`，
它的**自动最小尺寸（auto）会被算成 0** —— 于是窗口一旦比内容矮：

1. 卡片被压到窗口高度（实测 440 → 272），内容被裁（234 → 只剩 66）；
2. 量出来的底边永远等于「窗口底 − 8px」，于是**窗口一直长、内容一直缺**。

Electron 的卡片没有 `overflow-hidden`，`min-height: auto` 天然就压不扁。
Tauri 现在也一样（并额外显式写了 `shrink-0`）。

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

# Rust 自检(含 Safari 修复那三个回归测试)
cd tauri-app/src-tauri && cargo test --lib -- --nocapture

# Windows 代码体检(只做类型检查,不打包)
./tools/windows-check.sh
```

两个仓库的界面文件要保持一致，**改了哪边另一边都要显式搬**；
搬完用上面的对照脚本量一遍，不一致的地方会直接显形。
