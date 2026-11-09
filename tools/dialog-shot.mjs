/** 弹窗改版截图：绑定表单、提示卡、长文本卡。 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => document.querySelector('[data-tab="settings"]')?.click());
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(() => document.querySelector('[data-tab="backup"]')?.click());
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(() => document.querySelector('[data-bind="github"]')?.click());
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: 'screenshots/app/30-dialog-form.png' });
await page.evaluate(() => document.querySelector('.fm-dialog [data-act="cancel"]')?.click());
await new Promise((r) => setTimeout(r, 400));

await page.evaluate(async () => {
  const { showAlert } = await import('/src/ui/dialog.ts');
  void showAlert('GitHub 返回 401：Token 无效或权限不足，请在 Fine-grained token 里勾选 Contents 读写。', {
    title: 'GitHub 连接失败',
    tone: 'error',
  });
});
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: 'screenshots/app/31-dialog-alert.png' });
await page.evaluate(() => document.querySelector('.fm-dialog [data-act="ok"]')?.click());
await new Promise((r) => setTimeout(r, 400));

await page.evaluate(async () => {
  const { showText } = await import('/src/ui/dialog.ts');
  void showText({
    title: '发给华为客服的话术',
    text: '你好，我申请导出的运动健康数据副本里只有最近 1 年的记录，我需要导出最近 5 年的全部运动数据（含轨迹），麻烦帮忙把我的历史数据准备到导出系统，谢谢。',
  });
});
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: 'screenshots/app/32-dialog-text.png' });

await browser.close();
console.log('shots done');
