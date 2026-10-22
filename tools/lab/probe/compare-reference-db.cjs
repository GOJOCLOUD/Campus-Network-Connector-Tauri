/**
 * 对比两套参考库（GB2312 / GBK）在同一批字体上的准确率与耗时。
 *
 *   node tools/lab/compare-reference-db.cjs
 *
 * 为什么要比：参考库越大 → 候选越多 → 理论上更容易"认错邻居"。
 * 用**带真值的混淆字体**（map.json 就是真值）逐字核对，
 * 准确率掉了就不能换大库。
 */
const fs = require('fs');
const path = require('path');
const { GlyphEngine } = require('../../../src/features/safari-repair/engine');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIX = path.join(ROOT, 'src/features/safari-repair/test/fixtures/fonts');

// 默认只比**当前在用的**库（GBK 全集）。
// 要复现历史上「GB2312 vs GBK」的对比，先用不带 CR_INCLUDE_GBK 的命令
// 重建一份 GB2312 库，再把它的路径作为参数传进来。
const DBS = [
  { name: 'GBK(含生僻字)', file: path.join(ROOT, 'vendor', 'glyph-db-48.crdb.gz') },
  ...process.argv.slice(2).map((f) => ({ name: path.basename(f), file: path.resolve(f) })),
];

const FONTS = [
  { name: '仓库混淆字体 A', ttf: 'obf-same-style.ttf', map: 'obf-same-style.map.json' },
  { name: '仓库混淆字体 B', ttf: 'obf-second-style.ttf', map: 'obf-second-style.map.json' },
];

async function main() {
  for (const db of DBS) {
    if (!fs.existsSync(db.file)) {
      console.log(`跳过 ${db.name}（缺少 ${path.basename(db.file)}）`);
      continue;
    }
    console.log(`\n=== 参考库：${db.name}（${(fs.statSync(db.file).size / 1024 / 1024).toFixed(1)} MB）===`);
    const engine = new GlyphEngine({ dbPath: db.file, log: () => {} });
    for (const f of FONTS) {
      const truth = JSON.parse(fs.readFileSync(path.join(FIX, f.map), 'utf8'));
      const bytes = fs.readFileSync(path.join(FIX, f.ttf));
      const font = { kind: 'data', value: bytes.toString('base64') };
      const t0 = Date.now();
      const result = await engine.processScope('scope-' + f.name, Object.keys(truth), font, {});
      const ms = Date.now() - t0;
      let right = 0;
      let wrong = 0;
      let missed = 0;
      const wrongList = [];
      for (const [cipher, plain] of Object.entries(truth)) {
        const got = result.mapping[cipher];
        if (got === plain) right += 1;
        else if (got === undefined) missed += 1;
        else {
          wrong += 1;
          if (wrongList.length < 6) wrongList.push(`${cipher}→${got}(应 ${plain})`);
        }
      }
      const total = Object.keys(truth).length;
      console.log(`  ${f.name}: 正确 ${right}/${total}  认错 ${wrong}  未识别 ${missed}  耗时 ${ms}ms`);
      if (wrongList.length) console.log(`    认错的: ${wrongList.join('  ')}`);
    }
  }
}

main().catch((e) => {
  console.error('失败:' + String(e && e.message ? e.message : e));
  process.exit(1);
});
