/**
 * frame-bridge 的回归测试:**站点换掉嵌套 iframe 之后,映射必须还能送到新那层**。
 *
 * ## 复现的故障(2026-10-23 真机)
 *
 * 真实场景:学习通测验页的题目在**第 4 层同源 iframe** 里。
 * 站点(SPA)在**嵌套 frame 内部**换 iframe(换题/换内容)——
 * 顶层的 MutationObserver **看不见**嵌套里的变化,
 * 于是 bridge 里的 `framesInjected` 名单**过期**:
 *   - 映射被发到上一套 iframe(已经变 about:blank 的那些)
 *   - 真正在显示题目的那层**一份映射都收不到**
 *   - → 在那层复制出来还是密文(守卫日志 copy-no-mapping)
 *
 * 真机证据:bridge 名单里 17 个 frame,当前页面树只有 10 个(8 个过期残留);
 * 手动 rescan() + 分发一次 → 题目那层立刻拿到映射 → 复制出来是明文。
 *
 * ## 为什么这个测试不是"造一个场景凑数"
 *
 * 站点换 iframe 这件事本身**每天都在发生**(换题、翻页、加载下一段)。
 * 这里把"换掉"做成测试里的一个动作,断言**换完之后新那层能收到映射**——
 * 这正是那条不变量:「谁在显示题目,谁就要有映射」。
 *
 * 用纯 node 造假 frame 树,不需要浏览器、不需要 Safari。
 *
 * ## 为什么同一套用例要跑两遍(源码 / 入库产物)
 *
 * 这份源码在仓库里有**两个去处**,而且**没有任何东西保证它们同步**:
 *
 *   1. `packages/browser-adapters/shared/src/frame-bridge.ts` —— 源码(真身)
 *   2. `tauri-app/src-tauri/resources/frame-bridge.js` —— **提交进仓库的产物**,
 *      构建时用 `include_str!` 嵌进二进制 → **它才是真正装进 App 的那份**
 *
 * 产物是手工从 `vendor/frame-bridge.js` 复制过去的,忘了复制就静默漂移。
 * 只测一个都有漏洞:
 *   - 只测产物 → 源码被改坏没人知道(下次复制过去就把坏代码带进 App)
 *   - 只测源码 → 产物没同步,坏的那份照样发出去
 *
 * 所以这里**两头都测**:产物必须过(它就是要发出去的那份),
 * 源码现编的也必须过(它是真身)。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT = path.join(ROOT, 'tauri-app/src-tauri/resources/frame-bridge.js');
const SOURCE = path.join(ROOT, 'packages/browser-adapters/shared/src/frame-bridge.ts');

/** 入库产物(真正装进 App 的那份)。 */
const ARTIFACT_SRC = fs.readFileSync(ARTIFACT, 'utf8');

/** 源码现编出来的那份(esbuild 参数与 tools/build-vendor.mjs 一致)。 */
let SOURCE_SRC = '';
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    format: 'iife',
    target: ['safari16'],
    platform: 'browser',
    minify: false,
    legalComments: 'none',
    write: false,
  });
  SOURCE_SRC = out.outputFiles[0].text;
});

/** 造一个"frame":有守卫、有 setMapping、能被 eval 注入。 */
function makeFrame(label) {
  const win = {
    label,
    __copyRepairGuard: { version: 6, pending: null, mappings: {}, log: [], repairs: 0 },
    document: { querySelectorAll: () => [] },
    eval(src) {
      // 假装注入守卫成功(本测试只关心 frame 名单与映射分发)
      this.injected = true;
      return null;
    },
  };
  win.__copyRepairSetMapping = (scopeKey, mapping) => {
    win.__copyRepairGuard.mappings[scopeKey] = {
      ...(win.__copyRepairGuard.mappings[scopeKey] || {}),
      ...mapping,
    };
    return 'OK';
  };
  win.__copyRepairCollect = () => 'none';
  return win;
}

