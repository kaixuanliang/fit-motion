import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const outDir = 'screenshots/app';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('EXC', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('ERR', m.text()); } });

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const importSample = async (suffix = '') => {
  await page.evaluate(async (suffix) => {
    const sample = await import('/src/data/sample.ts');
    const bin = atob(sample.SAMPLE_FIT_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], sample.SAMPLE_NAME.replace('.fit', suffix + '.fit'));
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, suffix);
  await new Promise((r) => setTimeout(r, 2600));
};

await importSample('');
await page.evaluate(() => document.getElementById('import-close').click());
await new Promise((r) => setTimeout(r, 400));

// 同一份内容、不同文件名 → 文件指纹命中，应判重复
await page.evaluate(() => document.querySelector('[data-tab="import"]').click());
await importSample('_copy');
const dup = await page.evaluate(() => ({
  status: document.getElementById('import-status')?.textContent,
  report: document.getElementById('import-report')?.textContent,
  rows: document.querySelectorAll('.rec').length,
}));
console.log('duplicate run:', dup);
await page.evaluate(() => document.getElementById('import-close').click());
await new Promise((r) => setTimeout(r, 500));

// 换科技主题
await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
await page.evaluate(() => document.querySelector('[data-set-theme="tech"]').click());
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: `${outDir}/08-settings-tech.png` });
await page.evaluate(() => document.querySelector('[data-tab="records"]').click());
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: `${outDir}/09-records-tech.png` });

await page.evaluate(() => document.querySelector('.rec').click());
await new Promise((r) => setTimeout(r, 6000));
await page.screenshot({ path: `${outDir}/10-create-tech.png` });
const state = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  loading: !document.getElementById('stage-loading').classList.contains('is-hidden'),
  loadingText: document.getElementById('stage-loading')?.textContent?.trim().slice(0, 40),
  title: document.getElementById('activity-title')?.textContent,
  canvas: (() => { const c = document.getElementById('stage-canvas'); return c ? `${c.width}x${c.height}` : 'none'; })(),
}));
console.log(state);
console.log('errors:', errors.length);
await browser.close();
