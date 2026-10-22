# ADR-0001:用 Apple Events 注入,而不是 Safari 扩展

- 状态:已定
- 日期:2026-10-20

## 背景

要修的是 **Safari 里的复制**(copy 事件、WebKit 的 `clipboardData` 行为、DOM 里的字形混淆)。三条候选路线:

| 路线 | 结论 |
| --- | --- |
| Safari Web Extension | ❌ free 个人团队签不出 `com.apple.Safari.web-extension` 扩展点描述文件(appex 缺 `application-identifier`/`team-identifier`)→ 编译能过但 Safari 不加载,设置里扩展列表为空。需付费团队 |
| 辅助功能/全局热键工具(已做的 `copy-repair-safari-tool`) | ⚠️ 能用,但要在复制**之后**去改剪贴板,拿不到 copy 事件 → 只能修"复制劫持",修不了"字形混淆" |
| 原生 App + Apple Events 注入 JS 到当前标签页 | ✅ 选它 |

## 决定

用 Electron 原生 App,通过 Apple Events(`do JavaScript`)把守卫脚本注入目标标签页。

## 代价

- 需要用户手动开一次授权:
  Safari → 设置 → 高级 → 勾「显示网页开发者功能」→ 开发 → 允许来自 Apple Events 的 JavaScript
- 只能作用于**同源** frame(跨源注入被同源策略拦)
- 需要常驻 App(关窗口不退出)

## 验证

真实学习通页(题目在第 4 层同源 iframe):注入 → 守卫装好 → 真实 Cmd+C → 系统剪贴板 = 可见文字 ✅
