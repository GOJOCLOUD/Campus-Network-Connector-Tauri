# ADR-0030:Windows 线改用「软件自己起浏览器 + CDP 注入守卫」,不再装扩展

- 状态:**已定**(用户 2026-10-26 拍板:「认,按这条实现」「扩展退役」「**Rust 里自己写一个最小 CDP 客户端**」)
- 日期:2026-10-26
- 相关:ADR-0028(注册表自动注册扩展,本 ADR **取代**它的**落地方式**;界面形态不变)、
  ADR-0025(Windows 线与 macOS 线行为对齐)、ADR-0013(界面层逐字照搬 Electron)、
  ADR-0005(复制时当场解析作用域)、ADR-0012(平台功能范围)
- 谱系:**Electron 仓**的同一条决策是 **ADR-0020**(两边行为一致)。
  ⚠️ 两个仓的 ADR 编号**各算各的** —— 引用时必须写明是哪个仓的哪一条。
- 性质:定下 Windows 线**浏览器修复**的**落地形态**。
  界面层不变(仍是「和 mac 一样的一个开关」),**变的是背后怎么接管浏览器**。

---

## 背景

ADR-0028 定的是「注册表外部扩展」:桌面程序把扩展注册进 Chrome/Edge 的外部扩展清单,
用户拨一下开关即可。**这条路在真机上是不通的**:

| 卡点 | 实证 |
| --- | --- |
| 浏览器只在**启动时**读那份清单 | 改了注册表必须**重启一次浏览器**才生效(用户要动手) |
| 外部扩展必须打成 **.crx** 且**被签名** | 未打包目录走不了这条通路 |
| .crx 装上后被**验证器禁用** | 真机实测 `disable_reasons=[256]`(DISABLE_NOT_VERIFIED);用户点「启用」也开不了(`extension_prefs.cc`:`new_enabled = new_reasons.empty()`) |

⇒ 上一版形态**装得上、开不了**,而且还要用户重启浏览器。
⇒ 而用户的底线是**零点击**(唯一人工动作 = 扫码登录超星),重启浏览器这件事本身就不合格。

另一条路「用户手动加载未打包扩展」真机上可行,但要用户开开发者模式 + 选目录,
**同样违反零点击底线**,只能当退路。

---

## 候选方案

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A. 注册表外部扩展(ADR-0028) | 装上就一直有效 | **装上被 256 禁用**、要重启浏览器、要 .crx 签名 | **否**(实测走不通) |
| B. 用户手动加载未打包扩展 | 不用签名,真机可行 | 要用户开开发者模式、选目录 ⇒ 违反零点击 | 否(退路) |
| C. 接管用户**日常**那个浏览器 | 用户不用换窗口 | Chromium ≥136 对**默认 profile** 直接忽略调试端口 ⇒ 要改用户启动方式 ⇒ 破坏日常实例 | 否 |
| D. `autoConnect`(Chrome 146+ 内置远程调试) | 不用自己起浏览器 | 每次都要用户**授权** + 弹横幅 ⇒ 违反零点击;门槛要到 Chrome 146 | 否 |
| **E. 软件自己起浏览器 + CDP 注入** | **零点击**;绑定性满分;不用扩展/签名/开发者模式 | 用户得在**这个**窗口里用;首次扫码登录 | **是** |

---

## 决定

### 决定一:形态 —— 软件自己起 Edge,给每个标签页注入守卫

- 用户拨开关 → 桌面程序**自己拉起** Edge(带**自己的 profile 目录** + `--remote-debugging-port`)。
- 通过 CDP 连上它,给**每个标签页**在 **document_start** 注入页面守卫
  (`Page.addScriptToEvaluateOnNewDocument`)。
- 守卫发现页面里的混淆字体 → 上报 → App 侧用参考字形库算出「密文 → 明文」→
  下发回页面 → 用户按 Ctrl+C 时守卫在 copy 事件里把明文写进剪贴板。

**页面侧那套(守卫 + 帧桥)一行都没改** —— `tauri-app/src-tauri/resources/{page-guard,frame-bridge}.js`
是两条线共用的资产,`frame-bridge.js` 本来就只依赖「主进程在页面里执行 JS」,
mac 那边是 Apple Events,这边是 CDP `Runtime.evaluate` ⇒ **要换的只有 bridge 那一层**。

### 决定二:**不再需要扩展**

守卫由程序直接注入页面 ⇒ 不需要扩展 ID、不需要公钥/私钥、不需要 `.crx`、
不需要 `--load-extension`(Chrome 137 已移除该开关)、不需要开发者模式。

⇒ `apps/chromium-extension/` 在 Windows 线**退役**。
⇒ 之前「同 ID 的未打包扩展可被顶替」的**绑定性缺口自动消失**:
那个缺口来自「扩展是公开的」,现在**根本没有扩展** ——
profile 只有本程序碰得到,守卫只有本程序能注入。

### 决定三:不接管用户日常那个浏览器

用户要在**本软件开的那个 Edge 窗口**里上网、答题。
这条代价必须**如实写在界面上**(见下),不能让人以为是「接管了我平时的浏览器」。

---

## 代价

