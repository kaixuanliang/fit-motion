import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const outDir = 'screenshots/prototype';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--disable-crash-reporter', '--disable-breakpad'],
  defaultViewport: { width: 1100, height: 920, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
page.on('pageerror', (error) => console.log('PAGE EXCEPTION:', error.message));
page.on('console', (message) => {
  if (message.type() === 'error') console.log('PAGE ERROR:', message.text());
});

await page.goto('file:///D:/Mine/fit-motion/prototype/fitmotion-prototype.html', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 400));

const phone = await page.$('.phone');

async function shot(name) {
  await new Promise((r) => setTimeout(r, 260));
  await phone.screenshot({ path: `${outDir}/${name}.png` });
  console.log('saved', name);
}

await shot('01-records-tech');

await page.evaluate(() => document.querySelector('[data-set-theme="light"]').click());
await shot('02-records-light');

await page.evaluate(() => document.querySelector('[data-set-theme="night"]').click());
await page.evaluate(() => document.querySelector('.mini-create').click());
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => document.getElementById('playBtn').click());
await new Promise((r) => setTimeout(r, 900));
await shot('03-create-night-playing');

await page.evaluate(() => {
  document.getElementById('backBtn').click();
  document.querySelector('[data-tab="import"]').click();
});
await shot('04-import');

await page.evaluate(() => document.querySelector('[data-tab="backup"]').click());
await shot('05-backup');

await page.evaluate(() => {
  document.querySelector('[data-tab="settings"]').click();
  document.querySelector('[data-set-theme="tech"]').click();
});
await shot('06-settings');

await page.evaluate(() => {
  document.querySelector('[data-tab="records"]').click();
  document.getElementById('loadMore').click();
  document.getElementById('loadMore').click();
});
await shot('07-records-loaded');

const counts = await page.evaluate(() => ({
  cards: document.querySelectorAll('.rec').length,
  chips: document.querySelectorAll('.chip').length,
  summary: document.getElementById('recSum').textContent,
  foot: document.getElementById('loadMore').textContent,
}));
console.log(counts);

// 记录卡特写 + 点卡片进创作页 + 全屏播放 + 退出全屏
const card = await page.$('.rec');
await card.screenshot({ path: `${outDir}/08-card-actions.png` });
await page.evaluate(() => document.querySelector('.rec').click());
await new Promise((r) => setTimeout(r, 700));
await shot('09-create-from-card');
await page.evaluate(() => document.getElementById('fsBtn').click());
await new Promise((r) => setTimeout(r, 1400));
await shot('10-create-fullscreen');
await page.evaluate(() => document.getElementById('fsSwap').click());
await new Promise((r) => setTimeout(r, 400));
await shot('12-fullscreen-song-sheet');
await page.evaluate(() => document.getElementById('sheetMask').click());
await page.evaluate(() => document.getElementById('fsExit').click());
await new Promise((r) => setTimeout(r, 500));
await shot('11-back-to-create');

await browser.close();
