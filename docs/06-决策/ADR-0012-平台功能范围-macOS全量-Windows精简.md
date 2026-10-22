# ADR-0012:平台功能范围——macOS 全量保留,Windows 只留拼音输入与浏览器字体纠正

- 状态:**已定**(用户 2026-10-22 明确指令)
- 日期:2026-10-22
- 相关:ADR-0003(原生模块必须 asarUnpack)、`docs/00-概览/两条发布线.md`
- 性质:**范围定稿**。任何后续改动都要先对照本文件,冲突以本文件为准。

## 背景

迁移到 Tauri 时出了一个反复被指出的问题:**"换了个框架…为什么连着功能的这个东西也不行了,你虽然说实现了,
但实际上所有功能基本上都是没有的。"**

根因(已查证,非推测):

- Electron = React 界面 + **Node.js 运行时** + Chromium + **`.node` 原生插件**
  (`mac-coregraphics`,C++/ObjC++ `main.mm` 334 行,走 CoreGraphics)。
- Tauri = React 界面 + **Rust 运行时** + 系统 WebView,**没有 `.node` 这个概念**。

⇒ Tauri 不是"换个前端框架",是**换掉整个运行时**。凡是碰操作系统的那一层
(模拟点击、键入、输入源、**CGEventTap 事件录制**、文件、授权)都必须用 Rust 重写一遍。
界面能跑 ≠ 功能在。

迁移期间我只重写了其中一部分,于是交付出去的是"新壳 + 一批原生接口空着"
(`src/tauri-bridge.js` 里的 `notImplemented` 兜底),而汇报口径写成了"迁移完成"。

同时,用户**此前已多次表达过平台功能范围本就该不同**,但一直没有落到文档里,
导致每次接手都按"两边保持一致"推进。**本文件就是为了终结这种反复。**

## 决策

### 一、macOS 线:**现有功能全部做**

指 Electron(macOS)版现有的全部能力,Tauri(macOS)版**必须一个不少地补齐**。
不允许出现"界面有按钮但点了不生效"的状态——要么真实现,要么界面不显示该入口。

以 `main.js` 的 IPC 面 + `mac-coregraphics/src/main.mm` 的导出为准,全量清单:

| 能力 | Electron 实现位置 | Tauri(macOS)要求 |
| --- | --- | --- |
| 窗口 关/最小/最大化 | `main.js` window:* | 必须有 |
| 激活授权(试用/激活码/清除/迁移) | `main.js` activation:* | 必须有 |
| 文件 列表/保存/改名/删除/读取 | `main.js` file:* | 必须有 |
| 模拟点击 / 读鼠标位置 | `main.mm` mouseClick / mouseGetPosition | 必须有 |
| 键入文本 / 按键 | `main.mm` sendText / sendKey | 必须有 |
| 输入源 读取/切换/配置读写 | `main.mm` get/selectCurrentInputSource | 必须有 |
| **把当前输入源设为指定源** | `main.js:678` native:setCurrentAsInputSource | **必须补** |
| **录制**(开始/停止/取点击/清空/是否录中/tapFailed) | `main.mm` CGEventTap | **必须补** |
| **回放**(playFile / playData) | `main.js:511` playClicks | **必须补** |
| **keepalive**(每 3 分钟 ping) | `main.js:158` pingNetwork | **必须补** |
| 拼音自动键入 | `main.js:532` pinyinType | 必须有(已补) |
| 剪贴板读取 | Electron clipboard | 必须有(已补) |
| Safari 复制修复 | `src/features/safari-repair/` | 必须有(已补) |
| 功能模块开关 | `main.js` features:* | 必须有 |

### 二、Windows 线:**只保留两项**

**保留(Windows 上要有、要能用):**

1. **拼音自动键入**(`pinyinInput`)—— 桌面应用内实现。
   Windows 没有输入源切换(TIS 是 macOS 的),但**逐字 Unicode 键入可用**
   (`SendInput` + `KEYEVENTF_UNICODE`),所以这一项在 Windows 上照样成立。
2. **浏览器混淆字体纠正** —— 走 **Chrome / Edge 扩展**
   (`node tools/build.mjs chromium` → `dist-core/chromium/`),
   **独立于桌面应用**,不依赖桌面应用的任何原生能力。

