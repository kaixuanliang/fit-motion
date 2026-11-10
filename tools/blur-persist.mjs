/** 反复渲染同一时刻，逐帧dump可见瓦片位图尺寸，找出128 persist 的原因。 */
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

// 先顺序播放到 12s（制造真实状态），再停在 12s 连续渲染观察
for (let t = 0; t <= 12.001; t += 0.1) {
  await page.evaluate((time) => { window.__fitStage.renderAt(time); }, t);
  await new Promise((r) => setTimeout(r, 30));
}

for (let round = 0; round < 8; round += 1) {
  const snap = await page.evaluate(() => {
    const stage = window.__fitStage;
    const follow = stage.follow;
    window.__fmDrawDbg = { missActive: [], missBudget: [], lowRes: [], missActiveAmbient: [], upgraded: [] };
    stage.renderAt(12);
    const dbg = window.__fmDrawDbg;
    const sizes = {};
    for (const [key, bmp] of follow.bitmaps) sizes[key] = bmp.size;
    return {
      upgraded: dbg.upgraded,
      lowResCount: dbg.lowRes.length,
      lowRes: dbg.lowRes.slice(0, 4),
      bitmapCount: follow.bitmaps.size,
      activeCount: follow.active.size,
      renderScale: follow.renderScale,
      sizesSample: Object.entries(sizes).filter(([, s]) => s === 128).length,
    };
  });
  console.log(`round ${round}`, JSON.stringify(snap));
  await new Promise((r) => setTimeout(r, 100));
}
await browser.close();