1. **用户得在软件开的那个 Edge 窗口里用** —— 这是零点击的代价,界面必须说清楚。
2. **首次要扫码登录一次**(用户已确认:重新登录只需扫码)。
3. 页面若用 `user-select:none`,程序化选区取到的是**空串** ⇒ 守卫无字可改。
   ⇒ 真超星是不是这样**必须实测**(见「待验项」)。
4. CDP 调试端口在本机监听 ⇒ 同机其它进程理论上能连。
   缓解:只监听 127.0.0.1 + 随机端口。
   **这不是安全边界**(与 ADR-0028 同样定性)。
   ⚠️ **绝不能**加 `--remote-allow-origins=*` —— 那等于把调试端口对**任意网页**开放。
   本实现用 `tokio-tungstenite`,它**不发 `Origin` 头** ⇒ Chromium 天然放行(已实测)。

---

## 验证

### 2026-10-26 真机验证(Edge 156.0.4314.42,Windows)

用**仓库里的真守卫**(`page-guard.js` v10)+ **真混淆字体夹具**
(`obf-same-style.ttf` ⇒ 密文「天地玄黄宇宙洪荒日月盈昃」/ 明文「人工智能正在改变世界科技」):

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 普通页 + 合成 Ctrl+C | ✅ 剪贴板 = 明文 |
| 2 | **页面自己也拦复制**(window 捕获 preventDefault + document 冒泡 + 试图 setData/clearData 覆盖)+ 合成 Ctrl+C | ✅ **守卫赢过页面**,剪贴板 = 明文 |
| 3 | 页面用 `user-select:none` | ⚠️ 程序化选区取到空串 ⇒ 守卫记 `copy-no-mapping`,剪贴板保持原样 |
| 4 | **真人**鼠标选中 + 真实 Ctrl+C | ✅ 剪贴板 = 明文 |

守卫日志佐证:`copy-repaired {changed:12, text:"人工智能正在改变世界科技"}`。

### App 侧真字形识别(不用真值)

同一份夹具字体,用生产引擎(`ttf-parser` + Rust 字形引擎 + GBK 全集参考库 21517 字)
真算一遍:**132/132 全对**,耗时 1.1 秒。

### 顺手纠正的一条旧结论

之前记的是「Windows 上 CDP 合成按键不触发 DOM copy 事件」。准确说法是:
`Input.dispatchKeyEvent{commands:['copy']}` **不触发**;
但**真实按键序列**(`rawKeyDown Control` → `rawKeyDown c` → `keyUp c` → `keyUp Control`)
**能触发** ⇒ 合成按键可以直接当自动化回归用,不必真人参与。

---

## 端到端门禁(进 CI)

`tauri-app/src-tauri/tests/cdp_copy_repair.rs`:用**生产模块**
(`chromium::browser` / `chromium::bridge` / `chromium::coordinator` /
`safari::repair` 的字形引擎)起真 Edge → 注入 → 真字形识别 → 下发 → 合成 Ctrl+C
→ 断言**系统剪贴板**里是明文。

同时覆盖**两种注入时机**:

- 功能打开**之前**就开着的页面 ⇒ 导航已提交,只能靠 `inject_now` **补注入**
- 功能打开**之后**才开的页面 ⇒ 走 `document_start` 注入

CI 步骤:`cargo test --test cdp_copy_repair`(Windows workflow 里,跑不过就不发包)。

---

## 待验项

- **真超星页面**(本轮只验了自造夹具):用户扫码登录后的真考试页,
  特别是「站点是不是用了 `user-select:none`」。
- **Chrome**(只测了 Edge;Chrome 137 已移除 `--load-extension`,但本方案不用扩展 ⇒ 原理上不受影响)。
- iframe 子框架里的题目(超星常把题目放在第 3~4 层同源 iframe)。
- 换题 / 多标签页 / 标签切换时的注入覆盖与映射重下发。

---

## 影响面

**Tauri 线(本轮已落地)**
- `tauri-app/src-tauri/src/chromium/{cdp,browser,bridge,coordinator,repair}.rs`(新增)
- `tauri-app/src-tauri/src/chromium/{mod.rs}`(改为声明新模块)
- `tauri-app/src-tauri/src/safari/repair.rs`:字形引擎那几个函数改成 `pub`
  (Windows 线**复用**同一份引擎,不重写)
- `tauri-app/src-tauri/src/commands/app.rs`:状态 / 开关改成新形态
- `tauri-app/src-tauri/src/lib.rs`:启动时起协调器(不再重写注册表)
- `tauri-app/src-tauri/Cargo.toml`:加 `tokio` / `tokio-tungstenite` / `futures-util`;去掉 `base64`
- `tauri-app/src-tauri/tauri.conf.json`:去掉扩展进包那项
- `tauri-app/src-tauri/tests/cdp_copy_repair.rs`(新增,CI 硬门禁)
- `apps/chromium-extension/`、`tools/verify/verify-chromium-extension.cjs`、
  `tools/verify/verify-extension-id.cjs`(删)
- `tools/build.mjs`(去掉 chromium 目标)、`package.json`(去掉 `build:extension`)
- `.github/workflows/build-tauri-windows.yml`(扩展门禁换成 CDP 端到端门禁)

**Electron 线**:同一条决策的 ADR-0020(那边已落地)。

**mac 线**:一行没改。
