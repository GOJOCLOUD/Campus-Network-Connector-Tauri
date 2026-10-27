/**
 * 这个安装包是哪个正式版本。
 *
 * Windows 线有**两个并存的正式版本**：
 *   - **Electron 版**（本文件所在的仓）
 *   - **Tauri 版**（另一个仓）
 * 两份**界面一模一样、功能一模一样**，窗口又是自绘的
 * （Windows 上没有原生标题栏：Electron 用 `frame:false`、Tauri 用 `hiddenTitle:true`）
 * ⇒ 光看窗口根本分不出自己在测哪一个
 * （2026-10-27 用户口径：「你根本没有区分，让我测试」）。
 * ⇒ 顶部常驻一个小徽标，写清楚是哪个版本。
 *
 * ⚠️ 这个文件**两个仓各有一份、内容不同**（Electron 版 / Tauri 版）——
 *    不是重复代码，是**故意**区分开的。
 */
export const BUILD_FLAVOR = 'Tauri 版'
