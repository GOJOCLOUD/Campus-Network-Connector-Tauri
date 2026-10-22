/**
 * 第 4 步:键盘输入(拼音自动键入)+ 功能开关区。
 */
import FeatureToggles from './FeatureToggles'

export default function KeyboardPanel({
  name,
  onNameChange,
  onPinyinInput,
  onClearText,
  pinyinCountdown,
  message,
  featureList,
  featureStatus,
  onToggleFeature,
}) {
  return (
    <>
      <h2>键盘输入</h2>
      {<FeatureToggles featureList={featureList} featureStatus={featureStatus} onToggle={onToggleFeature} />}
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
