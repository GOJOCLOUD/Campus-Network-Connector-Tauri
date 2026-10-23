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

const GUARD_VERSION = 9;

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
  /** 当前 @font-face 集合的签名（换题 = 混淆字体换了 = 签名变） */
  fontSig: string;
  /**
   * 页面内容**是不是变了**（DOM 增删过）。
   *
   * 为什么不能只看 @font-face 签名：站点的顺序是
   * 「先注入新字体的 @font-face → 再把题目文字渲染出来」，
   * 也就是**字体规则比用到它的元素先到**。
   * 签名在第一次扫描时就已经是新字体的了 → 后面签名再不变 →
   * 「只在字体变了才重扫」这条规则就永远等不到那次重扫 →
   * **新题目的作用域一直没被发现** → 映射没下发 → 用户复制出密文。
   *
   * 实测（2026-10-23 真机）：重载题目那层后，守卫扫了 0 个作用域，
   * 手动把签名清空再扫一次，立刻就发现了（映射随后送达）。
   *
   * 所以触发条件是「字体变了 **或** DOM 变了」。
   */
  domDirty: boolean;
  /** 上次全量扫描时，这个页面上**还挂着**的全部作用域（判断"旧指纹"用） */
  pageScopes: string[];
  /** 上次上报出去的分组（App 一直没送回映射时，重试要靠它的字体来源） */
  reportedGroups: PendingBatch['groups'];
  /** scopeKey → 上次上报的时刻（**仅诊断用**：App 没确认时每一轮都会重报） */
  reportedAt: Record<string, number>;
  /**
   * scopeKey → App 把映射送达这一层的时刻。
   *
   * **为什么不能拿 `mappings` 当"App 已经知道"的判据**：
   * `mappings` 是"页面能不能修复复制"（复制时查表用），`deliveredAt` 才是
   * "App 知不知道这个作用域"（决定要不要重报）。两者在正常运行期一致，
   * 但**App 重启**之后就不一致了：页面还留着上一任 App 下发的映射（复制照样能修），
   * 而新 App 手里是空的 —— 若拿 `mappings` 当判据，页面就永远不会再报，
   * App 永远学不到这个作用域 → 不会登记这个标签 → **快通道是瞎的** →
   * 换题后只能等主通道那一圈（~1.2 秒）→ 用户"换题立刻复制"复制出密文
   * （2026-10-23 真机故障：第 1 次成功、第 2 次失败）。
   */
  deliveredAt: Record<string, number>;
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
 *
 * ## 必须**整份**哈希，不能取样
 *
 * 取样哈希（每 N 个字符取一个）在一对"结构相同、只有字形不同"的字体上会**撞车**
 * ——而站点的混淆字体正是这样生成的：表结构一模一样，只有字形数据不同。
 * 一旦撞车：新字体沿用旧作用域 → 页面不再上报（App 认为"已知"）→
 * 旧映射继续套在新字体上 → **复制出来是错字**（不是密文，是错的字）。
 * 整份哈希 18KB 字符串只要 ~0.1ms，扫描时每个字体算一次，完全可以接受。
 */
function fontFingerprint(font: FontSource | null): string {
  if (!font) return 'nofont';
  return font.kind + hashString(font.kind + ':' + font.value);
}

/**
 * 字符串短哈希（FNV-1a）。
 *
 * 只用来判断"变了没有"，不需要抗碰撞——变了能被发现就行。
 */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 当前页面的 @font-face 集合签名。
 *
 * **为什么需要它**：站点换题时会换掉混淆字体（`font-cxsecret` 的字体文件变了），
 * 作用域指纹随之变化 → 必须重新建映射。而"字体到底变了没有"这件事，
 * **只读 CSSOM 就能知道**，不必去遍历所有元素算 getComputedStyle。
 *
 * 代价：每轮遍历同源样式表里的 @font-face 规则（几十条，微秒级）；
 * 换来的是预热扫描（全元素遍历，约 13ms/帧）**只在字体变了时才做**。
 *
 * src 要**整段参与哈希**：字体文件是 base64 内嵌的，
 * 只看前几百个字符有撞车风险（旧字体与新字体头部可能很像）。
 */
function fontFaceSignature(): string {
  const parts: string[] = [];
  try {
    const sheets = Array.from(document.styleSheets);
    for (const sheet of sheets) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue; // 跨源样式表读不到
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if ((rule as CSSFontFaceRule).type !== 5) continue;
        const style = (rule as CSSFontFaceRule).style;
        if (!style) continue;
        parts.push(
          normalizeFamily(style.getPropertyValue('font-family') || '') +
            '|' + (style.getPropertyValue('font-weight') || '').trim().toLowerCase() +
            '|' + (style.getPropertyValue('font-style') || '').trim().toLowerCase() +
            '|' + hashString(style.getPropertyValue('src') || ''),
        );
      }
    }
  } catch (_) {
    /* ignore */
  }
  parts.sort();
  return parts.join(';');
}

