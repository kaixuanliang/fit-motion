/** 创作页舞台水平居中检查 + 全屏主题切换检查。 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));

await page.evaluate(async () => {
  const { SAMPLE_FIT_BASE64, SAMPLE_NAME } = await import('/src/data/sample.ts');
  const bin = atob(SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], SAMPLE_NAME));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    if (document.getElementById('import-overlay')?.hidden === true) break;
  }
  document.querySelector('#records-pane .rec')?.click();
});
for (let i = 0; i < 480; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  if (await page.evaluate(() => window.__fitReady === true)) break;
}
await new Promise((r) => setTimeout(r, 800));
const box = await page.evaluate(() => {
  const f = document.getElementById('stage-frame').getBoundingClientRect();
  return {
    left: Math.round(f.left), right: Math.round(innerWidth - f.right), width: Math.round(f.width),
    vw: innerWidth, centered: Math.abs(f.left - (innerWidth - f.right)) <= 2,
  };
});
console.log('STAGE', JSON.stringify(box));
await page.screenshot({ path: 'screenshots/app/50-stage-center.png' });

// 全屏 + 主题标签点击
await page.evaluate(() => document.getElementById('fullscreen-btn')?.click());
await new Promise((r) => setTimeout(r, 900));
const fs = await page.evaluate(() => ({
  active: document.getElementById('studio').classList.contains('fs'),
  tagText: document.getElementById('fs-theme-tag')?.textContent,
  tagTag: document.getElementById('fs-theme-tag')?.tagName,
  themeSheet: !!document.getElementById('theme-sheet'),
}));
console.log('FS', JSON.stringify(fs));
await page.screenshot({ path: 'screenshots/app/51-fs-theme.png' });
if (fs.themeSheet) {
  await page.evaluate(() => document.getElementById('fs-theme-tag')?.click());
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: 'screenshots/app/52-theme-sheet.png' });
  const opened = await page.evaluate(() => document.getElementById('theme-sheet')?.classList.contains('open'));
  await page.evaluate(() => document.querySelector('#theme-sheet [data-pick-theme="night"]')?.click());
  await new Promise((r) => setTimeout(r, 2500));
  const after = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    tag: document.getElementById('fs-theme-tag')?.textContent,
    stillFs: document.getElementById('studio').classList.contains('fs'),
    sheetOpen: document.getElementById('theme-sheet')?.classList.contains('open'),
  }));
  console.log('PICK', JSON.stringify({ opened, after }));
  await page.screenshot({ path: 'screenshots/app/53-theme-night.png' });
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close();
