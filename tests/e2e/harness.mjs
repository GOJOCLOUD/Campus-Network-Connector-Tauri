/**
 * e2e 测试脚手架。
 *
 * 关键约束（实测结论）：
 *  - headless Chrome 不会把 copy 事件里改写的 clipboardData 提交到系统剪贴板，
 *    因此"复制结果是否正确"必须用有头 Chrome + 系统剪贴板核对。
 *  - macOS 的 Cmd+C 是原生菜单动作，CDP 合成的按键不会触发复制；
 *    这里用 CDP 的编辑命令通道 Input.dispatchKeyEvent{commands:['copy']}，
 *    它走浏览器真实的复制命令路径（与菜单 Copy 同一条路径）。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');

/** 读取 macOS 系统剪贴板（用 osascript，避免编码歧义）。 */
export function readClipboard() {
  try {
    return execFileSync('osascript', ['-e', 'the clipboard as text'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

export async function launchWithExtension(extensionPath) {
  return puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--window-size=1000,700',
      '--window-position=40,40',
    ],
  });
}

/** 在页面里选中某个元素的全部内容。 */
export async function selectElement(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, selector);
}

/** 触发浏览器真实的复制命令（等价于用户按 Cmd+C / Ctrl+C）。 */
export async function triggerCopy(page, client) {
  const session = client ?? (await page.createCDPSession());
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
    key: 'c',
    code: 'KeyC',
    commands: ['copy'],
    modifiers: 4,
  });
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
    key: 'c',
    code: 'KeyC',
    modifiers: 4,
  });
}

/** 复制并读取系统剪贴板。 */
export async function copyAndRead(page, client) {
  await triggerCopy(page, client);
  await new Promise((r) => setTimeout(r, 600));
  return readClipboard();
}

export async function extensionStats(page) {
  const raw = await page.evaluate(() =>
    document.documentElement.getAttribute('data-copy-repair'),
  );
  return raw ? JSON.parse(raw) : null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