/**
 * 这个作用域要不要上报？
 *
 * 判据是**这一层自己的 deliveredAt**：App 把映射下发回来时会写进
 * `state.deliveredAt[scopeKey]` → 说明 App 已经处理过这个作用域，不必再报。
 *
 * ## 为什么 ack 之前**每一轮都报**
 *
 * 以前这里是"报过但没收到映射 → 冷却 3 秒再试"。那个冷却会造成**致盲**：
 * 报告可能在路上丢掉（frame 被重建、上一任 App 留下的账本、报告被别的东西取走），
 * 而 App 一次都没收到 → 这 3 秒里 App 根本不知道这个作用域存在 →
 * 用户复制就是密文，而 App 明明下一秒就能拿到。
 *
 * 真正的节流靠的是 **ack**，不是计时器：App 一旦把映射送回来，
 * 这一层就不再报（下面解释为什么这样就够）。
 *
 * ## 为什么 ack 之后就不报了
 *
 * App 下发的映射是**按整份字体**建的 —— 字体里每个码位都解了，
 * 整份一起下发（见 engine 的 processScope）。所以后续选区里出现新字，
 * 表里已经有了 → 不需要再报。
 *
 * 为什么必须这样：以前每一轮都把同一批作用域重报一遍，
 * App 就每轮重新建一次映射、下发一次（一次 Apple Event ≈110ms）——
 * 一轮的一半时间都花在**重复下发**上，而映射其实早就到位了。
 * 实测这一项就把一轮从 330ms 压到 110ms。
 *
 * 顺带解决"新 frame"：站点重建题目区域时，那一层的守卫是新的、
 * deliveredAt 是空的 → 它会自然上报 → App 把映射下发到新 frame ✓。
 */
function shouldReportScope(state: GuardState, scopeKey: string): boolean {
  // App 已经确认处理过这个作用域 → 不用再报。
  if (state.deliveredAt && state.deliveredAt[scopeKey]) return false;
  return true;
}

/**
 * 暂存并上报一批作用域。
 *
 * 只上报 App 还没送达到这一层的那部分 —— 其它部分保持"已送达"状态，
 * 不再重复触发 App 的建映射 + 下发。
 */