/** 造一个父 window:它的 iframe 列表可以被站点换掉。 */
function makeParent(label, children) {
  const win = {
    label,
    __copyRepairGuard: { version: 6, pending: null, mappings: {}, log: [], repairs: 0 },
    document: {},
    eval() {},
  };
  win.__copyRepairSetMapping = (scopeKey, mapping) => {
    win.__copyRepairGuard.mappings[scopeKey] = {
      ...(win.__copyRepairGuard.mappings[scopeKey] || {}),
      ...mapping,
    };
    return 'OK';
  };
  win.__copyRepairCollect = () => 'none';
  // children: 当前这一层的子 frame(contentWindow)
  win.setChildren = (list) => {
    win.document.querySelectorAll = (sel) =>
      sel === 'iframe' ? list.map((c) => ({ contentWindow: c })) : [];
  };
  win.setChildren(children);
  return win;
}

/** 在给定的 window 上装上 frame-bridge。 */
function installBridge(topWindow, src) {
  const sandbox = { window: topWindow, MutationObserver: undefined, document: topWindow.document };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  // 脚本本身只是**定义** installFrameBridge,还要显式调一次
  topWindow.__copyRepairInstallFrameBridge({ guardSource: '/* 假守卫源码 */' });
  return topWindow.__copyRepairBridge;
}

/**
 * 注册同一套用例。
 * @param {string} label 这一份源码的标签(产物 / 源码)
 * @param {() => string} getSrc 取源码的函数(源码那份要等 esbuild 编完)
 */
function suite(label, getSrc) {
  test(`[${label}] 站点换掉嵌套 iframe 后,映射仍能送到新那层`, () => {
    // 站点结构:top → mid → quiz(题目在这层)
    const quiz = makeFrame('quiz');
    const mid = makeParent('mid', [quiz]);
    const top = makeParent('top', [mid]);

    const bridge = installBridge(top, getSrc());

    // 第一轮:映射发到当前那层 → 应当收到
    bridge.setMapping('scope#A', { '天': '人' });
    assert.strictEqual(
      Object.keys(quiz.__copyRepairGuard.mappings).length,
      1,
      '第一轮:题目那层应当收到映射'
    );

    // 站点换 iframe:SPA 把 mid 里的 iframe 换成了**新的** frame 对象
    // (老的那份已经不在页面里了,浏览器上表现为 about:blank)
    const quiz2 = makeFrame('quiz-2');
    mid.setChildren([quiz2]);

    // 第二轮:映射必须发到**新**那层
    bridge.setMapping('scope#B', { '地': '工' });

    assert.deepStrictEqual(
      Object.keys(quiz2.__copyRepairGuard.mappings),
      ['scope#B'],
      '换掉 iframe 之后,映射必须发到新那层(老那层已经不在页面里了)'
    );
    assert.strictEqual(
      Object.keys(quiz.__copyRepairGuard.mappings).length,
      1,
      '老那层不该再收到新的映射'
    );

    // 名单里不该攒着过期的 frame
    const info = bridge.debug();
    assert.strictEqual(info.count, 2, '名单里只该留当前的 frame(顶层 + mid),不该攒着旧的');
  });

  test(`[${label}] take() 会先重扫,不然收集不到新那层上报的内容`, () => {
    const quiz = makeFrame('quiz');
    const top = makeParent('top', [quiz]);
    const bridge = installBridge(top, getSrc());

    // 新那层上报了一组待处理
    quiz.__copyRepairGuard.pending = { groups: [{ scopeKey: 'scope#C', chars: ['天'] }] };
    quiz.__copyRepairCollect = () => 'none';

    const taken = bridge.take();
    assert.strictEqual(taken.pending.length, 1, '应当收到新那层上报的分组');
    assert.strictEqual(taken.pending[0].groups[0].scopeKey, 'scope#C');
  });

  test(`[${label}] debug() 在有 pending 时不能抛异常(诊断工具不能自己坏)`, () => {
    const quiz = makeFrame('quiz');
    quiz.__copyRepairGuard.pending = { groups: [{ scopeKey: 'scope#D', chars: ['天'] }] };
    const top = makeParent('top', [quiz]);
    const bridge = installBridge(top, getSrc());

    const info = bridge.debug();
    assert.strictEqual(info.count, 1);
    assert.strictEqual(info.info[0].pending, 1, 'pending 的形状是 { groups: [...] }');
  });
}

// 入库产物:真正装进 App 的那份
suite('入库产物', () => ARTIFACT_SRC);

// 源码:真身(现编,永远与仓库里的 TS 一致)
suite('源码现编', () => SOURCE_SRC);
