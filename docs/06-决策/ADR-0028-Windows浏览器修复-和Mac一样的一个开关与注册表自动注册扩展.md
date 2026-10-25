# ADR-0028:Windows 的浏览器修复 —— 和 Mac **一样的一个开关**,桌面程序自己把扩展挂进 Chrome/Edge

- 状态:**已定**(用户 2026-10-25 原话:「Windows上我要和Mac一样的工作方式,
  你别搞什么这种搞扩展这么复杂的操作,越简单越好,你为什么不照搬,还搞这么特殊的」)
- 日期:2026-10-25
- 相关:ADR-0013(界面层逐字照搬 Electron)、ADR-0025(Windows 线与 macOS 线行为对齐)、
  ADR-0027(浏览器修复的两个根因)、ADR-0026(Windows 线不保留「默认执行」界面)
- 性质:定下 Windows 线**浏览器修复**的**交互形态**与**落地方式**。
- 谱系:Electron 侧是**同一条决策**的 ADR-0018,两边行为一致。

---

## 更正记录(2026-10-25 改口径)

上一版(ADR-0027 决策六)给的是**说明块**,不是开关。

| 项 | 上一版(2026-10-25 早) | **本版(现行)** |
| --- | --- | --- |
| 界面形态 | **说明书**:让用户自己去 chrome://extensions「加载已解压的扩展程序」 | **一个开关**,与 mac 的「Safari 复制修复」**同一个位置、同一个组件** |
| 谁装扩展 | **用户**手动装 | **桌面程序自己**注册进浏览器(注册表外部扩展机制) |
| 要不要开发者模式 | **要**(用户得先开) | **不要** |
| 用户要做的 | 复制文件夹、开开发者模式、选目录 | **拨一下开关**(外加:浏览器在跑的话重启一次) |

**为什么改**(用户原话):「Windows上我要和Mac一样的工作方式,
你别搞什么这种搞扩展这么复杂的操作,越简单越好,你为什么不照搬,还搞这么特殊的」。

⇒ 上一版那套说明**不是"实现难度大所以只能这样"**,是**当时没找到能自动化的办法**
⇒ 本版找到了办法(注册表外部扩展),于是说明书可以删掉,开关可以是真的。

---

## 决策一:界面上是**一个开关**,和 mac 完全一样

- 界面上原来那块「浏览器修复(复制修复)」说明书**整块删掉**
  (`src/App.jsx` 的 `BROWSER_REPAIR_NOTE`、`src/panels/KeyboardPanel.jsx` 的
  `browserRepairNote` 整块消失)。
- 开关由**既有的** `FeatureToggles` 组件渲染 ⇒ 位置、样式、状态文字
  (「关闭中 / 已开启 / 已接管」)、失败原因显示,**与 mac 的那个开关逐字一致**
  (ADR-0013)。
- 功能清单按平台给:
  - macOS:`safari-repair`「Safari 复制修复」(走 Apple Events 驱动 Safari)
  - Windows:`chromium-repair`「浏览器复制修复」(把扩展挂进 Chrome/Edge)
  - 两条线的**开关长得一样**,差别只在背后接哪个浏览器。

**Tauri 线**:`get_features()` 在 Windows 上返回 `chromium-repair`
(以前 Windows 上返回**空数组** —— 这正是上一版只能给说明书的直接原因:
「桌面程序接管不了浏览器 ⇒ 给开关就是骗人」)。

**Electron 线**:`src/features/index.js` 的 `FEATURES` 增加一条
`platforms: ['win32']` 的 `chromium-repair`(mac 上不加载,界面不变)。

---

## 决策二:桌面程序自己把扩展**注册**进 Chrome/Edge

### 为什么注册表能解决「不让用户手动装」

Chrome / Edge 在**启动时**读一份「外部扩展清单」。Windows 上这份清单可以来自注册表:

```text
HKCU\Software\Google\Chrome\Extensions\<扩展ID>\path     = 扩展目录的绝对路径
HKCU\Software\Microsoft\Edge\Extensions\<扩展ID>\path     = 扩展目录的绝对路径
                                          \version  = 与 manifest 一致的版本号
```

写进去之后:

- 扩展以「**外部安装**」的身份出现 ⇒ **不需要开发者模式**
- 用户**不用**去 chrome://extensions 里「加载已解压的扩展程序」
- 用户**不用**自己选文件夹
- 写的是 **HKCU**(当前用户)⇒ **不需要管理员权限**

⇒ 这就是「和 Mac 一样的工作方式」在 Windows 上能做到的最简形态。

### 为什么不用别的办法

