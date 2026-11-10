/**
 * 截取创作页封面帧与第一视角帧，用于优化前后的像素对比。
 * 用法：node tools/studio-frame-shot.mjs <前缀>
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const prefix = process.argv[2] ?? 'shot';
const outDir = path.join(process.cwd(), 'tools', 'downloads');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => { setTimeout(r, 500); });

await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const start = Date.parse('2026-08-01T02:00:00Z');
  const pts = [];
  for (let i = 0; i < 1200; i += 1) {
    pts.push(`<trkpt lat="${(39.9 + i * 0.0009).toFixed(7)}" lon="${(116.4 + Math.sin(i / 120) * 0.02).toFixed(7)}">`
      + `<ele>${(50 + (i % 60)).toFixed(1)}</ele><time>${new Date(start + i * 15000).toISOString()}</time></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="shot" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await importFiles([new File([gpx], 'shot-ride.gpx')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  await new Promise((r) => { setTimeout(r, 400); });
  window.__fitReady = false;
  document.querySelector('#records-pane .rec')?.click();
});

let ready = false;
for (let i = 0; i < 720; i += 1) {
  ready = await page.evaluate(() => window.__fitReady === true);
  if (ready) break;
  await new Promise((r) => { setTimeout(r, 250); });
}
await new Promise((r) => { setTimeout(r, 800); });

// 停掉自动播放，手动渲染指定时刻，保证两张图来自同一帧
await page.evaluate(() => {
  document.getElementById('play-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await new Promise((r) => { setTimeout(r, 300); });

const shotAt = async (time, name) => {
  await page.evaluate(async (t) => {
    const stage = window.__fitStage;
    if (!stage) return;
    stage.renderAt(t);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, time);
  const handle = await page.$('#stage-canvas');
  await handle.screenshot({ path: path.join(outDir, `${prefix}-${name}.png`) });
};

await shotAt(0, 'cover');
await shotAt(6, 'follow');

await browser.close();
console.log(JSON.stringify({ ready, prefix, files: [`${prefix}-cover.png`, `${prefix}-follow.png`] }));
