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

  const bridge = {
    pending,
    unrepaired,
    report(kind: 'pending' | 'unrepaired', payload: any, frame: Window) {
      if (kind === 'pending') {
        pending.push({ groups: payload.groups });
      } else {
        unrepaired.push(payload);
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
      return { pending: collected, unrepaired: collectedUnrepaired };
    },
    /** 把映射分发到所有 frame（顶层自己也设一份） */
    setMapping(scopeKey: string, mapping: Record<string, string>) {
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
            pending: g && g.pending ? g.pending.chars.length : null,
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
    const visit = (win: Window | null, depth: number): void => {
      if (!win || depth > 8) return;
      injectInto(win);
      try {
        const list = win.document.querySelectorAll('iframe');
        for (let i = 0; i < list.length; i += 1) {
          visit(list[i].contentWindow, depth + 1);
        }
      } catch (_) {
        /* 跨源 frame 忽略 */
      }
    };
    visit(window, 0);
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
