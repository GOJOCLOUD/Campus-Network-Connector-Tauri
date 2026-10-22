/**
 * 字形判定策略：把"匹配结果"变成"要不要改、改成什么"的决策。
 *
 * 这里的三条判据都来自阶段一实测（见 docs/字体映射技术说明.md）：
 *
 * 1. selfDistance —— 目标字体渲染出的字形，与参考库里"同一个字符"的参考字形的距离。
 *    · 混淆字体：底层字符渲染成完全不同的字形 → 距离极大（实测 ≈0.9）
 *    · 普通字体：渲染的就是该字符本身，仅风格不同 → 距离小（实测 ≈0.1）
 *    这是区分"混淆"与"正常但风格不同"的关键判据。
 *
 * 2. bestMatch —— 与参考库最近邻的距离。用于回答"屏幕上到底显示的是哪个字"。
 *
 * 3. margin —— 最近邻与次近邻的距离差。置信度不足时宁可不改。
 *
 * 判定作用域（scope）是否被混淆时用多数投票，避免单个异常字符导致误判；
 * 判定单个字符是否替换时要求三项同时成立。
 */

export interface GlyphCandidate {
  /** DOM 中的底层字符 */
  char: string;
  /** 参考库最近邻 */
  bestCodepoint: number | null;
  bestScore: number;
  bestMargin: number;
  /** 与"该字符自身参考字形"的距离（0=完全一致，1=完全不同） */
  selfDistance: number;
  /** 字符是否在参考库中 */
  inReference: boolean;
}

export interface ScopeThresholds {
  /** 作用域判为混淆所需的最低 selfDistance */
  obfuscatedSelfDistance: number;
  /** 作用域判为混淆所需的最低投票比例 */
  obfuscatedVoteRatio: number;
  /** 单字符替换所需的最低 selfDistance */
  replaceSelfDistance: number;
  /** 单字符替换所需的最低最近邻相似度 */
  replaceMinScore: number;
  /** 单字符替换所需的最低次优差距 */
  replaceMinMargin: number;
  /** 采样多少个字符用于作用域投票 */
  voteSampleSize: number;
}

export const DEFAULT_THRESHOLDS: ScopeThresholds = {
  // 混淆字体实测：selfDistance 最小 0.165、中位 0.25；
  // 正常字体实测：最大 0.171、且误判字符 margin ≤ 0.022。
  // 两条判据叠加后，正常字体的误判字符被完全排除。
  obfuscatedSelfDistance: 0.15,
  obfuscatedVoteRatio: 0.6,
  replaceSelfDistance: 0.15,
  replaceMinScore: 0.8,
  replaceMinMargin: 0.01,
  voteSampleSize: 24,
};

export interface ScopeDecision {
  obfuscated: boolean;
  votes: number;
  samples: number;
  medianSelfDistance: number;
}

/**
 * 作用域级判定：这个字体作用域是不是混淆字体。
 *
 * 只有当"多数采样字符"都表现为"渲染出的字形与该字符自身差得很远"时，
 * 才认定该作用域被混淆；否则按普通字体处理，一个字符都不动。
 */
export function decideScope(
  candidates: GlyphCandidate[],
  thresholds: ScopeThresholds = DEFAULT_THRESHOLDS,
): ScopeDecision {
  const usable = candidates.filter((c) => c.inReference);
  if (usable.length === 0) {
    return { obfuscated: false, votes: 0, samples: 0, medianSelfDistance: 0 };
  }
  const sample = usable.slice(0, thresholds.voteSampleSize);
  let votes = 0;
  for (const candidate of sample) {
    if (isConfidentSubstitution(candidate, thresholds)) votes += 1;
  }
  const ratio = votes / sample.length;
  const sorted = sample.map((c) => c.selfDistance).sort((a, b) => a - b);
  const medianSelfDistance = sorted[Math.floor(sorted.length / 2)];
  return {
    obfuscated: ratio >= thresholds.obfuscatedVoteRatio,
    votes,
    samples: sample.length,
    medianSelfDistance,
  };
}

/**
 * 单字符替换决策。
 *
 * @returns 可见字符；null 表示不改（保持原字符）
 */
export function decideChar(
  candidate: GlyphCandidate,
  thresholds: ScopeThresholds = DEFAULT_THRESHOLDS,
): string | null {
  if (!isConfidentSubstitution(candidate, thresholds)) return null;
  return candidate.bestCodepoint === null ? null : String.fromCodePoint(candidate.bestCodepoint);
}

/**
 * 是否满足"可以放心把底层字符换成最近邻字符"的全部条件。
 *
 * 四条同时成立才允许替换：
 *  1. 字符在参考库中
 *  2. 最近邻不是它自己（说明字体画的是别的字）
 *  3. 最近邻够像（score）
 *  4. 最近邻与次近邻拉得开（margin），且与"自身参考字形"差得够远（selfDistance）
 */
export function isConfidentSubstitution(
  candidate: GlyphCandidate,
  thresholds: ScopeThresholds = DEFAULT_THRESHOLDS,
): boolean {
  if (!candidate.inReference) return false;
  if (candidate.bestCodepoint === null) return false;
  if (candidate.bestCodepoint === candidate.char.codePointAt(0)) return false;
  if (candidate.selfDistance < thresholds.replaceSelfDistance) return false;
  if (candidate.bestScore < thresholds.replaceMinScore) return false;
  if (candidate.bestMargin < thresholds.replaceMinMargin) return false;
  return true;
}
