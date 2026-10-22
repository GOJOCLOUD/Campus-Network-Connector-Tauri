# macOS · Chrome / Edge 安装指南

适用：macOS 上的 Google Chrome 与 Microsoft Edge（Chromium 内核）。

---

## 1. 准备构建产物

```bash
npm install
node tools/build.mjs chromium
```

产物目录：`dist-core/chromium/`（与 Windows 完全相同，同一份构建产物）。

## 2. 加载扩展

### Chrome

1. 地址栏输入 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选择 `dist-core/chromium` 目录

### Edge

1. 地址栏输入 `edge://extensions/`
2. 左下角打开「开发人员模式」
3. 点「加载解压缩的扩展」
4. 选择 `dist-core/chromium` 目录

> 若扩展目录被移动过，在扩展详情页点「移除」后重新加载即可。

## 3. 确认已生效

- 扩展随浏览器启动自动生效，不需要手动开启。
- 快捷键是 `Cmd+C`；浏览器右键菜单里的「拷贝」同样走 copy 事件，行为一致。
- 权限：
  - `storage`（缓存映射）+ 内容脚本 `<all_urls>` 注入
  - **没有**主机权限，不联网、不读取网页内容
  - 复制内容、字体文件、浏览记录一律不出本机

## 4. 自测

```bash
node -e "import('./tests/e2e/server.mjs').then(async m=>{const s=await m.startServer(process.cwd());console.log(s.origin)})"
```

打开 `http://127.0.0.1:<端口>/tests/fixtures/c-font-obfuscation.html`，
选中文字按 `Cmd+C`，粘贴结果应为 **人工智能正在改变世界科技**。

也可以直接跑自动化验证（会打开一个真实的 Chrome 窗口并读写系统剪贴板）：

```bash
node tools/build.mjs chromium
node --test tests/e2e/copy-repair.test.ts
```

## 5. 注意事项（macOS 特有）

- **Cmd+C 是系统原生菜单动作**：自动化工具用合成按键无法触发它，
  本仓库的 e2e 改用 CDP 的编辑命令通道 `Input.dispatchKeyEvent{commands:['copy']}`，
  走的是同一条真实复制路径。
- **headless 模式不提交 copy 事件的 clipboardData 改写**，
  所以"复制结果是否正确"必须在有头模式下核对系统剪贴板（`osascript -e 'the clipboard as text'`）。
- 系统剪贴板内容用 `pbpaste` 读取时，默认按系统区域设置输出（本机为 GBK），
  会看到乱码；用 `pbpaste -Prefer txt` 或 `osascript` 读取才是 UTF-8。
