# Windows 11 · Chrome / Edge 安装指南

适用：Windows 11 上的 Google Chrome 与 Microsoft Edge（两者都是 Chromium 内核，装法一致）。

---

## 0. 产品用户:**装上程序,拨一下开关,完事**

> 这一节给**产品用户**(已经拿到安装包 / 桌面交付包的人);
> 下面第 1 节起是给**开发者**的(要改扩展源码、自己构建扩展的人)。

Windows 上的「把密文还原成明文」由一个 **Chrome / Edge 扩展**提供。
**这个扩展不用你装** —— 桌面程序会自己把它挂进浏览器。

**步骤**

1. 装上「模拟输入」(Tauri 版或 Electron 版任选其一,两个都带这个功能)。
2. 打开程序 → 走到**最后一页**(键盘输入那一页)。
3. 页面最上面有一个开关:**「浏览器复制修复」** —— 和 Mac 上的「Safari 复制修复」
   **长得一模一样**。
4. 点「开启」。
5. 如果 Chrome / Edge **正开着** ⇒ 关掉再打开一次(**浏览器只在启动时读那份扩展清单**,
   这是浏览器的机制,绕不过去)。
   如果浏览器没开 ⇒ 下次打开就生效。

之后:网页上复制出来的就是**明文**(不再是密文)。

**关掉**:把那个开关拨回「关闭」即可(程序会把浏览器里的登记撤掉)。

**扩展在哪**

| 你拿到的东西 | 扩展在哪 |
| --- | --- |
| 安装包(Tauri / Electron 任一) | **程序自己知道**(安装目录下的 `browser-extension/`) |
| 桌面交付包 `模拟输入-Windows-全部.zip` | 解压后目录里的 `browser-extension/` 文件夹(同上,程序用的就是它) |
| 只下了 `.exe`(GitHub release) | release 页面上的 `browser-extension-chromium.zip`(同上) |

**要不要开「开发者模式」?** **不要**。
程序走的是浏览器的「外部扩展」机制(注册表 `HKCU`),装进去的扩展是正常扩展,
不需要开发者模式,也不会在浏览器里报警告。

**怎么确认装上了**

- 打开 `chrome://extensions`(Edge 是 `edge://extensions`),
  扩展列表里应能看到「Copy Repair 复制修复」,来源标着「由外部程序安装」。
- 程序里那个开关的状态文字应是「**已接管**」;
  如果是「已开启」但没接管,下面会有一行**失败原因**(比如「安装包里找不到扩展」)。

**出问题了看这里** → `docs/05-运维/故障排查.md` 的
「浏览器修复开关拨了没用」那一节。

---

## 1. 准备构建产物(开发者)

在仓库根目录执行：

```bash
npm install
node tools/build.mjs chromium
```

产物目录：`dist-core/chromium/`

```
dist-core/chromium/
├── manifest.json
├── background.js
├── content-isolated.js
├── content-main.js
└── assets/glyph-db.crdb.gz     # 参考字形库（随扩展打包，不联网）
```

> Windows 上如果 npm 安装 puppeteer 失败，可跳过：`npm install --omit=optional`
> 或设置 `PUPPETEER_SKIP_DOWNLOAD=1`，扩展构建本身不需要 puppeteer。

## 2. 手动加载扩展(开发者用;产品用户**不需要**这一步)

> 正常用户走第 0 节的开关就行。这一节是给**调试**用的:
> 想在**不装桌面程序**的情况下单独试扩展时用。

### Chrome

1. 地址栏输入 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选择 `dist-core/chromium` 目录（**选目录本身**，不要进到里面选文件）

### Edge

1. 地址栏输入 `edge://extensions/`
2. 左下角打开「开发人员模式」
3. 点「加载解压缩的扩展」
4. 选择 `dist-core/chromium` 目录

> ⚠️ 手动加载的扩展 **ID 与自动注册那个不一样**（自动注册那个由 manifest 的 `key`
> 字段固定 ⇒ 每台机器、每个目录都一样;手动加载的那个按路径算 ⇒ 挪了目录就变）。
> 两者**不要同时开**,否则会看到两个同名扩展。

## 3. 确认已生效

1. 打开任意网页，扩展图标出现在工具栏（可点开详情确认「网站访问」为「在所有网站上」）。
2. 扩展在**浏览器启动后自动生效**，无需手动开启。
3. 权限说明：
   - 只申请了 `storage`（用于缓存映射）与内容脚本的 `<all_urls>` 注入
   - **没有**申请任何主机权限（host permissions），不会读取网页内容或联网
   - 所有分析在本地完成，不上传复制内容、字体或浏览记录

## 4. 自测

仓库自带测试页，起一个本地服务后访问：

```bash
node -e "import('./tests/e2e/server.mjs').then(async m=>{const s=await m.startServer(process.cwd());console.log(s.origin)})"
```

然后打开 `http://127.0.0.1:<端口>/tests/fixtures/c-font-obfuscation.html`，
选中那段文字按 `Ctrl+C`，粘贴出来的应是 **人工智能正在改变世界科技**（页面上显示的那句），
而不是底层乱码。

| 测试页 | 预期 |
| --- | --- |
| `a-normal.html` | 与原生复制完全一致 |
| `b-tamper.html` | 复制出原文，不含 `TAMPERED-GARBAGE` |
| `c-font-obfuscation.html` | 复制出可见文字 |
| `d-dynamic-font.html` | 换字体后自动失效并重新还原 |
| `e-mixed-font.html` | 逐段还原，正常文字不动 |
| `f-complex-dom.html` | 嵌套/跨节点/动态插入都正确，隐藏内容不出现 |

> 这六条也有自动化用例:`npm run test:e2e`(需要真实 Chrome + 系统剪贴板,
> 所以**只能在 macOS 上跑**;Windows CI 上跑不了 ⇒ 那边靠静态门禁)。

## 5. 卸载

- 程序里把「浏览器复制修复」开关拨回「关闭」⇒ 程序会撤掉浏览器的登记。
- 手动加载的扩展:Chrome / Edge 扩展管理页 →「移除」
- 本地构建目录可直接删除 `dist-core/chromium`
