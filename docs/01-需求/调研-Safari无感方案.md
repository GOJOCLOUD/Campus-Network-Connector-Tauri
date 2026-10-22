# 调研：macOS Safari 上"用户零额外操作"的复制修复实现路径

调研日期：2026-10-20　｜　环境：macOS 15（Darwin 24.6, arm64）、Safari 18.6、Xcode 26.1.1
调研问题见本仓库 `docs/` 外部转交的问题清单（目标：在 Safari 上让复制结果与可见文字一致，且用户无需额外操作）。

---

## 结论速览

| 路径 | 使用时是否无感 | 长期驻留 | 前置条件 | 本机可否达成 |
| --- | --- | --- | --- | --- |
| A. Safari 临时扩展（Add Temporary Extension） | ✅ 是 | ❌ 退出 Safari 即被移除 | 无需付费账号、无需 Xcode | ✅ **可以**（每次重启 Safari 后需重做 2 步） |
| B. 付费团队签名的 macOS 容器 App | ✅ 是 | ✅ | 付费 Apple Developer Program（$99/年） | ❌ 本机只有 free 个人团队 |
| C. Apple Events / JavaScript Automation | ❌ 每次需用户触发 | ❌ | Safari 开启「允许来自 Apple Events 的 JavaScript」 | ✅ 可以（= 当前热键工具） |
| D. 常驻监听剪贴板 | ✅ 是 | ✅ | 需辅助功能权限 | ⚠️ 与本任务的隐私约束冲突（后台持续读取剪贴板） |
| E. 第三方宿主（Raycast/Alfred 等）的扩展点 | ❌ 需用户触发 | 视宿主而定 | 装对应宿主 | 部分可，但不解决"无感" |

**一句话**：在 Safari 上，"使用无感"只有扩展能实现；而"扩展长期驻留"需要付费团队；
但"使用无感 + 每次 Safari 重启后手动重载一次"用官方**临时扩展**就能达到，**不需要付费账号**。

---

## 1. 官方文档原文（关键出处）

来源：<https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension>

> **Temporarily install a web extension folder in macOS Safari**
> To temporarily install your web extension folder in macOS Safari, first locate the folder or zip file
> containing your web extension's files in Finder, then open Safari.
> 1. In the Safari menu, choose Safari > Settings.
> 2. Select the **Developer tab**.
> 3. Click **"Add Temporary Extension…"**, then respond to Safari's unsigned extension authentication
>    prompt, if you haven't already selected the "Allow unsigned extensions" option.
> 4. Select the **folder or zip file** containing your web extension files, and click Select.
>
> **Safari removes temporary extensions after 24 hours or when you quit Safari.**

同页「Configure Safari in macOS to run unsigned extensions」：

> **If you're not part of the Apple Developer Program**, or if you haven't yet configured a developer
> identity for your existing Xcode project, your Safari web extension won't be signed with a development
> certificate. For security purposes, Safari ignores unsigned extensions by default…
>
> …In Safari 16 and earlier, choose Develop > Allow Unsigned Extensions. **In Safari 17 or later, use the
> Developer tab in Settings** … Check the "Allow unsigned extensions" box.
>
> **The "Allow unsigned extensions" setting for Safari resets when you quit Safari**; set it again the
> next time you launch Safari.

要点：
- 临时扩展**支持直接加载文件夹或 zip**，不需要 Xcode 工程、不需要开发者账号；
- 但**退出 Safari 就被移除**（且 24 小时也会清）；
- 「允许未签名扩展」开关**退出 Safari 后重置**。

## 2. 免费团队为什么签不出（与官方文档一致）

同一文档的 macOS 正式安装路径要求：用 macOS App 承载扩展，**App 一运行扩展即可用**；
而未签名/无描述文件的产物 Safari 不认。

第三方实测记录（2026-07）：
<https://github.com/artginzburg/PiPOSS/blob/main/docs/research/safari-extension-signing-2026-07.md>

> **Claim:** a Safari web extension is not registered by Safari when its host app is ad-hoc-signed,
> and a real signature (**Apple Development is enough**) is required.
> …
> | Build path | Signature | Safari registers the extension? |
> | `make app-build`（ad-hoc, linker-signed） | ad-hoc | **no** — compile check only |
> | bare `xcodebuild` / Xcode UI build | **Apple Development** | **yes** |
> | `make app`（SIGN=dev） | Apple Development | yes |
> | `make app-signed`（SIGN=devid） | Developer ID Application | yes, distributable |
>
> An extension Safari has **already registered** from a properly signed build keeps working when the
> bundle underneath it is replaced by an ad-hoc one: Safari's record lives in its own container.

