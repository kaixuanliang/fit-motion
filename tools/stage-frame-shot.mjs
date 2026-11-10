/**
 * 截取创作页整个预览容器（含左右延展区），用于检查「视频与边框之间是否大片空白」。
 * 用法：node tools/stage-frame-shot.mjs <前缀>
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const prefix = process.argv[2] ?? 'stage';
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
await new Promise((r) => { setTimeout(r, 1200); });

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
  const frame = await page.$('#stage-frame');
  await frame.screenshot({ path: path.join(outDir, `${prefix}-${name}.png`) });
};

const metrics = await page.evaluate(() => {
  const frame = document.getElementById('stage-frame').getBoundingClientRect();
  const core = document.getElementById('stage-canvas').getBoundingClientRect();
  return {
    frameW: Math.round(frame.width),
    frameH: Math.round(frame.height),
    coreW: Math.round(core.width),
    coreH: Math.round(core.height),
    sideGap: Math.round((frame.width - core.width) / 2),
    vh: window.innerHeight,
    vw: window.innerWidth,
  };
});

await shotAt(0.5, 'cover');
await shotAt(3, 'follow');
console.log(JSON.stringify(metrics, null, 2));

await browser.close();
