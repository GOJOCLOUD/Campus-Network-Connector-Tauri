# Windows 11 · Chrome / Edge 安装指南

适用：Windows 11 上的 Google Chrome 与 Microsoft Edge（两者都是 Chromium 内核，装法一致）。

---

## 1. 准备构建产物

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

## 2. 加载扩展

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

## 5. 卸载

- Chrome / Edge：扩展管理页 →「移除」
- 本地构建目录可直接删除 `dist-core/chromium`
