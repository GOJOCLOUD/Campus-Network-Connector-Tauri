/**
 * 功能注册表 —— **新增功能的唯一入口**。
 *
 * 约定:每个功能是 `src/features/<功能名>/` 下的一个自包含目录,必须导出:
 *
 *   {
 *     id:     '功能标识',
 *     title:  '界面显示名',
 *     init(ctx): 实例,        // ctx = { app, ipcMain, log, settings }
 *     registerIpc?(ipcMain): void,
 *     dispose?(): void,
 *   }
 *
 * `ctx.settings` 是**该功能专属的配置命名空间**(见 main.js 的 featureSettings):
 *   settings.get(key, fallback) / settings.set(key, value)
 * 不同功能的键互不冲突,统一持久化在 settings.json 的 features.<功能名> 下。
 *
 * `platforms` 是可选的可用平台白名单(不写 = 全平台):
 *   - Safari 复制修复走 Apple Events,只有 macOS 有 → platforms: ['darwin']
 *   - 不在白名单里的功能**连 require 都不做**,前端也看不到它的开关。
 *
 * 加一个新功能 = 建一个目录 + 在下面 FEATURES 里加一行 + 前端加一个开关。
 */
const FEATURES = [
  {
    id: 'safari-repair',
    title: 'Safari 复制修复',
    description: '把被网页字体混淆的文字还原成你看到的那句话',
    module: './safari-repair',
    platforms: ['darwin'],
  },
];

/**
 * 该功能在当前平台是否可用。
 * @param {{platforms?: string[]}} def
 * @param {string} [platform]
 */
function isPlatformAvailable(def, platform = process.platform) {
  if (!Array.isArray(def.platforms) || def.platforms.length === 0) return true;
  return def.platforms.includes(platform);
}

/** 当前平台可用的功能(注册表和 IPC 清单用同一份,避免两处口径不一致) */
function availableFeatures(platform = process.platform) {
  return FEATURES.filter((f) => isPlatformAvailable(f, platform));
}

/**
 * 载入全部功能。
 * @param {{app:any, ipcMain:any, log:(m:string)=>void, settings:any}} ctx
 */
function loadFeatures(ctx) {
  const loaded = new Map();
  const available = availableFeatures();
  for (const def of available) {
    try {
      const mod = require(def.module);
      const store = makeNamespace(ctx.settings, def.id);
      const instance = typeof mod.init === 'function' ? mod.init({ ...ctx, settings: store }) : mod;
      if (typeof mod.registerIpc === 'function') mod.registerIpc(ctx.ipcMain, { settings: store });
      loaded.set(def.id, instance);
      ctx.log?.(`[feature] ${def.id}（${def.title}）已载入`);
    } catch (error) {
      ctx.log?.(`[feature] ${def.id} 载入失败:`, error);
    }
  }
  // 统一的功能清单 IPC：前端不需要知道有哪些功能
  ctx.ipcMain.handle('features:list', async () =>
    available.map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description || '',
      prefix: f.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
    })),
  );

  return {
    /** 取某个功能的实例 */
    get(id) {
      return loaded.get(id) || null;
    },
    /** 功能清单（给界面用） */
    list() {
      return available.map((f) => ({
        id: f.id,
        title: f.title,
        description: f.description || '',
        // IPC 前缀由 id 推导：safari-repair → safariRepair
        prefix: f.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
      }));
    },
    /** 统一卸载 */
    disposeAll() {
      for (const [id, instance] of loaded) {
        try {
          instance?.dispose?.();
        } catch (_) {
          /* ignore */
        }
        ctx.log?.(`[feature] ${id} 已卸载`);
      }
      loaded.clear();
    },
  };
}

/** 把通用设置存储切成某个功能的命名空间 */
function makeNamespace(settings, featureId) {
  if (!settings) {
    return { get: (_k, fallback) => fallback, set: () => {} };
  }
  return {
    get(key, fallback) {
      const ns = settings.namespace(featureId);
      return key in ns ? ns[key] : fallback;
    },
    set(key, value) {
      settings.setNamespace(featureId, key, value);
    },
  };
}

module.exports = { FEATURES, loadFeatures, availableFeatures, isPlatformAvailable };
