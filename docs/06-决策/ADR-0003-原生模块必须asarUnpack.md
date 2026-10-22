# ADR-0003:原生模块必须 asarUnpack,且失败要"响"

- 状态:已定
- 日期:2026-10-21

## 背景

项目里**没有安装 electron-builder**,构建时用的是 `npx electron-builder`(版本随时间变)。
`mac-coregraphics/build/Release/*.node` 是原生模块,Electron **不能从 asar 里 dlopen**,
必须落在 `app.asar.unpacked/`。

## 出问题的地方

一次打包后,装上的 App 里**模拟输入/输入源/录制回放整组功能全废**,而 App 照常启动。

两个原因叠加:

1. 打包:那个版本的 electron-builder 没有把 `.node` 解包,直接塞进了 asar → `require` 必失败
2. 掩盖:我为了兼容 Windows 把 `require('./mac-coregraphics')` 改成了 try/catch + 平台判断
   → 加载失败**静默**,按钮变哑巴,App 还照跑 → 比直接崩溃更难查

## 决定

1. `package.json` 显式声明,不依赖 electron-builder 版本的自动行为:
   ```json
   "asarUnpack": ["mac-coregraphics/**"]
   ```
2. 加载失败**必须可见**:
   - 主进程 `console.error` 记下原因
   - 新增 `native:getStatus` IPC
   - 界面顶部挂**红色告警条**:"模拟输入相关功能不可用:原生模块加载失败(原因)"
3. 打包后必须跑 `node tools/verify/verify-package.cjs`,把"原生模块已解包且可加载"变成硬门禁

## 教训

**不要把"响亮的失败"改成"安静的失败"。** 为兼容一个平台而加的兜底,
前提是失败要能被看见。
