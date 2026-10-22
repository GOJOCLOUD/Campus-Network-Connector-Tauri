/**
 * 第 2 步:默认执行 + 选择录制文件。
 *
 * Windows 版**只有这两步**(激活 + 默认执行):录制和快捷输入是 macOS 专属能力,
 * 在 Windows 上既用不上也跑不通,所以那边不出现这两个界面。
 * Windows 上「管理录制文件」的入口挂在这里 —— 录制文件本身仍然要能挑/能改/能删。
 */
import { createPortal } from 'react-dom'
import ManageFilesPanel from './ManageFilesPanel'

export default function DefaultExecutePanel({
  isExecuting,
  onDefaultExecute,
  selectedJson,
  showJsonDropdown,
  onToggleDropdown,
  selectButtonRef,
  dropdownRef,
  dropdownPosition,
  filesLoading,
  jsonFiles,
  onSelectFile,
  showManage = false,
  isManageMode = false,
  onManage,
  onRename,
  onDelete,
}) {
  // 管理视图:Windows 上从这一步进入(macOS 上从「模拟点击」那一步进入)
  if (showManage && isManageMode) {
    return (
      <ManageFilesPanel
        jsonFiles={jsonFiles}
        onRename={onRename}
        onDelete={onDelete}
        onBack={onManage}
      />
    )
  }

  return (
      <div className="flex flex-col space-y-2">
        <div className="flex items-center space-x-3">
          <button
            type="button"
            disabled={isExecuting}
            onClick={onDefaultExecute}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-1.5 px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform"
          >{isExecuting ? '执行中…' : '默认执行'}</button>
          <div className="relative">
            <button
              ref={selectButtonRef}
              type="button"
              onClick={onToggleDropdown}
              className="bg-gray-400 hover:bg-gray-500 text-white font-medium py-1.5 px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform"
            >{selectedJson ? `选择录制: ${selectedJson}` : '选择录制'}</button>
            {showJsonDropdown && createPortal(
              <div
                ref={dropdownRef}
                className="fixed z-[9999] w-64 bg-white rounded-lg shadow-lg border border-gray-200 max-h-60 overflow-auto"
                style={{ top: dropdownPosition.top, left: dropdownPosition.left }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {filesLoading ? (
                  <div className="px-3 py-2 text-xs text-gray-500">加载中...</div>
                ) : jsonFiles.length > 0 ? (
                  jsonFiles.map(file => (
                    <button key={file.id} type="button"
                      onClick={() => onSelectFile(file.name)}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 ${selectedJson === file.name ? 'bg-gray-100 font-medium' : ''}`}
                    >{file.name}</button>
                  ))
                ) : (
                  <div className="px-3 py-2 text-xs text-gray-500">暂无录制文件</div>
                )}
              </div>,
              document.body
            )}
          </div>
          {showManage && (
            <button
              type="button"
              onClick={onManage}
              className="bg-gray-500 hover:bg-gray-600 text-white font-medium py-1.5 px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform"
            >管理</button>
          )}
        </div>
      </div>
    )
}
