/**
 * 页面守卫的回归测试：**换题之后映射必须提前建好，而且不能每轮重复下发**。
 *
 * ## 复现的故障(2026-10-23 真机)
 *
 * 学习通测验页换一题 → 站点换掉混淆字体(`font-cxsecret` 的字体文件变了)
 * → 作用域指纹随之变化 → 必须重新建映射。
 *
 * 当时有两个问题叠在一起:
 *
 * 1. **上报太晚**:守卫只在"选区变化"和"刚装上"时上报作用域。
 *    换题本身不触发任何上报 → 新字体的映射要等用户选中之后才开始建,
 *    用户在这之前按 ⌘C 就是**密文**(真机:第 1 次复制成功、第 2 次失败)。
 * 2. **每轮都在重复下发**:守卫每轮都把同一批作用域重报一遍,
 *    App 就每轮重新建一次映射、下发一次(一次 Apple Event ≈110ms)
 *    —— 一轮 330ms 里有 220ms 花在**重复下发**上。
 *
 * 现在的口径:
 * - **字体变了才重扫**:用 @font-face 集合的签名(只读 CSSOM,微秒级)判断
 *   "字体到底换了没有";变了才做全量预热扫描(13ms/帧)。
 * - **送到了就不重报**:App 已经确认处理过这个作用域(`state.deliveredAt`)→ 不再上报。
 * - **App 没确认就每轮重报**:报告可能在路上丢掉(frame 被重建、报告被取走)，
 *   这时每轮再报一次才能让 App 尽快补上;真正的节流靠 ack,不靠计时器
 *   (以前"冷却 3 秒再试"会造成 3 秒致盲:那 3 秒里 App 不知道这个作用域存在)。
 * - **预热分组要先并进"当前作用域"再删旧指纹**:否则刚下发好的映射会被自己抹掉。
 *
 * ## 为什么同一套用例要跑两遍(源码 / 入库产物)
 *
 * 守卫源码在仓库里有**两个去处**,而且没有任何东西保证它们同步:
 *   1. `packages/browser-adapters/shared/src/page-guard.ts` —— 源码(真身)
 *   2. `tauri-app/src-tauri/resources/page-guard.js` —— **提交进仓库的产物**,
 *      构建时用 `include_str!` 嵌进二进制 → 它才是真正装进 App 的那份
 *
 * 只测一个都有漏洞,所以这里两头都测。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT = path.join(ROOT, 'tauri-app/src-tauri/resources/page-guard.js');
const SOURCE = path.join(ROOT, 'packages/browser-adapters/shared/src/page-guard.ts');

const ARTIFACT_SRC = fs.readFileSync(ARTIFACT, 'utf8');

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

/**
 * 造一个页面:一个 @font-face + 一个用它的元素。
 * @param {string} src @font-face 的 src(换字体 = 换这个值)
 * @param {Array} elements 页面上的元素
 */
