/**
 * 核心引擎单元测试（浏览器无关）。
 *
 * 运行：node --test packages/core/test/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  flattenPath,
  rasterizeContours,
  blur,
  l1Distance,
} from '../src/glyph-matching/raster.ts';
import { GlyphDb, buildGlyphDb, dequantize, downsample } from '../src/glyph-matching/db.ts';
import {
  decideChar,
  decideScope,
  isConfidentSubstitution,
  type GlyphCandidate,
} from '../src/glyph-matching/policy.ts';
import { alignRuns, repairSelectionText } from '../src/copy/repair.ts';
import { scopeFromStyle, scopeKey, cssFontShorthand } from '../src/font-analysis/scope.ts';
import { MappingCache } from '../src/mapping-cache/cache.ts';

/* ---------------- 栅格化 ---------------- */

test('栅格化：矩形轮廓的覆盖度与几何一致', () => {
  const contours = [
    [0.2, -0.6, 0.8, -0.6, 0.8, -0.2, 0.2, -0.2],
  ];
  const coverage = rasterizeContours(contours, 32);
  assert.equal(coverage.length, 1024);
  // 左上角（0.2,-0.6）附近有墨，右上角没有
  const at = (x: number, y: number) => coverage[y * 32 + x];
  assert.ok(at(8, 10) > 0.9, `期望 (8,10) 完全有墨，实际 ${at(8, 10)}`);
  assert.ok(at(6, 8) > 0.3 && at(6, 8) < 0.7, `期望 (6,8) 部分有墨，实际 ${at(6, 8)}`);
  assert.ok(at(26, 10) < 0.05, `期望 (26,10) 无墨，实际 ${at(26, 10)}`);
  assert.ok(at(16, 28) < 0.05, `期望窗口底部无墨，实际 ${at(16, 28)}`);
});

test('栅格化：曲线被展平为多边形', () => {
  const contours = flattenPath([
    { type: 'M', x: 0, y: 0 },
    { type: 'Q', x1: 0.5, y1: -1, x: 1, y: 0 },
    { type: 'Z' },
  ]);
  assert.equal(contours.length, 1);
  assert.ok(contours[0].length >= 6);
});

test('模糊与距离：相同位图距离为 0', () => {
  const a = new Float32Array(64).fill(0.5);
  const b = blur(a, 8);
  assert.equal(l1Distance(a, b), 0);
  const c = new Float32Array(64);
  assert.ok(l1Distance(a, c) > 0);
});

/* ---------------- 参考字形库 ---------------- */

test('字形库：构建 → 序列化 → 反序列化 → 命中正确字符', () => {
  const size = 16;
  const make = (offset: number) => {
    const cov = new Float32Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (x >= offset && x < offset + 6 && y >= 2 && y < 12) cov[y * size + x] = 1;
      }
    }
    return cov;
  };
  const entries = [
    { codepoint: 0x4e00, coverage: make(1) },
    { codepoint: 0x4e01, coverage: make(8) },
  ];
  const db = buildGlyphDb(size, 8, entries);
  const bytes = db.serialize();
  const restored = GlyphDb.deserialize(bytes);

  assert.equal(restored.header.count, 2);
  assert.equal(restored.header.gridSize, size);
  assert.equal(restored.indexOfCodepoint(0x4e00), 0);
  assert.equal(restored.indexOfCodepoint(0x4e01), 1);
  assert.equal(restored.indexOfCodepoint(0x9999), -1);

  const match = restored.lookup(entries[1].coverage);
  assert.equal(match.codepoint, 0x4e01, '应命中另一个字符');
  assert.ok(match.score > 0.9);
});

test('字形库：反量化与降采样保持形状', () => {
  const cov = new Float32Array(64).fill(0.5);
  const packed = dequantize(new Uint8Array([0x88]), 0, 2);
  assert.ok(Math.abs(packed[0] - 8 / 15) < 1e-6);
  assert.ok(Math.abs(packed[1] - 8 / 15) < 1e-6);
  const small = downsample(cov, 8, 4);
  assert.equal(small.length, 16);
  assert.ok(Math.abs(small[0] - 0.5) < 1e-6);
});

/* ---------------- 判定策略 ---------------- */

