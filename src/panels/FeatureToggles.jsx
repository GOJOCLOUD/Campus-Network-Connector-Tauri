/**
 * 功能开关区 —— 由功能清单驱动,新增功能自动出现,前端不用改。
 */
export default function FeatureToggles({ featureList, featureStatus, onToggle }) {
  return (
<>
  {featureList.map((f) => {
    const st = featureStatus[f.id]
    if (st && st.supported === false) return null
    const on = !!(st && st.enabled)
    const stateText = !st
      ? ''
      : !on
        ? '关闭中'
        : st.injected
          ? '已接管'
          : '已开启'
    return (
      <div key={f.id} className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="font-medium">{f.title}</span>
            <span className="ml-2 text-xs">
              {stateText ? stateText + '：' : ''}
              {f.description}
            </span>
          </div>
          <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(f.prefix, !on) }}
            className={'shrink-0 font-medium py-1.5 px-4 rounded-lg transition duration-300 active:scale-95 transform ' + (on ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-md' : 'bg-gray-200 hover:bg-gray-300 text-gray-600')}>
            {on ? '关闭' : '开启'}
          </button>
        </div>
      </div>
    )
  })}
</>
  )
}
