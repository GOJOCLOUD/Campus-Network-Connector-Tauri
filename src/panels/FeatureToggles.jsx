/**
 * 功能开关区 —— 由功能清单驱动,新增功能自动出现,前端不用改。
 */
export default function FeatureToggles({ featureList, featureStatus, onToggle, onReopenFeatureBrowser }) {
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
    // 失败原因必须露出来:后台把错误记在 lastError 里,但界面不显示,
    // 用户只看到"已开启"却什么都没发生,根本无从判断是权限还是别的问题。
    const err = st && st.lastError ? String(st.lastError) : ''
    // Safari 没开是**中性状态**,不是故障:打开 Safari 后会自动接管。
    const safariOff = !!(st && st.safariRunning === false)
    const needsAutomation = /not authorized|-1743|自动化|automation/i.test(err)
    // 浏览器**被用户关掉了**（不是故障）—— 给一个「重新打开浏览器」按钮，
    // 而不是让软件偷偷再弹一个（2026-10-27 用户口径：「反反复复拉起浏览器」）。
    const browserClosed = !!(st && st.browserClosedByUser)
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
        {browserClosed ? (
          <div className="mt-1.5 text-xs text-gray-600 flex items-center gap-2">
            <span>浏览器已关闭 —— 本软件不会自动再弹一个。</span>
            <button type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onReopenFeatureBrowser?.(f.prefix) }}
              className="font-medium py-0.5 px-2.5 rounded bg-blue-600 hover:bg-blue-700 text-white">
              重新打开浏览器
            </button>
          </div>
        ) : null}
        {safariOff ? (
          <div className="mt-1.5 text-xs text-gray-600">
            Safari 未运行 —— 打开 Safari 后会自动接管(本软件不会替你启动它)。
          </div>
        ) : null}
        {/* 功能自带的提示(中性信息,不是错误)——
            Windows 的「浏览器复制修复」用它说明「重启浏览器后生效」。
            没有 hint 就不渲染 ⇒ mac 侧界面一个字都不变。 */}
        {st && st.hint ? (
          <div className="mt-1.5 text-xs text-gray-600">{st.hint}</div>
        ) : null}
        {err ? (
          <div className="mt-1.5 text-xs text-red-700 break-words">
            失败原因:{err}
            {needsAutomation ? (
              <span className="block mt-0.5">
                若提示没有自动化权限:系统设置 → 隐私与安全性 → 自动化 → 找到本应用 → 打开 Safari 开关;
                若是 Safari 侧:开发菜单 → 允许来自 Apple Events 的 JavaScript。
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  })}
</>
  )
}
