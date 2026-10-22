# 模拟输入（Tauri 版）

> **本仓库是同一个产品的两个正式版本之一,和 Electron 版同等优先。**
> 两个版本都是正式产品,区别只在**技术栈**,不存在"新版本取代旧版本"的关系:
>
> | | 版本 | 技术栈 | 仓库 |
> | --- | --- | --- | --- |
> | 本仓库 | **Tauri 版** | Rust + 系统 WebView,**无 Node、无 `.node` 插件** | `Campus-Network-Connector-Tauri` |
> | 另一个仓库 | **Electron 版** | Node.js + Chromium + `.node` 原生插件 | [`Campus-Network-Connector-Electron`](https://github.com/GOJOCLOUD/Campus-Network-Connector-Electron) |
>
> 两个仓库各有 `mac` / `win` 两条分支,各自出各自的包,**不互相回流**:
> 一边要另一边的改动必须**显式搬运**。
> 平台范围口径(哪个平台做什么、哪些能力明确不做)见
> **[ADR-0012](docs/06-决策/ADR-0012-平台功能范围-macOS全量-Windows精简.md)**。

## 模拟输入 (Campus Network Connector)

macOS 常驻桌面工具:**在别的 App 里代替你操作**(模拟点击 / 输入 / 按键)、**切换输入法**、
**录制并回放操作序列**,以及一个可选增强能力:**Safari 复制修复**
—— 让被网页字体混淆过的文字,复制出来就是屏幕上你看到的那句话。

## 两条发布线:平台各打各的包

| 线 | 分支 | 产物 | 原生实现 | 界面步骤 |
| --- | --- | --- | --- | --- |
| macOS | `mac` | `.app` + zip | Rust + CoreGraphics(**无 `.node`**) | 激活 → 默认执行 → 模拟点击 → 键盘输入 |
| Windows | `win` | NSIS `.exe` | Rust(SendInput / Unicode 键入) | 激活 → 默认执行 → 键盘输入 |

**两个平台不共用一个打包入口**:各自分支、各自的打包配置(`tauri.conf.json` /
`tauri.windows.conf.json`)、各自的 GitHub Actions workflow
(`build-tauri-macos.yml` / `build-tauri-windows.yml`)。macOS 的包不含任何 Windows 专属的
东西,Windows 的包也不含 macOS 专属的东西(Safari 复制修复走 Apple Events,只有 macOS 有)。

**两条线从 2026-10-21 起不再同步推进,也不再保持一模一样**:各自的功能、界面、实现
各自演化,一边想用另一边的改动必须显式搬过去。两个仓库(本仓库与 Electron 版仓库)
各自维护、各自发布,详细边界与协作约定见
**[docs/00-概览/两条发布线.md](docs/00-概览/两条发布线.md)**。

Windows 线按 **[ADR-0012](docs/06-决策/ADR-0012-平台功能范围-macOS全量-Windows精简.md)**
定稿:桌面应用里保留**拼音自动键入**(Unicode 逐字键入,跨输入法可用)与
**默认执行(回放)**;**不做**录制 / keepalive / 设为当前输入源。
浏览器字体纠正走 Chrome/Edge 扩展(`npm run build:core` → `dist-core/chromium/`),
**独立于桌面应用**。录制文件的挑选 / 重命名 / 删除保留在「默认执行」这一步的
「管理」入口里。

## 快速上手

```bash
npm install                  # 根目录依赖(前端 / 算法 / 构建脚本)
cd tauri-app && npm install  # Tauri CLI
npm run build                # 构建前端(必须先跑,前端会被编译进二进制)
npm run tauri:dev            # 开发模式启动
```

打包:

```bash
npm run tauri:build:mac      # → tauri-app/src-tauri/target/release/bundle/macos/*.app
npm run tauri:build:win      # → tauri-app/src-tauri/target/release/bundle/nsis/*.exe
```

> macOS 打包需要 Rust 工具链 + Xcode 命令行工具;Windows 打包需要 `llvm-rc`(资源编译器)
> 与 Windows SDK,**本机不装**——Windows 产物一律走云端 CI。
> 本机只保留 `x86_64-pc-windows-msvc` 这个 Rust 目标做 Windows 代码类型检查。

## 目录结构

这个仓库有**两层**,各管一摊,互不越界:

- **应用层** —— 桌面 App 本身(Tauri 外壳 + Rust 原生能力)
- **算法层** —— 2026-10-21 由原「浏览器修复」算法仓并入(copy-repair),本身是 monorepo 形状

### 应用层

| 路径 | 内容 | 进安装包 |
| --- | --- | --- |
| `src/` | 前端(React/Vite) | ✅(编译进二进制) |
| `src/features/` | **功能模块**,每个功能一个自包含目录 | ✅(测试除外) |
| `src/tauri-bridge.js` | 前端 ↔ Rust 的桥,所有 `cnc.*` 调用的实现 | ✅ |
| `tauri-app/src-tauri/src/commands/` | 命令层:`app.rs`(激活/文件/设置)、`play.rs`(回放)、`keepalive.rs` | ✅ |
| `tauri-app/src-tauri/src/commands/native/` | 原生能力:`macos.rs`、`windows.rs`、`recording.rs`(CGEventTap 录制) | ✅ |
| `tauri-app/src-tauri/src/safari/` | Safari 复制修复(Apple Events 注入 + 字形映射) | ✅ |
| `tauri-app/src-tauri/src/glyph/` | 字形还原算法(参考库、栅格化、判定) | ✅ |
| `vendor/` | 运行时依赖(参考字形库、字体解析器、注入脚本) | ✅ |
| `packages/` `apps/` `tests/` | 算法核心、扩展、端到端测试 | ❌ |

> Windows 线(`win` 分支)的原生实现是 `commands/native/windows.rs`(SendInput / Unicode 键入);
> `commands/native/recording_stub.rs` 只是占位,按 ADR-0012 不做录制。

### 算法层

| 路径 | 内容 | 进安装包 |
| --- | --- | --- |
| `packages/` | **算法核心** `core/` + **浏览器适配** `browser-adapters/`(TypeScript) | ❌(只有 `vendor/` 里的产物进包) |
| `apps/` | Chromium / Safari 扩展(辅助形态) | ❌ |
| `tests/` | 跨浏览器端到端测试与测试页夹具 | ❌ |
| `tools/` | 构建脚本 + `lab/` 实验 + `verify/` 校验 | ❌ |
| `docs/` | **文档系统** | ❌ |

### 构建产物(不进版本库)

| 路径 | 内容 |
| --- | --- |
| `dist/` | 前端产物(vite)—— **Tauri 会把它编译进二进制** |
| `vendor/` | `npm run build:vendor` 生成;参考库缺失会自动重建(约 5 秒) |
| `dist-core/` | 算法侧产物(Chromium 扩展等) |
| `tauri-app/src-tauri/target/` | Rust 编译缓存与打包产物 |

## 功能模块怎么加

新增功能 = 建一个目录 + 注册表加一行,前端自动出现开关:

```
src/features/<功能名>/index.js
   ↓  在 src/features/index.js 的 FEATURES 里加一行
   ↓  前端 cnc.getFeatures() → 自动渲染开关
```

详见 [docs/03-开发/新功能开发指南.md](docs/03-开发/新功能开发指南.md)。

现有功能:

| 功能 | 说明 | macOS | Windows |
| --- | --- | --- | --- |
| 模拟点击 / 文本注入 | 回放录制文件时用(Rust 原生实现) | ✅ | ✅ |
| 默认执行(回放) | 挑录制文件回放 | ✅ | ✅ |
| 拼音自动键入 | Unicode 逐字键入,跨输入法可用 | ✅ | ✅ |
| 录制 | CGEventTap 全局监听录下操作序列 | ✅ | ❌ 按 ADR-0012 不做 |
| 输入源切换 | 读当前输入源 / 切换 / 设为当前 | ✅ | ❌ macOS 专属(界面已去掉) |
| keepalive | 每 3 分钟 HTTPS ping,保活授权 | ✅ | ❌ 按 ADR-0012 不做 |
| 激活授权 | 机器指纹 + 授权码 + 试用 | ✅ | ✅ |
| Safari 复制修复 | 字体混淆还原 + 复制劫持拦截 | ✅ | ❌ 走 Apple Events,只有 macOS |
| 浏览器字体纠正 | Chrome / Edge 扩展(与桌面应用独立) | ✅(扩展) | ✅(扩展) |

## 文档

**[docs/README.md](docs/README.md) 是文档索引**,按"我要做什么"查:

- 想知道这项目是什么 → [产品与架构](docs/00-概览/产品与架构.md)
- 想了解字形还原算法 → [算法仓库说明](docs/00-概览/算法仓库说明.md)
- 要加新功能 → [新功能开发指南](docs/03-开发/新功能开发指南.md)
- 要打包发布 → [打包与发布](docs/05-运维/打包与发布.md)
- macOS 装完还要授权? → [安装指南(macOS · Tauri)](docs/05-运维/安装指南-macOS-Tauri.md)
- 出问题了 → [故障排查](docs/05-运维/故障排查.md)
- 想知道为什么这么设计 → [06-决策/](docs/06-决策/)
- 找开发/诊断脚本 → [tools/README.md](tools/README.md)

## 测试

```bash
npm test                                   # Safari 修复相关自测(必须串行,会真实操作 Safari 标签页)
npm run test:core                          # 算法核心单元测试(浏览器无关)
npm run test:e2e                           # Chromium 端到端(会开真实浏览器窗口)
node tools/verify/verify-ui-platforms.cjs  # 界面裁剪:macOS 4 步 / Windows 3 步(真实浏览器跑)

# 原生能力自检(Rust):录制状态机 / 回放分配 / 缺权限时的报错路径
cd tauri-app/src-tauri
cargo test --test feature_test -- --test-threads=1 --nocapture

# 单跑某一条
node src/features/safari-repair/test/generality.cjs     # 通用性:多作用域/同字跨作用域/双字体
node src/features/safari-repair/test/switch-quiz.cjs    # 换题回归:同标签来回换字体 + 跨节点拖选
node src/features/safari-repair/test/real-site-font.cjs # 真实站点字体:全量还原 + 笔画变轻的稳健性
```

## 相关仓库

- **Electron 版**(同一个产品的另一个正式版本,技术栈不同):
  [`Campus-Network-Connector-Electron`](https://github.com/GOJOCLOUD/Campus-Network-Connector-Electron)
- 算法与研究(参考库、栅格化、Chromium 扩展、实验记录)**已并入本仓**:
  `packages/core`(算法核心)、`packages/browser-adapters`(页面守卫)、`apps/`(扩展)、`tests/`(端到端)、`tools/`(脚本)、`docs/`(文档)。

## 交接

- [项目记忆](docs/00-概览/项目记忆.md) —— 这个项目经历过什么、为什么长这样(架构演变与关键决策)
- [历史交接快照](docs/00-概览/历史交接快照.md) —— 2026-10-21 之前的交接文案(已过时,保留追溯)
