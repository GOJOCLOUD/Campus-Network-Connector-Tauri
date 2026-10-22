/**
 * 按 URL 关键字找 Safari 标签页索引（标签序号会变，不能写死）。
 *   node tools/lab/find-tab.cjs chaoxing
 */
const { execFileSync } = require('child_process');

function findTab(keyword) {
  const out = execFileSync('osascript', ['-e', `tell application "Safari"
    set out to ""
    repeat with wi from 1 to (count of windows)
      repeat with ti from 1 to (count of tabs of window wi)
        try
          set u to (URL of tab ti of window wi)
          if u contains "${keyword}" then set out to out & wi & "|" & ti & "|" & u & linefeed
        end try
      end repeat
    end repeat
    return out
  end tell`], { encoding: 'utf8' });
  return String(out).split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [w, t, ...r] = l.split('|'); return { window: Number(w), index: Number(t), url: r.join('|') }; });
}

if (require.main === module) {
  const kw = process.argv[2] || 'chaoxing';
  for (const t of findTab(kw)) console.log(`窗口 ${t.window} 标签 ${t.index}  ${t.url.slice(0, 80)}`);
}
module.exports = { findTab };
