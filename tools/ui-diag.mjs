/** 诊断截图：导入弹窗、创作页缓存提示。 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 700));

// 清空记录以便重新导入，观察导入弹窗
await page.evaluate(async () => {
  const { clearAll } = await import('/src/store/repo.ts').catch(() => ({ clearAll: null }));
  if (clearAll) await clearAll();
});

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
});
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: 'screenshots/app/40-import-progress.png' });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'screenshots/app/41-import-done.png' });
const box = await page.evaluate(() => {
  const el = document.querySelector('.import-modal');
  const r = el?.getBoundingClientRect();
  return r ? { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight } : null;
});
console.log('import modal box', JSON.stringify(box));

await page.evaluate(() => document.getElementById('import-close')?.click());
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => document.querySelector('#records-pane .rec')?.click());
await new Promise((r) => setTimeout(r, 500));
const loading = await page.evaluate(() => {
  const el = document.getElementById('stage-loading');
  const row = el?.querySelector('.cache-row');
  return {
    text: el?.textContent?.trim(),
    rowRect: row ? row.getBoundingClientRect().height : null,
    height: el?.getBoundingClientRect().height,
  };
});
console.log('loading', JSON.stringify(loading));
await page.screenshot({ path: 'screenshots/app/42-studio-loading.png' });
await browser.close();