function stageAndReport(
  state: GuardState,
  groups: PendingBatch['groups'],
  kind: 'prefetch' | 'selection',
): 'new' | 'same' | 'none' {
  // 候选里可能有**重复的作用域**：预热扫描的结果与"上次报过的"合并时，
  // 同一个 scopeKey 会出现两次。两个都会通过 shouldReportScope 的过滤 →
  // App 把同一份映射建两遍、下发两遍（一次 ≈110ms，纯浪费）。
  const unique: PendingBatch['groups'] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    if (!g || seen.has(g.scopeKey)) continue;
    seen.add(g.scopeKey);
    unique.push(g);
  }
  const toReport = unique.filter((g) => shouldReportScope(state, g.scopeKey));
  if (toReport.length === 0) return 'same';
  state.pending = { groups: toReport };
  const now = Date.now();
  // 记住报过的分组：**重试时要用它的字体来源**（不然 App 拿不到字体文件）。
  const keep = new Map<string, PendingBatch['groups'][number]>();
  for (const g of state.reportedGroups) keep.set(g.scopeKey, g);
  for (const g of toReport) {
    // 诊断：这个作用域最后一次上报的时刻。
    state.reportedAt[g.scopeKey] = now;
    keep.set(g.scopeKey, g);
  }
  state.reportedGroups = [...keep.values()].slice(-12);
  log(state, 'pending', {
    kind,
    groups: toReport.length,
    chars: toReport.reduce((n, g) => n + g.chars.length, 0),
    fonts: toReport.map((g) => (g.font ? g.font.kind : 'none')),
    prefetch: toReport.filter((g) => g.prefetch).length,
  });
  reportToTop(state, 'pending', { groups: toReport });
  return 'new';
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
  // **预热扫描：字体变了 **或** 页面内容变了才做**。
  //
  // 以前每一轮都扫（全元素 getComputedStyle，实测 13ms/帧）——
  // 一页有十个 frame 就是 130ms，占掉一整轮的一半时间，
  // 而绝大多数轮次里字体根本没变，扫出来的东西也一模一样。
  //
  // 现在改成：先算 @font-face 集合的签名（只读 CSSOM，微秒级），
  // 签名变了才做全量扫描 —— **换题正好就是签名变了的那一刻**，
  // 于是"新字体的映射提前建好"这件事不受影响，轮次却便宜了一大半。
  //
  // **但只看签名不够**：站点的顺序是「先注入新字体的 @font-face → 再渲染题目文字」，
  // 字体规则比用到它的元素**先到** —— 第一次扫描时签名已经是新字体的了，
  // 之后签名再不变 → 永远等不到那次重扫 → 新题目的作用域一直没被发现
  // （实测：重载题目那层后守卫扫到 0 个作用域，手动清空签名再扫一次立刻发现）。
  // 所以还要看**DOM 变没变**（state.domDirty，由 MutationObserver 置位）。
  const sig = fontFaceSignature();
  const fontsChanged = sig !== state.fontSig;
  state.fontSig = sig;
  const needScan = fontsChanged || state.domDirty;

  // 预热扫描：把本页所有自定义字体都报上去，
  // App 侧把映射提前建好 → 用户什么时候复制都不用等。
  const prefetch = needScan ? collectPrefetchScopes() : [];
  if (needScan) {
    // 记下"这个页面上现在挂着哪些作用域"。
    // 换题之后这个列表就是**新**的 —— 后面判断"哪个是失效的旧指纹"要用它。
    state.pageScopes = prefetch.map((g) => g.scopeKey);
    state.domDirty = false;
  }
  if (!collected) {
    // 候选 = 预热分组 + 上次报过但还没收到映射的（重试）
    const candidates = prefetch.concat(state.reportedGroups);
    if (candidates.length === 0) return 'none';
    return stageAndReport(state, candidates, 'prefetch');
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

  // 预热分组与选区分组按 scopeKey 去重（选区里的优先，带上字符）。
  for (const g of prefetch) {
    if (activeScopes.has(g.scopeKey)) continue;
    activeScopes.add(g.scopeKey);
    pendingGroups.push(g);
  }
  // 上次报过、但 App 一直没把映射送回来的 → 冷却到了就重试
  // （重试要用它自己的字体来源，所以这里带上原分组）
  for (const g of state.reportedGroups) {
    if (activeScopes.has(g.scopeKey)) continue;
    activeScopes.add(g.scopeKey);
    pendingGroups.push(g);
  }

  // **当前还活着的作用域** = 选区正在用的 + 页面上还挂着的字体。
  //
  // 少了后面这一半就会误删：换题之后，用户可能选中的是**旧字体的残留元素**
  // （页面里还留着上一题的元素），而新字体的映射刚下发好 ——
  // 判据只看选区的话，新映射会被当成"失效的旧指纹"删掉，
  // 页面上的映射又空了一档，用户在这个空档里复制就是密文。
  const aliveScopes = new Set<string>(activeScopes);
  for (const s of state.pageScopes) aliveScopes.add(s);

  // 同一字体族换了字体（指纹变了）时，删掉旧指纹留下的映射，避免旧表越积越多
  const currentByBase = new Map<string, string>();
  for (const scope of aliveScopes) currentByBase.set(scope.split('#')[0], scope);
  for (const key of Object.keys(state.mappings)) {
    if (aliveScopes.has(key)) continue;
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

  if (pendingGroups.length === 0) return 'none';

  // 只上报 App 还没送达到这一层的那部分（其余的早已下发，不必重复下发）
  return stageAndReport(state, pendingGroups, 'selection');
}

/**
 * 把旧版本的守卫状态**就地**升级到当前版本。
 *
 * ## 为什么保留 mappings / charScopes
 *
 * 它们是"页面能不能修复复制"用的（复制时按作用域查表）。
 * 同一个字体 → 同一个作用域（key 里带字体内容指纹）→ 旧映射在新版本里照样是对的，
 * 升级并不会让它失效。以前换版本是整个换新实例 → mappings 被清空 →
 * 从那一刻起用户复制就是密文，要等 App 重新下发才恢复 ——
 * **升级本身制造了一个"复制出密文"的窗口**，这正是我们在修的那类问题。
 *
 * ## 为什么清掉 deliveredAt
 *
 * 那是"App 知不知道这个作用域"的账本。新一任 App 手里是空的，
 * 必须让页面把作用域重新报一遍，否则 App 永远学不到它
 * （学不到 → 不登记这个标签 → 快通道是瞎的 → 换题后只能等主通道那一圈）。
 *
 * ## 为什么把 fontSig 清空
 *
 * 强制下一次采集重扫一遍全量，把"这一版才知道的作用域"也补上报上来
 * （否则只有上次报过的那几个会被重新报）。
 */
function migrateState(old: GuardState): GuardState {
  const next = old as GuardState;
  next.version = GUARD_VERSION;
  if (!next.mappings || typeof next.mappings !== 'object') next.mappings = {};
  if (!next.charScopes || typeof next.charScopes !== 'object') next.charScopes = {};
  if (!Array.isArray(next.pageScopes)) next.pageScopes = [];
  if (!Array.isArray(next.reportedGroups)) next.reportedGroups = [];
  if (!next.reportedAt || typeof next.reportedAt !== 'object') next.reportedAt = {};
  // App 侧的账本：清空 → 这一批作用域会重新上报。
  next.deliveredAt = {};
  // 强制下一次采集重扫全量。
  next.fontSig = '';
  // DOM 变化标记：升级后先按"变了"处理一次（老版本没这个概念）。
  next.domDirty = true;
  return next;
}

function install(): GuardState {
  const existing = window[API];
  let state: GuardState;
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
    // **就地升级**：保留已有的 mappings/charScopes，只补齐新版本新增的字段。
    state = migrateState(existing);
  } else {
    state = {
      version: GUARD_VERSION,
      installedAt: Date.now(),
      pending: null,
      mappings: {},
      charScopes: {},
      deliveredAt: {},
      log: [],
      repairs: 0,
      copyEvents: 0,
      lastSelectionText: '',
      lastCollectedText: '',
      lastCollectedScope: '',
      // 初次为 ''：第一次采集时签名必然不同 → 装好就预热一次 ✓
      fontSig: '',
      // 装好时先按"内容变了"处理一次 → 第一次采集就会全量扫一遍。
      domDirty: true,
      pageScopes: [],
      reportedGroups: [],
      reportedAt: {},
      disabled: false,
      guardActive: false,
      intentText: null,
      internalCall: false,
    };
  }
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

  // ---- DOM 变化监听：只置一个标志位，真正的扫描在下一轮采集里做 ----
  //
  // 为什么需要：站点的顺序是「先注入新字体的 @font-face → 再渲染题目文字」，
  // **字体规则比用到它的元素先到**。只看 @font-face 签名的话，
  // 第一次扫描时签名就已经是新字体的了 → 后面签名不再变 → 再也不会重扫 →
  // 新题目的作用域一直没被发现 → 映射没下发 → 用户复制出密文
  // （2026-10-23 真机：重载题目那层后守卫扫到 0 个作用域；
  //   手动清空签名再扫一次立刻就发现了）。
  //
  // 这里只做"脏标记"，不做任何扫描 —— 扫描仍然是每轮最多一次。
  let domObserver: MutationObserver | null = null;
  try {
    domObserver = new MutationObserver(() => {
      state.domDirty = true;
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {
    domObserver = null;
  }

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
    // DOM 监听必须断开：否则重装一次就多一个观察者在跑。
    try {
      domObserver?.disconnect();
    } catch (_) {
      /* ignore */
    }
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
    state.deliveredAt = {};
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
    // 记下"App 已经把映射送到这一层"→ 之后不必再为它上报。
    state.deliveredAt[scopeKey] = Date.now();
    return 'OK';
  };
  (window as unknown as Record<string, unknown>).__copyRepairCollect = () => {
    const state = window[API];
    if (!state) return 'none';
    return collectAndStage(state);
  };
  /**
   * 让守卫**把已知的作用域重新报一遍**（App 启动时对每个标签喊一次）。
   *
   * ## 为什么需要它
   *
   * 守卫"App 已经送达到就不上报"这条规则是按**页面里的账本**算的，
   * 而 App 是**另一个进程**：App 重启之后，它自己手里是空的，
   * 页面却还留着上一任 App 下发的映射 → 守卫觉得"不用报" → App 永远学不到这个作用域。
   *
   * 后果很严重：**App 学不到作用域，就不会登记这个标签 → 快通道根本不盯它**
   * → 换题之后只能等主通道那一圈（~1.2 秒）→ 用户"换题立刻复制"就复制出密文
   * （2026-10-23 真机故障：第 1 次成功、第 2 次失败）。
   *
   * ## 关键：清哪本账、不清哪本账
   *
   * - **清 `deliveredAt`**（"App 知不知道"）→ 这一批作用域会重新上报 ✓
   * - **保留 `mappings`**（"页面能不能修复复制"）→ 用户在这段时间里复制**照样拿到明文** ✓
   *   清掉它反而会制造一个"复制出密文"的窗口，比不 resync 更糟。
   * - **清 `reportedAt` / `pending`**：重试冷却重新开始。
   * - **`fontSig` 清空**：强制下一次采集重扫一遍全量，
   *   把"只存在于预热扫描里、当前没有选区"的作用域也一并报上来。
   */
  (window as unknown as Record<string, unknown>).__copyRepairResync = () => {
    const state = window[API];
    if (!state) return 'NO-GUARD';
    state.deliveredAt = {};
    state.reportedAt = {};
    state.pending = null;
    state.fontSig = '';
    log(state, 'resync');
    return 'OK';
  };
  installPageGuard();
}
