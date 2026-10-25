(() => {
  // packages/browser-adapters/shared/src/frame-bridge.ts
  function installFrameBridge(options) {
    const guardSource = options.guardSource;
    const globalScope = window;
    const pending = [];
    const unrepaired = [];
    const MAX_QUEUE = 64;
    const bridge = {
      pending,
      unrepaired,
      report(kind, payload, frame) {
        if (kind === "pending") {
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
        return { pending: dedupeByScope(collected), unrepaired: collectedUnrepaired };
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
        scan();
        let count = 0;
        const all = framesInjected.slice();
        all.push(window);
        for (const frame of all) {
          try {
            const api = frame.__copyRepairResync;
            if (typeof api === "function") {
              api();
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
    function dedupeByScope(items) {
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const item of items) {
        const groups = item && item.groups || [];
        const fresh = groups.filter((g) => {
          const key = g && g.scopeKey;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (fresh.length > 0) out.push({ groups: fresh });
      }
      return out;
    }
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
