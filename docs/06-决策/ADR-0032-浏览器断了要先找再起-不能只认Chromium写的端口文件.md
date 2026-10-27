# ADR-0032:浏览器断了要**先找**再起 —— 不能只认 Chromium 自己写的那个端口文件

- 状态:**已定**
- 日期:2026-10-27
- 相关:ADR-0030(Windows 线自起浏览器 + CDP 注入守卫)、ADR-0029(网页字体晚到时必须能重新判定)
- 性质:定下「浏览器连不上时怎么恢复」这条**策略**。
- 谱系:**Electron 仓**的同一条决策是那边的 ADR-0022,两边行为一致。

---

## 一、现象(2026-10-27 真机)

用户在软件自己开的那个 Edge 里用着,突然:

- Edge **每隔约 29 秒自己弹出一个新的空白标签页**,再过一会儿又弹一个;
- 产品日志里「浏览器已就绪」只出现**一次** —— 之后一直在「启动 Edge」;
- 用户后来手动开的标签页里 `guard: undefined` ⇒ **页面守卫没装上**;
- ⇒ 网页上选中题干复制出来,**还是密文**。

## 二、根因链(四步,缺一不可)

1. CDP 的**浏览器级** WebSocket 断了(浏览器没关,只是连接断了);
2. 恢复流程只认一个地方:**Chromium 自己写的 `DevToolsActivePort` 文件**(在 profile 目录里);
3. 但**同一个 profile 的第二个浏览器是「转发启动」**(Chromium 的单例行为):
   - 它**不开自己的调试端口**(命令行里有 `--remote-debugging-port=`,但那个端口没人听);
   - 它**退出时会把 `DevToolsActivePort` 删掉**;
   - 它还会**多开一个空白标签页**;
4. ⇒ 恢复流程**永远找不到**「上次那个还在跑的浏览器」⇒ 只能不停起新的
   ⇒ 每轮 25 秒超时 + 4 秒退避 ≈ **29 秒一个**。

当场量过(不是猜):那一刻 `DevToolsActivePort` 文件**确实不存在**;
而按 `--user-data-dir` 扫进程**能**找出那个还活着的浏览器(端口 61381)并连上去。

⚠️ 后果比「多弹几个标签页」严重得多:新起的**也不等于连上了**
⇒ 用户后来开的标签页**没有守卫** ⇒ 复制必然是密文。

## 三、决策:三条候选,按可靠程度找,全部试过才允许起新的

| 顺序 | 办法 | 为什么排这个位置 |
| --- | --- | --- |
| ① | **自己记的端口**(`profile/simuinput-cdp-port.txt`) | 我们自己起的那台,最可靠;这个文件**只有我们自己写**,转发启动的进程碰不到它 |
| ② | Chromium 写的 `DevToolsActivePort` | 别人起的那个浏览器写的;但**会被转发启动的进程删掉** ⇒ 不可靠 |
| ③ | **扫进程命令行**(`Get-CimInstance Win32_Process` 按 `--user-data-dir` 匹配) | 最后一道兜底:①② 都没有时,至少能**认出**那个还活着的浏览器 |

**三条都试过之前,绝不允许起新的浏览器。**

起新的这一步还多一层兜底:起完发现**自己的调试端口没开** ⇒ 说明这次是「转发启动」
⇒ **改连那个已经在跑的**(把扫出来的端口逐个试),而不是当成失败。

## 四、还有两条配套

1. **错误必须打日志。**
   原来恢复失败只写 `state.lastError` ⇒ 界面上一闪而过、日志里**什么都没有**
   ⇒ 这个 bug 查了半天。改法:协调器的 catch 里补一行 `浏览器修复失败:<原因>`。
2. **断线重连要保住归属。**
   重连到**同一个**浏览器时,「这个浏览器是**我们**起的」这件事要接回去
   ⇒ 退出时仍然由我们关它(那台是我们打开给用户用的),而不是把它变成「来路不明」。

## 五、改动清单

| 位置 | 改动 |
| --- | --- |
| Tauri `tauri-app/src-tauri/src/chromium/browser.rs` | `PORT_FILE` / `read_remembered_port` / `remember_port` / `find_running_ports` / `attach_to_port`;`ensure()` 三段候选顺序;`launch()` 转发兜底;`port()` 访问器 |
| Tauri `tauri-app/src-tauri/tests/cdp_browser_recovery.rs` | **新门禁**:源码层断言 + 真起 Edge、断连、删 `DevToolsActivePort`、再 `ensure()` ⇒ 必须连回同一个 |
| Tauri `.github/workflows/build-tauri-windows.yml` | 门禁接进 CI(跑不过就不发包) |
| Electron `src/features/chromium-repair/browser.js` | **Electron 仓**的同款改造(那边的 ADR-0022) |
| Electron `tools/verify/verify-browser-recovery.cjs` | **Electron 仓**的门禁 |

## 六、验收

- **门禁(Tauri)**: `cargo test --test cdp_browser_recovery`
  ⇒ 源码层(候选顺序必须「先找后起」)+ 真跑(起真 Edge、断连、删 `DevToolsActivePort`、
  再 `ensure()` ⇒ 断言**端口不变**、**那个 profile 下只有一个浏览器进程**)。
- **门禁(Electron)**: `node --test tools/verify/verify-browser-recovery.cjs`
  (Electron 仓那边,本机已跑通 2/2)。
- **真机**:新包装上后复验「长时间挂着不弹标签页 + 复制出来是明文」
  —— 见 `docs/04-测试/测试与验收记录.md`。
