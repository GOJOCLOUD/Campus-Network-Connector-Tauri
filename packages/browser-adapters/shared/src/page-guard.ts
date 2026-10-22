/**
 * 页面内守卫（Safari 方案：原生 App 通过 Apple Events 注入本脚本到网页）。
 *
 * 与扩展的 content-isolated 相比，本脚本**在页面自己的上下文里**运行，
 * 因此可以：
 *   - 在 window 捕获阶段抢在网页之前处理 copy
 *   - 用 stopImmediatePropagation 阻断同阶段的后注册监听器
 *   - 直接改写 clipboardData 并 preventDefault，让浏览器提交修复后的内容
 *
 * 职责划分（重要）：
 *   页面**不做字形识别**。它只做两件事：
 *     1) 采集选区，按字体作用域分组，收集"这一段用了哪个字体、哪些字符"
 *     2) 把该作用域对应的 @font-face 字体文件（data: 内嵌或 URL）一并上报
 *   字形识别在 App 侧完成：App 用与参考库**同一套栅格化器**解析字体文件，
 *   再与参考字形库比对。页面用 canvas 渲染字形再回传位图会因为渲染器不同
 *   导致相似度不足、误判（实测把「专」判成「令」），所以不这么做。
 *
 * 幂等：重复注入不会叠加监听器（用 window.__copyRepairGuard 哨兵 + 版本号）。
 */

import { COMMON_CHARSET } from './common-charset';

const GUARD_VERSION = 6;

export interface PageGuardOptions {
  /** 页面暴露给 App 的接口名 */
  apiName?: string;
}

const API = '__copyRepairGuard';

interface GuardState {
  version: number;
  installedAt: number;
  pending: PendingBatch | null;
  /** 按字体作用域保存的映射：scopeKey -> { 底层字符: 可见字符 } */
  mappings: Record<string, Record<string, string>>;
  /** 字符 → 它所属的字体作用域（一个选区里可能混着普通字与混淆字） */
  charScopes: Record<string, string>;
  /** 卸载函数（版本升级时移除旧监听器，避免重复处理） */
  uninstall?: () => void;
  log: Array<{ at: number; event: string; data?: unknown }>;
  repairs: number;
  copyEvents: number;
  lastSelectionText: string;
  /** copy 事件派发期间为 true；原表示意文本（null = 未接管） */
  guardActive: boolean;
  intentText: string | null;
  /** 上次采集的选区文本，用于避免重复渲染 */
  lastCollectedText: string;
  lastCollectedScope: string;
  /** 停用标志：置 true 后守卫不再做任何事（用于清理误注入） */
  disabled: boolean;
  /** 内部调用标志：护栏不得拦截我们自己的 preventDefault/setData */
  internalCall: boolean;
  /** 最近一次复制的诊断信息（作用域、片段、没查到的字） */
  lastCopyDebug?: {
    at: number;
    text: string;
    pieces: Array<{ scopeKey: string; len: number; head: string }>;
    mappingKeys: string[];
    misses: string[];
  };
}

interface PendingBatch {
  /** 按字体作用域分组：每个分组带上字体信息 */
  groups: Array<{
    scopeKey: string;
    /** 作用域的字体族（完整 font-family 列表） */
    family: string;
    /** 作用域的字体样式/字重（用于挑对应的 @font-face 文件） */
    style: string;
    weight: string;
    /** 选区里出现过的字符（去重）；预热时为空 */
    chars: string[];
    /** 该作用域对应的字体文件（App 侧解析） */
    font: FontSource | null;
    /** true = 这是"预热"上报（页面扫描来的，与选区无关） */
    prefetch?: boolean;
  }>;
}

/** 字体文件来源：data: 内嵌（base64）或可下载的 URL */
interface FontSource {
  kind: 'data' | 'url';
  /** kind='data' 时是 base64 载荷；kind='url' 时是完整 URL */
  value: string;
}

declare global {
  interface Window {
    [API]?: GuardState;
  }
}

