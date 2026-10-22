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

  window.cnc = {
    // Clipboard（Tauri 版暂未接剪贴板，先给空串，界面不会崩）
    clipboardReadText: notImplemented('clipboardReadText'),

    // Window
    platform: 'darwin',
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
    pinyinInput: notImplemented('pinyinInput'),

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
