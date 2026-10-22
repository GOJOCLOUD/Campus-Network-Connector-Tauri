# macOS · Safari 安装与授权指南

Safari 有两条交付路径，**都不需要关闭 Safari 的任何安全保护**：

| | A. 热键工具（方案 B） | B. Safari Web Extension（方案 A） |
| --- | --- | --- |
| 状态 | ✅ **现在就能用**，已实测通过 | ⚠️ 需要付费开发者团队才能签名分发 |
| 安装 | 拖一个 App 到「应用程序」+ 绑一个快捷键 | Xcode 自动签名构建 → Safari 设置里启用 |
| 用户操作 | 复制后**按一下热键** | 无感，`Cmd+C` 直接正确 |
| 覆盖能力 | 字体混淆还原 + 篡改恢复（可选开关） | 字体混淆还原 + 篡改拦截 + 富文本保持 |
| 依赖 | Safari 的「允许来自 Apple Events 的 JavaScript」 | 付费 Apple Developer Program 团队 |

---

## 一、热键工具（推荐先用这个）

### 1. 安装

```bash
# 解压后把 "Copy Repair.app" 拖进「应用程序」
unzip copy-repair-safari-tool.zip -d ~/Downloads
```

或直接从仓库打包：

```bash
node tools/package-safari-tool.mjs      # 产物在 release-core/safari-tool/
```

### 2. 打开 Safari 的 Apple Events 通道

菜单栏 **开发** → 勾选 **「允许来自 Apple Events 的 JavaScript」**
（开发菜单本身在 **Safari → 设置 → 高级 → 显示网页开发者功能**）

### 3. 绑定快捷键

**系统设置 → 键盘快捷键 → App 快捷键 → ＋** → 选 **Copy Repair** → 设一个键（建议 `⌃⌥C`）

### 4. 用法

在 Safari 里选中文字 → `⌘C` 复制 → 按 `⌃⌥C` → 剪贴板被修正为**你看到的文字**。

命令行的等价用法（不含快捷键）：

```bash
cd release-core/safari-tool && node bin/copy-repair.mjs
# 附带恢复被网页篡改的内容（只在剪贴板与可见文字毫无共同字符时才动手）
node bin/copy-repair.mjs --restore
```

### 5. 行为约定

| 情况 | 行为 |
| --- | --- |
| 普通网页 | **不动剪贴板**（实测：原生复制结果保持不变） |
| 字体混淆 | 用字形映射还原成可见文字（实测：12/12 字符正确） |
| 网页篡改了复制内容 | 默认不动；加 `--restore` 才恢复（判据：与可见文字毫无共同字符） |
| 字体映射不置信 | 不改（保持原字符），不猜测 |

---

## 二、Safari Web Extension（要全自动就得走这条）

### 为什么默认装不上

本机 Xcode 登录的是 **free 个人团队**（`teamID=769LN7AY28`，`isFreeProvisioningTeam=1`）。
用它构建时：编译成功、签名成功（Apple Development 证书链），但
**签不出 `com.apple.Safari.web-extension` 扩展点所需的描述文件**
（appex 里没有 `embedded.provisionprofile`，entitlements 缺
`application-identifier` / `com.apple.developer.team-identifier`）。
没有这两个权限，**Safari 的 ExtensionFoundation 不会加载该扩展**
——表现是 Safari 设置→扩展**列表为空**、`SFSafariExtensionManager` 报 `SFErrorDomain Code=1`，
即使已勾选「允许未签名的扩展」也不加载。

### 拿到付费团队后

```bash
# 1) Xcode → 设置 → 账户 → 添加你的付费团队账号
# 2) 用付费团队重新构建（TEAM_ID = 你的 10 位团队号）
node tools/build-safari.mjs A1B2C3D4E5
# 3) 安装并启动
open "build/safari-xcode/Copy Repair/build/Build/Products/Release/Copy Repair.app"
# 4) Safari → 设置 → 扩展 → 打开 Copy Repair、网站权限设为「在所有网站上」
# 5) 验证
node tools/safari-check.mjs c-font-obfuscation.html '#target'
```

构建脚本会自动完成：打包 WebExtension → 转 Xcode 工程 → 修正 bundle id 前缀 →
以指定团队自动签名（`-allowProvisioningUpdates`，Xcode 自动申请并嵌入描述文件）。

### 与热键工具的差异

- 扩展是**复制时拦截**：能保住富文本（text/html）、能在网页改写 text/plain 时直接阻止；
- 热键工具是**复制后修正**：拿不到 copy 事件，所以只能改剪贴板当前内容。
- 扩展用 `world: "MAIN"` 注入防篡改护栏；Safari 的转换器报告**不支持 `world` 键**，
  若 Safari 真忽略它，则扩展的第二级（篡改拦截）会降级，字体还原不受影响。

---

## 三、自动化测试

```bash
node tools/safari-scenarios.mjs    # 三个场景（A 普通 / B 篡改 / C 字体混淆）
```

脚本自建**一个**临时标签，只在它内部导航，结束按 URL 精确删掉，
不触碰你已有的任何窗口与标签（运行前后会打印窗口数/标签数对比）。