function log(state: GuardState, event: string, data?: unknown): void {
  state.log.push({ at: Date.now(), event, data });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

/** 把 font-family 列表拆成数组，正确处理引号内的逗号（如 local("PingFang,SC")） */
function splitFamilies(fontFamily: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote = '';
  for (const ch of fontFamily) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** 归一化字体族名：去掉引号、转小写、去掉空格 */
function normalizeFamily(name: string): string {
  return name.replace(/["']/g, '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 找到某个字体族对应的 @font-face 源。
 *
 * 页面的 @font-face 可能来自：
 *   - 同源样式表（document.styleSheets 里可读）
 *   - 内联 <style>（同样在 document.styleSheets 里，type=3）
 *   - 跨源样式表（读不到 → 返回 null，App 侧可改用 Resource Timing 里的 URL）
 *
 * 只支持两种可解析来源：
 *   - data:application/font-ttf;base64,...  → 直接把 base64 交给 App
 *   - 普通 url(...)                         → 交给 App 去下载（App 无跨域限制）
 * local(...) / eot / svg 一律视为不可用。
 */
function resolveFontSource(family: string, fontStyle: string, fontWeight: string): FontSource | null {
  const families = splitFamilies(family).map(normalizeFamily);
  if (families.length === 0) return null;
  const target = families[0];

  let sheets: CSSStyleSheet[] = [];
  try {
    sheets = Array.from(document.styleSheets);
  } catch (_) {
    return null;
  }

  // 收集同族的所有规则
  const candidates: Array<{ src: string; weight: string; style: string }> = [];
  for (const sheet of sheets) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      continue; // 跨源样式表，读不到
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      if ((rule as CSSFontFaceRule).type !== 5) continue;
      const face = rule as CSSFontFaceRule;
      const faceFamily = normalizeFamily(face.style?.fontFamily || '');
      if (faceFamily !== target) continue;
      const src = face.style?.getPropertyValue('src') || '';
      if (!src) continue;
      candidates.push({
        src,
        weight: String(face.style?.fontWeight || 'normal').trim().toLowerCase(),
        style: String(face.style?.fontStyle || 'normal').trim().toLowerCase(),
      });
    }
  }
  if (candidates.length === 0) return null;

  // 同一字体族可能有多条 @font-face（不同字重各一个文件）。
  // 必须按作用域的字重/字形挑对应那条，否则 700 字重的密文字
  // 会拿 400 的字形去比，必然判错。
  const wantWeight = String(fontWeight || '400').trim().toLowerCase();
  const wantStyle = String(fontStyle || 'normal').trim().toLowerCase();
  const weightRank = (w: string): number => {
    if (w === wantWeight) return 0;
    const range = w.match(/^(\d+)\s+(\d+)$/);
    if (range) {
      const n = Number(wantWeight);
      if (Number.isFinite(n) && n >= Number(range[1]) && n <= Number(range[2])) return 1;
    }
    if (w === 'normal' && (wantWeight === '400' || wantWeight === 'normal')) return 2;
    if (w === 'bold' && (wantWeight === '700' || wantWeight === 'bold')) return 2;
    return 3;
  };
  const styleRank = (st: string): number => (st === wantStyle ? 0 : 1);

  const ranked = candidates
    .map((c, index) => ({ c, index, rank: weightRank(c.weight) * 10 + styleRank(c.style) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);

  for (const item of ranked) {
    const found = pickFontUrl(item.c.src);
    if (found) return found;
  }
  return null;
}

/** 从 src 描述里挑一个 App 能用的字体文件来源 */
function pickFontUrl(src: string): FontSource | null {
  const urls = src.match(/url\(([^)]+)\)/g) || [];
  for (const raw of urls) {
    const value = raw.slice(4, -1).trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    if (/^data:/i.test(value)) {
      const m = value.match(/base64,([^,]+)$/i);
      if (m) return { kind: 'data', value: m[1] };
      continue;
    }
    if (/\.eot(\?|$)/i.test(value)) continue;
    if (/local\(/i.test(value)) continue;
    // 相对路径要解析成绝对 URL：App 侧（Node）没有页面上下文，解析不了相对地址
    try {
      const absolute = new URL(value, document.baseURI).href;
      return { kind: 'url', value: absolute };
    } catch (_) {
      continue;
    }
  }
  return null;
}

/**
 * 字体来源的短指纹（FNV-1a）。
 *
 * 站点换字体时字体族名往往**不变**（还是 `font-cxsecret`），但里面的字形换了。
 * 如果作用域 key 只用字体族，旧字体的映射会残留下来；新字体里同一个码位含义
 * 不同时就会写出错字。把字体内容指纹并进作用域 key，换字体 = 换作用域 = 重新映射。
 */
function fontFingerprint(font: FontSource | null): string {
  if (!font) return 'nofont';
  let hash = 0x811c9dc5;
  const source = font.kind + ':' + font.value;
  // base64 可能十几 KB，取样哈希足够区分不同字体，又不至于每次遍历整串
  const step = Math.max(1, Math.floor(source.length / 512));
  for (let i = 0; i < source.length; i += step) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return font.kind + hash.toString(36);
}

/**
 * 预热：扫描本页所有**自定义字体**（有 @font-face 规则的字体族），
 * 不需要选区就把它们上报，App 侧随即把映射建好。
 *
 * 为什么要预热：否则用户切到标签页后马上复制，映射还没下发（要等一两轮），
 * 复制出来的还是乱码。预热后 **复制零等待**。
 */
function collectPrefetchScopes(): PendingBatch['groups'] {
  const groups: PendingBatch['groups'] = [];
  const seen = new Set<string>();
  let elements: Element[] = [];
  try {
    elements = Array.from(document.querySelectorAll('*'));
  } catch (_) {
    return groups;
  }
  for (const el of elements) {
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const st = window.getComputedStyle(el);
    const base = `${st.fontStyle}|${st.fontWeight}|${st.fontFamily}`;
    if (seen.has(base)) continue;
    seen.add(base);
    const font = resolveFontSource(st.fontFamily, st.fontStyle, st.fontWeight);
    if (!font) continue; // 系统字体，没有 @font-face，不需要管
    groups.push({
      scopeKey: `${base}#${fontFingerprint(font)}`,
      family: st.fontFamily,
      style: st.fontStyle,
      weight: st.fontWeight,
      chars: [],
      font,
      prefetch: true,
    });
  }
  return groups;
}

/** 取当前选区的文本与"按字体作用域分段的字符" */
function collectSelection(): {
  text: string;
  runs: Array<{ text: string; scope: string; family: string; style: string; weight: string; chars: string[] }>;
} | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const root = range.commonAncestorContainer;
  const container = root.nodeType === Node.TEXT_NODE ? root.parentElement ?? root : (root as Element);
  if (!container) return null;

  const runs: Array<{ text: string; scope: string; family: string; style: string; weight: string; chars: string[] }> = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    if (parent && !isHidden(parent)) {
      const style = window.getComputedStyle(parent);
      const scope = `${style.fontStyle}|${style.fontWeight}|${style.fontFamily}`;
      let run = runs[runs.length - 1];
      if (!run || run.scope !== scope) {
        run = { text: '', scope, family: style.fontFamily, style: style.fontStyle, weight: style.fontWeight, chars: [] };
        runs.push(run);
      }
      run.text += textNode.data;
      for (const char of textNode.data) {
        if (char === '\n' || char === '\r' || char === '\t' || char === ' ') continue;
        if (run.chars.indexOf(char) < 0) run.chars.push(char);
      }
    }
    node = walker.nextNode();
  }
  return { text, runs };
}

/**
 * 页面若在同源 iframe 内，把采集结果上报给顶层的 bridge，
 * 让主进程只跟顶层打交道就能看到 iframe 里的选区与复制。
 */
function reportToTop(state: GuardState, kind: 'pending', payload: unknown): void {
  try {
    if (window.top === window) return;
    // 逐级 parent 上溯（同源才行），把事件汇总到顶层 bridge
    let win: any = window;
    for (let i = 0; i < 8; i += 1) {
      try {
        const bridge = win.__copyRepairBridge;
        if (bridge && typeof bridge.report === 'function') {
          bridge.report(kind, payload, window);
          return;
        }
        if (!win.parent || win.parent === win) return;
        win = win.parent;
      } catch (_) {
        return; // 跨源边界，放弃上报
      }
    }
  } catch (_) {
    /* ignore */
  }
}

function isHidden(element: Element): boolean {
  const style = window.getComputedStyle(element);
  return style.display === 'none' || style.visibility === 'hidden';
}

/**
 * 选区里的一段文字：**它自己的文本 + 它自己所属的字体作用域**。
 *
 * 为什么必须**按段(逐个文本节点)**而不是按字符：
 *   混淆字体的密文码位恰恰是**常用字**（天/地/问/水/土…）。
 *   同一个字在一次选区里可能出现两次：一次用混淆字体（该字被画成别的字），
 *   一次用普通字体（该字就是它自己）。
 *   若按"字符身份"做全局映射（一个字只能对应一个作用域），
 *   另一处就会被**一起改掉** → 复制出**错字**。
 *   实测（generality 用例 s2-obf-first）：期望「人天」，实际「人人」——普通那处被改错了。
 */
interface SelectionPiece {
  /** 该文本节点落在选区里的原文 */
  text: string;
  /** 该文本节点所属的字体作用域 key（与 App 下发映射时用的公式一致） */
  scopeKey: string;
}

/** 取某个文本节点落在选区里的那一段 */
function selectedTextOf(range: Range, textNode: Text): string {
  try {
    const sub = range.cloneRange();
    sub.selectNodeContents(textNode);
    // 把 sub 裁剪到 range 之内
    if (sub.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
      sub.setStart(range.startContainer, range.startOffset);
    }
    if (sub.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
      sub.setEnd(range.endContainer, range.endOffset);
    }
    return sub.toString();
  } catch (_) {
    return '';
  }
}

/**
 * 复制时**当场**按当前选区算出「每一段文字属于哪个字体作用域」。
 *
 * 两个必须当场的理由：
 *   ① 采集缓存（charScopes）比复制慢一拍 —— 用户改选区后立刻 Cmd+C，
 *      新选区里的密文字还没进缓存 → 查表落空 → 原样进剪贴板。
 *      真实故障：测验页复制，前半句（早先选过的）修好了，后半句（刚选到的）仍是密文。
 *   ② 必须**按出现位置**判定，不能按字符身份（见 SelectionPiece 的注释）。
 */
function collectSelectionPieces(): SelectionPiece[] {
  const pieces: SelectionPiece[] = [];
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return pieces;
  let range: Range;
  try {
    range = selection.getRangeAt(0);
  } catch (_) {
    return pieces;
  }
  const root = range.commonAncestorContainer;
  const container = root.nodeType === Node.TEXT_NODE ? (root.parentElement ?? root) : (root as Element);
  if (!container) return pieces;

  // 同一个 base scope 只解析一次字体来源（resolveFontSource 要遍历样式表，不便宜）
  const fontByBase = new Map<string, FontSource | null>();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    if (parent && !isHidden(parent)) {
      let selected = '';
      try {
        if (range.intersectsNode(textNode)) selected = selectedTextOf(range, textNode);
      } catch (_) {
        selected = '';
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
          scopeKey: `${base}#${fontFingerprint(font)}`,
        });
      }
    }
    node = walker.nextNode();
  }
  return pieces;
}