function candidate(overrides: Partial<GlyphCandidate>): GlyphCandidate {
  return {
    char: '天',
    bestCodepoint: 0x4eba, // 人
    bestScore: 0.97,
    bestMargin: 0.08,
    selfDistance: 0.26,
    inReference: true,
    ...overrides,
  };
}

test('策略：混淆字体（多数字符的最近邻不是自己）判定为混淆', () => {
  const candidates = [
    candidate({ char: '天' }),
    candidate({ char: '地', bestCodepoint: 0x5de5 }),
    candidate({ char: '玄', bestCodepoint: 0x667a }),
    candidate({ char: '黄', bestCodepoint: 0x80fd }),
  ];
  const decision = decideScope(candidates);
  assert.equal(decision.obfuscated, true);
  assert.equal(decision.votes, 4);
});

test('策略：正常字体（最近邻都是自己）判定为不混淆', () => {
  const candidates = [
    candidate({ char: '天', bestCodepoint: 0x5929, selfDistance: 0.02 }),
    candidate({ char: '地', bestCodepoint: 0x5730, selfDistance: 0.03 }),
    candidate({ char: '玄', bestCodepoint: 0x7384, selfDistance: 0.02 }),
    candidate({ char: '黄', bestCodepoint: 0x9ec4, selfDistance: 0.04 }),
  ];
  const decision = decideScope(candidates);
  assert.equal(decision.obfuscated, false);
  assert.equal(decision.votes, 0);
});

test('策略：正常字体的偶发误判不会让作用域被误判为混淆', () => {
  const candidates = Array.from({ length: 20 }, (_, i) =>
    candidate({
      char: String.fromCodePoint(0x4e00 + i),
      bestCodepoint: 0x4e00 + i,
      selfDistance: 0.03,
    }),
  );
  // 其中 1 个字符最近邻出错（正常字体的典型误判：margin 很小）
  candidates[3] = candidate({
    char: '丁',
    bestCodepoint: 0x4e01,
    bestMargin: 0.008,
    selfDistance: 0.14,
  });
  const decision = decideScope(candidates);
  assert.equal(decision.obfuscated, false, '单个低置信度误判不应触发混淆判定');
});

test('策略：单字符替换必须同时满足四条判据', () => {
  assert.equal(decideChar(candidate({})), '人');
  // 最近邻是自己 → 不改
  assert.equal(decideChar(candidate({ bestCodepoint: 0x5929 })), null);
  // 自身距离太小（字体画的就是这个字）→ 不改
  assert.equal(decideChar(candidate({ selfDistance: 0.05 })), null);
  // 置信度不足 → 不改
  assert.equal(decideChar(candidate({ bestMargin: 0.005 })), null);
  assert.equal(decideChar(candidate({ bestScore: 0.5 })), null);
  // 不在参考库 → 不改
  assert.equal(decideChar(candidate({ inReference: false })), null);
  assert.equal(isConfidentSubstitution(candidate({})), true);
});

/* ---------------- 选区对齐与修复 ---------------- */

test('对齐：DOM run 与原生文本之间允许空白差异', () => {
  const scope = scopeFromStyle({ fontFamily: 'ObfA', fontWeight: '400', fontStyle: 'normal' });
  const runs = [{ text: '天地', scope }];
  const aligned = alignRuns(runs, '天地\n');
  assert.ok(aligned[0]);
  assert.equal(aligned[0].start, 0);
  assert.equal(aligned[0].end, 2);
});

test('对齐：完全对不上时返回 null（保持原样，不猜位置）', () => {
  const scope = scopeFromStyle({ fontFamily: 'ObfA', fontWeight: '400', fontStyle: 'normal' });
  const aligned = alignRuns([{ text: '完全不同的内容', scope }], '别的文字');
  assert.equal(aligned[0], null);
});

