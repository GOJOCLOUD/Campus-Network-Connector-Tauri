/**
 * 用户协议弹窗。mode='accept_to_start_trial' 时多一个「我同意」按钮。
 */
export default function UserAgreementDialog({
  open,
  onClose,
  mode,
  text,
  onAccept,
}) {
  if (!open) return null
  return (
    <div className="app-nodrag fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onMouseDown={onClose}>
      <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <h3 className="text-lg font-semibold">用户协议</h3>
          <button type="button" onClick={onClose}
            className="text-gray-500 hover:text-gray-700 px-2 py-1" aria-label="关闭">关闭</button>
        </div>
        <div className="space-y-3 text-sm text-gray-700 whitespace-pre-wrap">{text}</div>
        <div className="pt-4 flex justify-end gap-2">
          {mode === 'accept_to_start_trial' ? (
            <>
              <button type="button" onClick={onClose}
                className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded">拒绝</button>
              <button type="button" onClick={onAccept} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">我同意</button>
            </>
          ) : (
            <button type="button" onClick={onClose}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">知道了</button>
          )}
        </div>
      </div>
    </div>
  )
}