/**
 * 按"每段文字各自的作用域"把选区文本换成可见文字。
 *
 * baseText 是浏览器自己的选区文本（含块之间的换行等分隔符），
 * 我们把每一段对齐到它自己的位置后逐段替换。
 *
 * **对齐必须忽略空白差异**：
 *   浏览器的 selection.toString() 是"渲染后的文本"，空白按 CSS 折叠；
 *   而文本节点的原文里带着制表符、缩进换行。
 *   直接拿原文去找，必然对不上（实测：整页选中时第一段就断 → 整页都没还原）。
 *   所以匹配时只比对**非空白字符**，空白一律当分隔符；
 *   输出的骨架仍是浏览器那份（换行、缩进都保留）。
 *
 * 对不上的部分**原样保留**（宁可留密文，也不猜）。
 */
function applyMappingByPieces(
  state: GuardState,
  baseText: string,
  pieces: SelectionPiece[],
): { text: string; changed: number } {
  if (Object.keys(state.mappings).length === 0) return { text: baseText, changed: 0 };
  if (!pieces.length) return { text: baseText, changed: 0 };

  // base 拆成 code point，并记下"非空白字符"在哪
  const baseUnits: string[] = [];
  const baseContentIdx: number[] = [];
  let unitIdx = 0;
  for (const ch of baseText) {
    if (!isSpaceChar(ch)) baseContentIdx.push(unitIdx);
    baseUnits.push(ch);
    unitIdx += 1;
  }

  const out = baseUnits.slice();
  const baseContentChars = baseContentIdx.map((i) => baseUnits[i]);
  let changed = 0;
  let contentPos = 0; // 下一个片段在 base 的"非空白字符"序列里的起点

  for (const piece of pieces) {
    // 片段的非空白字符
    const pieceChars: string[] = [];
    let pUnit = 0;
    for (const ch of piece.text) {
      if (!isSpaceChar(ch)) pieceChars.push(ch);
      pUnit += 1;
    }
    void pUnit;
    if (!pieceChars.length) continue;
    const start = findSequence(baseContentChars, pieceChars, contentPos);
    if (start < 0) {
      // 对不上 → 剩下的原样保留（不猜，宁可留密文）
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
  return { text: out.join(''), changed };
}

/** 是否是空白字符（与浏览器的空白折叠规则一致：含 NBSP 等 Unicode 空白） */
function isSpaceChar(ch: string): boolean {
  return /\s/.test(ch);
}

/** 在 hay 里从 from 开始找 needle 的起始下标，找不到返回 -1 */
function findSequence(hay: string[], needle: string[], from: number): number {
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

/**
 * 采集当前选区，按字体作用域分组上报。
 *
 * 每组带上：该作用域的字体族、出现过的字符、以及对应的 @font-face 字体来源。
 * App 侧拿到字体文件后自己解析并比对，页面不参与字形识别。
 */
function collectAndStage(state: GuardState): 'new' | 'same' | 'none' {
  if (state.disabled) return 'none';

  // 先自愈下层 frame 的守卫：站点重建 iframe document 时守卫会丢，
  // 而顶层 DOM 的 MutationObserver 察觉不到**跨文档**的变化。
  // 必须放在任何 early return 之前 —— 顶层自己通常没有选区。
  try {
    const bridge = (window as unknown as Record<string, any>).__copyRepairBridge;
    if (bridge && typeof bridge.selfHeal === 'function') {
      const healed = bridge.selfHeal();
      if (healed) log(state, 'self-heal', { healed });
    }
  } catch (_) {
    /* ignore */
  }

  const collected = collectSelection();
  // 预热扫描总是做（实测 13ms）：把本页所有自定义字体都报上去，
  // App 侧把映射提前建好 → 用户什么时候复制都不用等。
  const prefetch = collectPrefetchScopes();
  if (!collected) {
    if (prefetch.length === 0) return 'none';
    state.pending = { groups: prefetch };
    log(state, 'prefetch', { groups: prefetch.length });
    reportToTop(state, 'pending', { groups: prefetch });
    return 'new';
  }
  state.lastSelectionText = collected.text;

  const groups = new Map<string, { scopeKey: string; family: string; style: string; weight: string; chars: string[] }>();
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
  if (groups.size === 0) return 'none';

  state.lastCollectedText = collected.text;
  state.lastCollectedScope = collected.runs[0]?.scope ?? '';

  const pendingGroups: PendingBatch['groups'] = [];
  const activeScopes = new Set<string>();
  const charToScope = new Map<string, string>();
  for (const group of groups.values()) {
    const font = resolveFontSource(group.family, group.style, group.weight);
    // 作用域 key 带上字体内容指纹：站点换字体 → 新作用域 → 重新映射，
    // 不会拿旧字体的映射去套新字体。
    const scopeKey = `${group.scopeKey}#${fontFingerprint(font)}`;
    pendingGroups.push({
      scopeKey,
      family: group.family,
      style: group.style,
      weight: group.weight,
      chars: group.chars,
      font,
    });
    activeScopes.add(scopeKey);
    for (const char of group.chars) {
      if (!charToScope.has(char)) charToScope.set(char, scopeKey);
    }
  }

  // 同一字体族换了字体（指纹变了）时，删掉旧指纹留下的映射，避免旧表越积越多
  const currentByBase = new Map<string, string>();
  for (const scope of activeScopes) currentByBase.set(scope.split('#')[0], scope);
  for (const key of Object.keys(state.mappings)) {
    if (activeScopes.has(key)) continue;
    const current = currentByBase.get(key.split('#')[0]);
    if (current && current !== key) delete state.mappings[key];
  }
  // 字符 → 作用域：旧的（已失效）作用域要改指到当前作用域，否则查表会落空
  for (const [char, scope] of Object.entries(state.charScopes)) {
    if (activeScopes.has(scope)) continue;
    const next = charToScope.get(char);
    if (next && next !== scope) state.charScopes[char] = next;
  }
  for (const [char, scope] of charToScope) {
    if (!state.charScopes[char]) state.charScopes[char] = scope;
  }

  // 预热分组与选区分组按 scopeKey 去重（选区里的优先，带上字符）
  for (const g of prefetch) {
    if (activeScopes.has(g.scopeKey)) continue;
    activeScopes.add(g.scopeKey);
    pendingGroups.push(g);
  }
  if (pendingGroups.length === 0) return 'none';

  state.pending = { groups: pendingGroups };
  log(state, 'pending', {
    groups: pendingGroups.length,
    chars: pendingGroups.reduce((n, g) => n + g.chars.length, 0),
    fonts: pendingGroups.map((g) => (g.font ? g.font.kind : 'none')),
    prefetch: pendingGroups.filter((g) => g.prefetch).length,
  });
  reportToTop(state, 'pending', { groups: pendingGroups });
  return 'new';
}

function install(): GuardState {
  const existing = window[API];
  if (existing) {
    if (existing.version === GUARD_VERSION) {
      // 走 log() 而不是直接 push —— 否则绕过 200 条上限，
      // 重注入每 1.5 秒一次，日志会一直涨
      log(existing, 'reinjected-skipped');
      return existing;
    }
    // 旧版本：先卸载再重装，避免重复监听导致重复处理
    try {
      existing.uninstall?.();
    } catch (_) {
      /* ignore */
    }
    existing.log.push({ at: Date.now(), event: 'upgraded' });
  }

  const state: GuardState = {
    version: GUARD_VERSION,
    installedAt: Date.now(),
    pending: null,
    mappings: {},
    charScopes: {},
    log: [],
    repairs: 0,
    copyEvents: 0,
    lastSelectionText: '',
    lastCollectedText: '',
    lastCollectedScope: '',
    disabled: false,
    guardActive: false,
    intentText: null,
    internalCall: false,
  };
  window[API] = state;
  log(state, 'installed');

  // ---- 选区变化：采集并上报，等 App 回传映射 ----
  const onSelectionChange = () => {
    try {
      collectAndStage(state);
    } catch (error) {
      log(state, 'selection-error', { error: String(error) });
    }
  };
  document.addEventListener('selectionchange', onSelectionChange, true);

  // ---- 原型护栏 ----
  // 网页的脚本先于我们执行注册，其 window 捕获监听器**先注册者先执行**，
  // 靠监听器顺序我们抢不过。因此额外 patch 原型：
  // 页面与守卫在同一个 JS 世界里，网页后续调用 e.preventDefault /
  // e.clipboardData.setData 时会走到被 patch 的方法，我们据此拦截。
  const restorePrototypes = installPrototypeGuards(state);

  // ---- 复制拦截：window 捕获阶段 ----
  const onCopy = (event: ClipboardEvent) => {
    if (state.disabled) return;
    state.copyEvents += 1;
    const selection = window.getSelection();
    const text = selection ? selection.toString() : '';
    // 作用域**当场**按当前选区解析：不依赖采集缓存，避免"刚改的选区还没采集就复制"；
    // 并且**按出现位置(逐个文本节点)**判定，避免同一个字在两个作用域时互相污染。
    // 没有下发的映射时不必解析（applyMappingByPieces 会直接原样返回）
    const pieces = Object.keys(state.mappings).length > 0 ? collectSelectionPieces() : [];
    let result = applyMappingByPieces(state, text, pieces);
    // 诊断：记下这次复制查的是哪个作用域、哪些字没查到映射
    state.lastCopyDebug = {
      at: Date.now(),
      text: text.slice(0, 60),
      pieces: pieces.map((p) => ({ scopeKey: p.scopeKey, len: p.text.length, head: p.text.slice(0, 16) })),
      mappingKeys: Object.keys(state.mappings),
      misses: [...text].filter((c) => {
        const piece = pieces.find((p) => p.text.includes(c));
        return piece && !(state.mappings[piece.scopeKey] || {})[c];
      }),
    };
    if (result.changed === 0) {
      // 没有可信映射 → 什么都不做，**保留原始复制**
      // （绝不取消默认动作后写空：那样用户会拿到空剪贴板）
      log(state, 'copy-no-mapping', { text: text.slice(0, 40) });
      return;
    }
    // 接管本次复制：先写修复文本，再 preventDefault（浏览器据此提交我们写的内容）
    state.intentText = result.text;
    state.guardActive = true;
    state.internalCall = true;
    try {
      // WebKit 的 clipboardData 不是 DataTransfer 实例，原型 patch 对它无效
      // （实测：网页在 document 阶段 setData 能覆盖我们的写入）。
      // 因此改用事件层面的阻断：
      //   stopImmediatePropagation —— 挡掉 window 上后注册的监听器
      //   stopPropagation         —— 挡掉继续向 document / target 传播
      // 这样网页的 document 捕获/冒泡监听器根本不会执行。
      event.stopImmediatePropagation();
      event.stopPropagation();
      event.clipboardData?.setData('text/plain', result.text);
      event.preventDefault();
      state.repairs += 1;
      log(state, 'copy-repaired', {
        changed: result.changed,
        text: result.text.slice(0, 40),
      });
    } finally {
      state.internalCall = false;
      state.guardActive = false;
      state.intentText = null;
    }
  };
  window.addEventListener('copy', onCopy, true);

  // 装好就预热：不依赖选区，先把本页的自定义字体报上去，
  // App 侧随即把映射建好 → 用户切到标签页马上复制也不用等。
  try {
    collectAndStage(state);
  } catch (error) {
    log(state, 'prefetch-error', { error: String(error) });
  }

  state.uninstall = () => {
    document.removeEventListener('selectionchange', onSelectionChange, true);
    window.removeEventListener('copy', onCopy, true);
    // 原型必须还原：否则重装一次就多套一层 wrapper
    try {
      restorePrototypes();
    } catch (_) {
      /* ignore */
    }
  };
  return state;
}

/**
 * 原型护栏：只在 copy 事件派发期间生效，且只针对 text/plain，
 * 避免影响网页的正常编辑行为。
 */
function installPrototypeGuards(state: GuardState): () => void {
  const proto = Event.prototype as unknown as {
    preventDefault: () => void;
  };
  const originalPreventDefault = proto.preventDefault;
  proto.preventDefault = function preventDefault(this: Event): void {
    // 我们自己调用时必须放行：否则事件永远不会被取消，
    // 浏览器会提交原始选区而不是我们写入的修复文本（实测踩过）。
    if (state.internalCall) {
      return originalPreventDefault.call(this);
    }
    if (state.guardActive && this.type === 'copy' && state.intentText !== null) {
      log(state, 'guard:blocked-preventDefault');
      return;
    }
    return originalPreventDefault.call(this);
  };

  const transferProto = DataTransfer.prototype as unknown as {
    setData: (format: string, data: string) => void;
    clearData: (format?: string) => void;
  };
  const originalSetData = transferProto.setData;
  transferProto.setData = function setData(this: DataTransfer, format: string, data: string): void {
    if (state.internalCall) {
      return originalSetData.call(this, format, data);
    }
    if (
      state.guardActive &&
      String(format).toLowerCase() === 'text/plain' &&
      state.intentText !== null &&
      data !== state.intentText
    ) {
      log(state, 'guard:blocked-setData', { length: data.length });
      return;
    }
    return originalSetData.call(this, format, data);
  };

  const originalClearData = transferProto.clearData;
  transferProto.clearData = function clearData(this: DataTransfer, format?: string): void {
    if (
      state.guardActive &&
      state.intentText !== null &&
      (format === undefined || String(format).toLowerCase() === 'text/plain')
    ) {
      log(state, 'guard:blocked-clearData');
      return;
    }
    return originalClearData.call(this, format);
  };

  // 还原原型（重装守卫时调用，避免层层套 wrapper）
  return () => {
    proto.preventDefault = originalPreventDefault;
    transferProto.setData = originalSetData;
    transferProto.clearData = originalClearData;
  };
}

export function installPageGuard(): GuardState {
  return install();
}

if (typeof window !== 'undefined') {
  // 注入即安装（幂等：重复注入只会被 install() 内部的哨兵拦下）
  (window as unknown as Record<string, unknown>).__copyRepairInstall = installPageGuard;
  (window as unknown as Record<string, unknown>).__copyRepairDisable = () => {
    const state = window[API];
    if (!state) return 'NO-GUARD';
    state.disabled = true;
    state.mappings = {};
    state.pending = null;
    log(state, 'disabled');
    return 'OK';
  };
  (window as unknown as Record<string, unknown>).__copyRepairSetMapping = (
    scopeKey: string,
    mapping: Record<string, string>,
  ) => {
    const state = window[API];
    if (!state) return 'NO-GUARD';
    // 合并而不是覆盖：密文→明文是**字体的属性**，不随选区变化。
    // 只保留本次上报过的字，避免选区变化时把已知的映射弄丢。
    state.mappings[scopeKey] = { ...(state.mappings[scopeKey] || {}), ...(mapping || {}) };
    return 'OK';
  };
  (window as unknown as Record<string, unknown>).__copyRepairCollect = () => {
    const state = window[API];
    if (!state) return 'none';
    return collectAndStage(state);
  };
  installPageGuard();
}
