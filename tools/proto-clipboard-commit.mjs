/**
 * 复制提交机制对照实验（有头 Chrome）：
 *   0) 哨兵写入 —— 确认每次测试前剪贴板是干净的
 *   1) 真实 Cmd+C（不改写）—— 确认复制本身生效
 *   2) 真实 Cmd+C + 事件内 setData —— 改写是否被提交
 *   3) 真实 Cmd+C + preventDefault + 异步 clipboard.write —— 替代路径
 */
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';

function clipboard() {
  try {
    return execFileSync('pbpaste', ['-Prefer', 'txt'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

async function sentinel(browser, site) {
  const page = await browser.newPage();
  await page.goto(`${site.origin}/tests/fixtures/a-normal.html`);
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL').catch(() => {}));
  await new Promise((r) => setTimeout(r, 300));
  await page.close();
}

async function main() {
  const { startServer } = await import('../tests/e2e/server.mjs');
  const site = await startServer(process.cwd());
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--window-size=900,600'],
  });

  const setup = async (withListener) => {
    const page = await browser.newPage();
    await page.goto(`${site.origin}/tests/fixtures/a-normal.html`, { waitUntil: 'load' });
    await page.bringToFront();
    await page.evaluate((useListener) => {
      window.__events = [];
      if (useListener) {
        document.addEventListener(
          'copy',
          (e) => {
            e.clipboardData.setData('text/plain', 'MODIFIED-VIA-EVENT');
            window.__events.push('setData-ok:' + e.clipboardData.getData('text/plain'));
          },
          true,
        );
      }
      const el = document.getElementById('p1');
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, withListener);
    await new Promise((r) => setTimeout(r, 250));
    return page;
  };

  const pressCopy = async (page) => {
    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyC');
    await page.keyboard.up('Meta');
    await new Promise((r) => setTimeout(r, 600));
  };

  // 1) 不改写的 Cmd+C
  await sentinel(browser, site);
  let page = await setup(false);
  await pressCopy(page);
  console.log('1) Cmd+C 无改写      =>', JSON.stringify(clipboard().slice(0, 24)));
  await page.close();

  // 2) 改写的 Cmd+C
  await sentinel(browser, site);
  page = await setup(true);
  await pressCopy(page);
  console.log('2) Cmd+C + setData   =>', JSON.stringify(clipboard().slice(0, 24)));
  console.log('   页面事件日志       =>', JSON.stringify(await page.evaluate(() => window.__events)));
  await page.close();

  // 3) preventDefault + 异步写入
  await sentinel(browser, site);
  page = await setup(false);
  await page.evaluate(() => {
    document.addEventListener(
      'copy',
      (e) => {
        e.preventDefault();
        navigator.clipboard.writeText('MODIFIED-VIA-ASYNC').catch(() => {});
      },
      true,
    );
  });
  await pressCopy(page);
  console.log('3) Cmd+C + 异步写入  =>', JSON.stringify(clipboard().slice(0, 24)));
  await page.close();

  await browser.close();
  await site.close();
}

main();