function makePage({ src = 'url(data:font/woff2;base64,AAAA)', elements = [] } = {}) {
  // 字体规则和页面元素都是**可变的**：站点是"先注入字体规则、之后才渲染题目文字"的，
  // 用例要能分别模拟这两件事。
  let srcValue = src;
  const style = {
    fontFamily: '"font-cxsecret"',
    fontWeight: '400',
    fontStyle: 'normal',
    getPropertyValue(name) {
      if (name === 'src') return srcValue;
      if (name === 'font-family') return '"font-cxsecret"';
      if (name === 'font-weight') return '400';
      if (name === 'font-style') return 'normal';
      return '';
    },
  };
  const sheet = { cssRules: [{ type: 5, style }] };

  // 页面上的元素是**可变的**：站点是"先注入字体规则、之后才把题目文字渲染出来"的，
  // 用例要能模拟"题目文字后到"。
  let current = elements;

  const doc = {
    styleSheets: [sheet],
    addEventListener() {},
    querySelectorAll(sel) {
      return sel === '*' ? current : [];
    },
    createTreeWalker() {
      let done = false;
      return {
        nextNode() {
          if (done) return null;
          done = true;
          return current.length ? current[0].__textNode : null;
        },
      };
    },
  };

  const win = {
    document: doc,
    top: null,
    location: { href: 'https://example.test/quiz' },
    addEventListener() {},
    getComputedStyle(el) {
      // 计数:用来断言"预热全量扫描"到底跑没跑
      // (全量扫描 = 遍历所有元素算样式,实测 13ms/帧)
      win.__styleCalls = (win.__styleCalls || 0) + 1;
      return el.__style;
    },
    getSelection() {
      return win.__selection;
    },
  };
  win.top = win;
  return {
    win,
    doc,
    sheet,
    style,
    /** 模拟"站点把题目文字渲染出来了"。 */
    setElements(list) {
      current = list;
    },
    /** 模拟"站点的 @font-face 规则变了"（换了一份混淆字体）。 */
    setSrc(next) {
      srcValue = next;
    },
  };
}

/** 一个用混淆字体的元素(带一个文本节点,选区就落在这里)。 */
function cipherElement(text = '题干文字') {
  const el = {
    textContent: text,
    __style: {
      // 真实页面的 computed style 里字体族**不带引号**(引号只在 @font-face 规则里)
      fontFamily: 'font-cxsecret',
      fontWeight: '400',
      fontStyle: 'normal',
      display: 'block',
      visibility: 'visible',
    },
  };
  el.__textNode = { nodeType: 3, data: text, parentElement: el };
  return el;
}

/** 一个用**普通字体**的元素(页面里没有对应的 @font-face → 永远建不出映射)。 */
function normalElement(text = '题干文字') {
  const el = {
    textContent: text,
    __style: {
      fontFamily: '"Microsoft YaHei", SimSun, Arial, sans-serif',
      fontWeight: '400',
      fontStyle: 'normal',
      display: 'block',
      visibility: 'visible',
    },
  };
  el.__textNode = { nodeType: 3, data: text, parentElement: el };
  return el;
}

/** 装上守卫(在假的 window 上 eval),返回可操作的状态句柄。 */
function installGuard(win, src, nowFn) {
  const listeners = {};
  class FakeEvent {
    preventDefault() {}
    stopImmediatePropagation() {}
    stopPropagation() {}
  }
  class FakeDataTransfer {
    setData() {}
    clearData() {}
  }
  // **假的 MutationObserver**：守卫用它来发现"页面内容变了"。
  // 这里把回调收起来,让用例能手动触发"DOM 变了"这一刻。
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.dead = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.dead = true;
    }
  }
  const sandbox = {
    window: win,
    document: win.document,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    Event: FakeEvent,
    DataTransfer: FakeDataTransfer,
    MutationObserver: FakeMutationObserver,
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4 },
    CSSRule: { FONT_FACE_RULE: 5 },
    Date: { now: nowFn || (() => Date.now()) },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const state = win.__copyRepairGuard;
  return {
    state,
    win,
    /** 模拟 App 把待处理队列取走(App 侧就是把它清成 null)。 */
    consume() {
      const pending = state.pending;
      state.pending = null;
      return pending;
    },
    /** 模拟 App 把映射下发回这一层。 */
    deliver(scopeKey, mapping) {
      return win.__copyRepairSetMapping(scopeKey, mapping);
    },
    collect() {
      return win.__copyRepairCollect();
    },
    /** 模拟"页面内容变了"（站���把题目文字渲染出来了）。 */
    triggerDomChange() {
      for (const o of observers) if (!o.dead) o.callback([]);
    },
  };
}

/** 报告出去的分组(守卫既写 state.pending,也经 bridge 上报;这里直接读 pending)。 */
function reportedGroups(h) {
  const pending = h.consume();
  return pending ? pending.groups : [];
}

