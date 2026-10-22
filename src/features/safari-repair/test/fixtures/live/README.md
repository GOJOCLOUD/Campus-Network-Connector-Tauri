# 真实站点字体夹具(仅测试用,**不进安装包**)

这里放的是从**真实学习通页面**抓下来的加密字体 + 真值表,用来给
`src/features/safari-repair/test/real-site-font.cjs` 当回归素材。

## 它们是什么

| 文件 | 内容 |
| --- | --- |
| `live-quiz-2.ttf` | 大学生与创业(二)的加密字体(25 个密文码位) |
| `live-quiz-2.truth.json` | 它的真值:密文码位 → 明文字,以及当时的选区原文与还原后文本 |
| `live-triz-11.ttf` | TRIZ理论(十一)的加密字体(44 个密文码位) |
| `live-triz-11.truth.json` | 同上 |

## 它们**不是**运行时代码的一部分

- 安装包里**没有**这个目录(打包白名单排除了 `src/features/**/test/**/*`,
  `tools/verify/verify-package.cjs` 会检查这一点)
- 运行时**不引用**任何一份夹具 —— 软件不知道任何一套题,
  它是**见到什么字体就现场解析什么字体**
- 这两个文件只是**回归证据**:证明"真实站点的字体"也能 100% 还原,
  以及"笔画再轻 30% 仍然 100%"

## 想要更干净?

可以整个删掉,不影响软件,只是少一份回归证据:

```bash
rm -rf src/features/safari-repair/test/fixtures/live
```

需要时随时可以再抓一份(工具在 `tools/lab/capture-fixture.cjs`):

```bash
# 先在 Safari 里打开目标题目的章节测验,然后:
node tools/lab/capture-fixture.cjs <tabIndex> <名字>
```

## 怎么加新的一套

1. Safari 里打开目标题目的「章节测验」
2. `node tools/lab/capture-fixture.cjs <tabIndex> <名字>` → 抓字体 + 真值
3. 跑 `node src/features/safari-repair/test/real-site-font.cjs` → 自动纳入回归

真值是「页面密文」与「剪贴板明文」逐字对齐得到的,所以**与题目内容无关**,
换任何一套题都成立。