同文引用的 Safari 自身字符串（`/System/Library/PrivateFrameworks/Safari.framework/…/Localizable.strings`）：

```
"Allow unsigned extensions"
"Safari is trying to allow unsigned extensions."
"%@ is trying to allow unsigned extensions."
"Touch ID to allow unsigned extensions."
```

→ 该能力存在，但**带授权门**（Touch ID / 密码确认），默认是拒绝。

**本机实测与之一致**（详见 `../04-测试/测试证据.md`）：
free 个人团队（`teamID=769LN7AY28`，`isFreeProvisioningTeam=1`）用 `Apple Development` 签名可成功，
但 **Xcode 不为 `com.apple.Safari.web-extension` 扩展点签发描述文件**
（appex 内无 `embedded.provisionprofile`，entitlements 缺 `application-identifier` 与
`com.apple.developer.team-identifier`）→ Safari 的 ExtensionFoundation 不加载它，
表现为 Safari 设置→扩展**列表为空**、`SFSafariExtensionManager.getStateOfSafariExtension` 返回
`SFErrorDomain Code=1`。**ad-hoc 签名同样不加载。**

## 3. 系统事件驱动的钩子（问题 3）

| 钩子 | 可用性 | 权限 | 与隐私约束的关系 |
| --- | --- | --- | --- |
| `NSPasteboard` 变更通知（`changeCount`） | 可用 | 无特殊权限 | 属于"后台持续读取剪贴板" → 与任务书冲突 |
| 全局键盘监听（CGEventTap） | 可用 | **辅助功能权限** | 属键盘记录器形态 → 与任务书冲突 |
| 辅助功能事件（AXObserver） | 可用 | **辅助功能权限** | 可监听"聚焦变化"但拿不到网页选区内容 |
| Safari 自身的 Apple Event | 可用 | Safari 开启「允许来自 Apple Events 的 JavaScript」 | ✅ 已在用（热键工具） |
| Safari 个人资料（Profile）级扩展启用状态 | 可用 | 无 | 只影响启停，不影响安装 |

## 4. 其它可能的新能力（问题 4）

- **WWDC26 / Safari 27**：Apple 推出 **Safari Web Extension Packager** —— 在 App Store Connect 网页端
  打包并提交 Safari 扩展，**不需要 Mac 或 Xcode**（来源：<https://developer.apple.com/videos/play/wwdc2026/216/>、
  <https://developer.apple.com/videos/play/wwdc2026/204/>）。这是**分发**路径的简化，提交仍需付费账号。
- 本机为 macOS 15 / Safari 18.6，**用不到** Safari 26/27 的新特性。

## 5. 同类产品（问题 5）

- 市场上"复制增强/复制为 Markdown"类 Safari 扩展（如 Copy as Markdown 等）**均为 Safari Web Extension**，
  走 App Store 分发 → **都依赖付费开发者账号**。
- 本任务的"字体混淆还原"在浏览器侧属于同一类问题，主流做法也是扩展（内容脚本 + 本地字体解析/还原）。

## 6. 尚未排除的可能性

1. **把"临时扩展"自动化**：用 LaunchAgent 在 Safari 启动后自动重放
   「设置 → Developer → 添加临时扩展」的文件选择对话框。
   依赖辅助功能权限 + UI 元素路径，脆弱；社区未检索到成熟方案。
2. **付费团队注册一次后长期可用**：第三方文档指出 Safari 的注册记录独立于 app 二进制，
   即便用付费团队签过一次，之后替换本地二进制也可能继续可用——**此点未经本机验证**。
3. **Safari 26+ 是否放宽临时扩展/签名的限制**：本机 macOS 15，无法验证。

---

## 附：本仓库两条已实现路径

- **Chromium 扩展**（Chrome/Edge）：全自动，`Cmd+C` 即得正确文字。已实测 6/6。
- **Safari 热键工具**（本仓库 `tools/safari-repair.mjs` + `release-core/safari-tool/`）：
  复制后按一次快捷键，剪贴板被修正为可见文字。已实测 3/3。
  底层走的是 Apple Events / JavaScript Automation（问题清单里的路径 C）。