| 方案 | 为什么不用 |
| --- | --- |
| 让用户手动「加载已解压的扩展程序」 | 用户原话否掉了;还要开开发者模式 |
| 启动浏览器时加 `--load-extension` | 要改用户的启动方式;不是「装上就一直有效」 |
| Chrome ≥136 的 CDP 注入 | Chrome ≥136 强制要求独立的 `--user-data-dir` ⇒ **用户要重新登录** ⇒ 不算「和 Mac 一样」 |
| `ExtensionInstallForcelist` 策略 | 要一个能下载的更新清单 URL ⇒ 本产品不联网 ⇒ 不可行 |

### 扩展 ID:由**公钥**决定,与路径无关

注册表键名里的 `<扩展ID>` 必须**正好等于** Chrome 算出来的那个 ID,否则浏览器不加载。

Chrome 的规则:扩展 ID = 32 个 `a..p` 的字母,来源是 SHA-256 的前 128 位
(每十六进制位映射到 `a..p`)。

- manifest 里带 `key` 字段(公钥 DER 的 base64)⇒ ID 由**公钥**决定
  ⇒ **与装在哪台机器、哪个目录无关** ⇒ 键名是常量,
  安装目录变了只要重写一次 `path`。
- 本轮这把公钥专门为这个扩展生成(私钥没有用途、也没保存 —— 未打包扩展不需要签名)。
- 实算 ID:`fobnhpnnampboobopbbdlkkaapbmlonc`
  —— 用**三条互相独立的管道**算过(openssl 一条管道 / node crypto /
  手工十六进制切片),三条结果一致。

### 决策三:开关的语义与「重启浏览器」这件事

- 开:找到安装包里的扩展 → 写注册表(Chrome + Edge)→ 状态「已接管」。
- 关:删掉那两把键 → 状态「关闭中」。
- **失败要如实显示**(沿用 `FeatureToggles` 既有的 `lastError` 通道):
  找不到扩展、reg.exe 调不动、路径写不进去,都要说清楚,
  不能让用户只看到「已开启」却什么都没发生。
- **浏览器只在启动时读那份清单** ⇒ 改完要**重启一次浏览器**才生效。
  这是浏览器的机制,绕不过去 ⇒ 界面上**必须把这句话说出来**:
  - 浏览器**没在跑** ⇒ 「下次打开浏览器即生效」
  - 浏览器**在跑** ⇒ 「请重启一次浏览器后生效」
- **自愈**:开关是落盘的,程序**每次启动**都把注册表那两把键**重写一遍**
  ⇒ 用户把程序挪了位置(或换了机器重装),不用做任何事,下次启动就修回来了。

### 扩展文件跟着安装包走

- Tauri:`tauri.conf.json` 的 `bundle.resources` 改成 **map 形式**
  (`"../../dist-core/chromium": "browser-extension"`)
  ⇒ 落在 `<资源目录>/browser-extension/`。
- Electron:`build.extraResources` 增加
  `{"from": "dist-core/chromium", "to": "browser-extension"}`
  ⇒ 落在 `resources/browser-extension/`。

⇒ 桌面程序**能**找到扩展 ⇒ 开关是**真的**能用的
(上一版「桌面程序管不着扩展」的前提,至此不成立)。

### 边界与诚实说明

- 这条通道**不是安全边界**:任何本机程序都能改 HKCU 的那两把键。
  它只影响本机浏览器加载哪个扩展,不涉及任何账号与数据。
- **浏览器重启才生效**这件事**没有 workaround** —— 界面上如实说明,
  不假装「一拨就好」。
- 本轮**没有**在 Windows 真机上验证过(开发机是 macOS):
  注册表键名、扩展被 Chrome 认出来的效果,都要在 Windows 上实测。
  ⇒ 见「验收记录」里列的**待用户实测项**。

---

## 影响面

**Tauri 线**
- `tauri-app/src-tauri/src/chromium/{mod.rs,repair.rs}`(**新增**):注册表读写、扩展 ID 计算、扩展目录查找
- `tauri-app/src-tauri/src/commands/app.rs`:功能清单 / 状态 / 开关
- `tauri-app/src-tauri/src/lib.rs`:启动时自愈重写注册表
- `tauri-app/src-tauri/Cargo.toml`:加 `base64`
- `tauri-app/src-tauri/tauri.conf.json`:扩展进包
- `src/App.jsx`、`src/panels/KeyboardPanel.jsx`:删说明书块
- `src/panels/FeatureToggles.jsx`:加 `hint` 一行(mac 侧不受影响)

**Electron 线**
- `src/features/chromium-repair/{index.js,registry.js}`(**新增**)
- `src/features/index.js`:注册新功能
- `package.json`:`build.files` / `build.extraResources`
- `src/App.jsx`、`src/panels/KeyboardPanel.jsx`:删说明书块
- `src/panels/FeatureToggles.jsx`:加 `hint` 一行

**两边共同的**
- `apps/chromium-extension/manifest.json`:加 `key` 字段(扩展 ID 由它决定)
- `tools/verify/verify-extension-id.cjs`(**新增**):四处 ID 必须一致
- `tools/verify/verify-package-*.cjs`:安装包里必须有扩展
