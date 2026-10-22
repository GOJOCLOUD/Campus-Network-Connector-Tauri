# 模拟输入（Tauri 版）

> 这个仓库是**新架构(Tauri)**的实现：Rust 负责原生能力，前端与 Electron 版共用同一份 `src/`。
> Electron 版在另一个仓库 `Campus-Network-Connector-Electron`。

## 模拟输入 (Campus Network Connector)

macOS 常驻桌面工具:**在别的 App 里代替你操作**(模拟点击 / 输入 / 按键)、**切换输入法**、
**录制并回放操作序列**,以及一个可选增强能力:**Safari 复制修复**
—— 让被网页字体混淆过的文字,复制出来就是屏幕上你看到的那句话。

## 两条发布线:平台各打各的包

| 线 | 分支 | 产物 | 原生模块 | 界面步骤 |
| --- | --- | --- | --- | --- |
| macOS | `mac` | DMG | `mac-coregraphics`(CoreGraphics) | 激活 → 默认执行 → 模拟点击 → 键盘输入 |
| Windows | `win` | NSIS exe | `win-input`(Win32) | 激活 → 默认执行 |

**两个平台不共用一个打包入口**:各自分支、各自的 `package.json` 打包配置、各自的
GitHub Actions workflow。macOS 的包不含任何 Windows 专属的东西,Windows 的包也不含
macOS 专属的东西(Safari 复制修复走 Apple Events,只有 macOS 有)。

**两条线从 2026-10-21 起不再同步推进,也不再保持一模一样**:各自的功能、界面、实现
各自演化,一边想用另一边的改动必须显式搬过去。仓库里有两个 Agent 在并行推进,
详细边界与协作约定见 **[docs/00-概览/两条发布线.md](docs/00-概览/两条发布线.md)**。

Windows 上**没有「模拟点击(录制)」和「键盘输入(快捷输入)」**——它们依赖 macOS 原生能力
(全局事件监听 / 输入源切换),在 Windows 上跑不通,业务上也不需要;录制文件的
挑选 / 重命名 / 删除保留在「默认执行」这一步的「管理」入口里。

> 旧的 `win` 分支已废弃:代码停在 2026-07 之前,原生模块还塞在 asar 里(装上就崩)。

## 快速上手

```bash
npm install
npm run build          # 前端
npm run build:native   # 原生模块(macOS 模拟输入用)
npm run electron       # 开发模式启动
```

打包:

```bash
npm run dist:mac:arm64                    # → release/mac-arm64/模拟输入.app
node tools/verify/verify-package.cjs      # 产物自检(必做)
node tools/lab/package-deliverables.cjs   # 桌面交付(两个 zip)
```

## 目录结构

这个仓库有**两层**,各管一摊,互不越界:

- **应用层** —— 桌面 App 本身(模拟输入 / 输入源切换 / 激活授权 / Safari 复制修复)
- **算法层** —— 2026-10-21 由原「浏览器修复」算法仓并入(copy-repair),本身是 monorepo 形状

### 应用层

| 路径 | 内容 | 进安装包 |
| --- | --- | --- |
| `src/` | 前端(React/Vite) | ✅ |
| `src/features/` | **功能模块**,每个功能一个自包含目录 | ✅(测试除外) |
| `main.js` `preload.js` | 主进程 / 预加载 | ✅ |
| `mac-coregraphics/` | 原生模块(CoreGraphics,仅 macOS) | ✅(必须解包) |
| `backend/` | 运行期数据(输入源配置、激活标记) | ✅ |
| `vendor/` | 运行时依赖(参考字形库、字体解析器、注入脚本) | ✅ |
| `electron/` `build/` | 打包钩子、图标 | ❌ |

> Windows 线(`win` 分支)对应的是 `win-input/`(Win32 插件),`vendor/` 不进那个包。

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
| `dist/` `release/` | 产品侧(vite / electron-builder) |
| `dist-core/` `release-core/` | 算法侧(扩展) |
| `vendor/` | `npm run build:vendor` 生成;参考库缺失会自动重建(约 5 秒) |

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
| 模拟点击 / 文本注入 | 回放录制文件时用(原生模块) | ✅ | ✅ |
| 录制 | 全局鼠标钩子录下操作序列 | ✅ | ❌ 只有 macOS |
| 输入源切换 | 读当前输入源 / 切换 / 设为当前 | ✅ | ❌ 只有 macOS(界面已去掉) |
| 快捷输入 | 切到拼音后自动键入一段文字 | ✅ | ❌ 只有 macOS(界面已去掉) |
| 激活授权 | 机器指纹 + 授权码 + 试用 | ✅ | ✅ |
| Safari 复制修复 | 字体混淆还原 + 复制劫持拦截 | ✅ | ❌ 走 Apple Events,只有 macOS |

## 文档

**[docs/README.md](docs/README.md) 是文档索引**,按"我要做什么"查:

- 想知道这项目是什么 → [产品与架构](docs/00-概览/产品与架构.md)
- 想了解字形还原算法 → [算法仓库说明](docs/00-概览/算法仓库说明.md)
- 要加新功能 → [新功能开发指南](docs/03-开发/新功能开发指南.md)
- 要打包发布 → [打包与发布](docs/05-运维/打包与发布.md)
- 出问题了 → [故障排查](docs/05-运维/故障排查.md)
- 想知道为什么这么设计 → [06-决策/](docs/06-决策/)
- 找开发/诊断脚本 → [tools/README.md](tools/README.md)

## 测试

```bash
npm test                                   # 全部自测(必须串行,会真实操作 Safari 标签页)
npm run test:core                          # 算法核心单元测试(浏览器无关)
npm run test:e2e                           # Chromium 端到端(会开真实浏览器窗口)
node tools/verify/verify-ui-platforms.cjs  # 界面裁剪:macOS 4 步 / Windows 2 步(真实浏览器跑)

# 单跑某一条
node src/features/safari-repair/test/generality.cjs     # 通用性:多作用域/同字跨作用域/双字体
node src/features/safari-repair/test/switch-quiz.cjs    # 换题回归:同标签来回换字体 + 跨节点拖选
node src/features/safari-repair/test/real-site-font.cjs # 真实站点字体:全量还原 + 笔画变轻的稳健性
node tools/verify/verify-package.cjs       # 打包产物自检
node tools/verify/verify-app-e2e.cjs       # 真实端到端(读系统剪贴板核对)
```

## 相关仓库

算法与研究(参考库、栅格化、Chromium 扩展、实验记录)**已并入本仓**:
`packages/core`(算法核心)、`packages/browser-adapters`(页面守卫)、`apps/`(扩展)、`tests/`(端到端)、`tools/`(脚本)、`docs/`(文档)。

## 交接

- [项目记忆](docs/00-概览/项目记忆.md) —— 这个项目经历过什么、为什么长这样(架构演变与关键决策)
- [历史交接快照](docs/00-概览/历史交接快照.md) —— 2026-10-21 之前的交接文案(已过时,保留追溯)
