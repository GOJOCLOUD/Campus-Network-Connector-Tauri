/**
 * 字形还原引擎（Node 侧，Safari 方案）。
 *
 * 关键设计：**字形识别全部在 App 侧用字体文件完成**，页面只负责
 * 上报「这一段用的哪个字体 + 哪些字符」。
 *
 * 为什么不用页面 canvas 渲染再回传位图：
 *   canvas 的字形栅格化与参考库的栅格化器不同（抗锯齿/合成方式差异），
 *   实测同一字在两侧的相似度只有 0.87~0.97，margin 小到 0.005，
 *   会出现「专」被判成「令」这种误判。
 *   直接解析字体文件、用与参考库**完全相同**的栅格化器，
 *   实测距离 0.001~0.043、margin 0.03~0.19，判定稳健。
 *
 * 流程：
 *   1. 拿到字体字节（页面内 base64 data: 或可下载 URL）
 *   2. 用 opentype.js 解析，读 name 表得知**底稿字族**（如 Source Han Sans CN）
 *   3. 固定用一套参考字形库（Noto Sans SC 48×48，与底稿同字型）
 *   4. 取每个码位的字形轮廓，用 core 的栅格化器转成位图（与参考库同尺度同量化）
 *   5. 与参考库做最近邻匹配 → 得到"这个码位画的是哪个字"
 *   6. 只有"字体确实重映射了这个码位"（selfDistance 大）才替换
 *
 * 字体按内容哈希缓存，同一个字体只解析一次。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const paths = require('./paths');
const core = require(paths.vendor('copy-repair-core.cjs'));
const opentype = require(paths.vendor('opentype.js'));
const { COMMON_CHARSET } = require(paths.vendor('common-charset.js'));
const { FastGlyphMatcher } = require('./fast-matcher');

/**
 * 常用字集合：字形接近时优先选常用字（例如「一」与全角连字符、
 * 格与挌/恪这类偏旁相同的字）。
 *
 * ⚠️ 必须存**码位数字**：候选的 codepoint 是数字，
 *    之前这里存的是字符串 → `has(codepoint)` 永远 false →
 *    "常用字优先"这个判定其实一直没生效（形近字会选到生僻字）。
 */
const COMMON_SET = new Set(Array.from(COMMON_CHARSET).map((ch) => ch.codePointAt(0)));

/**
 * 参考字形库：只带一套 —— Noto Sans SC 48×48，**GBK 全集**（21526 字）。
 *
 * 为什么是它：目标站点的加密字体底稿是思源黑体（Source Han Sans CN），
 * 与 Noto Sans SC 是**同一字型**，实测平均距离 0.031、margin 0.116（27/27 全中）；
 * 换宋体系立刻变成 0.118 / 0.045（错 4 个）。只保留一套，包更小、命中更稳。
 *
 * 为什么必须是 **GBK 全集**而不是 GB2312：
 *   参考库**缺**某个明文字时，最近邻会给出"形近但不是它"的字，而且
 *   分数/margin 都能过闸门 → **写出错字**。实测（GB2312 库）：
 *     燚 → 焱（分数 0.812，margin 0.074）  垚 → 寺（0.841 / 0.020）
 *     鿕 → 鲋（0.837 / 0.011）  㶿 → 饽（0.895 / 0.029）
 *   而真匹配的分数可以低到 0.888（真实字体的最低分）——**区间重叠，
 *   靠阈值分不开"真匹配"与"缺字错配"**。唯一的办法是让真答案在库里。
 *   库以 gzip 随包分发（9.7MB），解压后约 25MB 内存。
 */
const REFERENCE_DB = {
  key: 'sans',
  file: 'glyph-db-48.crdb.gz',
  label: 'Noto Sans SC 48x48 · GBK 全集（与思源黑体同字型）',
};