function suite(label, getSrc) {
  test(`[${label}] 换字体(换题)之后,新作用域会被重新上报`, () => {
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const h = installGuard(page.win, getSrc());

    // 装上就预热:第一份作用域应当已经报上去了
    const first = reportedGroups(h);
    assert.strictEqual(first.length, 1, '装好时应当预热上报一个作用域');
    const scope1 = first[0].scopeKey;
    assert.ok(scope1.startsWith('normal|400|font-cxsecret#'), '作用域键格式: ' + scope1);

    // App 把映射下发回来
    h.deliver(scope1, { '天': '人' });

    // 站点换题:混淆字体换了(src 变了)→ 作用域指纹变了
    page.style.getPropertyValue = (name) => {
      if (name === 'src') return 'url(data:font/woff2;base64,BBBB)';
      if (name === 'font-family') return '"font-cxsecret"';
      if (name === 'font-weight') return '400';
      if (name === 'font-style') return 'normal';
      return '';
    };

    h.collect();
    const second = reportedGroups(h);
    assert.strictEqual(second.length, 1, '字体变了之后,新作用域必须被上报');
    assert.notStrictEqual(second[0].scopeKey, scope1, '新字体的作用域指纹必须与旧的��同');
    assert.ok(second[0].scopeKey.startsWith('normal|400|font-cxsecret#'), '作用域键格式: ' + second[0].scopeKey);
  });

  test(`[${label}] 字体没变、映射也送到了 → 不会再重复上报`, () => {
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const h = installGuard(page.win, getSrc());

    const first = reportedGroups(h);
    assert.strictEqual(first.length, 1);
    h.deliver(first[0].scopeKey, { '天': '人' });

    // 连续几轮:字体没变、映射已送达 → 一次都不该再报
    for (let i = 0; i < 5; i += 1) {
      h.collect();
      const groups = reportedGroups(h);
      assert.strictEqual(groups.length, 0, `第 ${i + 1} 轮不该重复上报(重复上报 = App 每轮重复下发一次)`);
    }
  });

  test(`[${label}] App 一直没确认 → 每一轮都要重报(报告丢了也要能很快补上)`, () => {
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const h = installGuard(page.win, getSrc());

    const first = reportedGroups(h);
    assert.strictEqual(first.length, 1);
    const scope = first[0].scopeKey;

    // App 一直没把映射送回来(分析失败 / 字体取不到 / 报告在路上丢了)。
    // → **每一轮都要重报**：早一轮拿到映射，用户就少一次"复制出密文"。
    //
    // 以前这里是"报过但没收到映射 → 冷却 3 秒再试"，那个冷却是**致盲**的：
    // 这 3 秒里 App 一次都没收到 → 根本不知道这个作用域存在 →
    // 用户复制就是密文，而 App 明明下一轮就能拿到。
    // 真正的节流靠 App 的 ack（deliveredAt），不靠计时器。
    for (let i = 0; i < 3; i += 1) {
      h.collect();
      const groups = reportedGroups(h);
      assert.strictEqual(groups.length, 1, `第 ${i + 1} 轮必须重报(App 还没确认过)`);
      assert.strictEqual(groups[0].scopeKey, scope);
    }
  });

  test(`[${label}] 题目文字后渲染 → DOM 变了必须重扫(否则新作用域永远发现不了)`, () => {
    // 真机场景(2026-10-23)：站点的顺序是
    //   「先注入新字体的 @font-face → 再把题目文字渲染出来」
    // 也就是**字体规则比用到它的元素先到**。
    // 守卫第一次扫描时签名已经是新字体的了 → 后面签名不再变 →
    // 「只在字体变了才重扫」永远等不到那次重扫 →
    // **新题目的作用域一直没被发现** → 映射没下发 → 用户复制出密文。
    const el = cipherElement();
    const page = makePage({ elements: [] });
    const h = installGuard(page.win, getSrc());

    // 装好时页面还没有题目文字 → 扫不到任何作用域
    h.collect();
    assert.strictEqual(reportedGroups(h).length, 0, '还没有题目文字时不该报出作用域');

    // 站点把题目文字渲染出来了（DOM 变了）
    page.setElements([el]);
    h.triggerDomChange();

    h.collect();
    const groups = reportedGroups(h);
    assert.strictEqual(groups.length, 1, 'DOM 变了之后必须重扫并报出新作用域');
    assert.ok(
      groups[0].scopeKey.startsWith('normal|400|font-cxsecret#'),
      '作用域键格式: ' + groups[0].scopeKey
    );
  });

  test(`[${label}] 两份不同的混淆字体必须算出不同的作用域(撞车 = 复制出错字)`, () => {
    // 站点的混淆字体是"结构相同、只有字形不同"地生成的。
    // 指纹若用**取样哈希**（每 N 个字符取一个），两份字体很容易撞车 →
    // 新字体沿用旧作用域 → 页面以为 App 已知、不再上报 →
    // 旧映射继续套在新字体上 → **复制出来是错的字**（不是密文）。
    //
    // 下面这两份 src 长度完全一样，**只差一个字符**。
    // 位置是特意挑的：旧实现用"每 N 个字符取一个"的取样哈希
    // （载荷 1KB 时步长为 2），这个字符正好落在两个取样点**之间**
    // → 旧实现算出来的指纹完全相同 → 新字体沿用旧作用域。
    const el = cipherElement();
    const long = 'A'.repeat(1000);
    const tail = 'A'.repeat(23);
    const page = makePage({ src: 'url(data:font/woff2;base64,' + long + 'X' + tail + ')', elements: [el] });
    const h = installGuard(page.win, getSrc());

    const first = reportedGroups(h);
    assert.strictEqual(first.length, 1);
    const scope1 = first[0].scopeKey;

    // 换一份内容不同的字体（同样长度，只差那一个字符）
    page.setSrc('url(data:font/woff2;base64,' + long + 'Y' + tail + ')');
    h.collect();
    const second = reportedGroups(h);
    assert.ok(second.length >= 1, '换字体之后必须有上报');
    // 旧作用域也可能被重报(App 还没确认过) —— 关键是要**多出一个新作用域**。
    assert.ok(
      second.some((g) => g.scopeKey !== scope1),
      '不同字体必须算出不同的作用域(撞车会让旧映射套到新字体上 → 写出错字)'
    );
  });

  test(`[${label}] resync 之后,已知作用域必须重新上报(App 已经送达过映射也一样)`, () => {
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const h = installGuard(page.win, getSrc());

    const first = reportedGroups(h);
    assert.strictEqual(first.length, 1);
    const scope = first[0].scopeKey;
    h.deliver(scope, { '天': '人' });

    // 正常状态:App 已经送达到了 → 不再上报
    h.collect();
    assert.strictEqual(reportedGroups(h).length, 0, 'App 已经送达到就不该再上报');

    // App 重启 → 要求页面把已知作用域重新报一遍。
    // 页面手里还留着**上一任 App** 下发的映射,旧口径会以为"不用报" →
    // App 永远学不到这个作用域 → 不登记这个标签 → 快通道是瞎的。
    page.win.__copyRepairResync();
    h.collect();
    const again = reportedGroups(h);
    assert.strictEqual(again.length, 1, 'resync 之后必须重新上报(App 才学得到这个作用域)');
    assert.strictEqual(again[0].scopeKey, scope);
  });

  test(`[${label}] resync 不能清掉 mappings(这段时间里用户复制照样拿到明文)`, () => {
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const h = installGuard(page.win, getSrc());
    const first = reportedGroups(h);
    const scope = first[0].scopeKey;
    h.deliver(scope, { '天': '人' });

    page.win.__copyRepairResync();
    assert.ok(h.state.mappings[scope], 'resync 之后映射必须还在(清掉 = 用户复制到密文)');
  });

  test(`[${label}] resync 会强制重扫一遍全量(当前没有选区也要重新发现作用域)`, () => {
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const h = installGuard(page.win, getSrc());
    const first = reportedGroups(h);
    assert.strictEqual(first.length, 1);
    h.deliver(first[0].scopeKey, { '天': '人' });

    // 字体没变 → 预热扫描不跑(省 13ms/帧)
    page.win.__styleCalls = 0;
    h.collect();
    assert.strictEqual(page.win.__styleCalls, 0, '字体没变就不该做全量扫描');

    // resync → 强制重扫:把"只存在于扫描结果里"的作用域也重新报上来
    page.win.__styleCalls = 0;
    page.win.__copyRepairResync();
    h.collect();
    assert.ok(page.win.__styleCalls > 0, 'resync 之后必须重扫一遍全量');
  });

  test(`[${label}] 版本升级时保留已有的 mappings(升级不该制造"复制出密文"的窗口)`, () => {
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const oldScope = 'normal|400|font-cxsecret#OLD';
    // 假装页面上装的是**旧版本**守卫,手里已经有上一任 App 下发的映射
    page.win.__copyRepairGuard = {
      version: 1,
      installedAt: 1,
      pending: null,
      mappings: { [oldScope]: { '天': '人' } },
      charScopes: { '天': oldScope },
      log: [],
      repairs: 3,
      copyEvents: 5,
      lastSelectionText: '',
      lastCollectedText: '',
      lastCollectedScope: '',
      fontSig: 'stale-signature',
      pageScopes: [],
      reportedGroups: [
        {
          scopeKey: oldScope,
          family: 'font-cxsecret',
          style: 'normal',
          weight: '400',
          chars: ['天'],
          font: null,
        },
      ],
      reportedAt: { [oldScope]: 1 },
      disabled: false,
      guardActive: false,
      intentText: null,
      internalCall: false,
    };

    const h = installGuard(page.win, getSrc());
    assert.ok(h.state.version > 1, '应当升级到当前版本');
    assert.deepStrictEqual(
      Object.keys(h.state.mappings),
      [oldScope],
      '升级不能清空 mappings(清空 = 升级那一瞬间用户复制就是密文)'
    );
    assert.ok(
      h.state.reportedGroups.some((g) => g.scopeKey === oldScope),
      '升级后旧作用域必须回到"待上报"名单里(新一任 App 才知道要重新下发)'
    );
  });

  test(`[${label}] 选区在旧作用域、页面已经换了新字体 → 新映射不能被自己抹掉`, () => {
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const h = installGuard(page.win, getSrc());

    const first = reportedGroups(h);
    const scope1 = first[0].scopeKey;
    h.deliver(scope1, { '天': '人' });

    // 站点换题:换字体 → 新作用域
    page.style.getPropertyValue = (name) => {
      if (name === 'src') return 'url(data:font/woff2;base64,BBBB)';
      if (name === 'font-family') return '"font-cxsecret"';
      if (name === 'font-weight') return '400';
      if (name === 'font-style') return 'normal';
      return '';
    };
    h.collect();
    const second = reportedGroups(h);
    assert.strictEqual(second.length, 1);
    const scope2 = second[0].scopeKey;
    h.deliver(scope2, { '地': '工' });

    // **用户选中的还是旧作用域**(页面里还留着用旧字体的元素),
    // 于是 collectAndStage 走"有选区"那条分支。
    page.win.__selection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '题干文字',
      getRangeAt: () => ({ commonAncestorContainer: el.__textNode }),
    };
    h.collect();
    reportedGroups(h);

    // ⭐ 关键断言:新作用域的映射必须还在
    //    (以前预热分组排在"删旧指纹"之后 → 会被当成失效作用域删掉,
    //     App 刚下发好的映射一眨眼就没了 → 用户复制到密文)
    assert.ok(
      h.state.mappings[scope2],
      '新作用域的映射不能被"删旧指纹"顺手抹掉'
    );
    assert.deepStrictEqual(
      Object.keys(h.state.mappings),
      [scope1, scope2],
      '两个作用域的映射都应当在(旧的那个是选区正在用的)'
    );
  });

  test(`[${label}] 普通字体(没有字体来源)的作用域不上报(它永远建不出映射)`, () => {
    // 真实页面里,题干周围全是**普通字体**(正文、选项、说明)——
    // 这些作用域的 key 结尾是 `#nofont`:**没有字体文件**,App 侧永远建不出映射。
    //
    // 以前它们每轮都被报上去:App 每轮白处理一遍、页面每轮多报一遍,
    // 日志的 200 条环形缓冲还被 'pending' 冲光(真正的复制记录被挤没了)。
    const normal = normalElement('题干文字');
    const page = makePage({ elements: [normal] });
    page.win.__selection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '题干文字',
      getRangeAt: () => ({ commonAncestorContainer: normal.__textNode }),
    };
    const h = installGuard(page.win, getSrc());

    for (let i = 0; i < 3; i += 1) {
      h.collect();
      assert.strictEqual(
        reportedGroups(h).length,
        0,
        `第 ${i + 1} 轮不该上报普通字体作用域(它没有字体文件,永远建不出映射)`
      );
    }
    assert.deepStrictEqual(
      Object.keys(h.state.reportedAt),
      [],
      '普通字体作用域不该出现在"已上报"名单里'
    );

    // 对照:选区落在**混淆字体**元素里时,必须照常上报
    // (别把过滤做成"什么都不报")。
    const cipher = cipherElement();
    const page2 = makePage({ elements: [cipher] });
    page2.win.__selection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => '题干文字',
      getRangeAt: () => ({ commonAncestorContainer: cipher.__textNode }),
    };
    const h2 = installGuard(page2.win, getSrc());
    h2.collect();
    assert.strictEqual(
      reportedGroups(h2).length,
      1,
      '混淆字体作用域必须照常上报'
    );
  });

  test(`[${label}] 内容没变的 pending 不重复记日志(环形缓冲要留给真正要看的记录)`, () => {
    // 'pending' 是**每轮**都会发生的事(App 还没确认过 → 每轮重报)。
    // 以前每轮都往日志里塞一条 → 三十来秒就把 200 条的环形缓冲冲光,
    // `copy-repaired` / `copy-no-mapping` 这些真正要看的记录被挤没了 ——
    // 排查时连"这次复制走了哪条路径"都查不到。
    const el = cipherElement();
    const page = makePage({ elements: [el] });
    const h = installGuard(page.win, getSrc());

    const count1 = h.state.log.filter((e) => e.event === 'pending').length;
    for (let i = 0; i < 50; i += 1) {
      h.collect();
      reportedGroups(h);
    }
    const count2 = h.state.log.filter((e) => e.event === 'pending').length;
    assert.strictEqual(
      count2,
      count1,
      '内容没变就不该重复记 pending(轮数再多也不该涨)'
    );
    assert.ok(
      h.state.log.length <= 3,
      '日志不能被 pending 冲光(200 条环形缓冲要留给真正要看的记录),实际 ' + h.state.log.length + ' 条'
    );

    // 上报内容真的变了 → 必须再记一条(否则日志里看不出变化)
    page.setSrc('url(data:font/woff2;base64,CCCC)');
    h.collect();
    reportedGroups(h);
    const count3 = h.state.log.filter((e) => e.event === 'pending').length;
    assert.ok(count3 > count2, '上报内容变了必须再记一条 pending');
  });
}

// 入库产物:真正装进 App 的那份
suite('入库产物', () => ARTIFACT_SRC);

// 源码:真身(现编,永远与仓库里的 TS 一致)
suite('源码现编', () => SOURCE_SRC);
