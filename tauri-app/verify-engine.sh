#!/usr/bin/env bash
# 字形引擎对拍：Rust 版 vs TypeScript 版
#
#   tauri-app/verify-engine.sh
#
# 两边跑**同一批真实站点字体**，把映射表 dump 成 JSON 逐条比。
# 目的：证明"移植到 Rust"没有改变任何判定结果 —— 这是"宁可留错字绝不写错字"的底线。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/src/features/safari-repair/test/fixtures/live"
DB="$ROOT/vendor/glyph-db-48.crdb.gz"
BIN="$ROOT/tauri-app/tools/glyph-check/target/release/glyph-check"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [ ! -x "$BIN" ]; then
  echo "先编译: cd tauri-app/tools/glyph-check && cargo build --release"
  exit 1
fi
if [ ! -f "$DB" ]; then
  echo "参考库缺失，先生成: npm run build:vendor"
  exit 1
fi

fail=0
for font in "$FIX"/*.ttf; do
  name="$(basename "$font" .ttf)"
  truth="$FIX/$name.truth.json"
  echo "════ $name ════"
  node "$ROOT/tauri-app/tools/ts-dump.js" "$font" "$TMP/ts.json"
  GLYPH_DUMP="$TMP/rs.json" "$BIN" "$font" "$truth" "$DB" | sed 's/^/  /'
  node -e "
const fs=require('fs');
const a=JSON.parse(fs.readFileSync('$TMP/ts.json'));
const b=JSON.parse(fs.readFileSync('$TMP/rs.json'));
const keys=new Set([...Object.keys(a),...Object.keys(b)]);
let diff=0;
for(const k of keys) if(a[k]!==b[k]) diff++;
console.log('  映射条数 TS='+Object.keys(a).length+' RS='+Object.keys(b).length+' 差异 '+diff+' 处');
process.exit(diff===0?0:1);
" || fail=1
done
[ $fail -eq 0 ] && echo "✅ Rust 引擎与 TypeScript 引擎完全一致" || echo "❌ 存在差异"
exit $fail
