import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const outDir = 'screenshots/app';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});

const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => { errors.push(error.message); console.log('PAGE EXCEPTION:', error.message); });
page.on('console', (message) => {
  if (message.type() === 'error') { errors.push(message.text()); console.log('CONSOLE ERROR:', message.text()); }
});

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 900));

async function shot(name) {
  await new Promise((r) => setTimeout(r, 320));
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('saved', name);
}

await shot('01-records-empty');

// 用真实 FIT 样本走一遍导入管线
const imported = await page.evaluate(async () => {
  const sample = await import('/src/data/sample.ts');
  const binary = atob(sample.SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], sample.SAMPLE_NAME, { type: 'application/octet-stream' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { size: bytes.length, name: sample.SAMPLE_NAME };
});
console.log('imported sample', imported);

await page.waitForFunction(() => {
  const rows = document.querySelectorAll('.rec');
  const status = document.getElementById('import-status');
  return rows.length > 0 || (status && /新增 0/.test(status.textContent || ''));
}, { timeout: 30000 }).catch(() => console.log('wait for record timed out'));

await new Promise((r) => setTimeout(r, 1500));
await shot('02-import-done');

const report = await page.evaluate(() => ({
  status: document.getElementById('import-status')?.textContent,
  report: document.getElementById('import-report')?.textContent?.slice(0, 400),
  rows: document.querySelectorAll('.rec').length,
  sum: document.getElementById('records-sum')?.textContent,
}));
console.log(report);

await page.evaluate(() => document.getElementById('import-close').click());
await new Promise((r) => setTimeout(r, 600));
await shot('03-records-one');

const summary = await page.evaluate(() => {
  const card = document.querySelector('.rec');
  return {
    title: card?.querySelector('b')?.textContent,
    meta: card?.querySelector('.meta')?.textContent,
    state: card?.querySelector('.state')?.textContent,
    thumb: card?.querySelector('path')?.getAttribute('d')?.length,
    chips: Array.from(document.querySelectorAll('.chip')).map((c) => c.textContent),
  };
});
console.log(summary);

// 点记录进创作页
await page.evaluate(() => document.querySelector('.rec').click());
await new Promise((r) => setTimeout(r, 5000));
await shot('04-create');

const createState = await page.evaluate(() => ({
  view: document.getElementById('app')?.dataset.view,
  title: document.getElementById('activity-title')?.textContent,
  distance: document.getElementById('total-distance')?.textContent,
  maxHr: document.getElementById('max-hr')?.textContent,
  loading: !document.getElementById('stage-loading')?.classList.contains('is-hidden'),
  canvas: (() => { const c = document.getElementById('stage-canvas'); return c ? `${c.width}x${c.height}` : 'none'; })(),
}));
console.log(createState);

await page.evaluate(() => document.querySelector('[data-tab="backup"]').click());
await shot('05-backup');
await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
await shot('06-settings');
await page.evaluate(() => document.querySelector('[data-tab="import"]').click());
await shot('07-import');

console.log('errors:', errors.length);
await browser.close();
