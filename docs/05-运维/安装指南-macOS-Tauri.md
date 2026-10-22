# macOS · Tauri 版安装与授权指南

适用:`模拟输入-Tauri.app`(Tauri 版)。与 Electron 版**并存**,功能范围见
[ADR-0012](../06-决策/ADR-0012-平台功能范围-macOS全量-Windows精简.md)。

---

## 一、安装

**用一条命令装**(解包 + 重签 + 启动 + 自检都在里面):

```bash
# 从云端 Release 下载
gh release download mac-tauri-<run-id> --repo GOJOCLOUD/Campus-Network-Connector-Tauri --pattern "*.zip"
tools/install-macos-app.sh CampusNetworkConnector-mac-tauri-0.0.0.zip
```

也可以指向本地构建出来的 .app:

```bash
npm run build                    # 先构建前端(产物在 dist/)
cd tauri-app && npx @tauri-apps/cli@2 build --bundles app
cd ../.. && tools/install-macos-app.sh tauri-app/src-tauri/target/release/bundle/macos/模拟输入-Tauri.app
```

### 为什么必须重签(别手动跳过这步)

macOS 的系统授权(辅助功能 / 自动化)是**按代码签名身份**记的。
云端 CI 出的包是 **ad-hoc 签名**(TeamIdentifier = not set),身份跟着二进制内容变 ——
每出一个新包,之前授过的权**直接失效**,得重新勾一次。

`tools/install-macos-app.sh` 会用钥匙串里那张**固定证书**重签:

```
Identifier=com.gojocloud.campus-network-connector.tauri
TeamIdentifier=769LN7AY28
```

这样授权**跟着签名身份走,以后更新包不会掉**。换证书:设 `SIGN_IDENTITY=...` 环境变量。

> 手动装的话,务必自己补上这一步:
> `codesign --force --deep --sign "<身份>" /Applications/模拟输入-Tauri.app`

---

## 二、权限:哪些功能要哪些授权

**这张表是这次迁移里最要紧的结论** —— Tauri 版把「辅助功能」和「自动化」拆成了两件事,
Electron 版没拆,所以那边失败是**静默的**(命令返回成功,屏幕上什么都没发生)。

| 功能 | 需要什么 | 没有会怎样 |
| --- | --- | --- |
| **录制**(监听左键点击) | **不需要任何授权** | — |
| **模拟点击 / 回放 / 拼音自动键入** | 「辅助功能」 | 事件被系统**静默丢弃**:界面显示成功,屏幕上什么也没发生 |
| **Safari 复制修复** | 「自动化」(控制 Safari) | 界面**会**显示失败原因和授权指引 |
| 剪贴板读取 | 不需要 | — |

Tauri 版在**第 4 页(键盘输入)右上角**有一个小问号,标着「辅助功能」的授权状态:
**红色 = 还没授权**(模拟点击 / 回放 / 拼音自动键入都发不出去),
**绿色 = 已授权**。点它直接跳到系统设置那一页,不用自己找路径。

### 授予「辅助功能」

1. **系统设置 → 隐私与安全性 → 辅助功能**
2. 点 **＋**,选 `/Applications/模拟输入-Tauri.app`(**或把它拖进去**)
3. 打开它的开关
4. **完全退出并重开本软件**(macOS 的授权要重启进程才生效)

> 授权**只认签名身份**,所以务必用 `tools/install-macos-app.sh` 装(它会重签成固定身份)。
> 用 ad-hoc 签名的包授权,下次更新就白授权了。

### 授予「自动化」(Safari 复制修复用)

1. **系统设置 → 隐私与安全性 → 自动化**
2. 在列表里找到 **模拟输入-Tauri**,打开 **Safari** 那一项
3. Safari 侧:**开发**菜单 → 勾选 **「允许来自 Apple Events 的 JavaScript」**
   (开发菜单本身在 **Safari → 设置 → 高级 → 显示网页开发者功能**)

---

## 三、功能清单(macOS 全量,与 Electron 版对齐)

| 功能 | 状态 | 备注 |
| --- | --- | --- |
| 激活 / 试用 / 激活码 | ✅ | 激活码格式与 Electron 版**通用** |
| 录制文件管理(列表/保存/改名/删除) | ✅ | 录制文件是跨平台 JSON,macOS 录 → Windows 也能回放 |
| 模拟点击 | ✅ | 需要「辅助功能」 |
| 键盘输入 / 拼音自动键入 | ✅ | 需要「辅助功能」 |
| 输入源读取 / 切换 | ✅ | macOS 专有(TIS) |
| 把当前输入源记为 ABC / 拼音 | ✅ | |
| 录制(监听左键点击) | ✅ | **不需要授权** |
| 回放(默认执行) | ✅ | 需要「辅助功能」 |
| keepalive(每 3 分钟 HTTPS 保活) | ✅ | 默认开启 |
| 剪贴板读取 | ✅ | |
| Safari 复制修复 | ✅ | 需要「自动化」 |

---

## 四、排查

### 界面上的功能"点了没反应"

1. 看**第 4 页(键盘输入)右上角的小问号**:红色 = 辅助功能没给(见上),绿色 = 已授权。
2. 问号是绿的但仍没反应 → 看应用数据目录里的自检文件:

```bash
D="$HOME/Library/Application Support/com.gojocloud.campus-network-connector.tauri"
cat "$D/diag.json"
```

里面记着:窗口是否透明、拖拽探针、Safari 修复的真实状态与失败原因。

### Safari 复制修复显示"AppleScript 超时"

多半是 macOS 在等「允许控制 Safari」的弹窗 → 见上面「授予『自动化』」。

### 录制一直录不到点击

- 先确认点的是**左键**(只监听左键按下)。
- 录制期间**点了本软件自己的窗口**会被排除(这是有意的:避免把「点开始录制」也录进去)。
- 监听是 **listen-only** 的,不需要授权;如果 `diag.json` 里没有异常,就是真的没点到左键。

### 授权突然没了(装完新包之后)

macOS 的授权**认签名身份**:ad-hoc 签名的包每出一个新构建身份就变,授权会全部掉。

用 `tools/install-macos-app.sh` 重装(它会用固定证书重签),然后**辅助功能只勾一次**,
以后更新包不会再掉。

### 想知道"到底生效没有"

```bash
D="$HOME/Library/Application Support/com.gojocloud.campus-network-connector.tauri"
cat "$D/diag.json"     # 每 3 秒刷新一次
```

---

## 五、自检(开发者)

```bash
cd tauri-app/src-tauri
cargo test --test feature_test -- --test-threads=1 --nocapture
```

录制的端到端断言("发一次点击 → 必须录到坐标")**需要当前进程有「辅助功能」权限**;
没有时测试会**明确打印**"这次测不到点击是否被录到",而不是假装通过。
