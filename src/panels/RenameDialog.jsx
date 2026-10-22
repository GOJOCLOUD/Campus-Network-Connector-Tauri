/**
 * 重命名录制文件的弹窗。
 */
export default function RenameDialog({
  open,
  onClose,
  selectedFile,
  newFileName,
  onNewFileNameChange,
  onSubmit,
}) {
  if (!open) return null
  return (
    <div className="app-nodrag fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold mb-4">重命名文件</h3>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">当前文件名</label>
          <p className="text-sm text-gray-600 mb-2">{selectedFile}</p>
          <label className="block text-sm font-medium mb-2">新文件名</label>
          <input type="text" value={newFileName} onChange={(e) => onNewFileNameChange(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2" placeholder="请输入新文件名" />
        </div>
        <div className="flex justify-end space-x-3">
          <button onClick={onClose}
            className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded">取消</button>
          <button onClick={onSubmit}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">确认</button>
        </div>
      </div>
    </div>
  )
}
