/**
 * 清理测试残留。
 *
 * ⚠️ 安全约束:测试脚本现在**只加临时标签页、不再新建窗口**,
 * 所以这里默认只**列出**候选,不会自动关。
 * 真要关也只关"**只有一个标签**且该标签是本地测试页"的窗口 ——
 * 绝不能按"URL 含 127.0.0.1"去关用户的窗口(之前就是这么把用户窗口拆成两个的)。
 *
 *   node safari-repair/test/cleanup.cjs          # 只列出
 *   node safari-repair/test/cleanup.cjs --close  # 关掉符合条件的(单标签本地页)
 */
const { execFileSync } = require('child_process');

function osa(s) {
  return execFileSync('osascript', ['-e', s], { encoding: 'utf8' });
}

const shouldClose = process.argv.includes('--close');

const candidates = osa(`tell application "Safari"
  set out to ""
  repeat with wi from 1 to (count of windows)
    try
      set n to (count of tabs of window wi)
      if n is 1 then
        set u to (URL of tab 1 of window wi)
        if u contains "127.0.0.1" then set out to out & (wi as text) & "|" & u & linefeed
      end if
    end try
  end repeat
  return out
end tell`).trim();

if (!candidates) {
  console.log('没有发现测试残留窗口');
} else {
  const rows = candidates.split('\n').filter(Boolean);
  console.log(`发现 ${rows.length} 个候选窗口(单标签 + 本地地址):`);
  for (const r of rows) console.log('   ' + r);
  if (!shouldClose) {
    console.log('\n加 --close 才会关闭它们。');
  } else {
    for (const r of rows) {
      const wi = Number(r.split('|')[0]);
      osa(`tell application "Safari"
        try
          close window ${wi}
        end try
      end tell`);
      console.log('   已关闭窗口 ' + wi);
    }
  }
}
