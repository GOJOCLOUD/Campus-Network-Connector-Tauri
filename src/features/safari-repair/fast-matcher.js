/**
 * 快速字形匹配器（Safari 侧专用）。
 *
 * 为什么不用 core 的 GlyphDb.lookup：
 *   它每次查询都要遍历全库 7949 条做粗距离 + 全量排序 + 512 次精筛，
 *   实测 **5.36ms/字**。字库大一点（比如某次考试用到 1000 个密文字）就是 5 秒，
 *   用户根本等不到映射下发 → 复制出来还是密文。
 *
 * 这里做两件事：
 *   1) **精确哈希快路径**：密文字体通常是把明文字形**原样搬到**密文码位
 *      （实测这类字体的字形与参考字形逐位相同，距离 0.0000）。
 *      建一张「量化位图哈希 → 码位」的表，命中就是 O(1)，1000 字只要 20ms。
 *   2) **更快的最近邻**：粗距离用预展开的 nibble 数组（避免每次解包 + 查表），
 *      精筛用无排序的部分选择（只留前 K 个候选）。
 *
 * 命中不了精确哈希的字（站点把字形**重绘**过，真实站点就是这种）走最近邻，
 * 实测 0.65ms/字。
 */
const core = require(require('./paths').vendor('copy-repair-core.cjs'));

/** 量化覆盖度 → 4bit 打包字节（与参考库同格式） */
function pack(coverage, size) {
  const bytes = new Uint8Array((size * size) >> 1);
  for (let i = 0; i < size * size; i += 2) {
    const hi = Math.round(Math.min(1, Math.max(0, coverage[i])) * 15);
    const lo = Math.round(Math.min(1, Math.max(0, coverage[i + 1] ?? 0)) * 15);
    bytes[i >> 1] = (hi << 4) | lo;
  }
  return bytes;
}

/** FNV-1a 64 位（用两个 32 位拼接成一个 number 作为 Map key 的替代） */
function hashBytes(bytes) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + bytes[i] * 2654435761) >>> 0;
  }
  return `${h1.toString(36)}:${h2.toString(36)}`;
}

class FastGlyphMatcher {
  constructor(db) {
    this.db = db;
    this.size = db.header.gridSize;
    this.coarseSize = db.header.coarseSize;
    this.count = db.header.count;
    this.fineBytes = (this.size * this.size) >> 1;
    this.coarseCells = this.coarseSize * this.coarseSize;

    // 参考库的粗栅格解包成 nibble 数组（count × cells），避免每次查询都解包
    this.coarseNibbles = new Uint8Array(this.count * this.coarseCells);
    for (let i = 0; i < this.count; i += 1) {
      const off = i * (this.coarseCells >> 1);
      for (let c = 0; c < this.coarseCells; c += 1) {
        const b = db.coarse[off + (c >> 1)];
        this.coarseNibbles[i * this.coarseCells + c] = c % 2 === 0 ? b >> 4 : b & 15;
      }
    }

    // 精确哈希索引：量化位图 → 码位
    this.exact = new Map();
    for (let i = 0; i < this.count; i += 1) {
      const off = i * this.fineBytes;
      const view = db.fine.subarray(off, off + this.fineBytes);
      const key = hashBytes(view);
      let list = this.exact.get(key);
      if (!list) {
        list = [];
        this.exact.set(key, list);
      }
      list.push(i);
    }
  }

  /** 与参考库某个条目的精细位图逐字节比较 */
  sameAsReference(queryPacked, index) {
    const off = index * this.fineBytes;
    const ref = this.db.fine.subarray(off, off + this.fineBytes);
    for (let i = 0; i < queryPacked.length; i += 1) {
      if (queryPacked[i] !== ref[i]) return false;
    }
    return true;
  }

