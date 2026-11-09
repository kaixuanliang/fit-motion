import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args: ['--no-sandbox','--disable-gpu','--hide-scrollbars'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('EXC', e.message); });
page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log('ERR', m.text()); } });
await page.goto('file:///D:/Mine/fit-motion/dist/index.html', { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 1200));
// 生产包里没有 dev 的模块路径，直接用页面内已有的解析器不好拿，改为验证占位与主题切换
await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
await page.evaluate(() => document.querySelector('[data-set-theme="night"]').click());
await new Promise(r => setTimeout(r, 300));
await page.screenshot({ path: 'screenshots/app/11-dist-settings-night.png' });
const state = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  view: document.getElementById('app').dataset.view,
  sum: document.getElementById('records-sum').textContent,
  tabs: document.querySelectorAll('.tab').length,
}));
console.log(state, 'errors', errors.length);
await browser.close();
