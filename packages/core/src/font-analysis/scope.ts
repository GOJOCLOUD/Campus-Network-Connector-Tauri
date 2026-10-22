/**
 * 字体作用域（font scope）。
 *
 * 同一段文字在不同 font-family / weight / style 下可能显示为完全不同的字形，
 * 因此映射必须按"作用域"而不是按字符全局缓存。
 *
 * 本模块只依赖 Web 标准 API（DOM / CSSOM），Chromium 与 Safari 通用。
 */

export interface FontScope {
  /** CSS font-family 列表（computed style 原样） */
  family: string;
  /** CSS font-weight（computed style 原样） */
  weight: string;
  /** CSS font-style（computed style 原样） */
  style: string;
}

export interface ScopeStyle {
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
}

export function scopeFromStyle(style: ScopeStyle): FontScope {
  return {
    family: normalizeFamily(style.fontFamily),
    weight: style.fontWeight || '400',
    style: style.fontStyle || 'normal',
  };
}

/** 归一化 font-family：去空白、统一引号，保留列表顺序（顺序决定回退链）。 */
export function normalizeFamily(family: string): string {
  return family
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part.length > 0)
    .join(',');
}

export function scopeKey(scope: FontScope): string {
  return `${scope.style}|${scope.weight}|${scope.family}`;
}

/** 生成用于 canvas 渲染的 font 简写。 */
export function cssFontShorthand(scope: FontScope, sizePx: number): string {
  const style = scope.style === 'normal' ? '' : `${scope.style} `;
  const weight = scope.weight === '400' ? '' : `${scope.weight} `;
  return `${style}${weight}${sizePx}px ${scope.family}`;
}
