(() => {
  // packages/browser-adapters/shared/src/page-guard.ts
  var GUARD_VERSION = 6;
  var API = "__copyRepairGuard";
  function log(state, event, data) {
    state.log.push({ at: Date.now(), event, data });
    if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  }
  function splitFamilies(fontFamily) {
    const out = [];
    let current = "";
    let quote = "";
    for (const ch of fontFamily) {
      if (quote) {
        current += ch;
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === ",") {
        if (current.trim()) out.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  }
  function normalizeFamily(name) {
    return name.replace(/["']/g, "").replace(/\s+/g, "").toLowerCase();
  }
  function resolveFontSource(family, fontStyle, fontWeight) {
    const families = splitFamilies(family).map(normalizeFamily);
    if (families.length === 0) return null;
    const target = families[0];
    let sheets = [];
    try {
      sheets = Array.from(document.styleSheets);
    } catch (_) {
      return null;
    }
    const candidates = [];
    for (const sheet of sheets) {
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue;
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type !== 5) continue;
        const face = rule;
        const faceFamily = normalizeFamily(face.style?.fontFamily || "");
        if (faceFamily !== target) continue;
        const src = face.style?.getPropertyValue("src") || "";
        if (!src) continue;
        candidates.push({
          src,
          weight: String(face.style?.fontWeight || "normal").trim().toLowerCase(),
          style: String(face.style?.fontStyle || "normal").trim().toLowerCase()
        });
      }
    }
    if (candidates.length === 0) return null;
    const wantWeight = String(fontWeight || "400").trim().toLowerCase();
    const wantStyle = String(fontStyle || "normal").trim().toLowerCase();
    const weightRank = (w) => {
      if (w === wantWeight) return 0;
      const range = w.match(/^(\d+)\s+(\d+)$/);
      if (range) {
        const n = Number(wantWeight);
        if (Number.isFinite(n) && n >= Number(range[1]) && n <= Number(range[2])) return 1;
      }
      if (w === "normal" && (wantWeight === "400" || wantWeight === "normal")) return 2;
      if (w === "bold" && (wantWeight === "700" || wantWeight === "bold")) return 2;
      return 3;
    };
    const styleRank = (st) => st === wantStyle ? 0 : 1;
    const ranked = candidates.map((c, index) => ({ c, index, rank: weightRank(c.weight) * 10 + styleRank(c.style) })).sort((a, b) => a.rank - b.rank || a.index - b.index);
    for (const item of ranked) {
      const found = pickFontUrl(item.c.src);
      if (found) return found;
    }
    return null;
  }
  function pickFontUrl(src) {
    const urls = src.match(/url\(([^)]+)\)/g) || [];
    for (const raw of urls) {
      const value = raw.slice(4, -1).trim().replace(/^["']|["']$/g, "");
      if (!value) continue;
      if (/^data:/i.test(value)) {
        const m = value.match(/base64,([^,]+)$/i);
        if (m) return { kind: "data", value: m[1] };
        continue;
      }
      if (/\.eot(\?|$)/i.test(value)) continue;
      if (/local\(/i.test(value)) continue;
      try {
        const absolute = new URL(value, document.baseURI).href;
        return { kind: "url", value: absolute };
      } catch (_) {
        continue;
      }
    }
    return null;
  }
  function fontFingerprint(font) {
    if (!font) return "nofont";
    let hash = 2166136261;
    const source = font.kind + ":" + font.value;
    const step = Math.max(1, Math.floor(source.length / 512));
    for (let i = 0; i < source.length; i += step) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return font.kind + hash.toString(36);
  }
  function collectPrefetchScopes() {
    const groups = [];
    const seen = /* @__PURE__ */ new Set();
    let elements = [];
    try {
      elements = Array.from(document.querySelectorAll("*"));
    } catch (_) {
      return groups;
    }
    for (const el of elements) {
      const text = (el.textContent || "").trim();
      if (!text) continue;
      const st = window.getComputedStyle(el);
      const base = `${st.fontStyle}|${st.fontWeight}|${st.fontFamily}`;
      if (seen.has(base)) continue;
      seen.add(base);
      const font = resolveFontSource(st.fontFamily, st.fontStyle, st.fontWeight);
      if (!font) continue;
      groups.push({
        scopeKey: `${base}#${fontFingerprint(font)}`,
        family: st.fontFamily,
        style: st.fontStyle,
        weight: st.fontWeight,
        chars: [],
        font,
        prefetch: true
      });
    }
    return groups;
  }
  function collectSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString();
    if (!text) return null;
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const container = root.nodeType === Node.TEXT_NODE ? root.parentElement ?? root : root;
    if (!container) return null;
    const runs = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const textNode = node;
      const parent = textNode.parentElement;
      if (parent && !isHidden(parent)) {
        const style = window.getComputedStyle(parent);
        const scope = `${style.fontStyle}|${style.fontWeight}|${style.fontFamily}`;
        let run = runs[runs.length - 1];
        if (!run || run.scope !== scope) {
          run = { text: "", scope, family: style.fontFamily, style: style.fontStyle, weight: style.fontWeight, chars: [] };
          runs.push(run);
        }
        run.text += textNode.data;
        for (const char of textNode.data) {
          if (char === "\n" || char === "\r" || char === "	" || char === " ") continue;
          if (run.chars.indexOf(char) < 0) run.chars.push(char);
        }
      }
      node = walker.nextNode();
    }
    return { text, runs };
  }
  function reportToTop(state, kind, payload) {
    try {
      if (window.top === window) return;
      let win = window;
      for (let i = 0; i < 8; i += 1) {
        try {
          const bridge = win.__copyRepairBridge;
          if (bridge && typeof bridge.report === "function") {
            bridge.report(kind, payload, window);
            return;
          }
          if (!win.parent || win.parent === win) return;
          win = win.parent;
        } catch (_) {
          return;
        }
      }
    } catch (_) {
    }
  }
  function isHidden(element) {
    const style = window.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  }
  function selectedTextOf(range, textNode) {
    try {
      const sub = range.cloneRange();
      sub.selectNodeContents(textNode);
      if (sub.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
        sub.setStart(range.startContainer, range.startOffset);
      }
      if (sub.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
        sub.setEnd(range.endContainer, range.endOffset);
      }
      return sub.toString();
    } catch (_) {
      return "";
    }
  }
  function collectSelectionPieces() {
    const pieces = [];
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return pieces;
    let range;
    try {
      range = selection.getRangeAt(0);
    } catch (_) {
      return pieces;
    }
    const root = range.commonAncestorContainer;
    const container = root.nodeType === Node.TEXT_NODE ? root.parentElement ?? root : root;
    if (!container) return pieces;
    const fontByBase = /* @__PURE__ */ new Map();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const textNode = node;
      const parent = textNode.parentElement;
      if (parent && !isHidden(parent)) {
        let selected = "";
        try {
          if (range.intersectsNode(textNode)) selected = selectedTextOf(range, textNode);
        } catch (_) {
          selected = "";
        }
        if (selected) {
          const style = window.getComputedStyle(parent);
          const base = `${style.fontStyle}|${style.fontWeight}|${style.fontFamily}`;
          if (!fontByBase.has(base)) {
            fontByBase.set(base, resolveFontSource(style.fontFamily, style.fontStyle, style.fontWeight));
          }
          const font = fontByBase.get(base) ?? null;
          pieces.push({
            text: selected,
            // 与 collectAndStage 用的是**同一个**作用域 key 公式，App 下发的表才对得上
            scopeKey: `${base}#${fontFingerprint(font)}`
          });
        }
      }
      node = walker.nextNode();
    }
    return pieces;
  }
  function applyMappingByPieces(state, baseText, pieces) {
    if (Object.keys(state.mappings).length === 0) return { text: baseText, changed: 0 };
    if (!pieces.length) return { text: baseText, changed: 0 };
    const baseUnits = [];
    const baseContentIdx = [];
    let unitIdx = 0;
    for (const ch of baseText) {
      if (!isSpaceChar(ch)) baseContentIdx.push(unitIdx);
      baseUnits.push(ch);
      unitIdx += 1;
    }
    const out = baseUnits.slice();
    const baseContentChars = baseContentIdx.map((i) => baseUnits[i]);
    let changed = 0;
    let contentPos = 0;
    for (const piece of pieces) {
      const pieceChars = [];
      let pUnit = 0;
      for (const ch of piece.text) {
        if (!isSpaceChar(ch)) pieceChars.push(ch);
        pUnit += 1;
      }
      void pUnit;
      if (!pieceChars.length) continue;
      const start = findSequence(baseContentChars, pieceChars, contentPos);
      if (start < 0) {
        break;
      }
      const mapping = state.mappings[piece.scopeKey];
      for (let j = 0; j < pieceChars.length; j += 1) {
        const baseUnit = baseContentIdx[start + j];
        const char = baseUnits[baseUnit];
        const mapped = mapping ? mapping[char] : null;
        if (mapped && mapped !== char) {
          out[baseUnit] = mapped;
          changed += 1;
        }
      }
      contentPos = start + pieceChars.length;
    }
    return { text: out.join(""), changed };
  }
  function isSpaceChar(ch) {
    return /\s/.test(ch);
  }
  function findSequence(hay, needle, from) {
    if (!needle.length) return from;
    const limit = hay.length - needle.length;
    for (let i = Math.max(0, from); i <= limit; i += 1) {
      let ok = true;
      for (let j = 0; j < needle.length; j += 1) {
        if (hay[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  }
  function collectAndStage(state) {
    if (state.disabled) return "none";
    try {
      const bridge = window.__copyRepairBridge;
      if (bridge && typeof bridge.selfHeal === "function") {
        const healed = bridge.selfHeal();
        if (healed) log(state, "self-heal", { healed });
      }
    } catch (_) {
    }
    const collected = collectSelection();
    const prefetch = collectPrefetchScopes();
    if (!collected) {
      if (prefetch.length === 0) return "none";
      state.pending = { groups: prefetch };
      log(state, "prefetch", { groups: prefetch.length });
      reportToTop(state, "pending", { groups: prefetch });
      return "new";
    }
    state.lastSelectionText = collected.text;
    const groups = /* @__PURE__ */ new Map();
    for (const run of collected.runs) {
      let group = groups.get(run.scope);
      if (!group) {
        group = { scopeKey: run.scope, family: run.family, style: run.style, weight: run.weight, chars: [] };
        groups.set(run.scope, group);
      }
      for (const char of run.chars) {
        if (group.chars.indexOf(char) < 0) group.chars.push(char);
      }
    }
    if (groups.size === 0) return "none";
    state.lastCollectedText = collected.text;
    state.lastCollectedScope = collected.runs[0]?.scope ?? "";
    const pendingGroups = [];
    const activeScopes = /* @__PURE__ */ new Set();
    const charToScope = /* @__PURE__ */ new Map();
    for (const group of groups.values()) {
      const font = resolveFontSource(group.family, group.style, group.weight);
      const scopeKey = `${group.scopeKey}#${fontFingerprint(font)}`;
      pendingGroups.push({
        scopeKey,
        family: group.family,
        style: group.style,
        weight: group.weight,
        chars: group.chars,
        font
      });
      activeScopes.add(scopeKey);
      for (const char of group.chars) {
        if (!charToScope.has(char)) charToScope.set(char, scopeKey);
      }
    }
    const currentByBase = /* @__PURE__ */ new Map();
    for (const scope of activeScopes) currentByBase.set(scope.split("#")[0], scope);
    for (const key of Object.keys(state.mappings)) {
      if (activeScopes.has(key)) continue;
      const current = currentByBase.get(key.split("#")[0]);
      if (current && current !== key) delete state.mappings[key];
    }
    for (const [char, scope] of Object.entries(state.charScopes)) {
      if (activeScopes.has(scope)) continue;
      const next = charToScope.get(char);
      if (next && next !== scope) state.charScopes[char] = next;
    }
    for (const [char, scope] of charToScope) {
      if (!state.charScopes[char]) state.charScopes[char] = scope;
    }
    for (const g of prefetch) {
      if (activeScopes.has(g.scopeKey)) continue;
      activeScopes.add(g.scopeKey);
      pendingGroups.push(g);
    }
    if (pendingGroups.length === 0) return "none";
    state.pending = { groups: pendingGroups };
    log(state, "pending", {
      groups: pendingGroups.length,
      chars: pendingGroups.reduce((n, g) => n + g.chars.length, 0),
      fonts: pendingGroups.map((g) => g.font ? g.font.kind : "none"),
      prefetch: pendingGroups.filter((g) => g.prefetch).length
    });
    reportToTop(state, "pending", { groups: pendingGroups });
    return "new";
  }
  function install() {
    const existing = window[API];
    if (existing) {
      if (existing.version === GUARD_VERSION) {
        log(existing, "reinjected-skipped");
        return existing;
      }
      try {
        existing.uninstall?.();
      } catch (_) {
      }
      existing.log.push({ at: Date.now(), event: "upgraded" });
    }
    const state = {
      version: GUARD_VERSION,
      installedAt: Date.now(),
      pending: null,
      mappings: {},
      charScopes: {},
      log: [],
      repairs: 0,
      copyEvents: 0,
      lastSelectionText: "",
      lastCollectedText: "",
      lastCollectedScope: "",
      disabled: false,
      guardActive: false,
      intentText: null,
      internalCall: false
    };
    window[API] = state;
    log(state, "installed");
    const onSelectionChange = () => {
      try {
        collectAndStage(state);
      } catch (error) {
        log(state, "selection-error", { error: String(error) });
      }
    };
    document.addEventListener("selectionchange", onSelectionChange, true);
    const restorePrototypes = installPrototypeGuards(state);
    const onCopy = (event) => {
      if (state.disabled) return;
      state.copyEvents += 1;
      const selection = window.getSelection();
      const text = selection ? selection.toString() : "";
      const pieces = Object.keys(state.mappings).length > 0 ? collectSelectionPieces() : [];
      let result = applyMappingByPieces(state, text, pieces);
      state.lastCopyDebug = {
        at: Date.now(),
        text: text.slice(0, 60),
        pieces: pieces.map((p) => ({ scopeKey: p.scopeKey, len: p.text.length, head: p.text.slice(0, 16) })),
        mappingKeys: Object.keys(state.mappings),
        misses: [...text].filter((c) => {
          const piece = pieces.find((p) => p.text.includes(c));
          return piece && !(state.mappings[piece.scopeKey] || {})[c];
        })
      };
      if (result.changed === 0) {
        log(state, "copy-no-mapping", { text: text.slice(0, 40) });
        return;
      }
      state.intentText = result.text;
      state.guardActive = true;
      state.internalCall = true;
      try {
        event.stopImmediatePropagation();
        event.stopPropagation();
        event.clipboardData?.setData("text/plain", result.text);
        event.preventDefault();
        state.repairs += 1;
        log(state, "copy-repaired", {
          changed: result.changed,
          text: result.text.slice(0, 40)
        });
      } finally {
        state.internalCall = false;
        state.guardActive = false;
        state.intentText = null;
      }
    };
    window.addEventListener("copy", onCopy, true);
    try {
      collectAndStage(state);
    } catch (error) {
      log(state, "prefetch-error", { error: String(error) });
    }
    state.uninstall = () => {
      document.removeEventListener("selectionchange", onSelectionChange, true);
      window.removeEventListener("copy", onCopy, true);
      try {
        restorePrototypes();
      } catch (_) {
      }
    };
    return state;
  }
  function installPrototypeGuards(state) {
    const proto = Event.prototype;
    const originalPreventDefault = proto.preventDefault;
    proto.preventDefault = function preventDefault() {
      if (state.internalCall) {
        return originalPreventDefault.call(this);
      }
      if (state.guardActive && this.type === "copy" && state.intentText !== null) {
        log(state, "guard:blocked-preventDefault");
        return;
      }
      return originalPreventDefault.call(this);
    };
    const transferProto = DataTransfer.prototype;
    const originalSetData = transferProto.setData;
    transferProto.setData = function setData(format, data) {
      if (state.internalCall) {
        return originalSetData.call(this, format, data);
      }
      if (state.guardActive && String(format).toLowerCase() === "text/plain" && state.intentText !== null && data !== state.intentText) {
        log(state, "guard:blocked-setData", { length: data.length });
        return;
      }
      return originalSetData.call(this, format, data);
    };
    const originalClearData = transferProto.clearData;
    transferProto.clearData = function clearData(format) {
      if (state.guardActive && state.intentText !== null && (format === void 0 || String(format).toLowerCase() === "text/plain")) {
        log(state, "guard:blocked-clearData");
        return;
      }
      return originalClearData.call(this, format);
    };
    return () => {
      proto.preventDefault = originalPreventDefault;
      transferProto.setData = originalSetData;
      transferProto.clearData = originalClearData;
    };
  }
  function installPageGuard() {
    return install();
  }
  if (typeof window !== "undefined") {
    window.__copyRepairInstall = installPageGuard;
    window.__copyRepairDisable = () => {
      const state = window[API];
      if (!state) return "NO-GUARD";
      state.disabled = true;
      state.mappings = {};
      state.pending = null;
      log(state, "disabled");
      return "OK";
    };
    window.__copyRepairSetMapping = (scopeKey, mapping) => {
      const state = window[API];
      if (!state) return "NO-GUARD";
      state.mappings[scopeKey] = { ...state.mappings[scopeKey] || {}, ...mapping || {} };
      return "OK";
    };
    window.__copyRepairCollect = () => {
      const state = window[API];
      if (!state) return "none";
      return collectAndStage(state);
    };
    installPageGuard();
  }
})();
