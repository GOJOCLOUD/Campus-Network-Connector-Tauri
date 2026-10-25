/**
 * Tauri 桥接层：让**同一份 React 界面**在 Electron 和 Tauri 两边都能跑。
 *
 * 背景：Electron 版通过 preload 暴露 `window.cnc`（IPC）；Tauri 版走 `invoke`。
 * 界面代码只认 `window.cnc`，所以这里在 Tauri 环境下补一个同形状的 `window.cnc`，
 * 把每个方法映射到对应的 Tauri 命令。
 *
 * 在 Electron 下这个文件是**空操作**（window.cnc 已由 preload 提供，直接跳过）。
 *
 * ⚠️ 这里**不允许**再留"空实现/占位"的接口：
 * 每个方法要么真接到一条 Rust 命令，要么整个不暴露。
 * 曾经这里有一批 `notImplemented()` 兜底，界面看起来正常、点下去毫无反应
 * —— 那正是"Tauri 版功能基本都没有"的来源（见 ADR-0012）。
 */

function installTauriBridge() {
  // Electron：preload 已经提供了 window.cnc
  if (window.cnc) return
  const tauri = window.__TAURI__
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return

  const invoke = (cmd, ...args) => tauri.core.invoke(cmd, ...args)

  // Tauri 与 Electron **用完全相同的 CSS 变量**(--panel-max / --panel-pad),
  // 两个壳的窗口几何、卡片位置、投影留白必须一模一样,不再各搞一套。
  // Tauri 窗口本身是透明的(和 Electron 一样),白底只由卡片提供 → 没有"外圈"。

  // 拖动窗口:**只用 Tauri 原生机制**(`data-tauri-drag-region` → startDragging)。
  //
  // 之前这里自己实现了一套 setPosition 拖拽,结果和 macOS 原生标题栏拖拽区
  // **两套机制同时生效、互相抵消**:慢拖时窗口像是不动,快滑时又叠加成
  // "闪一下、闪到屏幕最外沿"。原生那套是操作系统级的,跟鼠标严格同步,不会跳。
  //
  // 唯一前提:窗口要是 key window(否则 performDragOperation 直接失效)。
  // 启动时已 set_focus();这里再记一次"按下瞬间的焦点态",好核对。
  //
  // 另外**不要**再引入鼠标穿透(ignoresMouseEvents):它一开,窗口连原生
  // 红绿灯都不响应,而且高频切换会把主线程打满(整个应用卡顿)。
  const tauriWindow = () => window.__TAURI__.window.getCurrentWindow()
  let lastDragProbe = null
  window.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return
      const el = e.target && e.target.closest ? e.target.closest('[data-tauri-drag-region]') : null
      if (!el) return
      if (el.getAttribute('data-tauri-drag-region') === 'false') return
      tauriWindow()
        .isFocused()
        .then((focused) => { lastDragProbe = { focused: !!focused, at: Date.now() } })
        .catch(() => { lastDragProbe = { focused: null, at: Date.now() } })
    },
    true,
  )

  // 运行时自检:把"到底生效没有"写成事实,而不是靠猜。
  // 持续刷新 —— Safari 修复这类后台逻辑的错误是**几秒后才发生**的,
  // 只写启动那一刻的快照看不到任何东西。
  const writeDiag = async () => {
    const card = document.querySelector('.rounded-4xl')
    const rect = card ? card.getBoundingClientRect() : null
    const cardCs = card ? getComputedStyle(card) : null
    // 顶部留白(pt-10)给原生红绿灯 —— 和 Electron 版同一套写法。
    // 注意要量的是 **App 的根容器**(`#root` 的第一个子元素),不是 `#root` 本身
    // —— `#root` 只是挂载点,边距在 App 那个 div 上。
    const rootEl = document.getElementById('root')
    const appRoot = rootEl && rootEl.firstElementChild
    const rootCs = appRoot ? getComputedStyle(appRoot) : null
    // 内容区(卡片里那个可滚动的容器):**内容比可视区高 = 有功能被藏进滚动条了**
    const scroller = card
      ? [...card.querySelectorAll('div')].find((d) => getComputedStyle(d).overflowY === 'auto')
      : null
    const contentMetrics = scroller
      ? {
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        clipped: scroller.scrollHeight > scroller.clientHeight + 1,
      }
      : null
    // 录制文件清单:老用户从 Electron 版迁过来的文件**也该出现在这里**
    // (两个版本的数据目录天生不同,不迁就会"自己的录制文件全没了")。
    let recordingFiles = null
    try {
      recordingFiles = await window.cnc?.listFiles?.()
    } catch (e) {
      recordingFiles = null
    }
    // 剪贴板:接口有没有被接到原生实现上、原生读得到东西吗。
    // **只探一次** —— 每 3 秒读一次剪贴板既浪费也不礼貌。
    if (!window.__clipboardProbed) {
      window.__clipboardProbed = true
      try {
        const t = await invoke('clipboard_read_text')
        window.__clipboardProbe = {
          patched: !!window.__clipboardPatched,
          nativeLength: typeof t === 'string' ? t.length : null,
        }
      } catch (e) {
        window.__clipboardProbe = { patched: !!window.__clipboardPatched, nativeLength: null }
      }
    }
    try {
      // 原生模块状态:顺手探一下**新命令**能不能从界面这一侧调通。
      // (命令没注册 / 名字对不上 → 这里会记下错误,而不是界面上一片空白)
      let nativeStatus = null
      let nativeStatusError = ''
      try {
        nativeStatus = await invoke('get_native_status')
      } catch (e) {
        nativeStatusError = String(e?.message || e || '调用失败')
      }
      // 拖拽探针:按下拖拽区时窗口是不是 key window(原生拖拽的前提)
      const dragProbe = { last: lastDragProbe, note: '原生拖拽 data-tauri-drag-region' }
      await invoke('diag_report', {
        info: {
          hasTauriGlobal: typeof window.__TAURI__ !== 'undefined',
          hasTauriCore: !!(window.__TAURI__ && window.__TAURI__.core),
          hasInvoke: typeof (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) === 'function',
          hasCnc: typeof window.cnc !== 'undefined' && !!window.cnc,
          nativeStatus: nativeStatus,
          nativeStatusError: nativeStatusError,
          // 卡片用的是哪套类名 —— 用来跟 Electron 版逐字对账
          cardClass: card ? (typeof card.className === 'string' ? card.className : '') : null,
          rootPadTop: rootCs ? rootCs.paddingTop : null,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          // 窗口在屏幕上的位置与尺寸 —— 和原生侧的「排除矩形」对账用。
          // (录制时点自己界面上的按钮不算一次点击,靠的就是那个矩形。)
          windowRect: {
            screenX: window.screenX,
            screenY: window.screenY,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
          },
          cardRect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
          // 白圈判定:卡片与窗口四边的间隙
          ringLeft: rect ? Math.round(rect.x) : null,
          ringRight: rect ? Math.round(window.innerWidth - (rect.x + rect.width)) : null,
          ringTop: rect ? Math.round(rect.y) : null,
          ringBottom: rect ? Math.round(window.innerHeight - (rect.y + rect.height)) : null,
          cardBg: cardCs ? cardCs.backgroundColor : null,
          cardRadius: cardCs ? cardCs.borderRadius : null,
          cardBorder: cardCs ? cardCs.borderTopWidth + ' ' + cardCs.borderTopStyle : null,
          cardShadow: cardCs ? cardCs.boxShadow : null,
          contentMetrics: contentMetrics,
          recordingFiles: recordingFiles,
          clipboard: window.__clipboardProbe || null,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          rootBg: getComputedStyle(document.getElementById('root')).backgroundColor,
          dragProbe: dragProbe,
        }
      })
    } catch (e) {
      console.warn('[diag] 上报失败', e)
    }
  }
  writeDiag()
  setInterval(writeDiag, 3000)

  // ── 窗口贴合内容 ───────────────────────────────────────────────
  // 窗口不该比"看得见的白色面板"大一大圈:多出来的那圈虽然透明,但
  // **照样吃鼠标事件**(macOS 的透明窗口整块矩形都收事件),下面的 App
  // 就点不动了,还白占着桌面。
  //
  // 高度以**卡片底边**为准(不是窗口高度,也不是根容器高度):卡片是内容高度,
  // 与窗口高度无关,所以收窗口不会引发"收窄→测量变→再收窄"的抖动。
  // 宽度不动 —— 卡片宽度是定死的,动宽度会互相追着跑。
  //
  // ⚠️ 卡片是 **React 渲染出来的**,而本文件是在 `main.jsx` 里 import 时
  // 同步执行的 —— 那时 `createRoot().render()` 还没跑,卡片**根本不存在**。
  // 之前就是在这里直接 querySelector 一次,拿到 null,observer 再也没挂上,
  // 结果:窗口只在启动那两次 setTimeout 里被动过一次,之后**永远不跟内容**,
  // 换页时内容超出窗口就被根容器的 overflow-hidden **横切一刀**。
  // 现在改成:卡片一出现就挂上,元素被换掉(整个 Stepper 重挂)就重新挂。
  const CARD_SELECTOR = '.rounded-4xl'
  const fitWindow = async () => {
    const card = document.querySelector(CARD_SELECTOR)
    if (!card) return
    const rect = card.getBoundingClientRect()
    if (!rect || !rect.height) return
    // 卡片底边 + 下边距 + 一点余量(卡片的 shadow-md 往下扩约 6px,
    // 不留余量的话阴影会被窗口边缘硬切,面板看着像"被剪过")。
    const want = Math.ceil(rect.bottom + 16)
    try {
      await invoke('window_fit_to_content', { height: want })
    } catch (e) {
      // 收窗口失败不该影响界面:只记一笔
      console.warn('[fit] 窗口贴合失败', e)
    }
  }
  // 卡片尺寸变了(换步骤、文本变多、窗口被用户改过)都要重新贴合
  if (typeof ResizeObserver === 'function') {
    let pending = 0
    const schedule = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        fitWindow()
      })
    }
    const observer = new ResizeObserver(schedule)
    let observedCard = null
    const attach = () => {
      const card = document.querySelector(CARD_SELECTOR)
      if (!card || card === observedCard) return
      if (observedCard) observer.unobserve(observedCard)
      observer.observe(card)
      observedCard = card
      schedule()
    }
    // 卡片出现 / 被替换都能被发现(换激活态会让整个 Stepper 重挂)
    const watcher = new MutationObserver(attach)
    watcher.observe(document.documentElement, { childList: true, subtree: true })
    attach()
    window.addEventListener('resize', schedule)
  }
  // 首帧之后也贴合一次:首帧时卡片可能还没量出高度
  setTimeout(fitWindow, 60)
  setTimeout(fitWindow, 400)

  // 平台标识:界面上 `cnc.platform` 在模块加载时就被同步读取
  // (isMac / isWindows 是模块级常量),而 Tauri 的 IPC 是异步的,
  // 没法等一次 invoke 再赋值 —— 所以这里用 WebView 的 UA 判断:
  // Windows 上的 WebView2 必带 "Windows NT",macOS 的 WKWebView 必带 "Macintosh"。
  const ua = navigator.userAgent || ''
  const platform = /Windows/i.test(ua)
    ? 'win32'
    : (/Macintosh|Mac OS X/i.test(ua) ? 'darwin' : 'darwin')

  // ── 剪贴板 API:接到原生的 NSPasteboard 上 ──────────────────────
  //
  // 界面里两处用的是**浏览器**的剪贴板 API(Electron 版逐字搬过来的):
  //   · ⌃⇧D 剪贴板直入 → navigator.clipboard.readText()
  //   · 「复制 UUID」    → navigator.clipboard.writeText()
  // Electron 里这两个是能用的;**WKWebView 里不可靠** —— 读要么直接失败,
  // 要么每次弹「允许粘贴」,于是窗口内那条 ⌃⇧D 就"按了没反应"。
  //
  // 这里把浏览器 API 换成原生实现(NSPasteboard / NSPasteboardTypeString):
  // **界面代码一个字都不用改**(与 Electron 逐字相同,见 ADR-0013),
  // 行为也回到 Electron 那边"静默读/写系统剪贴板"的样子。
  //
  // Windows 不装这个补丁:那边原生读剪贴板还没实现,
  // 浏览器 API 留着反而能用(WebView2 的行为和 Electron 一致)。
  if (platform === 'darwin') {
    try {
      const nativeClipboard = {
        readText: async () => {
          const t = await invoke('clipboard_read_text')
          return typeof t === 'string' ? t : ''
        },
        writeText: async (text) => {
          await invoke('clipboard_write_text', { text: String(text ?? '') })
        },
      }
      if (!navigator.clipboard) {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: nativeClipboard,
        })
      } else {
        // 已有 clipboard 对象:把两个方法换成原生的
        Object.defineProperty(navigator.clipboard, 'readText', {
          configurable: true,
          value: nativeClipboard.readText,
        })
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: nativeClipboard.writeText,
        })
      }
      window.__clipboardPatched = true
    } catch (e) {
      console.warn('[clipboard] 接管剪贴板 API 失败', e)
    }
  }

  window.cnc = {
    // Clipboard（macOS 走 NSPasteboard；Windows 暂未实现，界面不会崩）
    clipboardReadText: () => invoke('clipboard_read_text').catch(() => ''),

    // Window
    platform: platform,
    quit: () => invoke('window_quit'),
    minimize: () => invoke('window_minimize'),
    maximize: () => invoke('window_maximize'),
    // 窗口贴合内容(见上面 fitWindow 的说明)
    fitWindowToContent: () => fitWindow(),
    // 打开「系统设置 → 隐私与安全性 → 辅助功能」
    openAccessibilitySettings: () => invoke('open_accessibility_settings'),

    // Activation
    getActivationSnapshot: () => invoke('get_activation_snapshot'),
    startTrial: (expiresAt) => invoke('start_trial', { expiresAt }),
    saveLicense: (license) => invoke('save_license', { license }),
    clearLicense: () => invoke('clear_license'),
    migrateLegacyActivation: (legacy) => invoke('migrate_legacy_activation', { legacy }),

    // Mouse
    mouseClick: (x, y) => invoke('mouse_click', { x, y }),
    mouseGetPosition: () => invoke('mouse_get_position'),

    // Keyboard
    sendText: (text) => invoke('send_text', { text }),
    sendKey: (keyCode, flags) => invoke('send_key', { keyCode, flags }),

    // Input source
    getInputSource: () => invoke('get_current_input_source'),
    selectInputSource: (sourceId) => invoke('select_input_source', { sourceId }),
    getInputSourceConfig: () => invoke('get_settings'),
    saveInputSourceConfig: (config) => invoke('set_settings', { patch: config }),
    // 把**当前**输入源记成某个角色(ascii / pinyin)的 id。
    // Electron 版是主进程一条命令干完的(读当前输入源 → 写配置);
    // Tauri 版这两步本来就有对应命令,这里在桥接层拼起来,语义完全一致。
    setCurrentAsInputSource: async (role) => {
      try {
        // 返回的是 `{ id, name, isASCII }`(与 Electron 版原生模块同形状),
        // 要的是里面的 id。
        const current = await invoke('get_current_input_source');
        const currentId = current && current.id ? current.id : '';
        if (!currentId) return { status: 'error', message: '无法读取当前输入源 ID' };
        const cfg = (await invoke('get_settings')) || {};
        if (role === 'ascii') cfg.ascii_id = currentId;
        else if (role === 'pinyin') cfg.pinyin_id = currentId;
        else return { status: 'error', message: '未知角色' };
        await invoke('set_settings', {
          patch: { ascii_id: cfg.ascii_id || '', pinyin_id: cfg.pinyin_id || '' },
        });
        return { status: 'success', message: '已保存', ...cfg };
      } catch (e) {
        return { status: 'error', message: String(e?.message || e || '保存失败') };
      }
    },

    // Recording(CGEventTap,macOS 专有;Windows 线按 ADR-0012 不做录制)
    //
    // 「点自己界面上的按钮不算一次点击」由**原生层**负责:排除矩形用原生
    // 窗口位置算,并且在窗口每次移动/变高时刷新(见 native/recording.rs)。
    // 所以这里**不传**矩形 —— 前端那份 `window.screenX` 只是开始录制时的
    // 一张快照,窗口一动就过期了(点「结束」会被记成一次点击)。
    startRecording: async () => {
      try {
        const ok = await invoke('start_recording');
        return ok === true;
      } catch (e) {
        // Electron 版主进程失败时返回 {error: msg},界面按这个形状显示
        return { error: String(e?.message || e || '启动失败') };
      }
    },
    stopRecording: async () => {
      try {
        // 命令直接返回已录到的点击(停止那一刻录到的最后一次点击只有这里拿得到)
        const clicks = await invoke('stop_recording');
        return Array.isArray(clicks) ? clicks : [];
      } catch (_) {
        // null = 失败。界面据此**保留**原来的记录,不清空。
        return null;
      }
    },
    getRecordingClicks: () => invoke('get_recording_clicks').catch(() => []),
    clearRecordingClicks: () => invoke('clear_recording_clicks').catch(() => false),
    // 删掉第 index 次点击(单条删除)
    removeRecordingClick: (index) => invoke('remove_recording_click', { index }).catch(() => false),
    isRecording: () => invoke('is_recording').catch(() => false),
    tapFailed: () => invoke('tap_failed').catch(() => false),

    // File management
    listFiles: () => invoke('list_files'),
    saveFile: (clicks, filename) => invoke('save_file', { clicks, filename }),
    renameFile: (oldName, newName) => invoke('rename_file', { oldName, newName }),
    deleteFile: (filename) => invoke('delete_file', { filename }),
    readFile: (filename) => invoke('read_file', { filename }),

    // Playback(回放)
    // Electron 版的 play:playFile / play:playData 失败时返回 {status:'error', message},
    // 界面按这个形状显示原因 —— 这里保持一致,别让 Promise 直接 reject
    // (界面那两处只有 .then,没有 .catch,reject 了用户就什么都看不到)。
    playFile: async (fileName, interval, inputText) => {
      try {
        return await invoke('play_file', { fileName, interval, inputText });
      } catch (e) {
        return { status: 'error', message: String(e?.message || e || '执行失败') };
      }
    },
    playData: async (clicks, interval) => {
      try {
        return await invoke('play_data', { clicks, interval });
      } catch (e) {
        return { status: 'error', message: String(e?.message || e || '执行失败') };
      }
    },
    // 拼音自动键入：与 Electron 版 pinyinType 同流程 ——
    // 可选切到 ASCII 输入源 → 等 delaySeconds → 逐字键入
    pinyinInput: async (text, delaySeconds, autoSwitchIme) => {
      const value = text || '';
      if (!value) return { status: 'success', message: '没有要输入的内容' };
      if (autoSwitchIme) {
        try {
          const cfg = await invoke('get_settings');
          const asciiId = cfg && cfg.ascii_id;
          if (asciiId) await invoke('select_input_source', { sourceId: asciiId });
        } catch (_) {
          /* 切不动就按当前输入源继续 */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      // `??` 不是 `||`:**显式传 0 就是"不要等"**,不能被当成"没传"。
      // (旧写法 `delaySeconds || 3` 把 0 当成假值 ⇒ 明明要立刻键入,却等了 3 秒;
      //  Electron 那边是 `if (delaySeconds > 0)` ⇒ 传 0 就是立刻。
      //  两边因此对"立刻键入"的处理不一致,这里按 Electron 的口径改成 `??`。)
      const wait = Math.max(0, Number(delaySeconds ?? 3)) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      await invoke('send_text', { text: value });
      return { status: 'success', message: `将在 ${delaySeconds ?? 3} 秒后开始输入` };
    },

    // Settings
    settings: {
      setSelectedJson: (fileName) => invoke('set_settings', { patch: { selectedJson: fileName } }),
      getSelectedJson: async () => {
        const s = await invoke('get_settings')
        return (s && s.selectedJson) || ''
      },
      setPinyinText: (text) => invoke('set_settings', { patch: { pinyinText: text } }),
      setPinyinSources: (sources) => invoke('set_settings', { patch: { pinyinSources: sources } }),
      setAutoSwitchIme: (enabled) => invoke('set_settings', { patch: { autoSwitchIme: enabled } }),
    },

    // Keepalive(每 3 分钟一次 HTTPS 保活;Windows 线按 ADR-0012 不做)
    getKeepaliveStatus: () => invoke('keepalive_get_status').catch(() => false),
    setKeepaliveEnabled: (enabled) =>
      invoke('keepalive_set_enabled', { enabled: !!enabled }).catch(() => false),

    // 原生模块状态
    getNativeStatus: () => invoke('get_native_status'),

    // 功能模块
    getFeatures: () => invoke('get_features'),
    getFeatureStatus: (prefix) => invoke('get_feature_status', { prefix }),
    // setFeatureEnabled = 只改运行态;setFeatureEnabledSetting = 只落盘。
    // 界面两个都调(Electron 版同口径),合起来才是"立刻生效且下次还在"。
    setFeatureEnabled: (prefix, enabled) => invoke('set_feature_enabled', { prefix, enabled }),
    setFeatureEnabledSetting: (prefix, enabled) =>
      invoke('set_feature_enabled_setting', { prefix, enabled }),

    // Safari 复制修复
    safariRepair: {
      getStatus: () => invoke('safari_repair_get_status'),
      setEnabled: (enabled) => invoke('safari_repair_set_enabled', { enabled }),
      setEnabledSetting: (enabled) => invoke('safari_repair_set_enabled_setting', { enabled }),
      checkNow: () => invoke('safari_repair_check_now'),
    },
  }
}

installTauriBridge()

export default installTauriBridge
