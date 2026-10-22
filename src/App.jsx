import { useMemo, useState, useEffect, useRef } from 'react'
import Stepper, { Step } from './components/Stepper'
import ActivationPanel from './panels/ActivationPanel'
import DefaultExecutePanel from './panels/DefaultExecutePanel'
import ClickPanel from './panels/ClickPanel'
import KeyboardPanel from './panels/KeyboardPanel'
import RenameDialog from './panels/RenameDialog'
import UserAgreementDialog from './panels/UserAgreementDialog'
import { USER_AGREEMENT_MD, TRIAL_SECONDS } from './lib/user-agreement'

// cnc API helper — maps to window.cnc IPC calls
const cnc = window.cnc || {};
// macOS 用原生红绿灯,其它平台才需要自绘关闭按钮
const isMac = cnc.platform === 'darwin';
// Windows 版是**精简版**:只保留「激活 + 默认执行(回放/挑文件)」。
// 录制(ClickPanel)和快捷输入(KeyboardPanel)都依赖 macOS 原生能力
// (CoreGraphics 事件监听 / 输入源切换),在 Windows 上跑不通也不需要,故不出现。
const isWindows = cnc.platform === 'win32';

function App() {
  const [name, setName] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [clicks, setClicks] = useState([])
  const [clickInputs, setClickInputs] = useState([])
  const [message, setMessage] = useState('')
  const [isManageMode, setIsManageMode] = useState(false)
  const [jsonFiles, setJsonFiles] = useState([])
  const [selectedJson, setSelectedJson] = useState('')
  const [showJsonDropdown, setShowJsonDropdown] = useState(false)
  const [filesLoading, setFilesLoading] = useState(false)
  const dropdownRef = useRef(null)
  const selectButtonRef = useRef(null)
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 })
  const [countdown, setCountdown] = useState(0)
  const [isExecuting, setIsExecuting] = useState(false)
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState('')
  const [newFileName, setNewFileName] = useState('')
  const [pinyinCountdown, setPinyinCountdown] = useState(0)
  // 功能模块清单（新增功能自动出现，前端不用改）
  const [featureList, setFeatureList] = useState([])
  const [featureStatus, setFeatureStatus] = useState({})
  // 原生模块（模拟输入 / 输入源切换 / 录制回放）是否可用
  const [nativeStatus, setNativeStatus] = useState(null)

  const [deviceUuid, setDeviceUuid] = useState('')
  const [activationCode, setActivationCode] = useState('')
  const [activationStatus, setActivationStatus] = useState('unactivated')
  const [trialRemainingMs, setTrialRemainingMs] = useState(0)
  const [trialUsed, setTrialUsed] = useState(false)
  const [isUserAgreementOpen, setIsUserAgreementOpen] = useState(false)
  const [userAgreementMode, setUserAgreementMode] = useState('view')
  const [activationUiMessage, setActivationUiMessage] = useState('')
  const refreshLockRef = useRef(false)

  const isActivated = activationStatus === 'trial' || activationStatus === 'licensed'

  // 功能模块：拉清单 + 轮询状态
  const refreshFeatures = useMemo(() => async () => {
    try {
      if (!cnc.getFeatures) return;
      const list = await cnc.getFeatures();
      if (!Array.isArray(list)) return;
      setFeatureList(list);
      const statuses = {};
      for (const f of list) {
        try {
          const st = await cnc.getFeatureStatus(f.prefix);
          statuses[f.id] = st || null;
        } catch (_) {}
      }
      setFeatureStatus(statuses);
    } catch (_) {}
  }, []);

  useEffect(() => {
    refreshFeatures();
    const timer = setInterval(refreshFeatures, 3000);
    return () => clearInterval(timer);
  }, [refreshFeatures]);

  // 原生模块状态：加载失败时明确告知，而不是让按钮静默失灵
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        if (!cnc.getNativeStatus) return;
        const st = await cnc.getNativeStatus();
        if (alive) setNativeStatus(st || null);
      } catch (_) {}
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const toggleFeature = async (prefix, next) => {
    try {
      if (cnc.setFeatureEnabled) cnc.setFeatureEnabled(prefix, next);
      if (cnc.setFeatureEnabledSetting) cnc.setFeatureEnabledSetting(prefix, next);
    } catch (_) {}
    setTimeout(refreshFeatures, 400);
  };

  const getLocal = (k, fallback = '') => {
    try {
      const v = localStorage.getItem(k)
      return v == null ? fallback : v
    } catch (_) { return fallback }
  }

  const removeLocal = (k) => {
    try { localStorage.removeItem(k) } catch (_) {}
  }

  const clearLegacyUsageInfo = () => {
    removeLocal('cnc_device_uuid')
    removeLocal('cnc_trial_used')
    removeLocal('cnc_trial_expires_at')
    removeLocal('cnc_license')
    removeLocal('cnc_install_id')
  }

  const refreshActivationStatus = async () => {
    if (refreshLockRef.current) return
    refreshLockRef.current = true
    const snapshot = await cnc.getActivationSnapshot()
    const now = Date.now()
    const used = snapshot?.trialUsed === true
    const expiresAt = Number(snapshot?.trialExpiresAt || 0) || 0
    setDeviceUuid(String(snapshot?.deviceUuid || ''))
    setTrialUsed(used)
    if (expiresAt > now) {
      setActivationStatus('trial')
      setTrialRemainingMs(expiresAt - now)
      refreshLockRef.current = false
      return
    }
    setTrialRemainingMs(0)
    if (snapshot?.licenseValid === true) {
      setActivationStatus('licensed')
      refreshLockRef.current = false
      return
    }
    if (String(snapshot?.license || '').trim()) {
      await cnc.clearLicense()
    }
    setActivationStatus('unactivated')
    refreshLockRef.current = false
  }

  useEffect(() => {
    ;(async () => {
      try {
        await cnc.migrateLegacyActivation?.({
          deviceUuid: (getLocal('cnc_device_uuid', '') || '').trim(),
          trialUsed: getLocal('cnc_trial_used', '0') === '1',
          trialExpiresAt: Number(getLocal('cnc_trial_expires_at', '0') || '0') || 0,
          license: (getLocal('cnc_license', '') || '').trim(),
        })
        clearLegacyUsageInfo()
      } catch (_) {}

      refreshActivationStatus()
    })()
  }, [])

  useEffect(() => {
    const t = setInterval(() => { refreshActivationStatus() }, 1000)
    return () => clearInterval(t)
  }, [])

  const requestPinyinInput = (text) => {
    const t = (text || '').trim()
    if (!t) {
      setMessage('内容为空')
      setTimeout(() => setMessage(''), 2000)
      return
    }
    setPinyinCountdown(3)
    setMessage('')
    cnc.pinyinInput(t, 3, false)
      .then((data) => {
        if (data?.status === 'success') {
          setMessage(data.message || '已发起输入')
        } else {
          setMessage(data?.message || '请求失败')
          setPinyinCountdown(0)
        }
      })
      .catch(() => { setMessage('请求失败'); setPinyinCountdown(0) })
  }

  // 录制中每 0.1s 拉取一次坐标
  useEffect(() => {
    let interval
    if (isRecording) {
      interval = setInterval(() => {
        cnc.getRecordingClicks()
          .then((serverClicks) => {
            if (Array.isArray(serverClicks)) {
              setClicks(serverClicks)
              setClickInputs(prev => {
                const next = [...prev]
                if (serverClicks.length > next.length) {
                  for (let i = next.length; i < serverClicks.length; i += 1) next[i] = next[i] || ''
                }
                return next.slice(0, serverClicks.length)
              })
            }
          })
          .catch(() => {})
      }, 100)
    }
    return () => { if (interval) clearInterval(interval) }
  }, [isRecording])

  // 拼音输入倒计时
  useEffect(() => {
    if (pinyinCountdown <= 0) return
    const t = setInterval(() => { setPinyinCountdown((c) => (c <= 1 ? 0 : c - 1)) }, 1000)
    return () => clearInterval(t)
  }, [pinyinCountdown])

  const defaultExecuteRef = useRef(null)

  useEffect(() => {
    // 这里原本还会往屏幕最底下贴一条黑色调试条(显示按键信息)——
    // 那条带子已经删掉了(挡住屏幕底下的内容),但快捷键保留。
    const onKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyA') {
        e.preventDefault()
        defaultExecuteRef.current()
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyD' && !isWindows) {
        e.preventDefault()
        setMessage('读取剪贴板中...')
        setTimeout(() => setMessage(''), 2000)
        navigator.clipboard.readText().then((text) => {
          if (!(text || '').trim()) {
            setMessage('剪贴板为空')
            setTimeout(() => setMessage(''), 2000)
            return
          }
          cnc.pinyinInput(text, 0, false)
            .then((data) => {
              setMessage(data?.status === 'success' ? '开始输入' : (data?.message || '输入失败'))
              setTimeout(() => setMessage(''), 2000)
            })
            .catch(() => setMessage('输入请求失败'))
        }).catch(() => setMessage('无法读取剪贴板，请确认已授权'))
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [])

  // 点击页面其他区域关闭下拉
  useEffect(() => {
    if (!showJsonDropdown) return
    const onDocClick = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        selectButtonRef.current && !selectButtonRef.current.contains(e.target)
      ) { setShowJsonDropdown(false) }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [showJsonDropdown])

  // 把选择录制同步给主进程
  useEffect(() => {
    try { cnc?.settings?.setSelectedJson?.(selectedJson || '') } catch (_) {}
  }, [selectedJson])

  const handleStart = () => {
    setMessage('')
    setCountdown(3)
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          const left = window.screenX
          const top = window.screenY
          const right = left + window.outerWidth
          const bottom = top + window.outerHeight
          const excludeRect = [left, top, right, bottom]
          cnc.startRecording(excludeRect)
            .then((ok) => {
              if (ok === true) {
                setIsRecording(true)
                setMessage('录制已开始')
              } else {
                setMessage(ok?.error || '启动失败')
              }
              setTimeout(() => setMessage(''), 1000)
            })
            .catch(() => { setMessage('启动失败'); setTimeout(() => setMessage(''), 1000) })
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  const handleStop = () => {
    cnc.stopRecording()
      .then((clickData) => {
        setIsRecording(false)
        setMessage('录制已停止（返回 ' + (Array.isArray(clickData) ? clickData.length : 0) + ' 个点击）')
        setTimeout(() => setMessage(''), 1000)
      })
      .catch(() => { setMessage('停止失败'); setTimeout(() => setMessage(''), 1000) })
  }

  const handleClear = () => {
    if (!clicks.length) {
      setMessage('没有可清空的记录')
      setTimeout(() => setMessage(''), 3000)
      return
    }
    cnc.clearRecordingClicks()
      .then(() => {
        setClicks([])
        setClickInputs([])
        setMessage('已清空')
        setTimeout(() => setMessage(''), 1000)
      })
      .catch(() => { setMessage('清空失败'); setTimeout(() => setMessage(''), 1000) })
  }

  const handleDefaultExecute = () => {
    if (isExecuting) return
    setMessage('')
    setIsExecuting(true)

    const runWithFile = (fileName) => {
      const interval = 0.5
      const inputText = name || ''
      cnc.playFile(fileName, interval, inputText)
        .then((result) => {
          if (result?.status === 'success') {
            setMessage('开始执行')
          } else {
            setMessage(result?.message || '执行失败')
          }
          setTimeout(() => setMessage(''), 2000)
        })
        .finally(() => setIsExecuting(false))
    }

    if (selectedJson) {
      runWithFile(selectedJson)
      return
    }

    cnc.listFiles()
      .then((files) => {
        if (!files || !files.length) {
          setMessage('暂无录制文件')
          setTimeout(() => setMessage(''), 1000)
          setIsExecuting(false)
          return
        }
        const latest = [...files].sort((a, b) => (a.name < b.name ? 1 : -1))[0]
        runWithFile(latest.name)
      })
      .catch(() => { setMessage('无法获取文件列表'); setTimeout(() => setMessage(''), 3000); setIsExecuting(false) })
  }

  const handleSaveWithInputs = () => {
    if (!clicks.length) {
      setMessage('没有可保存的记录')
      setTimeout(() => setMessage(''), 3000)
      return
    }

    const payloadClicks = clicks.map((click, index) => ({
      x: click.x,
      y: click.y,
      timestamp: click.timestamp ?? 0,
      input_text: clickInputs[index] || ''
    }))

    cnc.saveFile(payloadClicks)
      .then((data) => {
        if (data?.status === 'success') {
          setMessage('已保存')
          getJsonFiles()
          setClicks([])
          setClickInputs([])
        } else {
          setMessage('保存失败')
        }
        setTimeout(() => setMessage(''), 3000)
      })
      .catch(() => { setMessage('保存失败'); setTimeout(() => setMessage(''), 3000) })
  }

  const getJsonFiles = () => {
    setFilesLoading(true)
    cnc.listFiles()
      .then((files) => {
        if (Array.isArray(files)) {
          const list = files.map((f, i) => ({ id: i + 1, name: f.name }))
          const names = list.map(f => f.name)
          setJsonFiles(list)
          setSelectedJson(prev => (prev && names.includes(prev) ? prev : ''))
        } else {
          setJsonFiles([])
          setSelectedJson('')
        }
      })
      .catch(() => { setJsonFiles([]); setSelectedJson(''); setMessage('获取文件列表失败'); setTimeout(() => setMessage(''), 3000) })
      .finally(() => setFilesLoading(false))
  }

  const handleManage = () => {
    setIsManageMode(!isManageMode)
    if (!isManageMode) getJsonFiles()
  }

  const handleRename = (fileName) => {
    setSelectedFile(fileName)
    setNewFileName(fileName.replace('.json', ''))
    setIsRenameModalOpen(true)
  }

  const handleRenameSubmit = () => {
    if (!newFileName) return
    cnc.renameFile(selectedFile, newFileName)
      .then((data) => {
        if (data?.status === 'success') {
          setMessage('重命名成功')
          setTimeout(() => setMessage(''), 1000)
          getJsonFiles()
          setIsRenameModalOpen(false)
        } else {
          setMessage('重命名失败')
          setTimeout(() => setMessage(''), 1000)
        }
      })
      .catch(() => { setMessage('重命名失败'); setTimeout(() => setMessage(''), 1000) })
  }

  const handleDelete = (fileName) => {
    if (window.confirm(`确定要删除文件 ${fileName} 吗？`)) {
      cnc.deleteFile(fileName)
        .then((data) => {
          if (data?.status === 'success') {
            setMessage('删除成功')
            setTimeout(() => setMessage(''), 1000)
            getJsonFiles()
          } else {
            setMessage('删除失败')
            setTimeout(() => setMessage(''), 1000)
          }
        })
        .catch(() => { setMessage('删除失败'); setTimeout(() => setMessage(''), 1000) })
    }
  }

  // ref 只在事件里读，赋值放到 effect 里（render 期写 ref 是 React 禁止的）
  useEffect(() => {
    defaultExecuteRef.current = handleDefaultExecute
  })

  // ── 传给面板组件的 props(逻辑全在 App,面板只负责显示) ──
  const activationPanelProps = {
    isActivated,
    activationStatus,
    trialRemainingMs,
    trialUsed,
    deviceUuid,
    activationCode,
    onActivationCodeChange: setActivationCode,
    activationUiMessage,
    onStartTrial: () => { setUserAgreementMode('accept_to_start_trial'); setIsUserAgreementOpen(true) },
    onViewAgreement: () => { setUserAgreementMode('view'); setIsUserAgreementOpen(true) },
    onCopyUuid: () => {
      const t = String(deviceUuid || '').trim()
      if (!t) return
      navigator.clipboard?.writeText?.(t).catch(() => {})
      setActivationUiMessage('已复制 UUID')
      setTimeout(() => setActivationUiMessage(''), 1200)
    },
    onActivate: async () => {
      setActivationUiMessage('')
      const code = String(activationCode || '').trim()
      if (!code) { setActivationUiMessage('请输入激活码'); return }
      try {
        const r = await cnc.saveLicense(code)
        if (r.ok) {
          setActivationStatus('licensed')
          setActivationUiMessage('激活成功')
          setTimeout(() => setActivationUiMessage(''), 1500)
        } else { setActivationUiMessage(r.error || '激活失败') }
      } catch (_) { setActivationUiMessage('激活失败') }
    },
  }

  const defaultExecutePanelProps = {
    isExecuting,
    onDefaultExecute: (e) => { e.preventDefault(); e.stopPropagation(); handleDefaultExecute() },
    selectedJson,
    showJsonDropdown,
    onToggleDropdown: (e) => {
      e.preventDefault(); e.stopPropagation()
      const next = !showJsonDropdown
      if (next && selectButtonRef.current) {
        const rect = selectButtonRef.current.getBoundingClientRect()
        setDropdownPosition({ top: rect.bottom + 4, left: rect.left })
      }
      setShowJsonDropdown(next)
      if (next) getJsonFiles()
    },
    selectButtonRef,
    dropdownRef,
    dropdownPosition,
    filesLoading,
    jsonFiles,
    onSelectFile: (name) => { setSelectedJson(name); setShowJsonDropdown(false) },
    // Windows 上没有录制界面 → 把「管理录制文件」的入口挂在这一步
    showManage: isWindows,
    isManageMode,
    onManage: handleManage,
    onRename: handleRename,
    onDelete: handleDelete,
  }

  const clickPanelProps = {
    isManageMode,
    countdown,
    isRecording,
    clicks,
    message,
    clickInputs,
    onClickInputChange: (index, v) => setClickInputs(prev => { const next = [...prev]; next[index] = v; return next }),
    onStart: handleStart,
    onStop: handleStop,
    onManage: handleManage,
    onSave: handleSaveWithInputs,
    onClear: handleClear,
    jsonFiles,
    onRename: handleRename,
    onDelete: handleDelete,
  }

  const keyboardPanelProps = {
    name,
    onNameChange: setName,
    onPinyinInput: (text) => requestPinyinInput(text || ''),
    onClearText: () => setName(''),
    pinyinCountdown,
    message,
    featureList,
    featureStatus,
    onToggleFeature: toggleFeature,
  }

  const renameDialogProps = {
    open: isRenameModalOpen,
    onClose: () => setIsRenameModalOpen(false),
    selectedFile,
    newFileName,
    onNewFileNameChange: setNewFileName,
    onSubmit: handleRenameSubmit,
  }

  const userAgreementDialogProps = {
    open: isUserAgreementOpen,
    onClose: () => setIsUserAgreementOpen(false),
    mode: userAgreementMode,
    text: USER_AGREEMENT_MD,
    onAccept: async () => {
      const expiresAt = Date.now() + TRIAL_SECONDS * 1000
      await cnc.startTrial(expiresAt)
      setActivationStatus('trial')
      setIsUserAgreementOpen(false)
    },
  }

  return (
    <div className="app-drag relative h-screen bg-transparent flex flex-col overflow-hidden pt-10 px-2 pb-2">
      {nativeStatus && nativeStatus.ok === false && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-red-600 text-white text-sm px-4 py-2 shadow">
          模拟输入相关功能不可用：原生模块加载失败（{nativeStatus.error || '未知原因'}）。
          请重新安装最新版安装包。
        </div>
      )}
      <Stepper
        key={isActivated ? 'active' : 'inactive'}
        initialStep={isActivated ? 2 : 1}
        onStepChange={() => {}}
        onFinalStepCompleted={() => {}}
        backButtonText="上一步"
        nextButtonText="下一步"
        disableStepIndicators={!isActivated}
        nextDisabled={!isActivated}
        hideCompleteButton={isWindows}
        corner={
          /* macOS 用原生红绿灯(见 main.js 的 titleBarStyle/trafficLightPosition),
             这里只给没有原生按钮的平台兜底 */
          !isMac && <button
            type="button"
            onClick={() => cnc.quit?.()}
            title="关闭（⌘Q）"
            aria-label="关闭"
            className="h-6 w-6 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        }
      >
        <Step>
          <ActivationPanel {...activationPanelProps} />
        </Step>

        <Step>
          <DefaultExecutePanel {...defaultExecutePanelProps} />
        </Step>

        {/* 以下两步是 macOS 专属:录制要事件监听,快捷输入要切换输入源。
            Windows 版到「默认执行」为止,少两个界面但功能不缺。 */}
        {!isWindows && (
          <Step>
            <ClickPanel {...clickPanelProps} />
          </Step>
        )}

        {!isWindows && (
          <Step>
            <KeyboardPanel {...keyboardPanelProps} />
          </Step>
        )}
      </Stepper>

<RenameDialog {...renameDialogProps} />

<UserAgreementDialog {...userAgreementDialogProps} />
    </div>
  )
}

export default App