const DEFAULTS = {
  // 一次匹配请求最多处理多少字符
  maxCharsPerRound: 256,
  // 替换所需的最低相似度
  minScore: 0.8,
  // 预热时更严：图标字体的"最佳匹配"距离很大，用严闸门挡掉，避免把图标映射成汉字
  // ——注意：这一条**只用于字体级拟合率闸门**（见 buildMapping 里的 MIN_FIT_RATIO），
  // 逐字判定一律用 minScore（预热与选区统一，见 ADR-0009）。
  minPrefetchScore: 0.88,
  // 替换所需的最低次优差距（置信度不足宁可不改）
  minMargin: 0.01,
  // 替换所需的最低"自身距离"：字体把这个码位画成了别的字才允许替换
  minSelfDistance: 0.15,
  // 候选分数接近这个差值时，用"常用字优先"打破平局
  tieEpsilon: 0.02,
  // 常用字的**先验加分**：像素分不出"偏旁相同的字"（格/挌/恪/烙）时，
  // 由字频来分。加分参与 margin 计算 → 只跟"同样说得通的候选"比。
  commonCharPriorBonus: 0.02,
  // 粗筛候选数量（越大越准，越慢）
  maxCandidates: 512,
  // 每个字保留多少个候选（诊断 / 将来做上下文消歧用）
  keepCandidates: 3,
  // 字体缓存最多留几份（防长期运行累积）
  maxCachedFonts: 8,
  // 字体下载失败后的冷却时长：期内不再重复请求（避免每轮都去 404 一次）
  fontFailCooldownMs: 10 * 60 * 1000,
  // 字体级闸门：多少比例的字形对得上常用字，才认定它是混淆字体
  minFontFitRatio: 0.7,
};

/** 把覆盖度量化到 4bit —— 参考库就是这么存的，查询侧必须对称 */
function quantize(coverage) {
  const out = new Float32Array(coverage.length);
  for (let i = 0; i < coverage.length; i += 1) {
    out[i] = Math.round(Math.min(1, Math.max(0, coverage[i])) * 15) / 15;
  }
  return out;
}

/** 读字体的 name 表，得到底稿字族（如 "Source Han Sans CN Normal"） */
function readBaseFamily(font) {
  const names = font.names || {};
  for (const platform of ['windows', 'macintosh']) {
    const record = names[platform] && names[platform].fontFamily;
    if (!record) continue;
    const value = record.en || record['zh-CN'] || Object.values(record)[0];
    if (value) return String(value);
  }
  return '';
}

/**
 * 读参考库文件并反序列化（gzip 自动解开），**不建匹配器**。
 *
 * 参考库只有一份真身：`vendor/glyph-db-48.crdb.gz`（随包分发）。
 * `tools/reference-fonts/*.crdb` 是同内容的未压缩构建产物，**不要直接读它**——
 * 两份会漂移，诊断脚本就会跟线上跑的东西对不上。
 *
 * 需要快速匹配器的走 `GlyphEngine.loadDb`。
 *
 * @param {string} file 绝对路径，或 vendor/ 下的文件名
 */
function loadReferenceDb(file) {
  // 绝对路径 → 原样；带分隔符 → 相对仓库根；只有文件名 → vendor/ 下
  const full = path.isAbsolute(file)
    ? file
    : file.includes(path.sep)
      ? path.resolve(paths.ROOT, file)
      : paths.vendor(file);
  let raw = fs.readFileSync(full);
  // 库以 gzip 随包分发（24MB → 9.7MB），加载时解开
  if (file.endsWith('.gz')) raw = zlib.gunzipSync(raw);
  return core.GlyphDb.deserialize(new Uint8Array(raw));
}

