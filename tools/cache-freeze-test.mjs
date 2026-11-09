/**
 * 用用户提供的 160km/37982 点真实 GPX 复现「85% 进度卡死」：
 * 注入文件 → 进创作页 → 缓存期间每 300ms 试探一次主线程响应，
 * 记录最大无响应间隔与缓存总耗时。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5178/';
const GPX = 'C:/Users/admin/xwechat_files/wxid_y1t5w0reko9722_969a/temp/RWTemp/2026-11/9e20f478899dc29eb19741386f9343c8/20250906户外骑行.gpx';
const executablePath = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await wait(2000);

// 清库，导入用户 GPX
await page.evaluate(async () => {
  const mod = await import('/src/store/repo.ts');
  for (const meta of await mod.allMeta()) await mod.removeActivity(meta.id);
});
await wait(300);
await page.evaluate(() => document.querySelector('[data-tab="import"]')?.click());
await wait(300);
const b64 = fs.readFileSync(GPX).toString('base64');
await page.evaluate((b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], '20250906户外骑行.gpx'));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, b64);
await wait(9000);
const imported = await page.evaluate(() => ({
  line: document.getElementById('import-line')?.textContent ?? '',
  toast: document.getElementById('toast')?.textContent ?? '',
}));
console.log('import:', imported);
await page.evaluate(() => document.getElementById('import-close')?.click());
await wait(500);
await page.evaluate(() => document.querySelector('[data-tab="records"]')?.click());
await wait(500);
await page.evaluate(() => document.querySelector('#records-pane .rec')?.click());
await page.waitForFunction(() => document.querySelector('#studio.active'), { timeout: 30000 });
console.log('studio open, caching…');

// 主线程响应探针：缓存期间每 300ms 发一次 evaluate，量两次探测间的实际间隔
const t0 = Date.now();
let last = Date.now();
let maxGap = 0;
const stalls = [];
const probe = setInterval(async () => {
  try {
    await page.evaluate(() => 1 + 1);
    const now = Date.now();
    const gap = now - last;
    if (gap > 400) {
      stalls.push({ gap, at: +((now - t0) / 1000).toFixed(1) });
      maxGap = Math.max(maxGap, gap);
    } else {
      maxGap = Math.max(maxGap, gap);
    }
    last = now;
  } catch { /* evaluate 被阻塞时抛错也计入 */ }
}, 300);

let pctSeen = [];
try {
  await page.waitForFunction(() => {
    const fill = document.querySelector('.cache-meter i');
    return fill ? parseFloat(fill.style.width) >= 84 : false;
  }, { timeout: 240000 });
  const at84 = Date.now() - t0;
  console.log(`reached 84% in ${(at84 / 1000).toFixed(1)}s`);
  // 84% → 100% 的解码段
  await page.waitForFunction(() => window.__fitReady === true, { timeout: 240000 });
} finally {
  clearInterval(probe);
}
const total = (Date.now() - t0) / 1000;
console.log(`cache total: ${total.toFixed(1)}s, max main-thread unresponsive gap: ${maxGap}ms`);
console.log('stalls > 400ms:', stalls);
const progress = await page.evaluate(() => ({
  ready: window.__fitReady === true,
  label: document.querySelector('.cache-label')?.textContent ?? '',
}));
console.log('final:', progress, 'errors:', errors.slice(0, 4));
await browser.close();