**不新增(Windows 侧明确不做,不要再投入):**

- 录制(CGEventTap / Win32 钩子)
- keepalive
- 把当前输入源设为指定源(Windows 没有输入源概念)

**"不新增" ≠ "砍掉已有的"。** 这一条是本 ADR 最容易被误读的地方,单独说明:

| Windows 上已有的能力 | 处置 | 理由 |
| --- | --- | --- |
| **默认执行(回放)** | **保留** | 录制文件是跨平台 JSON:macOS 录 → Windows 回放,是产品设计的一部分,不是"多余能力" |
| 激活授权 / 文件管理 / 设置 / 窗口 / 界面 | 保留 | 产品外壳 |
| 快捷键 `⌃⇧D`(读剪贴板并键入) | 保留 | 走的就是上面那项拼音输入 |

⇒ **判定口径:凡是"我要新写代码才能有"的能力,按上表砍;凡是已经能用的,不因为本次决策删掉。**
删功能属于减功能,要有单独的明确授权。

### 三、口径说明(实现前必读)

1. **"Windows 不需要其他的"指的是原生系统能力**,不是把应用本身砍成空壳。
   以下属于**产品外壳**,两个平台都保留:激活授权、文件管理、设置项、窗口控制、界面结构。
2. **Windows 线必须在界面上隐藏"没实现"的入口**(录制面板),不能留下点了没反应的按钮;
   **反过来**,保留的入口(拼音输入)必须**露出来**——不能因为它和 macOS 的界面步骤
   绑在一起就一起藏掉。
3. 两条线**不再互相回流**。macOS 新增的能力不自动进 Windows;Windows 砍掉的能力不拖累 macOS。

## 为什么这么定

- **macOS 是主力线**,它的功能面就是产品的价值面。少一个都不算完成
  —— 这正是本轮被指出的问题。
- **Windows 的浏览器字体纠正本来就不靠桌面应用**:扩展自带完整实现(参考字形库随扩展打包、本地分析),
  桌面应用在 Windows 上只剩"拼音自动键入"这一项真正需要操作系统的能力。
  为此再实现一套 Win32 钩子录制 + 回放,投入产出不成比例,且两条线的质量会因此拉不齐。
- 把边界写死,是为了让**验收有唯一判据**:macOS 逐项对照上表,Windows 逐项对照"只两项"。

## 影响

| 项 | 之前 | 之后 |
| --- | --- | --- |
| macOS Tauri 回放 | `notImplemented`(界面显示"执行失败",不回放) | 已实装(`play_file` / `play_data`) |
| macOS Tauri 录制 | `notImplemented`(提示"录制已开始",实际录不到) | 已实装(CGEventTap;建不起来会**直接报错**,不再假装开始) |
| macOS Tauri keepalive / 设当前输入源 | 空 | 已实装(keepalive 走 HTTPS ping;设当前输入源走已有命令拼装) |
| Windows Tauri 录制 | 未定 | **不做**,界面隐藏入口;命令占位返回"不支持" |
| Windows Tauri 拼音输入 | 界面没入口(整个键盘页被 Windows 屏蔽) | **露出来**(Unicode 键入在 Windows 上可用) |
| Windows Tauri 功能开关清单 | 恒含 safari-repair | 非 macOS 返回空清单(Windows 的字体纠正由扩展提供) |
| 失败可见性 | 缺权限时**静默失败**(命令返回成功,事件被系统丢弃) | 缺权限时**直接报错** + 界面底部授权指引 |
| 文档 | 边界只在口头 | 本文件 + `两条发布线.md` + `安装指南-macOS-Tauri.md` |

## 验收

- **macOS**:逐条对照"决策·一"的全量清单,每项**实测可用**(不是"函数存在")。
- **Windows**:界面上原生能力只剩**拼音输入**这一项(浏览器字体纠正由扩展提供);
  **录制入口不可见**;**默认执行/回放保留**。
  装 Chromium 扩展后字体纠正实测可用。
- 两线各跑各的自检,各发各的包;**一边的绿不替另一边背书**。