/**
 * 从匹配结果里挑最终答案。
 *
 * 最近邻有时会出现"几个字几乎一样"的情况：
 *   - 「一」与全角连字符这种 → 用**常用字优先**打破平局
 *   - 更常见的是**偏旁相同**的字：格(木各) / 挌(扌各) / 恪(忄各) / 烙(火各)
 *     它们的差别只在左边那一小块，48×48 的像素距离几乎一样
 *     （实测：格 0.8496 vs 挌 0.8472，差 0.0024）。
 *     这种情况下**像素分不出，但字频分得出**：挌/袼/恪 是生僻字，格是常用字。
 *
 * 所以：给常用字一个**先验加分**，并用**加分后的分数**算 margin。
 *   - 常用字 vs 生僻字 → 分得开 → 允许替换（像素虽接近，但字频说得通）
 *   - 两个都是常用字（如 己/已/巳）→ 加分抵消 → 仍然 margin 太小 → 不改
 *   - 两个都是生僻字 → 加分抵消 → 仍然 margin 太小 → 不改
 * 这样既不放过真·难分辨的常用字，又不会因为"旁边恰好有个生僻字"而漏还原。
 */
function pickCandidate(match) {
  const candidates = match.candidates || [];
  if (!candidates.length) {
    return { codepoint: match.codepoint, score: match.score, margin: match.margin, alts: [] };
  }
  const bonus = (cp) => (COMMON_SET.has(cp) ? DEFAULTS.commonCharPriorBonus : 0);
  // 距离用**二值差异**（越小越像）：站点重绘的笔画更细，灰度 L1 会偏向"笔画少"的字
  const dist = (c) => (typeof c.distance === 'number' ? c.distance : 1 - c.score);
  // 常用字先验：等价于把距离调小一点
  const adjusted = (c) => dist(c) - bonus(c.codepoint);
  const ranked = [...candidates].sort((a, b) => adjusted(a) - adjusted(b));
  const preferred = ranked[0];
  let second = Infinity;
  for (const c of ranked) {
    if (c.codepoint === preferred.codepoint) continue;
    if (adjusted(c) < second) second = adjusted(c);
  }
  const alts = candidates
    .filter((c) => c.codepoint !== preferred.codepoint)
    .slice(0, DEFAULTS.keepCandidates)
    .map((c) => ({ codepoint: c.codepoint, score: Number(c.score.toFixed(4)) }));
  return {
    codepoint: preferred.codepoint,
    // score 仍是灰度 L1 的分数（分数闸门沿用原口径，不动）
    score: preferred.score,
    // margin 用**调整后**的距离差：先验参与判定，margin 才反映真实把握
    margin: Math.max(0, second - adjusted(preferred)),
    alts,
  };
}

class GlyphEngine {
  constructor({ dbPath, log } = {}) {
    this.log = log || (() => {});
    this.dbPath = dbPath || null; // null = 按底稿字族自动选
    this.dbs = new Map(); // file -> GlyphDb
    this.matchers = new Map(); // file -> FastGlyphMatcher
    this.scopes = new Map(); // scopeKey -> { mapping, unresolved }
    /** 字体内容哈希 -> { entries: Map<codepoint, info> } */
    this.fontCache = new Map();
    /** 字体下载失败 -> { at, message }（负缓存，冷却期内不重复请求） */
    this.fontFailCache = new Map();
  }

  /** 加载指定参考库（按文件路径缓存），并建好快速匹配器 */
  loadDb(file) {
    if (this.dbs.has(file)) return this.dbs.get(file);
    const db = loadReferenceDb(file);
    this.dbs.set(file, db);
    this.matchers.set(file, new FastGlyphMatcher(db));
    this.log(`参考库已加载：${path.basename(file)}（${db.header.count} 字，栅格 ${db.header.gridSize}）`);
    return db;
  }

  /** 兼容旧调用：默认加载 sans 库 */
  load() {
    return this.loadDb(this.dbPath || REFERENCE_DB.file);
  }

