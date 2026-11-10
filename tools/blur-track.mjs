/** 追踪特定瓦片在顺序播放中的位图尺寸变化，找出不升级的原因。 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const fitPath = process.argv[2];
const buf = fs.readFileSync(fitPath);

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));

const b64 = buf.toString('base64');
await page.evaluate(async (data, name) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await importFiles([new File([bytes], name)]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  await new Promise((r) => setTimeout(r, 500));
  window.__fitReady = false;
  document.querySelector('#records-pane .rec')?.click();
}, b64, path.basename(fitPath));

for (let i = 0; i < 1200; i += 1) {
  if (await page.evaluate(() => window.__fitReady === true)) break;
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 1500));
await page.evaluate(() => {
  const btn = document.getElementById('play-btn');
  if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
});
await new Promise((r) => setTimeout(r, 400));

// 顺序播放 0 -> 13.2，每步记录 13500/6194 等关键瓦片的尺寸与缓存状态
const track = ['14/13500/6194', '14/13500/6195', '14/13499/6196'];
for (let t = 11.4; t <= 13.21; t += 0.1) {
  const snap = await page.evaluate((time, keys) => {
    const follow = window.__fitStage.follow;
    window.__fmDrawDbg = { missActive: [], missBudget: [], lowRes: [] };
    window.__fitStage.renderAt(time);
    const dbg = window.__fmDrawDbg;
    const out = {};
    for (const k of keys) {
      const bmp = follow.bitmaps.get(k);
      out[k] = bmp ? bmp.size : null;
    }
    return {
      t: time,
      sizes: out,
      lowResCount: dbg.lowRes.length,
      lowRes: dbg.lowRes,
      count: follow.bitmaps.size,
    };
  }, Number(t.toFixed(2)), track);
  console.log(JSON.stringify(snap));
  await new Promise((r) => setTimeout(r, 30));
}
await browser.close();
