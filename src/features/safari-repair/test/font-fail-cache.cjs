/**
 * 字体下载失败的负缓存：失败后冷却期内**不重复请求**。
 *
 * 背景：站点里常驻着取不到的 @font-face（例如跨源的 icomoon.ttf，HTTP 404）。
 * 不做负缓存的话，每一轮调度都会去请求一次 → 无谓的外部请求 + 日志噪声。
 *
 *   node --test src/features/safari-repair/test/font-fail-cache.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { GlyphEngine, DEFAULTS } = require('../engine');

test('字体下载失败后进入负缓存,冷却期内不再发请求', async () => {
  const engine = new GlyphEngine({ log: () => {} });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 404 };
  };
  try {
    const font = { kind: 'url', value: 'https://example.invalid/icomoon.ttf' };

    await assert.rejects(() => engine.fetchFont(font), /HTTP 404/);
    assert.equal(calls, 1, '第一次应当发一次请求');

    // 冷却期内再取：不应再发请求，但仍要报错（调用方据此标记"字体不可用"）
    await assert.rejects(() => engine.fetchFont(font), /HTTP 404/);
    assert.equal(calls, 1, '冷却期内不应重复请求');

    // 冷却过期后允许重试
    engine.fontFailCache.get(font.value).at -= DEFAULTS.fontFailCooldownMs + 1000;
    await assert.rejects(() => engine.fetchFont(font), /HTTP 404/);
    assert.equal(calls, 2, '冷却过期后应重新请求');
  } finally {
    global.fetch = originalFetch;
  }
});

test('内嵌字体不走网络', async () => {
  const engine = new GlyphEngine({ log: () => {} });
  const bytes = engine.fetchFont({ kind: 'data', value: Buffer.from('hello').toString('base64') });
  const buf = await bytes;
  assert.equal(buf.toString('utf8'), 'hello');
});
