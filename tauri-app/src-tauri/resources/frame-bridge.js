(() => {
  // packages/browser-adapters/shared/src/frame-bridge.ts
  function installFrameBridge(options) {
    const guardSource = options.guardSource;
    const globalScope = window;
    const pending = [];
    const unrepaired = [];
    const bridge = {
      pending,
      unrepaired,
      report(kind, payload, frame) {
        if (kind === "pending") {
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
        scan();
        const collected = pending.splice(0, pending.length);
        const collectedUnrepaired = unrepaired.splice(0, unrepaired.length);
        const all = framesInjected.slice();
        all.push(window);
        for (const frame of all) {
          try {
            const g = frame.__copyRepairGuard;
            if (!g) continue;
            try {
              if (typeof frame.__copyRepairCollect === "function") {
                frame.__copyRepairCollect();
              }
            } catch (_) {
            }
            if (g.pending && g.pending.groups && g.pending.groups.length > 0) {
              collected.push({ groups: g.pending.groups });
              g.pending = null;
              g.lastCollectedText = "";
              g.lastCollectedScope = "";
            }
          } catch (_) {
          }
        }
        return { pending: collected, unrepaired: collectedUnrepaired };
      },
      /** 把映射分发到所有 frame（顶层自己也设一份） */
      setMapping(scopeKey, mapping) {
        scan();
        let count = 0;
        const topApi = globalScope.__copyRepairSetMapping;
        if (typeof topApi === "function") {
          topApi(scopeKey, mapping);
          count += 1;
        }
        for (const frame of framesInjected) {
          try {
            const api = frame.__copyRepairSetMapping;
            if (typeof api === "function") {
              api(scopeKey, mapping);
              count += 1;
            }
          } catch (_) {
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
        const info = [];
        for (const frame of framesInjected) {
          try {
            const g = frame.__copyRepairGuard;
            info.push({
              hasGuard: !!g,
              pending: g && g.pending && g.pending.groups ? g.pending.groups.length : null,
              hasCollect: typeof frame.__copyRepairCollect === "function"
            });
          } catch (e) {
            info.push({ err: String(e) });
          }
        }
        return { count: framesInjected.length, info };
      }
    };
    const framesInjected = [];
    function injectInto(frameWin) {
      if (!frameWin || frameWin === window) return;
      try {
        if (framesInjected.indexOf(frameWin) >= 0) {
          if (frameWin.__copyRepairGuard) return;
        }
        frameWin.eval(guardSource);
        if (frameWin.__copyRepairGuard) {
          const at = framesInjected.indexOf(frameWin);
          if (at >= 0) framesInjected[at] = frameWin;
          else framesInjected.push(frameWin);
        }
      } catch (_) {
      }
    }
    function selfHeal() {
      scan();
      let healed = 0;
      for (const frame of framesInjected.slice()) {
        try {
          if (!frame.__copyRepairGuard) {
            frame.eval(guardSource);
            if (frame.__copyRepairGuard) healed += 1;
          }
        } catch (_) {
        }
      }
      return healed;
    }
    function scan() {
      const current = [];
      const visit = (win, depth) => {
        if (!win || depth > 8) return;
        injectInto(win);
        try {
          const list = win.document.querySelectorAll("iframe");
          for (let i = 0; i < list.length; i += 1) {
            const child = list[i].contentWindow;
            if (child) current.push(child);
            visit(child, depth + 1);
          }
        } catch (_) {
        }
      };
      visit(window, 0);
      for (let i = framesInjected.length - 1; i >= 0; i -= 1) {
        if (current.indexOf(framesInjected[i]) < 0) framesInjected.splice(i, 1);
      }
    }
    globalScope.__copyRepairBridge = bridge;
    scan();
    try {
      const observer = new MutationObserver(() => {
        scan();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      globalScope.__copyRepairObserver = observer;
    } catch (_) {
    }
    return "OK";
  }
  if (typeof window !== "undefined") {
    window.__copyRepairInstallFrameBridge = installFrameBridge;
  }
})();
