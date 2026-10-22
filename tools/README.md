# 开发脚本索引

> 这些脚本**不进安装包**(打包白名单里显式排除了 `tools/`、`packages/`、`apps/`、`tests/`)。
> 布局:`tools/` 根 = 构建脚本;`lab/` = 实验与诊断;`verify/` = 验收与校验。
>
> 约定:**脚本只增不攒**。结论一旦写进 `docs/`,对应的实验脚本就可以删掉;
> 只留下"下次还会用"的工具。当前 lab 下的每个脚本都在下面有出处。

## 构建脚本(tools/ 根)

| 脚本 | 作用 | 输出 |
| --- | --- | --- |
| `build-vendor.mjs` | 从 `packages/` 构建注入网页的守卫等产物 | `vendor/`(**进安装包**) |
| `build-reference-db.mjs` | 用参考字体重建字形库 | `tools/reference-fonts/glyph-db-48-gbk.crdb` |
| `build.mjs` | 构建 Chromium / Safari 扩展 | `dist-core/` |
| `build-page-guard.mjs` / `build-safari.mjs` / `build-safari-tool.mjs` | 单项构建 | 见脚本头注释 |
| `package-safari-tool.mjs` | 打包 Safari 热键工具 | `release-core/safari-tool/` |
| `make-fixtures.mjs` / `make-obfuscated-font.mjs` | 生成测试页夹具与混淆字体 | `tests/fixtures/` |

```bash
npm run build:vendor        # 改了 packages/browser-adapters 之后必须跑
npm run build:core
npm run build:reference-db  # 只有换参考字体/栅格尺寸时才需要（GBK 全集，约 5 秒）
```

> `dist-core/` 与 `release-core/` 刻意和产品侧的 `dist/`、`release/` 分开,避免 vite / electron-builder 清错目录。

## verify/(验收与校验)

| 脚本 | 作用 | 需要 Safari |
| --- | --- | --- |
| `verify/verify-package.cjs` | 打包产物自检:原生模块是否解包且可加载、运行时文件是否齐全、**源码/文档/脚本是否误入包**、解包后真跑一遍引擎 | 否 |
| `verify/verify-app-e2e.cjs` | 真实端到端:由**已安装的 App** 独立完成修复,读系统剪贴板核对。密文字按**页面实际下发的映射表**判定 | 是 |

```bash
node tools/verify/verify-package.cjs              # 不传参时依次找 release/ → /Applications
node tools/verify/verify-app-e2e.cjs
```

## lab/ —— 按用途分三层

```
tools/lab/          日常入口(13 个):平时真正常用的那些
tools/lab/diag/     诊断(23 个):出问题时用来定位的
tools/lab/probe/    探测取证(7 个):一次性取证,结论已进 docs/ADR
```

### ① 日常入口(`lab/` 根)

| 脚本 | 作用 |
| --- | --- |
| `lab/check-vendor.cjs` | 检查 `vendor/` 是否与源码一致(改完 `packages/` 忘了重建会在这里报出来) |
| `lab/cipher-probe.cjs <tab>` | 用引擎算出"哪些码位是密文、哪些没还原"(**验收判定的唯一口径**) |
| `lab/e2e-clipboard.cjs <tab> [--no-coordinator]` | 全选 → 复制 → 读系统剪贴板 |
| `lab/verify-fastcopy.cjs [--tab N] [--guard 路径]` | **回归**:清空采集缓存后立刻复制,必须全部还原(旧守卫会红) |
| `lab/verify-clipboard.cjs` | 只读系统剪贴板并比对期望片段 |
| `lab/verify-all-questions.cjs` | 复现用户场景:选中**全部 5 道题**后复制,看还有没有密文残留 |
| `lab/capture-fixture.cjs <tab> <名字>` | 抓真实题(字体 + 真值)落成夹具,钉死"真实站点必须 100% 还原" |
| `lab/find-tab.cjs <关键字>` | 按 URL 找 Safari 标签索引(标签序号会变,别写死) |
| `lab/open-quiz.cjs [tab]` | 用完整事件链点开「章节测验」(站点对 `.click()` 不响应) |
| `lab/real-page-run.cjs <tab>` | 手动驱动一轮调度 |
| `lab/guard-inject.cjs` | 往真实标签页注入守卫并读回状态(不启动 Electron) |
| `lab/package-deliverables.cjs` | 把 macOS zip 与 Windows zip 放到桌面(**统一 zip,不再出 dmg**) |
| `lab/update-installed-app.cjs` | 把已安装的 App 就地更新为最新构建(旧版本移入废纸篓,可恢复) |

```bash
node tools/lab/check-vendor.cjs              # 改完 packages/ 先跑这个
node tools/lab/package-deliverables.cjs      # 出桌面交付物(两个 zip)
node tools/lab/update-installed-app.cjs      # 更新 /Applications 里的 App
```

### ② 诊断(`lab/diag/`)—— 出问题时按症状挑

| 症状 | 脚本 |
| --- | --- |
| 复制结果不对 | `diag/diag-pieces.cjs [tab]` 逐段对齐诊断(先看这个) |
| 复制结果不对 | `diag/diag-apply.cjs [tab] [full\|judge\|body]` 逐字复算查表路径,找出"该替换却没替换"的字符 |
| 守卫到底在不在 | `diag/diag-frames.cjs [关键字] [tab]` 导出每一层同源 frame 的守卫状态 |
| 页面当前是什么 | `diag/diag-text.cjs [tab]` 打印各 frame 文本 |
| 字体作用域 | `diag/diag-fonts.cjs [tab]` 查 `@font-face` 与作用域分布 |
| 作用域闪变 | `diag/diag-loop.cjs [tab] [次数]` 连续采样 |
| 映射对不上 | `diag/diag-mapping.cjs [tab]` 守卫手里的表 vs 引擎算的 |
| 映射对不上 | `diag/diag-mapping-diff.cjs` 逐键对比 |
| 拖选式选区 | `diag/diag-mouse-selection.cjs` 跨文本节点的 Range 能不能还原 |
| 换题后立刻复制 | `diag/diag-switch-latency.cjs` 映射要多久才就绪 |
| 换题后映射何时到位 | `diag/diag-mapping-ready.cjs` 不干扰式测量 |