test('修复：只替换混淆作用域的字符，普通作用域原样保留', () => {
  const obf = scopeFromStyle({ fontFamily: 'ObfA', fontWeight: '400', fontStyle: 'normal' });
  const plain = scopeFromStyle({ fontFamily: 'PingFang SC', fontWeight: '400', fontStyle: 'normal' });
  const runs = [
    { text: '正常', scope: plain },
    { text: '天地', scope: obf },
  ];
  const result = repairSelectionText('正常天地', runs, {
    isObfuscated: (scope) => scopeKey(scope) === scopeKey(obf),
    mapChar: (scope, char) => {
      if (scopeKey(scope) !== scopeKey(obf)) return null;
      return char === '天' ? '人' : char === '地' ? '工' : null;
    },
  });
  assert.equal(result.text, '正常人工');
  assert.equal(result.changed, true);
  assert.equal(result.applied.length, 2);
  assert.equal(result.unresolved, 0);
});

test('修复：没有可信映射的字符保持原样并计入未还原', () => {
  const obf = scopeFromStyle({ fontFamily: 'ObfA', fontWeight: '400', fontStyle: 'normal' });
  const runs = [{ text: '天地玄', scope: obf }];
  const result = repairSelectionText('天地玄', runs, {
    isObfuscated: () => true,
    mapChar: (_scope, char) => (char === '天' ? '人' : null),
  });
  assert.equal(result.text, '人地玄', '无法还原的字符保持原字符');
  assert.equal(result.unresolved, 2);
});

test('修复：strict 模式下整段放弃，保留原始复制结果', () => {
  const obf = scopeFromStyle({ fontFamily: 'ObfA', fontWeight: '400', fontStyle: 'normal' });
  const runs = [{ text: '天地玄', scope: obf }];
  const result = repairSelectionText(
    '天地玄',
    runs,
    {
      isObfuscated: () => true,
      mapChar: (_scope, char) => (char === '天' ? '人' : null),
    },
    { strict: true },
  );
  assert.equal(result.text, '天地玄');
  assert.equal(result.changed, false);
  assert.equal(result.skippedRuns, 1);
});

test('修复：非混淆作用域一个字都不改', () => {
  const plain = scopeFromStyle({ fontFamily: 'PingFang SC', fontWeight: '400', fontStyle: 'normal' });
  const result = repairSelectionText('正常文字', [{ text: '正常文字', scope: plain }], {
    isObfuscated: () => false,
    mapChar: () => 'X',
  });
  assert.equal(result.text, '正常文字');
  assert.equal(result.changed, false);
});

/* ---------------- 作用域与缓存 ---------------- */

test('作用域：同一 family 列表归一化后键相同', () => {
  const a = scopeFromStyle({ fontFamily: ' "ObfA" ,  PingFang SC ', fontWeight: '400', fontStyle: 'normal' });
  const b = scopeFromStyle({ fontFamily: 'ObfA,PingFang SC', fontWeight: '400', fontStyle: 'normal' });
  assert.equal(scopeKey(a), scopeKey(b));
  assert.equal(cssFontShorthand(a, 32), '32px ObfA,PingFang SC');
});

test('缓存：字体指纹变化后旧映射自动作废', () => {
  const cache = new MappingCache();
  const scope = scopeFromStyle({ fontFamily: 'ObfA', fontWeight: '400', fontStyle: 'normal' });
  cache.ensureScope(scope, 'sig-1');
  cache.set(scope, '天', { mapped: '人', score: 0.98, margin: 0.1 });
  cache.markObfuscated(scope, true);
  assert.equal(cache.isObfuscated(scope), true);
  assert.ok(cache.get(scope, '天'));

  // 字体换了 → 指纹变化 → 映射清空
  cache.ensureScope(scope, 'sig-2');
  assert.equal(cache.get(scope, '天'), undefined);
  assert.equal(cache.isObfuscated(scope), false);
});

test('缓存：快照可序列化并恢复，命中统计有效', () => {
  const cache = new MappingCache();
  const scope = scopeFromStyle({ fontFamily: 'ObfA', fontWeight: '400', fontStyle: 'normal' });
  cache.ensureScope(scope, 'sig-1');
  cache.set(scope, '天', { mapped: '人', score: 0.98, margin: 0.1 });

  const restored = new MappingCache();
  restored.fromSnapshot(cache.toSnapshot());
  assert.equal(restored.get(scope, '天')?.mapped, '人');
  restored.get(scope, '天');
  restored.get(scope, '不存在的字');
  const stats = restored.stats();
  assert.equal(stats.hits, 2, '两次 get(天) 都算命中');
  assert.equal(stats.misses, 1);
});