  /**
   * 最近邻匹配。
   * @returns {{codepoint:number|null, score:number, margin:number, exact:boolean, alts:Array}}
   */
  lookup(coverage, { maxCandidates = 256 } = {}) {
    const size = this.size;
    const queryPacked = pack(coverage, size);

    // ① 精确命中（字形是原件搬运）
    const exactList = this.exact.get(hashBytes(queryPacked));
    if (exactList) {
      for (const index of exactList) {
        if (this.sameAsReference(queryPacked, index)) {
          const codepoint = this.db.codepoints[index];
          return {
            codepoint,
            score: 1,
            margin: 1,
            runnerUp: null,
            exact: true,
            candidates: [{ codepoint, score: 1 }],
          };
        }
      }
    }

    // ② 粗距离（不解包、不排序，只保留前 K）
    const coarseQuery = core.downsample(coverage, size, this.coarseSize);
    const qNibbles = new Uint8Array(this.coarseCells);
    for (let c = 0; c < this.coarseCells; c += 1) {
      const v = coarseQuery[c];
      qNibbles[c] = Math.round(Math.min(1, Math.max(0, v)) * 15);
    }
    const scores = new Float32Array(this.count);
    const cn = this.coarseNibbles;
    const cells = this.coarseCells;
    for (let i = 0; i < this.count; i += 1) {
      const base = i * cells;
      let sum = 0;
      for (let c = 0; c < cells; c += 1) {
        sum += Math.abs(qNibbles[c] - cn[base + c]);
      }
      scores[i] = 1 - sum / (15 * cells);
    }

    // 部分选择：只取前 K（不排序全库）
    const K = Math.min(maxCandidates, this.count);
    const best = [];
    let worst = -1;
    for (let i = 0; i < this.count; i += 1) {
      const s = scores[i];
      if (best.length < K) {
        best.push(i);
        if (best.length === K) {
          worst = scores[best[0]];
          for (const b of best) if (scores[b] < worst) worst = scores[b];
        }
      } else if (s > worst) {
        // 替换掉当前最差的那个
        let wi = 0;
        let ws = Infinity;
        for (let b = 0; b < best.length; b += 1) {
          if (scores[best[b]] < ws) {
            ws = scores[best[b]];
            wi = b;
          }
        }
        best[wi] = i;
        worst = Infinity;
        for (const b of best) if (scores[b] < worst) worst = scores[b];
      }
    }

    // ③ 精筛
    //    两种距离同时算：
    //      score    —— 灰度 L1（沿用原口径，"像不像"）
    //      distance —— **二值差异**（比形状、不比笔画粗细）
    //    为什么要有二值：站点把字形**重绘**过，笔画往往比参考**细**。
    //    灰度 L1 里"笔画少一半"的字反而更近（实测：站点的「略」离「赂」0.1007、
    //    离「略」0.1162 → 判错）。二值化去掉粗细因素后：
    //    「略」0.0920 < 「赂」0.1042 → 判对，margin 也从 0.0019 放大到 0.0122。
    //    "重绘得更细"是站点的通用做法 → 必须在**度量**上解决，调阈值没用。
    const qFine = queryPacked;
    const cells2 = this.size * this.size;
    let bestIndex = -1;
    let bestScore = -1;
    let bestDist = Infinity;
    let secondDist = Infinity;
    const ranked = [];
    for (const index of best) {
      const off = index * this.fineBytes;
      const ref = this.db.fine.subarray(off, off + this.fineBytes);
      let sum = 0;
      let binDiff = 0;
      for (let i = 0; i < this.fineBytes; i++) {
        const b = ref[i];
        const q = qFine[i];
        sum += Math.abs((b >> 4) - (q >> 4)) + Math.abs((b & 15) - (q & 15));
        // 二值：nibble >= 8 视为有笔画（4bit 量化的 0.5 阈值）
        if (((b >> 4) >= 8) !== ((q >> 4) >= 8)) binDiff += 1;
        if (((b & 15) >= 8) !== ((q & 15) >= 8)) binDiff += 1;
      }
      const score = 1 - sum / (15 * cells2);
      const distance = binDiff / cells2;
      ranked.push({ index, score, distance });
      if (distance < bestDist) {
        secondDist = bestDist;
        bestDist = distance;
        bestScore = score;
        bestIndex = index;
      } else if (distance < secondDist) {
        secondDist = distance;
      }
    }
    ranked.sort((a, b) => a.distance - b.distance);
    return {
      codepoint: bestIndex >= 0 ? this.db.codepoints[bestIndex] : null,
      score: Math.max(0, bestScore),
      // margin 用**二值差异**：能分清 = 形状上的差别够大（与笔画粗细无关）
      margin: Math.max(0, secondDist - bestDist),
      distance: bestDist,
      runnerUp: ranked.length > 1 ? this.db.codepoints[ranked[1].index] : null,
      exact: false,
      candidates: ranked.slice(0, 24).map((r) => ({
        codepoint: this.db.codepoints[r.index],
        score: r.score,
        distance: r.distance,
      })),
    };
  }
}

module.exports = { FastGlyphMatcher, pack, hashBytes };
