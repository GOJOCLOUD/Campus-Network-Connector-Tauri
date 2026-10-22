/**
 * 生成字体混淆测试页与测试期望数据。
 *
 * 页面 DOM 里放的是"底层字符"，用户眼睛看到的是字体渲染出来的"显示字符"，
 * 两者由 tests/fixtures/pairs-same-style.json 决定。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const fixtures = resolve(root, 'tests/fixtures');

const pairs = JSON.parse(readFileSync(resolve(fixtures, 'pairs-same-style.json'), 'utf8'));

/** 底层串 -> 显示串 */
function render(underlying) {
  return [...underlying].map((c) => pairs[c] ?? c).join('');
}

const SENTENCE_UNDERLYING = '天地玄黄宇宙洪荒日月盈昃';
const SENTENCE_DISPLAY = render(SENTENCE_UNDERLYING);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>测试 C：字体混淆</title>
<style>
  body { font: 16px/1.8 "PingFang SC", sans-serif; margin: 24px; }
  @font-face { font-family: "ObfA"; src: url("./fonts/obf-same-style.ttf") format("truetype"); }
  #target { font-family: "ObfA"; font-size: 22px; }
  .normal { font-family: "PingFang SC", sans-serif; }
</style>
</head>
<body>
<h1>测试 C：自定义字体把底层字符映射成不同的可见汉字</h1>
<p>下面这段文字的 DOM 内容是乱码，但字体把它渲染成正常句子：</p>
<p id="target">${SENTENCE_UNDERLYING}</p>
<p class="normal">对照组：${SENTENCE_DISPLAY}（正常字体，应原样复制）</p>
</body>
</html>
`;

writeFileSync(resolve(fixtures, 'c-font-obfuscation.html'), html);

const expectations = {
  obfuscatedUnderlying: SENTENCE_UNDERLYING,
  obfuscatedDisplay: SENTENCE_DISPLAY,
  mixed: {
    underlying: '天地玄黄宇宙洪荒',
    display: render('天地玄黄宇宙洪荒'),
  },
  complex: {
    underlying: '天地玄黄宇宙洪荒日月盈昃',
    display: render('天地玄黄宇宙洪荒日月盈昃'),
  },
};
writeFileSync(resolve(fixtures, 'expectations.json'), `${JSON.stringify(expectations, null, 2)}\n`);
console.log(`[fixtures] 底层=${SENTENCE_UNDERLYING}`);
console.log(`[fixtures] 显示=${SENTENCE_DISPLAY}`);
