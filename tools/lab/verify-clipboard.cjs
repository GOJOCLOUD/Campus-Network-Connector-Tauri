/**
 * 读系统剪贴板并与期望的修复结果比对（验收用）。
 *
 *   node tools/lab/verify-clipboard.cjs
 *
 * 用 osascript 读剪贴板（UTF-8）；pbpaste 默认按系统区域设置输出，中文环境会乱码。
 */
const { execFileSync } = require('node:child_process');

function readClipboard() {
  return execFileSync('osascript', ['-e', 'the clipboard as text'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

const EXPECT_MARKERS = ['目前中国专利法', '实用新型和外观设计', '授予的期限为'];

function main() {
  let text = '';
  try {
    text = readClipboard();
  } catch (e) {
    console.log('读取剪贴板失败:', e.message);
    process.exit(1);
  }
  console.log(`剪贴板长度: ${text.length} 字符`);
  console.log('内容:');
  console.log(text.slice(0, 1200));
  console.log('---');
  const hits = EXPECT_MARKERS.filter((m) => text.includes(m));
  console.log(`期望片段命中 ${hits.length}/${EXPECT_MARKERS.length}: ${hits.join(' / ') || '无'}`);
  const hasCipher = /[㐀-䶿]/.test(text);
  console.log(hasCipher ? '仍含生僻密文字（说明没修好）' : '不含密文生僻字');
}

main();
