/**
 * 第 4 步:键盘输入(拼音自动键入)+ 功能开关区。
 */
import FeatureToggles from './FeatureToggles'

export default function KeyboardPanel({
  name,
  onNameChange,
  onPinyinInput,
  onClearText,
  shortcutNotice,
  browserRepairNote,
  pinyinCountdown,
  message,
  featureList,
  featureStatus,
  onToggleFeature,
  showAccessibilityBadge,
  accessibilityTrusted,
  onOpenAccessibilitySettings,
}) {
  // 「辅助功能」授权状态:一个小问号就够,不做成占一整条的大横幅。
  // 红=还不能用(模拟点击/回放/键入发不出去),绿=可以用,灰=状态未知。
  // **Windows 没有「辅助功能」**(SendInput 不需要授权)→ 那边根本不显示这个小问号
  // (App.jsx 传的是 `showAccessibilityBadge: isMac`,Windows 上恒为 false)。
  const trusted = accessibilityTrusted === true
  const unknown = accessibilityTrusted === null || accessibilityTrusted === undefined
  const badgeClass = unknown
    ? 'text-gray-400 border-gray-300 bg-gray-50'
    : trusted
      ? 'text-emerald-600 border-emerald-300 bg-emerald-50'
      : 'text-red-600 border-red-300 bg-red-50'
  const badgeTitle = unknown
    ? '正在确认系统授权状态'
    : trusted
      ? '「辅助功能」已授权:模拟点击 / 回放 / 键入都能发出去'
      : '没有「辅助功能」权限:模拟点击 / 回放 / 键入发不出去(点我去系统设置打开)'

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2>键盘输入</h2>
        {showAccessibilityBadge !== false && (
          <button
            type="button"
            onClick={() => onOpenAccessibilitySettings?.()}
            title={badgeTitle}
            aria-label={badgeTitle}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold leading-none transition hover:opacity-80 ${badgeClass}`}
          >
            ?
          </button>
        )}
      </div>
      {<FeatureToggles featureList={featureList} featureStatus={featureStatus} onToggle={onToggleFeature} />}
      {/* **浏览器修复**(复制修复)的说明块 —— 位置与 mac 的「Safari 复制修复」
          开关**完全相同**(都在这一页的最上面),但**内容不是开关**。

          为什么不是开关:mac 上这个能力是**原生**的(Apple Events 驱动 Safari),
          开关一拨就接管了;Windows 上没有 Safari、没有 Apple Events,
          桌面程序**接管不了浏览器** ⇒ 那个能力由 **Chrome/Edge 扩展**提供,
          而扩展装不装、装在哪,桌面上**管不着** ⇒ 给一个开关就是骗人。

          ⇒ 给一个**说明块**:说清楚它由谁提供、去哪拿、怎么装。
          (用户 2026-10-25:「在windows上那个把密文转化成明文的那个功能是失效的,
           没有用的」「最后个页面的相关提示也和macOS上面的两个版本完全不同」) */}
      {browserRepairNote ? (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-2">
          <div className="font-medium">{browserRepairNote.title}</div>
          <div className="mt-1 text-xs leading-relaxed whitespace-pre-line">{browserRepairNote.body}</div>
        </div>
      ) : null}
      {/* ⌃D **抢没抢到**的提示:抢不到时必须说清楚,否则用户只会觉得
          「按了没反应」,还不知道是不是我们自己的问题。 */}
      {shortcutNotice && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">{shortcutNotice}</p>
      )}
      <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-2">输入完成前不要尝试操作电脑，否则可能导致电脑死机（强制重启可以解决）</p>
      <div className="relative w-full mb-3">
        <textarea
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="输入要键入的内容（中英文均可）"
          className="bg-gray-100 text-gray-900 border border-gray-300 rounded px-3 py-2 w-full min-h-[2.5rem] resize-y pr-7"
          rows={3} style={{ resize: 'vertical' }} title="右下角可拖拽拉高"
        />
        <span className="absolute bottom-1.5 right-1.5 pointer-events-none text-gray-400 select-none" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="opacity-70">
            <path d="M12 16l-4-4h3V8h2v4h3l-4 4z" />
          </svg>
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => onPinyinInput(name || '')}
          className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-1.5 px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform">开始输入（3s 后键入）</button>
        <button type="button" onClick={onClearText}
          className="bg-gray-200 hover:bg-gray-300 text-gray-600 font-medium py-1.5 px-4 rounded-lg transition duration-300 active:scale-95 transform">清空</button>
      </div>
      {pinyinCountdown > 0 && (
        <p className="text-sm text-yellow-500 mt-2">{pinyinCountdown} 秒后开始输入，请将光标移动到目标位置</p>
      )}
      {message && pinyinCountdown === 0 && (
        <p className="text-sm text-gray-500 mt-2">{message}</p>
      )}
    </>
  )
}
