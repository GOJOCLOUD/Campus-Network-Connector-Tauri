/**
 * 第 3 步:模拟点击(录制 / 回放),以及「管理录制文件」视图。
 *
 * 注意:**这个面板只在 macOS 上出现**。Windows 版没有录制能力(录制依赖 macOS 的
 * 事件监听),那一侧只保留「选择/管理录制文件 + 回放」,见 DefaultExecutePanel。
 */
import ManageFilesPanel from './ManageFilesPanel'

export default function ClickPanel({
  isManageMode,
  countdown,
  isRecording,
  clicks,
  message,
  clickInputs,
  onClickInputChange,
  onStart,
  onStop,
  onManage,
  onSave,
  onClear,
  jsonFiles,
  onRename,
  onDelete,
}) {
  return (
      <div className={`flex flex-col gap-4 w-full transition-all duration-500 ${isManageMode ? 'items-center' : ''}`}>
        {!isManageMode ? (
          <div className="flex w-full gap-4">
            <div className="flex flex-col space-y-4 w-fit">
              <h2>模拟点击</h2>
              <div className="flex flex-col space-y-3">
                <button onClick={onStart}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-1.5 px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform text-center w-full">开始</button>
                <button onClick={onStop}
                  className="bg-gray-400 hover:bg-gray-500 text-white font-medium py-1.5 px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform text-center w-full">结束</button>
                <button onClick={onManage}
                  className="bg-gray-500 hover:bg-gray-600 text-white font-medium py-1.5 px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform text-center w-full">管理</button>
              </div>
            </div>
            <div className="bg-gray-200 rounded-lg p-6 flex-1">
              {countdown > 0 ? (
                <div className="flex flex-col space-y-2">
                  <p className="text-sm text-yellow-500">{countdown}秒后开始录制</p>
                </div>
              ) : isRecording ? (
                <div className="flex flex-col space-y-2">
                  <p className="text-sm text-green-500">录制中...</p>
                  <h3 className="font-medium">点击坐标：</h3>
                  {clicks.length > 0 ? (
                    <ul className="space-y-1 max-h-48 overflow-auto">
                      {clicks.map((click, index) => (
                        <li key={index} className="text-sm">第{index + 1}次: ({Math.round(click.x)}, {Math.round(click.y)})</li>
                      ))}
                    </ul>
                  ) : (<p className="text-sm text-gray-500">等待点击...</p>)}
                </div>
              ) : (
                <div className="flex flex-col space-y-2">
                  {message && <p className="text-sm text-gray-500">{message}</p>}
                  {clicks.length > 0 ? (
                    <>
                      <h3 className="font-medium">点击坐标（可配置每次输入）：</h3>
                      <div className="space-y-2">
                        <ul className="space-y-1 max-h-48 overflow-auto">
                          {clicks.map((click, index) => (
                            <li key={index} className="text-sm flex flex-col space-y-1">
                              <span>第{index + 1}次: ({Math.round(click.x)}, {Math.round(click.y)})</span>
                              <input type="text"
                                value={clickInputs[index] || ''}
                                onChange={e => onClickInputChange(index, e.target.value)}
                                placeholder="此点击后输入的内容（可选）"
                                className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                            </li>
                          ))}
                        </ul>
                        <div className="flex space-x-2 mt-2">
                          <button onClick={onSave}
                            className="bg-blue-600 hover:bg-blue-700 text-white text-sm py-1 px-3 rounded-lg transition duration-300 shadow-md active:scale-95 transform">保存</button>
                          <button onClick={onClear}
                            className="bg-gray-400 hover:bg-gray-500 text-white text-sm py-1 px-3 rounded-lg transition duration-300 shadow-md active:scale-95 transform">清空</button>
                        </div>
                      </div>
                    </>
                  ) : (<p className="text-sm text-gray-500">未开始录制</p>)}
                </div>
              )}
            </div>
          </div>
        ) : (
          <ManageFilesPanel
            jsonFiles={jsonFiles}
            onRename={onRename}
            onDelete={onDelete}
            onBack={onManage}
          />
        )}
      </div>
  )
}