  /**
   * 取字体字节：data: 内嵌直接解码，URL 直接下载（App 侧没有跨域限制）
   *
   * 下载失败会**记进负缓存**：站点里常驻着一些取不到字体的 @font-face
   * （例如跨源的 icomoon.ttf，HTTP 404）。不缓存的话，每一轮调度都会去请求一次，
   * 变成无谓的外部请求 + 日志噪声。这里失败后冷却一段时间再重试。
   */
  async fetchFont(font) {
    if (!font || !font.value) return null;
    if (font.kind === 'data') {
      return Buffer.from(font.value, 'base64');
    }
    if (font.kind === 'url') {
      const url = font.value;
      const failed = this.fontFailCache.get(url);
      if (failed && Date.now() - failed.at < DEFAULTS.fontFailCooldownMs) {
        throw new Error(failed.message);
      }
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      } catch (error) {
        const message = `字体下载失败: ${url} (${error && error.message ? error.message : error})`;
        this.rememberFontFailure(url, message);
        throw new Error(message);
      }
      if (!res.ok) {
        const message = `字体下载失败 HTTP ${res.status}: ${url}`;
        this.rememberFontFailure(url, message);
        throw new Error(message);
      }
      return Buffer.from(await res.arrayBuffer());
    }
    return null;
  }

  /** 记一次字体下载失败，冷却期内不再重复请求 */
  rememberFontFailure(url, message) {
    this.fontFailCache.set(url, { at: Date.now(), message });
    while (this.fontFailCache.size > DEFAULTS.maxCachedFonts) {
      const oldest = this.fontFailCache.keys().next().value;
      this.fontFailCache.delete(oldest);
    }
  }

  /**
   * 解析字体并得出"码位 → 可见字"的对照表。
   * @returns {Map<number, {plain:number|null, score:number, margin:number, selfDistance:number, alts:Array}>}
   */
  analyzeFont(bytes) {
    const hash = crypto.createHash('sha1').update(bytes).digest('hex');
    const cached = this.fontCache.get(hash);
    if (cached) return cached;

    const font = opentype.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const baseFamily = readBaseFamily(font);
    const ref = this.dbPath
      ? { key: 'fixed', file: this.dbPath, label: '指定参考库' }
      : REFERENCE_DB;
    const size = this.loadDb(ref.file).header.gridSize;

    // 1) 逐码位取轮廓并栅格化（与参考库无关，只做一次）
    const glyphIndexMap = font.tables?.cmap?.glyphIndexMap;
    const pairs =
      glyphIndexMap instanceof Map
        ? [...glyphIndexMap.entries()].map(([gid, cps]) => [cps[0], gid])
        : Object.entries(glyphIndexMap || {}).map(([cp, gid]) => [Number(cp), gid]);

    const samples = [];
    for (const [codepoint, glyphId] of pairs) {
      if (!codepoint || codepoint < 0x20 || !glyphId) continue;
      const pathObj = font.getPath(String.fromCodePoint(codepoint), 0, 0, 1);
      const contours = core.flattenPath(pathObj.commands);
      if (!contours.some((c) => c.length >= 6)) continue; // 空字形（.notdef）
      samples.push({
        codepoint,
        coverage: quantize(core.rasterizeContours(contours, size)),
      });
    }

    // 2) 与参考库比对
    const db = this.loadDb(ref.file);
    const attempt = this.matchAgainst(db, samples, this.matchers.get(ref.file));
    const entries = new Map();
    // **字体级闸门**：只有"绝大多数字形都能对上常用字"的字体才是混淆字体。
    // 图标字体(icomoon/VideoJS 之类)里偶尔有一个字形碰巧长得像某个汉字,
    // 如果逐字判定就会把它映射成汉字 → 复制出来是错字。
    // 混淆字体的特征是：**几乎每个字形**都对得上一个常用字。
    const MIN_FIT_RATIO = DEFAULTS.minFontFitRatio;
    const fit = [...attempt.perChar.values()].filter(
      (info) =>
        info.plain !== null &&
        info.plain !== info.selfCodepoint &&
        info.score >= DEFAULTS.minPrefetchScore &&
        info.margin >= DEFAULTS.minMargin &&
        info.selfDistance >= DEFAULTS.minSelfDistance,
    ).length;
    const ratio = attempt.perChar.size ? fit / attempt.perChar.size : 0;
    if (ratio < MIN_FIT_RATIO) {
      this.log(
        `字体 ${baseFamily || '未知'}：只有 ${(ratio * 100).toFixed(0)}% 的字形对得上常用字，` +
          `判定为普通字体（图标字体等），不做映射`,
      );
      this.fontCache.set(hash, entries);
      while (this.fontCache.size > DEFAULTS.maxCachedFonts) {
        const oldest = this.fontCache.keys().next().value;
        this.fontCache.delete(oldest);
      }
      return entries;
    }
    for (const [codepoint, info] of attempt.perChar) {
      entries.set(codepoint, info);
    }
    this.log(
      `字体解析完成：底稿字族「${baseFamily || '未知'}」→ 参考库 ${ref.label}；` +
        `码位 ${entries.size} 个，平均距离 ${attempt.meanDistance.toFixed(4)}，` +
        `平均 margin ${attempt.meanMargin.toFixed(4)}（哈希 ${hash.slice(0, 8)}）`,
    );
    // 字体缓存要**有上限**：每份字体几百个码位、每码位一条对照，
    // 长时间用、题库又多时会累积成几十 MB。只保留最近几份。
    this.fontCache.set(hash, entries);
    while (this.fontCache.size > DEFAULTS.maxCachedFonts) {
      const oldest = this.fontCache.keys().next().value;
      this.fontCache.delete(oldest);
    }
    return entries;
  }

  /** 用某个参考库给全部字形做最近邻匹配，并统计拟合质量 */
  matchAgainst(db, samples, matcher) {
    const perChar = new Map();
    let distanceSum = 0;
    let marginSum = 0;
    let count = 0;
    for (const sample of samples) {
      const ownIndex = db.indexOfCodepoint(sample.codepoint);
      const selfDistance = ownIndex >= 0 ? db.distanceToIndex(ownIndex, sample.coverage) : 1;
      // **预筛**：自身距离不够 = 这个码位没被重映射 → 反正也不会被替换，
      // 也不进字体级拟合率的分子（拟合率本来就要求 selfDistance ≥ 阈值）。
      // 所以跳过它的最近邻搜索**不改变任何判定结果**，只是省掉一次全库检索。
      // 参考库越大（GBK 全集 21526 字）这个预筛越值钱：普通 webfont 几乎全被跳过。
      if (selfDistance < DEFAULTS.minSelfDistance) {
        perChar.set(sample.codepoint, {
          selfCodepoint: sample.codepoint,
          plain: null,
          score: 0,
          margin: 0,
          selfDistance,
          alts: [],
        });
        continue;
      }
      const raw = matcher.lookup(sample.coverage, { maxCandidates: DEFAULTS.maxCandidates });
      const match = pickCandidate(raw);
      const distance = 1 - match.score;
      perChar.set(sample.codepoint, {
        selfCodepoint: sample.codepoint,
        plain: match.codepoint,
        score: match.score,
        margin: match.margin,
        selfDistance,
        alts: match.alts,
      });
      distanceSum += distance;
      marginSum += match.margin;
      count += 1;
    }
    return {
      perChar,
      meanDistance: count ? distanceSum / count : 1,
      meanMargin: count ? marginSum / count : 0,
    };
  }

  /**
   * 处理某个作用域的一批字符。
   * @param {string} scopeKey
   * @param {string[]} chars 选区里出现过的字符
   * @param {{kind:string,value:string}|null} font 该作用域的字体来源
   */
  async processScope(scopeKey, chars, font, options = {}) {
    const limited = chars.slice(0, DEFAULTS.maxCharsPerRound);
    // 预热：没有选区也把整个字体解一遍（映射本来就是按字体建的，与选区无关）。
    // 注意：预热与选区**用同一套阈值**（见下面 mapping 的构建）——
    //      早先预热用更严的 0.88，导致换题后页面里只有"少了几个字"的那张表，
    //      用户"切完题立刻复制"就会漏还原。
    void options;
    const mapping = {};
    let unresolved = 0;
    let reason = '';

    if (!font) {
      // 没有字体来源 → 无法判断这个作用域是否被混淆 → 一个字都不动
      this.scopes.set(scopeKey, { mapping, unresolved: limited.length });
      return { scopeKey, obfuscated: false, mapping, unresolved: limited.length, reason: 'no-font' };
    }

    let entries;
    try {
      const bytes = await this.fetchFont(font);
      if (!bytes) throw new Error('字体来源为空');
      entries = this.analyzeFont(bytes);
    } catch (error) {
      const cause = error && error.cause ? ` (${error.cause.code || ''} ${error.cause.message || ''})` : '';
      reason = 'font-fetch-failed: ' + String(error && error.message ? error.message : error) + cause;
      this.scopes.set(scopeKey, { mapping, unresolved: limited.length });
      return { scopeKey, obfuscated: false, mapping, unresolved: limited.length, reason };
    }

    const uncertain = [];
    // 关键：映射必须**按字体建**，不能只覆盖"采集时选区里出现过的字"。
    // 否则用户扩大选区后，新出现的密文字没有映射 → 复制出来还是乱码
    // （实测：选区只含第 1 题时只解出 7 个字，换成 5 题后第 2~5 题全是密文）。
    // 字体里的每个码位都已经算好了，这里整份下发，任意选区都覆盖得到。
    //
    // 阈值：**预热与选区用同一个**（minScore）。
    //   早先预热用更严的 minPrefetchScore(0.88)，选区用 minScore(0.8)，
    //   结果预热下发的表**比选区少几条**（实测少一条：调→需，0.8~0.88 之间）。
    //   用户换题后"选中就立刻复制"，此时页面上只有预热那张表 → 那几个字查不到
    //   → 复制出来一半是密文。**这正是"换题就失败"的成因。**
    //   图标字体不需要靠这条更严的阈值来挡 —— 字体级拟合率闸门(≥0.7)早就把它
    //   判成普通字体、压根不建映射了(icomoon 实测 3%)。
    const minScore = DEFAULTS.minScore;
    for (const [cp, info] of entries) {
      const char = String.fromCodePoint(cp);
      if (info.plain === null || info.plain === cp) continue; // 画的就是它自己
      if (info.selfDistance < DEFAULTS.minSelfDistance) continue; // 没被重映射
      if (info.score < minScore) continue;
      if (info.margin < DEFAULTS.minMargin) {
        // 认不准：记下来供诊断，但**不改**
        uncertain.push({ char, ...info });
        continue;
      }
      mapping[char] = String.fromCodePoint(info.plain);
    }

    const resolved = Object.keys(mapping).length;
    const inSelection = limited.filter((c) => mapping[c]).length;
    unresolved = resolved - inSelection;
    const obfuscated = resolved > 0;
    this.scopes.set(scopeKey, { mapping, unresolved, uncertain });
    if (process.env.CR_DEBUG) {
      this.log(
        `作用域 ${scopeKey.slice(0, 50)}：字体共 ${entries.size} 个码位，解出 ${resolved} 个` +
          `（选区命中 ${inSelection} 个）` +
          (uncertain.length ? `，不确定 ${uncertain.length} 个（保持原样）` : '') +
          (reason ? `（${reason}）` : ''),
      );
    }
    return { scopeKey, obfuscated, mapping, unresolved, uncertain, reason };
  }

  /** 取某个作用域已缓存的映射（诊断用）。 */
  mappingFor(scopeKey) {
    const record = this.scopes.get(scopeKey);
    return record ? record.mapping : null;
  }

  /** 已处理作用域的数量（诊断用）。 */
  stats() {
    return { scopes: this.scopes.size, fonts: this.fontCache.size, dbs: this.dbs.size };
  }
}

module.exports = { GlyphEngine, DEFAULTS, REFERENCE_DB, pickCandidate, loadReferenceDb };