### ③ 字形/算法诊断(`lab/diag/`,离线可跑)

| 脚本 | 作用 |
| --- | --- |
| `diag/diag-render.cjs <字体> <字> [参考字...]` | 把字形画成 **ASCII**,肉眼确认站点画的是哪个字 |
| `diag/diag-matcher.cjs` | 快速匹配器在某个字形上到底返回了什么?正确答案有没有进候选 |
| `diag/diag-normalize.cjs <字体> <字> [候选...]` | 三种归一化口径(原始/总墨量/二值)的区分度对比 |
| `diag/diag-binary-vs-db.cjs <字体> <字> [候选...]` | 二值距离对**库里字形**的实际效果 |
| `diag/diag-blur-variants.cjs` | 查询侧与参考侧三种口径对 margin 的影响 |
| `diag/diag-weighted-distance.cjs` | 靠"按区分度加权的距离"能不能分开 略/赂 |
| `diag/diag-db-entry.cjs` | 库里的字形和现算的字形一致吗 |
| `diag/diag-root-cause.cjs` | 站点字形与参考字形**系统性地**差了什么 |
| `diag/diag-thickness.cjs` | 量化:改动的量与"认错"的关系(笔画变细多少) |
| `diag/diag-font-meta.cjs` | 是「同一字型改了轮廓」还是「**换了个更细的字重**」 |
| `diag/diag-typeface-compat.cjs` | 站点字体与参考库**是不是同一种字型**;"画细"的比例稳不稳定 |
| `diag/diag-what-changed.cjs` | 站点到底改了什么(综合对比) |

### ④ 探测取证(`lab/probe/`)—— 一次性,结论已进 ADR

| 脚本 | 作用 | 结论在哪 |
| --- | --- | --- |
| `probe/fetch-plaintext.cjs` | 把还原出来的明文逐个丢进同源接口响应里搜 | ADR-0011(明文从未到过浏览器) |
| `probe/list-resources.cjs` | 列出页面请求过的资源,找题干数据来自哪个接口 | ADR-0011 |
| `probe/font-extract.cjs` | 从页面抠出混淆字体(base64)并做基础分析 | ADR-0010 |
| `probe/probe-scopes.js` | 探测页面作用域 | ADR-0005 |
| `probe/probe-missing-char.cjs [库文件]` | 参考库缺字时会不会**写出错字**(燚→焱/垚→寺) | ADR-0007 |
| `probe/compare-reference-db.cjs [库文件...]` | 两套参考库在同一批字体上的准确率与耗时对比 | ADR-0007 |
| `probe/score-distribution.cjs <字体...>` | 逐字的匹配分数分布(定阈值用) | ADR-0008/0010 |

> 这几个脚本的结论**都已经写进 ADR**了,平时不用跑;要重新验证(比如换了参考字体)再拿出来。

## 算法侧实验脚本(tools/ 根的 *.mjs)

`proto-*.mjs`(字形匹配策略实验)、`safari-*.mjs`(Safari 场景/守卫校验)属于
**算法侧的实验工具**,需要 `opentype.js` / `puppeteer`(已在 devDependencies)。

| 脚本 | 作用 |
| --- | --- |
| `proto-accuracy.mjs` | 识别准确率原型 |
| `proto-metrics.mjs` | 距离/分数/置信度指标原型 |
| `proto-policy.mjs` | **阈值标定**:同时渲染多套字体,统计 best/score/margin/selfDistance |
| `proto-clipboard-commit.mjs` | 剪贴板提交机制原型(为什么必须 preventDefault) |
| `proto-render-diag.mjs` | 渲染侧诊断原型 |
| `safari-repair.mjs` / `safari-guard-verify.mjs` / `safari-check.mjs` / `safari-scenarios.mjs` | Safari 侧的检查脚本 |

> 实验脚本的结论如果被采纳,应把结论写进 `docs/`,脚本本身可以删掉。
> 已经这么做掉的:OCR 取证链路(`ocr*.mjs`)、旧复制原型(`proto-copy*.mjs`)、
> 早期实验台(`lab*.mjs`/`art-page.js`/`same-frame.html` 等)—— 结论都在 `docs/` 里。

## 参考素材

| 路径 | 内容 |
| --- | --- |
| `reference-fonts/NotoSansSC-Regular.otf` | 参考字形库的**输入**(OFL 授权):黑体系,与目标站点的加密字体底稿同字型 |
| `reference-fonts/glyph-db-48-gbk.crdb` | 已建好的 48×48 GBK 全集库(`npm run build:reference-db` 可重建,约 5 秒,字节级可复现) |

> 只保留黑体系:宋体系(Noto Serif SC)已随"宋体库弃用"一并移除(见 ADR-0010)。
> 库本身是**构建产物**(已 gitignore),`npm run build:vendor` 缺了会自动重建。

## 注意

- 会真实操作 Safari 标签页的脚本**必须串行**跑(`npm test` 已用 `--test-concurrency=1`)
- 脚本只在**前台窗口末尾加一个**临时标签,用完精确删掉;不新开窗口、不关用户已有窗口
- 脚本里的仓库根路径一律用 `path.resolve(__dirname, '..', '..')` 算 —— **放到子目录时记得同步加一层 `..`**
