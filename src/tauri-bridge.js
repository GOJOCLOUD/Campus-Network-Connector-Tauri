/**
 * Tauri 桥接层：让**同一份 React 界面**在 Electron 和 Tauri 两边都能跑。
 *
 * 背景：Electron 版通过 preload 暴露 `window.cnc`（IPC）；Tauri 版走 `invoke`。
 * 界面代码只认 `window.cnc`，所以这里在 Tauri 环境下补一个同形状的 `window.cnc`，
 * 把每个方法映射到对应的 Tauri 命令。
 *
 * 在 Electron 下这个文件是**空操作**（window.cnc 已由 preload 提供，直接跳过）。
 */

/** 命令没实现时的统一兜底：不让界面崩，只是不生效。 */
function notImplemented(name) {
  return async () => {
    console.warn(`[tauri-bridge] 该功能在 Tauri 版尚未实现: ${name}`)
    return null
  }
}

function installTauriBridge() {
  // Electron：preload 已经提供了 window.cnc
  if (window.cnc) return
  const tauri = window.__TAURI__
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return

  const invoke = (cmd, ...args) => tauri.core.invoke(cmd, ...args)

  // Tauri 与 Electron **用完全相同的 CSS 变量**(--panel-max / --panel-pad),
  // 两个壳的窗口几何、卡片位置、投影留白必须一模一样,不再各搞一套。
  // Tauri 窗口本身是透明的(和 Electron 一样),白底只由卡片提供 → 没有"外圈"。

  // 拖动窗口。
  //
  // 用 Tauri 自带的 data-tauri-drag-region 不行:它走 NSWindow.performDragOperation,
  // 窗口不是 key window 时会**直接失效**(表现就是"拖不动")。
  // 这里自己算:按下时记下鼠标屏幕位置和窗口位置,移动时把差值 setPosition 回去。
  // 窗口跟着鼠标等量移动,所以光标相对窗口的位置恒定,不会拖出窗口外丢失事件 ——
  // 行为与 Electron 的原生拖拽一致。
  //
  // 注意:**不要**再引入"鼠标穿透"(ignoresMouseEvents):它一开,窗口连原生
  // 红绿灯都不响应,而且高频切换会把主线程打满(表现为整个应用卡顿)。
  const tauriWindow = () => window.__TAURI__.window.getCurrentWindow()

  // 移动窗口。
  //
  // 注意参数形状:setPosition 收的是 **LogicalPosition 实例**,不是普通对象。
  // 传普通对象会被 JS 侧包成 Position 时丢掉 type 字段,序列化出
  // {"undefined":{x,y}},Rust 反序列化直接报
  // "unknown variant `undefined`, expected `Physical` or `Logical`"。
  const moveWindowTo = (x, y) => {
    const Ctor = window.__TAURI__ && window.__TAURI__.dpi && window.__TAURI__.dpi.LogicalPosition
    if (Ctor) return tauriWindow().setPosition(new Ctor(x, y))
    // 兜底:直接调底层命令,值形状 = { Logical: { x, y } }
    const internals = window.__TAURI_INTERNALS__ || {}
    const label = (internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label) || 'main'
    return window.__TAURI__.core.invoke('plugin:window|set_position', {
      label,
      value: { Logical: { x, y } },
    })
  }

  let drag = null
  // 最近一次实际发出的窗口移动(自检用)
  let lastDragMove = null
  // setPosition 是否被系统接受(权限/调用失败会 reject)
  let lastDragOk = null
  let lastDragErr = null
  const onDragMouseDown = (e) => {
    if (e.button !== 0) return
    const el = e.target && e.target.closest ? e.target.closest('[data-app-drag-region]') : null
    if (!el) return
    // data-app-drag-region="false" 的元素(按钮、步骤圆点)是禁止拖拽的
    if (el.getAttribute('data-app-drag-region') === 'false') return
    e.preventDefault()
    drag = { sx: e.screenX, sy: e.screenY, base: null }
    tauriWindow()
      .outerPosition()
      .then((p) => {
        if (!drag) return
        const scale = window.devicePixelRatio || 1
        drag.base = { x: p.x / scale, y: p.y / scale }
      })
      .catch(() => {})
  }
  const onDragMouseMove = (e) => {
    if (!drag || !drag.base) return
    e.preventDefault()
    const x = Math.round(drag.base.x + (e.screenX - drag.sx))
    const y = Math.round(drag.base.y + (e.screenY - drag.sy))
    lastDragMove = { x, y, dx: e.screenX - drag.sx, dy: e.screenY - drag.sy }
    // 权限不足时 setPosition 会 reject —— 必须把结果记下来,
    // 否则"拖不动"会被一句 catch 吞掉,查起来全靠猜。
    Promise.resolve(moveWindowTo(x, y))
      .then(() => { lastDragOk = true })
      .catch((err) => {
        lastDragOk = false
        lastDragErr = String((err && err.message) || err)
      })
  }
  const onDragMouseUp = () => {
    drag = null
  }
  // 监听挂在 window 上:真实鼠标事件的传播路径末端就是 window,
  // 而直接派发到 window 的事件不会经过 document —— 挂 document 会漏掉。
  window.addEventListener('mousedown', onDragMouseDown, true)
  window.addEventListener('mousemove', onDragMouseMove, true)
  window.addEventListener('mouseup', onDragMouseUp, true)


  // 运行时自检:把"到底生效没有"写成事实,而不是靠猜。
  // 持续刷新 —— Safari 修复这类后台逻辑的错误是**几秒后才发生**的,
  // 只写启动那一刻的快照看不到任何东西。
  const writeDiag = async () => {
    const cs = getComputedStyle(document.documentElement)
    const card = document.querySelector('[data-panel-probe]')
    const rect = card ? card.getBoundingClientRect() : null
    const cardCs = card ? getComputedStyle(card) : null
    const strip = document.querySelector('[data-app-drag-region]')
    const stripRect = strip ? strip.getBoundingClientRect() : null
    try {
      // 拖拽链路自检:合成一次"零位移"拖拽 —— 事件 → outerPosition → setPosition
      // 整条链路必须真的跑通,否则就是"拖不动"。位移取 0,窗口不会挪动。
      let dragProbe = { attempted: false, moveIssued: false, error: null }
      try {
        const stripEl = document.querySelector('[data-app-drag-region]')
        if (stripEl) {
          dragProbe.attempted = true
          const r = stripEl.getBoundingClientRect()
          const sx = 200
          const sy = 200
          stripEl.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, button: 0,
            screenX: sx, screenY: sy, clientX: r.left + 4, clientY: r.top + 4,
          }))
          // 等 outerPosition() 回来(base 要先就位)
          await new Promise((res) => setTimeout(res, 200))
          dragProbe.baseReady = !!(drag && drag.base)
          // 真实位移 6px:回读窗口位置,确认"窗口确实动了",而不只是命令发出去
          document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, cancelable: true, button: 0, screenX: sx + 6, screenY: sy + 4,
          }))
          await new Promise((res) => setTimeout(res, 250))
          const after = await tauriWindow().outerPosition().catch(() => null)
          const scale = window.devicePixelRatio || 1
          dragProbe.actualPos = after ? { x: Math.round(after.x / scale), y: Math.round(after.y / scale) } : null
          document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, cancelable: true, button: 0, screenX: sx + 6, screenY: sy + 4,
          }))
          dragProbe.moveIssued = !!lastDragMove
          dragProbe.lastMove = lastDragMove
          dragProbe.setPositionOk = lastDragOk
          dragProbe.setPositionError = lastDragErr
          if (dragProbe.actualPos && lastDragMove) {
            dragProbe.movedAsExpected =
              Math.abs(dragProbe.actualPos.x - lastDragMove.x) <= 2 &&
              Math.abs(dragProbe.actualPos.y - lastDragMove.y) <= 2
          }
        }
      } catch (e) {
        dragProbe.error = String((e && e.message) || e)
      }
      await invoke('diag_report', {
        info: {
          hasTauriGlobal: typeof window.__TAURI__ !== 'undefined',
          hasTauriCore: !!(window.__TAURI__ && window.__TAURI__.core),
          hasInvoke: typeof (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) === 'function',
          hasCnc: typeof window.cnc !== 'undefined' && !!window.cnc,
          panelMax: cs.getPropertyValue('--panel-max').trim(),
          panelPad: cs.getPropertyValue('--panel-pad').trim(),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          cardRect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
          stripRect: stripRect ? { x: Math.round(stripRect.x), y: Math.round(stripRect.y), w: Math.round(stripRect.width), h: Math.round(stripRect.height) } : null,
          // 白圈判定:卡片与窗口四边的间隙
          ringLeft: rect ? Math.round(rect.x) : null,
          ringRight: rect ? Math.round(window.innerWidth - (rect.x + rect.width)) : null,
          ringTop: rect ? Math.round(rect.y) : null,
          ringBottom: rect ? Math.round(window.innerHeight - (rect.y + rect.height)) : null,
          cardBg: cardCs ? cardCs.backgroundColor : null,
          cardRadius: cardCs ? cardCs.borderRadius : null,
          cardBorder: cardCs ? cardCs.borderTopWidth + ' ' + cardCs.borderTopStyle : null,
          cardShadow: cardCs ? cardCs.boxShadow : null,
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

  // 平台标识:界面上 `cnc.platform` 在模块加载时就被同步读取
  // (isMac / isWindows 是模块级常量),而 Tauri 的 IPC 是异步的,
  // 没法等一次 invoke 再赋值 —— 所以这里用 WebView 的 UA 判断:
  // Windows 上的 WebView2 必带 "Windows NT",macOS 的 WKWebView 必带 "Macintosh"。
  const ua = navigator.userAgent || ''
  const platform = /Windows/i.test(ua)
    ? 'win32'
    : (/Macintosh|Mac OS X/i.test(ua) ? 'darwin' : 'darwin')

  window.cnc = {
    // Clipboard（macOS 走 NSPasteboard；Windows 暂未实现，界面不会崩）
    clipboardReadText: () => invoke('clipboard_read_text').catch(() => ''),

    // Window
    platform: platform,
    quit: () => invoke('window_quit'),
    minimize: () => invoke('window_minimize'),
    maximize: () => invoke('window_maximize'),

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
    setCurrentAsInputSource: notImplemented('setCurrentAsInputSource'),

    // Recording（Tauri 版暂未移植事件监听录制）
    startRecording: notImplemented('startRecording'),
    stopRecording: notImplemented('stopRecording'),
    getRecordingClicks: async () => [],
    clearRecordingClicks: notImplemented('clearRecordingClicks'),
    isRecording: async () => false,
    tapFailed: notImplemented('tapFailed'),

    // File management
    listFiles: () => invoke('list_files'),
    saveFile: (clicks, filename) => invoke('save_file', { clicks, filename }),
    renameFile: (oldName, newName) => invoke('rename_file', { oldName, newName }),
    deleteFile: (filename) => invoke('delete_file', { filename }),
    readFile: (filename) => invoke('read_file', { filename }),

    // Playback（Tauri 版暂未移植回放）
    playFile: notImplemented('playFile'),
    playData: notImplemented('playData'),
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
      const wait = Math.max(0, Number(delaySeconds || 3)) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      await invoke('send_text', { text: value });
      return { status: 'success', message: `将在 ${delaySeconds || 3} 秒后开始输入` };
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

    // Keepalive（Tauri 版暂未移植）
    getKeepaliveStatus: async () => ({ enabled: false, ok: false }),
    setKeepaliveEnabled: notImplemented('setKeepaliveEnabled'),

    // 原生模块状态
    getNativeStatus: () => invoke('get_native_status'),

    // 功能模块
    getFeatures: () => invoke('get_features'),
    getFeatureStatus: (prefix) => invoke('get_feature_status', { prefix }),
    setFeatureEnabled: (prefix, enabled) => invoke('set_feature_enabled', { prefix, enabled }),
    setFeatureEnabledSetting: (prefix, enabled) => invoke('set_feature_enabled', { prefix, enabled }),

    // Safari 复制修复
    safariRepair: {
      getStatus: () => invoke('safari_repair_get_status'),
      setEnabled: (enabled) => invoke('safari_repair_set_enabled', { enabled }),
      setEnabledSetting: (enabled) => invoke('safari_repair_set_enabled', { enabled }),
      checkNow: () => invoke('safari_repair_check_now'),
    },
  }
}

installTauriBridge()

export default installTauriBridge
