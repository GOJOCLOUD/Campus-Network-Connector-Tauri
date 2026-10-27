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
## 六、真机复验抓到的新问题：窗口标题在真机上**还是**「模拟输入」（2026-10-27 18:40 → 19:20 改正根因）

第二节写的是「窗口标题 = 模拟输入（Tauri 版）」，
但 2026-10-27 真机一读窗口标题，实际显示的是 **「模拟输入」**。

**证据**（本机装好的包，`GetWindowText` 逐个窗口读）：

| 窗口 | 读到的标题 | 应该是 |
| --- | --- | --- |
| Tauri 版主窗口（`Tauri Window`） | **模拟输入** | 模拟输入（Tauri 版） |
| Electron 版主窗口（`Chrome_WidgetWin_1`） | **模拟输入** | 模拟输入（Electron 版） |

⇒ **两个版本在任务栏悬停提示 / Alt+Tab 里长得一模一样**，还是分不出来。

### 根因：Tauri 有**平台覆盖配置**，它把窗口配置**整个替换**了

⚠️ **本节 18:40 的初稿把根因写成了「前端 `<title>` 把窗口标题顶掉了」
—— 那只对 Electron 线成立**（Electron 默认「页面标题一变，窗口标题跟着变」，
见 **Electron 仓 ADR-0025 第六节**）。
**Tauri 线不是这样**：19:20 真机复验（把前端 `<title>` 改成带版本名 →
重新出包装 → 再读窗口标题，**还是**「模拟输入」）把那条路**否掉了**。

真正的根因是 **`tauri-app/src-tauri/tauri.windows.conf.json`**：

| 文件 | `app.windows[0].title` | 真机上谁说了算 |
| --- | --- | --- |
| `tauri.conf.json`（主配置） | 模拟输入（Tauri 版） | ❌ **不算** |
| `tauri.windows.conf.json`（Windows 平台覆盖） | **模拟输入** | ✅ **就是它** |

Tauri v2 的**平台覆盖配置**在 Windows 上会**整个替换** `app.windows` 这个数组
（**不是**逐字段合并）⇒ 真机上 Windows 用的是覆盖文件里那份，
连 `decorations` / `hiddenTitle` / `titleBarStyle` 都被它换掉了。

⇒ 为什么之前没人发现：改的**只有主配置**，门禁也**只查主配置**
⇒ 源码看着全对、门禁全绿、装上去窗口标题却是错的。
**只有真机读窗口标题才抓得到。**

### 改法

1. `tauri.windows.conf.json` 的 `title` 改成「模拟输入（Tauri 版）」；
2. 门禁 `verify-build-flavor.cjs` 加一条：
   **`src-tauri` 下每一份 `tauri*.conf.json`** 的窗口标题都必须是「模拟输入（版本名）」
   （已做过**反向自查**：把覆盖文件改回旧标题 ⇒ 门禁立刻转红）；
3. 门禁 `verify-package-tauri-win.cjs` 加一条：
   **编出来的 exe 里**必须带着版本化的标题字符串；
4. （顺带）前端 `index.html` 的 `<title>` 也改成带版本名
   —— 不是根因，但**本来就该对**（万一哪天框架改成跟文档标题走）。

### 教训

- **平台覆盖配置**是个隐形陷阱：它**整个替换**数组，不是合并。
  以后凡是「Windows 上真正生效的是哪一份配置」，
  门禁要**把每一份都查一遍**，不能只查主配置。
- 「源码写了 + 门禁绿 + 装上还是不对」⇒ 说明**门禁查错了地方**：
  门禁必须对着**真机上真正生效的那一份**写。
- **同一个症状，两条线的根因可以完全不同** ⇒ 不能把一条线的修法照抄到另一条。
