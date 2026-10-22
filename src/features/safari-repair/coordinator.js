/**
 * 注入协调器：决定"何时、向哪个标签页注入"，并把字体的对照表下发到页面。
 *
 * 设计约束（来自实机实验结论）：
 *  - 真实 Cmd+C 会在**选区所在的那个文档**里派发 isTrusted=true 的 copy 事件；
 *    目标页面的选区可能在**第 4 层嵌套 frame**里 → 必须**递归**注入所有同源 frame。
 *  - 事件到达 window 捕获阶段时 defaultPrevented=false → 守卫可以抢先。
 *  - **绝不在主进程事后改写系统剪贴板**：没有可信映射时，守卫完全不动，
 *    浏览器照常提交原始复制（失败就保留原始复制，绝不取消默认动作后写空）。
 *
 * 调度策略：
 *  - 每次都处理**前台标签**（用户正在用的那个）。
 *  - 额外**看住**那些出现过混淆字体的标签：它们的守卫容易被 iframe 重新加载冲掉，
 *    而且用户随时可能切回去复制 → 每隔几轮就复查一次并保持映射是热的。
 *  - 守卫装好就**预热**（不需要选区就把该页的自定义字体报上来），
 *    App 侧提前把映射建好 → 用户切到标签页马上复制也**不用等**。
 */
const fs = require('fs');
const { existsSync } = require('fs');
const paths = require('./paths');
const { SafariBridge } = require('./bridge');
const { GlyphEngine } = require('./engine');

const DEFAULT_INTERVAL_MS = 300;
const MAX_BACKOFF_MS = 15000;
/** 每隔几轮复查一次"被看住的标签" */
const WATCH_EVERY_ROUNDS = 10;
/** 每隔几轮处理一次"命中目标站点"的标签 */
const SITE_TAB_EVERY_ROUNDS = 2;
/** 同一个标签连续几轮没有守卫就强制重注入 */
const FORCE_INJECT_EVERY = 5;
/**
 * 带混淆字体的标签：**单独快速轮询**的间隔（毫秒）。
 *
 * 为什么要有这条：换题后站点会换一套新的加密字体，新字体的映射需要
 * 「发现 → 解析 → 下发」这一圈。主轮次一圈要轮询多个标签（每个标签一次
 * Apple Event，实测一圈 ~1.4 秒），用户**切完题马上复制**时映射还没就绪 →
 * 剪贴板里是原始密文（实测：换题后 1956ms 才正确）。
 * 所以把这些标签从主轮次里拎出来，用一个独立的快轮询盯着（~200ms 一轮），
 * 换题后约 0.5 秒就能复制正确。
 */
const CIPHER_TAB_POLL_MS = 200;

