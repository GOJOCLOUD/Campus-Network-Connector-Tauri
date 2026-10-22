/**
 * 「管理录制文件」视图 —— 从 ClickPanel 里抽出来的独立面板。
 *
 * 为什么抽出来:Windows 版**没有录制界面**(录制依赖 macOS 的事件监听),
 * 但录制文件的挑选/重命名/删除在任何平台都得留着。
 * 所以这个视图被两个地方复用:
 *   - macOS:ClickPanel 的「管理」视图
 *   - Windows:默认执行面板里的「管理」入口
 *
 * 纯展示组件,所有动作通过 props 回调交给 App 处理。
 */
export default function ManageFilesPanel({
  jsonFiles,
  onRename,
  onDelete,
  onBack,
}) {
  return (
    <div className="w-full max-w-md animate-fadeIn">
      <h2 className="text-2xl font-bold mb-6 text-center">管理录制文件</h2>
      <div className="bg-gray-200 rounded-lg p-6">
        {jsonFiles.length > 0 ? (
          <ul className="space-y-4">
            {jsonFiles.map((file) => (
              <li key={file.id} className="flex items-center justify-between">
                <span className="text-sm truncate flex-1 mr-2">{file.name}</span>
                <div className="flex space-x-2 whitespace-nowrap">
                  <button
                    onClick={() => onRename(file.name)}
                    className="bg-blue-500 hover:bg-blue-600 text-white text-xs py-0.5 px-2 rounded"
                  >重命名</button>
                  <button
                    onClick={() => onDelete(file.name)}
                    className="bg-gray-400 hover:bg-gray-500 text-white text-xs py-0.5 px-2 rounded"
                  >删除</button>
                </div>
              </li>
            ))}
          </ul>
        ) : (<p className="text-sm text-gray-500 text-center">暂无录制文件</p>)}
        <button
          onClick={onBack}
          className="mt-6 w-full bg-gray-500 hover:bg-gray-600 text-white font-medium py-1.5 px-4 rounded-lg transition duration-300 shadow-md active:scale-95 transform"
        >返回</button>
      </div>
    </div>
  )
}
