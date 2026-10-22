/**
 * Safari 复制修复 —— 功能模块入口。
 *
 * 由 `src/features/index.js` 的注册表统一加载;新增功能照这个目录的形状做即可。
 *
 * 本功能负责:
 *   - 往 Safari 的目标标签页注入页面守卫（Apple Events，见 bridge.js）
 *   - 解析页面的加密字体、算出「密文码位 → 可见文字」对照表（engine.js）
 *   - 在 copy 事件里把密文换成可见文字（页面守卫负责，主进程只管下发映射）
 *
 * 依赖 macOS 的 Safari + Apple Events；其他平台不支持（界面会自动隐藏开关）。
 */
const { InjectorCoordinator } = require('./coordinator');

/** 目标站点：这些站点的标签**始终**被接管，与是不是前台标签无关 */
const SITE_FILTER = ['chaoxing.com'];

/** 本功能在 settings.json 里的配置键（命名空间由注册表按功能 id 隔离） */
const KEY_ENABLED = 'enabled';
const KEY_WATCHED = 'watched';

let coordinator = null;

function init({ log, settings } = {}) {
  if (coordinator) return coordinator;
  coordinator = new InjectorCoordinator({
    log,
    siteFilter: SITE_FILTER,
    onWatch: (urls) => settings?.set(KEY_WATCHED, urls),
  });
  // 恢复上次的开关状态与"看住过的标签"
  if (settings?.get(KEY_ENABLED, false)) {
    coordinator.setEnabled(true);
    const watched = settings.get(KEY_WATCHED, []);
    if (Array.isArray(watched) && watched.length) {
      coordinator.restoreWatched(watched).catch(() => {});
    }
  }
  return coordinator;
}

function get() {
  return coordinator;
}

/** 注册 IPC（命名遵循项目既有约定：模块:动作）。 */
function registerIpc(ipcMain, { settings } = {}) {
  ipcMain.handle('safariRepair:getStatus', async () => {
    // 这套能力依赖 macOS 的 Safari + Apple Events，别的平台没有对应实现
    if (process.platform !== 'darwin') {
      return { enabled: false, running: false, supported: false };
    }
    if (!coordinator) return { enabled: false, running: false, supported: true };
    return { ...coordinator.getStatus(), supported: true };
  });

  ipcMain.on('safariRepair:setEnabled', (_e, enabled) => {
    if (!coordinator) return;
    coordinator.setEnabled(!!enabled);
  });

  ipcMain.on('safariRepair:setEnabledSetting', (_e, enabled) => {
    settings?.set(KEY_ENABLED, !!enabled);
  });

  ipcMain.handle('safariRepair:checkNow', async () => {
    if (!coordinator) return { action: 'not-initialized' };
    return coordinator.tick();
  });
}

function dispose() {
  try {
    coordinator?.stop();
  } catch (_) {
    /* ignore */
  }
  coordinator = null;
}

module.exports = { id: 'safari-repair', title: 'Safari 复制修复', init, get, registerIpc, dispose, InjectorCoordinator };