class InjectorCoordinator {
  constructor({ log, intervalMs, guardPath, dbPath, targetTabIndex = null, onWatch = null, siteFilter = [] } = {}) {
    this.log = log || (() => {});
    this.intervalMs = intervalMs || DEFAULT_INTERVAL_MS;
    // 目标标签：null = 用户当前的前台标签（生产默认）；测试可指定具体标签
    this.targetTabIndex = targetTabIndex;
    this.guardSource = fs.readFileSync(
      guardPath || paths.vendor('page-guard.js'),
      'utf8',
    );
    const frameBridgePath = paths.vendor('frame-bridge.js');
    this.frameBridgeSource = existsSync(frameBridgePath)
      ? fs.readFileSync(frameBridgePath, 'utf8')
      : '';
    /** 看住的标签变化时的回调（用来持久化，重启后能立刻找回） */
    this.onWatch = onWatch;
    /**
     * 目标站点 URL 片段：匹配的标签**始终**被接管，不管它是不是前台标签。
     * 只看"前台标签"是不够的 —— 用户可能在别的标签上操作，
     * 或者页面换题后目标标签不再在前台，功能就"看起来坏了"。
     */
    this.siteFilter = (siteFilter || []).map(String).filter(Boolean);
    this.bridge = new SafariBridge({ log: this.log });
    this.engine = new GlyphEngine({ dbPath, log: this.log });
    this.timer = null;
    this.enabled = false;
    this.running = false;
    this.backoffUntil = 0;
    /** 被看住的标签：tabIndex -> { url, ticksSinceInject } */
    this.watched = new Map();
    /** 已经打过日志的失败原因（scopeKey|reason），避免每轮重复刷同一句 */
    this.loggedReasons = new Set();
    /** 带混淆字体的标签（key -> {tabIndex, windowIndex, url}），走快轮询 */
    this.cipherTabs = new Map();
    /** 快轮询的定时器 */
    this.fastTimer = null;
    this.fastRunning = false;
    this.state = {
      running: false,
      injected: false,
      safariRunning: false,
      safariFrontmost: false,
      lastError: '',
      lastTickAt: 0,
      injections: 0,
      mappings: 0,
      unresolved: 0,
      ticks: 0,
      watchedTabs: 0,
    };
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) this.start();
    else this.stop();
    this.log(`Safari 复制修复：${this.enabled ? '已启用' : '已停用'}`);
    return this.enabled;
  }

  /** 启动快轮询（只盯带混淆字体的标签） */
  startFastPoll() {
    if (this.fastTimer) return;
    this.fastTimer = setInterval(() => {
      this.fastTick().catch(() => {
        /* ignore */
      });
    }, CIPHER_TAB_POLL_MS);
    if (this.fastTimer.unref) this.fastTimer.unref();
  }

  stopFastPoll() {
    if (this.fastTimer) {
      clearInterval(this.fastTimer);
      this.fastTimer = null;
    }
  }

  start() {
    if (this.timer) return;
    this.startFastPoll();
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.state.lastError = String(error && error.message ? error.message : error);
      });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopFastPoll();
    this.running = false;
    this.state.running = false;
    this.state.injected = false;
  }

  /** 登记一个"出现过混淆字体"的标签，之后持续看住它 */
  watchTab(tabIndex, url, windowIndex = null) {
    const key =
      tabIndex === null || tabIndex === undefined
        ? 'front'
        : windowIndex
          ? `w${windowIndex}t${tabIndex}`
          : String(tabIndex);
    const existing = this.watched.get(key);
    if (existing && existing.url === url) return;
    this.watched.set(key, { url: url || '', ticksSinceInject: 0, tabIndex, windowIndex });
    this.state.watchedTabs = this.watched.size;
    this.log(`看住标签 ${key}${url ? '（' + url.slice(0, 60) + '）' : ''}`);
    this.persistWatch();
  }

  /** 把"看住的标签"交给上层持久化（重启后立刻能找回，不用等它再成为前台标签） */
  persistWatch() {
    if (!this.onWatch) return;
    try {
      this.onWatch(this.getWatchedUrls());
    } catch (_) {
      /* ignore */
    }
  }

  getWatchedUrls() {
    return [...this.watched.values()].map((info) => info.url).filter(Boolean);
  }

  /** 恢复之前看住的标签（按 URL 重新找索引） */
  async restoreWatched(urls) {
    for (const url of urls || []) {
      if (!url) continue;
      const index = await this.bridge.findTabByUrl(url);
      if (index > 0) {
        this.watched.set(String(index), { url, ticksSinceInject: 0, tabIndex: index, windowIndex: null });
      }
    }
    this.state.watchedTabs = this.watched.size;
    if (this.watched.size) {
      this.log(`恢复看住的标签 ${this.watched.size} 个`);
    }
  }

  /**
   * 本轮要处理哪些标签。
   *  - 前台标签：每轮都处理（用户正在用的）
   *  - 命中目标站点的标签：每 SITE_TAB_EVERY_ROUNDS 轮处理一次（不依赖它在前台）
   *  - 之前"看住"过的标签：兜底
   */
  async planJobs() {
    const jobs = [{ tabIndex: this.targetTabIndex, windowIndex: null, key: 'front' }];
    const seen = new Set(['front']);

    if (this.siteFilter.length && this.state.ticks % SITE_TAB_EVERY_ROUNDS === 0) {
      const tabs = await this.bridge.listTabs();
      for (const tab of tabs) {
        if (!this.siteFilter.some((f) => tab.url.includes(f))) continue;
        const key = `w${tab.window}t${tab.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({ tabIndex: tab.index, windowIndex: tab.window, key });
      }
    }

    if (this.state.ticks % WATCH_EVERY_ROUNDS === 0) {
      for (const [key, info] of this.watched) {
        if (key === 'front' || seen.has(key)) continue;
        // 带混淆字体的标签由快轮询负责，这里不重复
        if (this.cipherTabs.has(key)) continue;
        jobs.push({ tabIndex: info && info.tabIndex != null ? info.tabIndex : Number(key), windowIndex: info ? info.windowIndex : null, key });
      }
    }
    return jobs;
  }

  /**
   * 快轮询：只处理"带混淆字体的标签"。
   *
   * 用户换题后往往**立刻**选中复制，这一轮必须尽快把新字体的映射下发，
   * 否则剪贴板里就是原始密文（用户看到的就是"乱七八糟"）。
   * 它独立于主轮次（不共用 running 标志），否则主轮次一圈 1.4 秒会把快轮询饿死。
   */
  async fastTick() {
    if (!this.enabled || this.fastRunning || !this.cipherTabs.size) return;
    this.fastRunning = true;
    try {
      for (const [key, info] of [...this.cipherTabs]) {
        try {
          const r = await this.processTab(info.tabIndex, info.windowIndex, key);
          if (process.env.CR_DEBUG) {
            this.log('fastPoll ' + key + ' => ' + JSON.stringify(r) + ' @' + Date.now() % 100000);
          }
        } catch (err) {
          this.log('fastPoll ' + key + ' 出错: ' + String(err && err.message ? err.message : err));
        }
      }
    } finally {
      this.fastRunning = false;
    }
  }

  /** 处理一个标签：轮询状态 → 必要时注入 → 消费待处理队列并下发映射 */
  async processTab(tabIndex, windowIndex = null, jobKey = null) {
    const state = await this.bridge.pollState({ tabIndex, windowIndex });
    if (process.env.CR_DEBUG) {
      this.log('pollState => ' + JSON.stringify(state).slice(0, 260));
    }
    if (state.collect === 'evaluate-failed') {
      this.state.lastError = 'Safari 不可用，或未开启「允许来自 Apple Events 的 JavaScript」';
      this.backoffUntil = Date.now() + MAX_BACKOFF_MS;
      this.state.injected = false;
      return { action: 'evaluate-failed' };
    }

    // 标签可能被关掉/换位 → 用 URL 校验
    const watchKey = tabIndex === null || tabIndex === undefined ? 'front' : tabIndex;
    const watchInfo = this.watched.get(watchKey);
    if (watchInfo && state.url && watchInfo.url && state.url !== watchInfo.url) {
      this.watched.delete(watchKey);
      this.state.watchedTabs = this.watched.size;
    }

    // 守卫不在 → 注入（顶层 + 递归所有同源 frame）
    const tabState = watchInfo || { ticksSinceInject: 0 };
    tabState.ticksSinceInject = (tabState.ticksSinceInject || 0) + 1;
    const forceInject = tabState.ticksSinceInject >= FORCE_INJECT_EVERY;
    if (!state.guard || forceInject) {
      tabState.ticksSinceInject = 0;
      try {
        await this.bridge.injectGuard(this.guardSource, {
          tabIndex,
          windowIndex,
          frameBridgeSource: this.frameBridgeSource,
        });
        this.state.injections += 1;
        this.state.injected = true;
        if (tabIndex === this.targetTabIndex) {
          this.log('已向当前标签页注入页面守卫（含所有同源 frame）');
        }
      } catch (error) {
        this.state.lastError = String(error && error.message ? error.message : error);
        this.backoffUntil = Date.now() + MAX_BACKOFF_MS;
        return { action: 'inject-failed' };
      }
    } else {
      this.state.injected = true;
    }
    if (watchInfo) this.watched.set(watchKey, tabState);

    // 待处理队列：顶层自己的 + 各层 frame 上报的
    // 每个 item 是 { groups: [{ scopeKey, chars, font }] }，一个选区可能含多个字体作用域
    const queue = [];
    if (state.pending && state.pending.groups && state.pending.groups.length > 0) {
      queue.push(state.pending);
    }
    if (Array.isArray(state.frames)) {
      for (const item of state.frames) {
        if (item && item.groups && item.groups.length > 0) queue.push(item);
      }
    }

    let mapped = 0;
    for (const item of queue) {
      for (const group of item.groups) {
        // 页面只上报「字体 + 字符」，字形识别在 App 侧用字体文件完成
        const result = await this.engine.processScope(group.scopeKey, group.chars, group.font, {
          prefetch: group.prefetch === true,
        });
        this.state.mappings = Object.keys(result.mapping).length;
        this.state.unresolved = result.unresolved;
        // 失败原因**只打一次**:同一个作用域每轮都会重复上报,
        // 像图标字体取不到(404)这种会每轮刷一遍同样的日志,噪声很大。
        let reasonText = '';
        if (result.reason) {
          const reasonKey = group.scopeKey + '|' + result.reason;
          if (!this.loggedReasons.has(reasonKey)) {
            this.loggedReasons.add(reasonKey);
            reasonText = `（${result.reason}）`;
          }
        }
        this.log(
          `作用域 ${group.scopeKey.slice(0, 60)}：${result.obfuscated ? '混淆字体' : '普通字体'}，` +
            `映射 ${Object.keys(result.mapping).length} 个，未还原 ${result.unresolved} 个` +
            reasonText,
        );
        // 出现自定义字体 → 这个标签值得持续看住
        if (group.font) {
          this.watchTab(tabIndex, state.url, windowIndex);
          // 而且要**快轮询**：换题后新字体的映射必须尽快就绪，
          // 否则用户"切完题立刻复制"拿到的是原始密文。
          const ckey = jobKey || (tabIndex === null || tabIndex === undefined ? 'front' : `w${windowIndex || 1}t${tabIndex}`);
          this.cipherTabs.set(ckey, { tabIndex, windowIndex, url: state.url });
        }
        const setResult = await this.bridge.setMapping(group.scopeKey, result.mapping, { tabIndex, windowIndex });
        if (process.env.CR_DEBUG) this.log('setMapping => ' + JSON.stringify(setResult));
        if (!setResult || setResult === 'FAILED' || String(setResult).indexOf('NO-') === 0) {
          this.state.lastError = '映射下发失败: ' + setResult;
        }
        mapped += 1;
      }
    }
    return { action: mapped === 0 ? 'idle' : 'mapped', count: mapped };
  }

  /** 一轮调度（异步，不阻塞主进程）。 */
  async tick(_options = {}) {
    this.state.lastTickAt = Date.now();
    this.state.ticks += 1;
    if (!this.enabled) return { action: 'disabled' };
    if (this.running) return { action: 'busy' };
    if (Date.now() < this.backoffUntil) return { action: 'backoff' };

    this.running = true;
    this.state.running = true;
    try {
      let mapped = 0;
      let action = 'idle';
      for (const job of await this.planJobs()) {
        const r = await this.processTab(job.tabIndex, job.windowIndex, job.key);
        if (r.action === 'evaluate-failed') return r;
        if (r.action === 'inject-failed') return r;
        if (r.count) {
          mapped += r.count;
          action = 'mapped';
        }
      }
      if (mapped === 0) return { action };
      return { action, count: mapped };
    } finally {
      this.running = false;
      this.state.running = false;
    }
  }

  getStatus() {
    return { ...this.state, enabled: this.enabled, ...this.engine.stats() };
  }
}

module.exports = { InjectorCoordinator, DEFAULT_INTERVAL_MS, WATCH_EVERY_ROUNDS };
