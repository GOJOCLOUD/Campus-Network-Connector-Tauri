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
// Windows 版是**精简版**:比 macOS 少「录制」这一步(ClickPanel)。
// 录制依赖 macOS 专属的 CoreGraphics 事件监听,Windows 线**不做**(ADR-0012);
// 但「键盘输入」(拼音自动键入)**保留** —— Windows 直接送 Unicode 字符,
// 不需要输入源切换,功能不缺。
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
      // ⚠️ **Windows 线这两个键一律不在窗口内接管**(2026-10-25 用户口径)。
      //
      // - **⌃D 我们抢成全局热键了**(读剪贴板并键入)。它在**别的软件**里
      //   是「退出软件」那一族动作 —— 抢到手,那个软件就**收不到**它,
      //   于是**不会被自己的「退出」关掉**
      //   (用户原话:「干脆直接把系统的抢了,我的软件优先级最高……
      //     在使用这个的时候没必要退出吧,所以就给他压制住」)。
      //   ⇒ 但系统级注册是**独占**的:别的软件先注册了 ⇒ 我们**抢不到**。
      //   抢没抢到**看得见**(见 `shortcutPasteRegistered` 与界面上的提示行)。
      // - **⌃S 不抢**:它驱动的「默认执行(回放)」在 Windows 上**已经没有界面了**
      //   (上一轮按用户口径撤掉:「本来就没有这个功能」)⇒ 留着它就是一个
      //   **没有入口的隐藏功能**;而且 Ctrl+S 在别的软件里是「保存」。
      //
      // 所以 Windows 线:**⌃D 走系统级全局热键、⌃S 不注册**;
      // 而**窗口内**这两个键都不拦 —— 在我们自己的窗口里它们就是普通按键。
      //
      // 下面这两条是 macOS 线(⌃S 默认执行 / ⌃D 读剪贴板并键入),
      // 只认 **Control**:不认 Win/Alt,也不要求 Shift(带 Shift 照样触发)——
      // 两个平台**逐字一致**(见 ADR-0013)。
      if (isWindows) return
      if (e.ctrlKey && e.code === 'KeyS') {
        e.preventDefault()
        defaultExecuteRef.current()
      }
      if (e.ctrlKey && e.code === 'KeyD') {
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
          // 「点自己界面上的按钮不算一次点击」由**原生层**负责:
          // 排除矩形用原生窗口位置算,并在窗口每次移动/变高时刷新。
          // 这里**不传**矩形 —— 前端那份 `window.screenX` 只是开始那一刻的
          // 一张快照,窗口一动就过期了(点「结束」会被记成一次点击)。
          cnc.startRecording()
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
        // null = 停止失败(这时**别**把界面上的记录清掉);
        // 数组 = 原生那边拿到的点击。
        // 停止那一刻录到的最后一次点击只有原生那边有(界面是 100ms 轮询,
        // 可能差最后一次),所以以它为准。
        const list = Array.isArray(clickData) ? clickData : null
        if (list) {
          setClicks(list)
          setClickInputs(prev => {
            const next = [...prev]
            for (let i = 0; i < list.length; i += 1) next[i] = next[i] || ''
            return next.slice(0, list.length)
          })
        }
        setMessage('录制已停止（返回 ' + (list ? list.length : clicks.length) + ' 个点击）')
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

  // 单条删除:界面上每一条点击旁边有个「×」,点它只删这一条。
  // 原生那边也要删**同一条** —— 两边都留着就对不上号了
  // (原生那份是回放时真正用的)。
  const handleDeleteClick = (index) => {
    if (!(index >= 0 && index < clicks.length)) return
    if (cnc.removeRecordingClick) cnc.removeRecordingClick(index)
    setClicks(prev => prev.filter((_, i) => i !== index))
    setClickInputs(prev => prev.filter((_, i) => i !== index))
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
    // 「管理录制文件」的入口:macOS 上在「模拟点击」那一步里,
    // Windows 上没有那一步 ⇒ 挂在「默认执行」这一步。
    // (补了「键盘输入」那一步之后**仍然**挂在这里 —— 它管的是录制文件,
    //  和「键盘输入」没关系。)
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
    onDeleteClick: handleDeleteClick,
    jsonFiles,
    onRename: handleRename,
    onDelete: handleDelete,
  }

  const keyboardPanelProps = {
    name,
    onNameChange: setName,
    onPinyinInput: (text) => requestPinyinInput(text || ''),
    onClearText: () => setName(''),
    // ⌃D **抢没抢到**必须看得见(2026-10-24 用户口径:
    // 「怎么保证它使用的是你的功能而不是系统功能」)。
    // 抢不到 ⇒ 那个组合键被别的软件先注册了 ⇒
    // ① 按它**不会触发我们**;② 目标软件自己的 Ctrl+D 也**照常生效**
    // (所以那个软件还是会被它的「退出」关掉)—— 这两件都要让用户知道。
    shortcutNotice: (nativeStatus && nativeStatus.shortcutPasteRegistered === false)
      ? 'Ctrl+D 没抢到(这个组合键被别的软件先注册了):按它不会触发我们,目标软件自己的 Ctrl+D 也会照常生效。'
      : '',
    pinyinCountdown,
    message,
    featureList,
    featureStatus,
    onToggleFeature: toggleFeature,
    // 「辅助功能」授权状态:不做成占一整条的大横幅,只在第 4 页放一个小问号
    // (红=还不能用,绿=可以用),点一下直接跳到系统设置。
    // **只有 macOS 有「辅助功能」这回事**(Windows 的 SendInput 不需要授权),
    // 所以 Windows 上这个小问号根本不出现,免得误报红色。
    showAccessibilityBadge: isMac,
    accessibilityTrusted: isMac
      ? (nativeStatus ? nativeStatus.accessibilityTrusted === true : null)
      : null,
    onOpenAccessibilitySettings: () => cnc.openAccessibilitySettings?.(),
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
    <div
      className="app-drag relative h-screen bg-transparent flex flex-col overflow-hidden pt-10 px-2 pb-2"
      data-tauri-drag-region="deep"
    >
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
        // 「完成」按钮:**显示**(和 macOS 一致)。
        //
        // 最后一步点「完成」会把整个面板**收起**(isCompleted → 高度 0),
        // 收起后还能靠顶上的步骤圈再点回来。
        //
        // 两个平台的最后一步现在**都是「键盘输入」**
        // (Windows 撤掉「默认执行」之后也是它)⇒ 两边行为一致,按钮都显示。
        hideCompleteButton={false}
        corner={
          /* macOS 用原生红绿灯(见 main.js 的 titleBarStyle/trafficLightPosition),
             这里只给没有原生按钮的平台兜底。

             Windows 线自绘**四个**按钮(2026-10-24 用户口径:
             「你加一个最小化,加一个关闭,加一个最大化,别他妈就只留小叉,
               让小叉变成放在后台,那不然人家真正想关软件还得点两次」):

             - **最小化** / **最大化**(再点一次还原);
             - **关闭软件** = 彻底退出进程 —— **一次点击就退**,
               不用先去托盘再点一次;
             - **小叉** = **放到后台**(窗口藏起来,进程留着,功能继续生效)
               —— 小叉**不是退出**。

             放到后台之后:托盘图标(左键)把窗口叫回来,
             托盘右键「退出程序」彻底退出。 */
          !isMac && (
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => cnc.minimize?.()}
                title="最小化"
                aria-label="最小化"
                className="h-6 w-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M5 12h14" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => cnc.maximize?.()}
                title="最大化（再点一次还原）"
                aria-label="最大化"
                className="h-6 w-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round">
                  <rect x="5" y="5" width="14" height="14" rx="1.5" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => cnc.quit?.()}
                title="关闭软件（彻底退出程序）"
                aria-label="关闭软件"
                className="h-6 w-6 flex items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600 transition"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 3v9" />
                  <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => cnc.hide?.()}
                title="放到后台（程序继续运行；托盘图标可以叫回来）"
                aria-label="放到后台"
                className="h-6 w-6 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )
        }
      >
        <Step>
          <ActivationPanel {...activationPanelProps} />
        </Step>

        {/* 「默认执行(回放)」这一步在 **Windows 上不出现**。
            Windows 线没有录制 ⇒ 没有可回放的源 ⇒ 这一屏是「点了没反应」的死界面。
            (2026-10-24 用户口径:「本来就没有这个功能」—— 既然没有,界面就不该露出来。)
            下面的「模拟点击(录制)」同样是 macOS 专属(ADR-0012:Windows 不做录制入口)。 */}
        {!isWindows && (
          <Step>
            <DefaultExecutePanel {...defaultExecutePanelProps} />
          </Step>
        )}

        {/* 「模拟点击(录制)」这一步是 macOS 专属(按 ADR-0012,Windows 侧不做录制入口)。
            下面的「键盘输入」两边都有 —— Windows 直接送 Unicode 逐字键入。 */}
        {!isWindows && (
          <Step>
            <ClickPanel {...clickPanelProps} />
          </Step>
        )}

        {/* 键盘输入(拼音自动键入)两边都要有:
            macOS 靠 TIS 切输入源,Windows 直接用 Unicode 逐字键入,都能用
            (见 ADR-0012:Windows 保留拼音输入,不保留录制)。 */}
        <Step>
          <KeyboardPanel {...keyboardPanelProps} />
        </Step>
      </Stepper>

<RenameDialog {...renameDialogProps} />

<UserAgreementDialog {...userAgreementDialogProps} />
    </div>
  )
}

export default App