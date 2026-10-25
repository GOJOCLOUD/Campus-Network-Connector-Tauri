/**
 * 顶层桥：把守卫注入到所有**同源 iframe**，并汇总它们上报的事件。
 *
 * 学习通之类的考试页把题目放在同源 iframe 里，copy 事件在 iframe 文档内派发，
 * 顶层页面收不到；只注入顶层等于没注入。
 *
 * 由主进程在注入顶层守卫之后追加执行。
 */

export interface FrameBridgeOptions {
  /** 守卫源码（会被注入到每个同源 iframe 内） */
  guardSource: string;
}

export function installFrameBridge(options: FrameBridgeOptions): string {
  const guardSource = options.guardSource;
  const globalScope = window as unknown as Record<string, any>;
  // 注意：这里**不能**在已存在时 early-return。
  // 旧 bridge 实例里的 framesInjected 只含第一层 frame，
  // 复用它会让深层 frame 永远进不了收集范围（真实页面的选区在第 4 层）。
  // 每次注入都重建 bridge，并重新递归扫描。

  const pending: Array<{ groups: any[] }> = [];
  const unrepaired: Array<{ text: string; scopeKey: string; at: number }> = [];

  /**
   * 队列上限。
   *
   * 为什么需要：App 还没确认过的作用域**每一轮都会重报**（这样 App 丢了一次
   * 也能很快补上），而 App 不取走时（App 没开 / 卡住）这个数组只进不出。
   * 不设上限就会在页面里无限涨。
   */
  const MAX_QUEUE = 64;

  const bridge = {
    pending,
    unrepaired,
    report(kind: 'pending' | 'unrepaired', payload: any, frame: Window) {
      if (kind === 'pending') {
        pending.push({ groups: payload.groups });
        if (pending.length > MAX_QUEUE) pending.splice(0, pending.length - MAX_QUEUE);
      } else {
        unrepaired.push(payload);
        if (unrepaired.length > MAX_QUEUE) unrepaired.splice(0, unrepaired.length - MAX_QUEUE);
      }
    },
    /**
     * 从所有已注入的 frame（以及顶层）收集待处理位图与"未修复的复制"，然后清空。
     *
     * 由顶层主动去读各 frame —— 顶层访问同源 iframe 是可靠的，
     * 比让 iframe 反向访问 top 更稳。
     */
    /**
     * 从**所有层级**的 frame 收集待处理位图。
     * 主动驱动各 frame 采集（selectionchange 在程序化选区时可能不触发）。
     */
    take() {
      // **先重扫**:frame 名单必须是用之前的当前状态。
      // 站点会在**嵌套 frame 内部**换 iframe(SPA 换题),
      // 而顶层的 MutationObserver **看不见**嵌套里的变化 →
      // 名单一旦过期,映射就发不到真正有题目的那层 →
      // 那一层复制出来还是密文(2026-10-23 真机故障)。
      scan();
      const collected = pending.splice(0, pending.length);
      const collectedUnrepaired = unrepaired.splice(0, unrepaired.length);
      const all = framesInjected.slice();
      all.push(window as unknown as Window);
      for (const frame of all) {
        try {
          const g = (frame as any).__copyRepairGuard;
          if (!g) continue;
          try {
            if (typeof (frame as any).__copyRepairCollect === 'function') {
              (frame as any).__copyRepairCollect();
            }
          } catch (_) {
            /* ignore */
          }
          if (g.pending && g.pending.groups && g.pending.groups.length > 0) {
            // 不要把 frame（Window 对象）放进结果：JSON.stringify 遇循环引用会直接抛错
            collected.push({ groups: g.pending.groups });
            g.pending = null;
            // 关键：pending 被消费后必须清掉"已采集"标记，
            // 否则守卫会因为"选区没变"而不再重新生成 pending，主进程就永远拿不到。
            g.lastCollectedText = '';
            g.lastCollectedScope = '';
          }
        } catch (_) {
          /* 跨源 frame 忽略 */
        }
      }
      return { pending: dedupeByScope(collected), unrepaired: collectedUnrepaired };
    },
    /** 把映射分发到所有 frame（顶层自己也设一份） */
    setMapping(scopeKey: string, mapping: Record<string, string>) {
      // **先重扫**:分发必须打到**当前**的 frame 上。
      // 名单过期时,映射会发到上一套 iframe(已经变 about:blank 的那些),
      // 真正在显示题目的那层反而拿不到 → 复制出来还是密文。
      scan();
      let count = 0;
      // 注意：API 挂在 window 上（不是 state 对象上）
      const topApi = globalScope.__copyRepairSetMapping;
      if (typeof topApi === 'function') {
        topApi(scopeKey, mapping);
        count += 1;
      }
      for (const frame of framesInjected) {
        try {
          const api = (frame as any).__copyRepairSetMapping;
          if (typeof api === 'function') {
            api(scopeKey, mapping);
            count += 1;
          }
        } catch (_) {
          /* 跨源 frame 忽略 */
        }
      }
      return count;
    },
    /**
     * 让**所有 frame（含顶层）**把已知的作用域重新报一遍。
     *
     * ## 为什么必须广播到 frame
     *
     * 真正带混淆字体的往往是**嵌套 frame**（学习通是第 3~4 层），
     * 每一层各有各的守卫、各自的账本。只喊顶层等于没喊 ——
     * 顶层通常压根没有自定义字体，它那边清账本没有任何效果。
     *
     * ## 为什么要"重新报"
     *
     * 守卫"App 已经送达到就不上报"这条规则是按**页面里的账本**算的，
     * 而 App 是另一个进程：App 重启后自己手里是空的，
     * 页面却还留着上一任 App 下发的映射 → 守卫觉得"不用报" →
     * App 永远学不到这个作用域 → 不登记这个标签 → **快通道是瞎的** →
     * 换题后只能等主通道那一圈（~1.2 秒）→ 用户"换题立刻复制"复制出密文。
     *
     * 重报**不会**清掉页面上的映射（那本账是"页面能不能修复复制"），
     * 所以这段时间里用户复制照样拿到明文。
     */
    resync() {
      // 先重扫：新 frame 可能还没进名单（站点换题会重建 iframe）。
      scan();
      let count = 0;
      const all = framesInjected.slice();
      all.push(window as unknown as Window);
      for (const frame of all) {
        try {
          const api = (frame as any).__copyRepairResync;
          if (typeof api === 'function') {
            api();
            count += 1;
          }
        } catch (_) {
          /* 跨源 frame 忽略 */
        }
      }
      return count;
    },
    rescan() {
      scan();
    },
    /** 补注入守卫已丢失的 frame（站点重建 iframe document 时用） */
    selfHeal() {
      return selfHeal();
    },
    /** 诊断：已注入的 frame 列表与各自的 pending 情况 */
    debug() {
      const info: any[] = [];
      for (const frame of framesInjected) {
        try {
          const g = (frame as any).__copyRepairGuard;
          info.push({
            hasGuard: !!g,
            pending: g && g.pending && g.pending.groups ? g.pending.groups.length : null,
            hasCollect: typeof (frame as any).__copyRepairCollect === 'function',
          });
        } catch (e) {
          info.push({ err: String(e) });
        }
      }
      return { count: framesInjected.length, info };
    },
  };

  const framesInjected: Window[] = [];

  /**
   * 同一批作用域可能**从两条路**进到队列里：
   *   1. 守卫自己上报到 bridge 的 pending 数组（reportToTop）
   *   2. 守卫自己把分组挂在 `state.pending` 上（take() 里再收一次）
   * 两条路都收 → 主进程会把**同一个作用域处理两遍**：
   * 重新建一次映射、下发一次（一次 Apple Event ≈110ms）。
   * 实测一轮 330ms 里有 220ms 花在重复下发上。
   *
   * 作用域 key 里带了字体内容指纹，所以同一个 key 就是**同一份映射**，
   * 去重不会丢信息（下发是广播给所有 frame 的，发一次就够）。
   */
  function dedupeByScope(items: Array<{ groups: any[] }>): Array<{ groups: any[] }> {
    const seen = new Set<string>();
    const out: Array<{ groups: any[] }> = [];
    for (const item of items) {
      const groups = (item && item.groups) || [];
      const fresh = groups.filter((g: any) => {
        const key = g && g.scopeKey;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length > 0) out.push({ groups: fresh });
    }
    return out;
  }

  function injectInto(frameWin: Window | null): void {
    if (!frameWin || frameWin === window) return;
    try {
      // **不能**只看"这个 frame 我注入过没有"：
      // 站点重新渲染题目区域时会换掉 iframe 的 document，
      // WindowProxy 还是同一个、但 document 已经是新的 —— 守卫早没了，
      // 而旧逻辑以为不用再注入 → 该 frame 永远没有守卫 → 复制不被修复。
      // 所以要看 frame 里**现在**有没有守卫。
      if (framesInjected.indexOf(frameWin) >= 0) {
        if ((frameWin as any).__copyRepairGuard) return; // 守卫还在，跳过
      }
      (frameWin as any).eval(guardSource);
      if ((frameWin as any).__copyRepairGuard) {
        const at = framesInjected.indexOf(frameWin);
        if (at >= 0) framesInjected[at] = frameWin;
        else framesInjected.push(frameWin);
      }
    } catch (_) {
      /* 跨源或未就绪 */
    }
  }

  /**
   * 自愈：重新扫描 DOM，并给"守卫已丢失"的 frame 补注入。
   *
   * 站点换题/刷新题目区域会重建 iframe 的 document，守卫随之消失。
   * 顶层 DOM 的 MutationObserver 察觉不到**跨文档**的变化，
   * 所以必须由顶层主动逐个 frame 检查。
   */
  function selfHeal(): number {
    scan();
    let healed = 0;
    for (const frame of framesInjected.slice()) {
      try {
        if (!(frame as any).__copyRepairGuard) {
          (frame as any).eval(guardSource);
          if ((frame as any).__copyRepairGuard) healed += 1;
        }
      } catch (_) {
        /* frame 已销毁 */
      }
    }
    return healed;
  }

  /**
   * 递归注入所有**同源** frame（不限层级）。
   * 真实目标页面的选区在第 4 层嵌套 frame 里，只扫第一层会完全漏掉。
   */
  function scan(): void {
    // 本轮**当前树**里的 frame —— 用来把过期条目从名单里清掉
    const current: Window[] = [];
    const visit = (win: Window | null, depth: number): void => {
      if (!win || depth > 8) return;
      injectInto(win);
      try {
        const list = win.document.querySelectorAll('iframe');
        for (let i = 0; i < list.length; i += 1) {
          const child = list[i].contentWindow;
          if (child) current.push(child);
          visit(child, depth + 1);
        }
      } catch (_) {
        /* 跨源 frame 忽略 */
      }
    };
    visit(window, 0);
    // 站点重建 iframe 之后,旧 frame 已经不在页面里了 ——
    // 留在名单里只会让映射白发给一堆 about:blank,而且越攒越多。
    for (let i = framesInjected.length - 1; i >= 0; i -= 1) {
      if (current.indexOf(framesInjected[i]) < 0) framesInjected.splice(i, 1);
    }
  }

  globalScope.__copyRepairBridge = bridge;
  scan();

  // iframe 动态创建/导航后重新注入
  try {
    const observer = new MutationObserver(() => {
      scan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    globalScope.__copyRepairObserver = observer;
  } catch (_) {
    /* ignore */
  }

  return 'OK';
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__copyRepairInstallFrameBridge = installFrameBridge;
}
