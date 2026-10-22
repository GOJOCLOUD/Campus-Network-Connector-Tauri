/**
 * 第 1 步:激活 / 试用入口。
 *
 * 纯展示组件 —— 所有动作都通过 props 回调交给 App 处理。
 */
export default function ActivationPanel({
  isActivated,
  activationStatus,
  trialRemainingMs,
  trialUsed,
  deviceUuid,
  activationCode,
  onActivationCodeChange,
  activationUiMessage,
  onStartTrial,
  onViewAgreement,
  onCopyUuid,
  onActivate,
}) {
  return (
    <>
      {isActivated ? (
        <div className="text-sm text-gray-500 text-center py-8">已激活，无需重复激活</div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-lg font-semibold">激活</div>
            <div className="text-xs text-gray-500">
              状态：{activationStatus === 'licensed' ? '已激活' : activationStatus === 'trial' ? `试用中（剩余 ${Math.ceil(trialRemainingMs / 1000)}s）` : '未激活'}
            </div>
          </div>

          {!trialUsed ? (
            <div className="relative">
              <button
                type="button"
                onClick={onStartTrial}
                className="relative w-1/3 bg-green-500 hover:bg-green-600 text-white font-medium text-sm h-10 px-3 rounded-lg transition duration-300 shadow-md active:scale-95 transform pr-9"
              >
                <span className="block text-center">开始试用</span>
                <span
                  onClick={(e) => { e.stopPropagation(); onViewAgreement() }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-5 h-5 rounded-full border border-white/50 bg-white/10 text-white text-[12px] leading-none hover:bg-white/15 cursor-pointer select-none"
                  title="用户协议" aria-label="用户协议"
                >?</span>
              </button>
            </div>
          ) : (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onViewAgreement}
                className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-gray-300 text-gray-700 hover:bg-gray-100 text-[12px] leading-none"
                title="用户协议" aria-label="用户协议"
              >?</button>
            </div>
          )}

          <div className="flex items-stretch gap-2">
            <div className="flex-1 h-10 border border-gray-300 rounded-lg px-3 bg-white flex items-center gap-2 overflow-hidden">
              <span className="text-[11px] text-gray-400 select-none shrink-0">UUID</span>
              <input value={deviceUuid || '—'} readOnly className="flex-1 bg-transparent outline-none min-w-0 font-mono text-[11px] text-gray-700 truncate" />
            </div>
            <button
              type="button"
              onClick={onCopyUuid}
              className="h-10 shrink-0 bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium text-sm px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform"
            >复制</button>
          </div>

          <div className="flex items-stretch gap-2">
            <div className="flex-1 h-10 border border-gray-300 rounded-lg px-3 bg-white flex items-center gap-2 overflow-hidden">
              <span className="text-[11px] text-gray-400 select-none shrink-0">激活码</span>
              <input value={activationCode} onChange={(e) => onActivationCodeChange(e.target.value)} className="flex-1 bg-transparent outline-none text-sm min-w-0" placeholder="" />
            </div>
            <button
              type="button"
              onClick={onActivate}
              className="h-10 shrink-0 bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform"
            >激活</button>
          </div>

          {(activationUiMessage || activationUiMessage === '') && activationUiMessage ? (
            <div className="text-sm text-gray-600">{activationUiMessage}</div>
          ) : null}
        </div>
      )}
    </>
  )
}
