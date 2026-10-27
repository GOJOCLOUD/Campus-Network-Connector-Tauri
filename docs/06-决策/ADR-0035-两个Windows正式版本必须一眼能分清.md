# ADR-0035:两个 Windows 正式版本必须**一眼能分清**

- 状态:**已定**
- 日期:2026-10-27
- 用户原话(2026-10-27 18:01):
  > 「Electron版本和那个版本，你根本就没有区分，让我测试」
- 相关:ADR-0013(两条线同口径)、ADR-0012(Windows 线的能力边界)
- 谱系:Electron 侧是**同一条决策**的 ADR-0025,两边行为一致。

---

## 一、问题

Windows 线有**两个并存的正式版本**:

- **Electron 版**(Electron 仓)
- **Tauri 版**(Tauri 仓)

两边的**界面一模一样、功能一模一样**。而且窗口与托盘都是**自绘**的:

| | Electron 版 | Tauri 版 |
| --- | --- | --- |
| 窗口 | `frame: false`(没有原生标题栏) | `hiddenTitle: true` + `titleBarStyle: Overlay`(没有原生标题栏) |
| ⇒ 后果 | **光看窗口分不出来** | **光看窗口分不出来** |

⇒ 用户在测的时候根本不知道自己测的是哪一个。

## 二、决策:四处都要写清楚是哪个版本

| 位置 | Electron 版 | Tauri 版 |
| --- | --- | --- |
| **界面顶部徽标**(常驻) | Electron 版 | Tauri 版 |
| **托盘提示**(悬停) | 模拟输入（Electron 版） | 模拟输入（Tauri 版） |
| **窗口标题**(任务栏悬停 / Alt+Tab) | 模拟输入（Electron 版） | 模拟输入（Tauri 版） |
| **安装名 / 开始菜单名** | 模拟输入-Electron | 模拟输入-Tauri |

⚠️ **顶部徽标只在 Windows 上显示** —— mac 线的窗口有**原生标题栏**,
本来就分得清;而且 mac 线**由另一台机器负责**,这里不动它。
(Windows 线上本来就有不少 mac 没有的东西,比如「辅助功能」小问号只在 mac 上出现。)

## 三、为什么徽标要放在「顶部那条空白带」

Windows 上窗口没有原生标题栏 ⇒ 顶部那 40px(根容器的 `pt-10`)本来就是空的,
拖拽区在那儿 ⇒ 徽标放那儿**不占地方、不会被内容挤掉、也不会挡住拖拽**
(`pointer-events-none`)。

## 四、改动清单

| 位置 | 改动 |
| --- | --- |
| 两仓 `src/lib/build-info.js` | **新文件**:导出 `BUILD_FLAVOR`(两个仓内容不同,是**故意**区分的) |
| 两仓 `src/App.jsx` | 导入并渲染顶部徽标(仅 Windows) |
| Tauri `tauri-app/src-tauri/tauri.conf.json` | 窗口标题 + 托盘提示 |
| （Tauri 的 productName 本来就带 `-Tauri`，不用改） | `build.productName` + `build.nsis.shortcutName` |
| Tauri `tauri-app/src-tauri/tauri.conf.json` | 窗口标题 |
| Tauri `tauri-app/src-tauri/src/lib.rs` | 托盘提示 |
| 两仓 `tools/verify/verify-build-flavor.cjs` | **新门禁**:徽标存在 / 界面渲染 / 托盘与标题同名 / 安装名带 Electron |
| 两仓 `.github/workflows/build-*.yml` | 门禁接进 CI |

## 五、验收

- **门禁**: `node --test tools/verify/verify-build-flavor.cjs`(两仓各 4 条,全绿)。
- **真机**:装上后,看界面左上角与托盘提示,一眼能说出是哪个版本。
## 六、真机复验抓到的新问题：窗口标题被前端 `<title>` 顶掉了（2026-10-27 18:40）

第二节写的是「窗口标题 = 模拟输入（Tauri 版）」，
但 2026-10-27 真机一读窗口标题，实际显示的是 **「模拟输入」**。

**证据**（本机装好的 v5，`GetWindowText` 逐个窗口读）：

| 窗口 | 读到的标题 | 应该是 |
| --- | --- | --- |
| Tauri 版主窗口（`Tauri Window`） | **模拟输入** | 模拟输入（Tauri 版） |
| Electron 版主窗口（`Chrome_WidgetWin_1`） | **模拟输入** | 模拟输入（Electron 版） |

⇒ **两个版本在任务栏悬停提示 / Alt+Tab 里长得一模一样**，还是分不出来。

**根因**：`tauri.conf.json` 里 `"title": "模拟输入（Tauri 版）"` 只是**初始**标题。
页面一加载，Tauri v2 在 Windows 上会拿 **webview 的文档标题**（前端 `<title>`）
去改窗口标题（wry 的 document-title-changed 回调）。
前端 `index.html` 里写的是 `<title>模拟输入</title>`
⇒ 窗口标题最后被顶成「模拟输入」。

（Electron 那边是同一个坑的另一个实现：Electron 默认「页面标题一变，窗口标题跟着变」。）

**修法**：

1. `index.html` 的 `<title>` 改成 `模拟输入（Tauri 版）`
   —— Tauri 的窗口标题就是拿它当准的；
2. 门禁 `verify-build-flavor.cjs` 加一条：`<title>` 必须带版本名。

**为什么这次能抓到**：真机复验时用 `GetWindowText` **逐个窗口读标题**，
才发现「源码里写了 ≠ 窗口上真是那样」。
⇒ 教训：凡是「窗口标题 / 托盘提示」这类**要显示给人看**的标识，
都必须**真机读窗口标题**来验，不能只看源码里写没写。
## 七、真机截图又抓到：徽标**太淡**，等于没区分（2026-10-27 19:05）

窗口标题那一处修完之后，截真机图查徽标，发现
**徽标确实画出来了，但几乎看不见**。

**根因**：徽标原来是浅灰字（`text-gray-400`），
而 Windows 上窗口顶部那条带是**透明的**（窗口整体 `transparent:true`）
⇒ 压在浅色桌面上，肉眼分不清是「Tauri 版」还是「Electron 版」。

（这一条跟第六节是同一类问题：**源码里写了 ≠ 屏幕上看得见**。
第六节是「被顶掉了」，这一节是「太淡了」。）

**改法**：徽标改成**白色药丸** —— 白底（`bg-white/90`）+ 描边（`ring-1 ring-gray-200`）
+ 深灰字（`text-gray-600`）⇒ 任何壁纸背景上都读得出来。

**门禁**：加一条断言 —— 徽标那一行的 class 里必须有底色（`bg-*`）
⇒ 以后有人改回「浅灰字 + 透明底」，门禁会红。
