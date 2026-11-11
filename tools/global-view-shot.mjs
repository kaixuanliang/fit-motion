/**
 * 全局视角截图：同一记录在第一视角 / 全局视角下的封面与巡航帧。
 * 用法：node tools/global-view-shot.mjs <前缀> [bright|night|tech]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const prefix = process.argv[2] ?? 'global';
const theme = process.argv[3] ?? '';
// 点数：1200 点 ≈ 120km；3600 点 ≈ 360km（>300km 应锁定全局视角）
const routePoints = Math.max(2, Number(process.argv[4] ?? '1200'));
const outDir = path.join(process.cwd(), 'tools', 'downloads');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
if (theme) {
  await page.evaluateOnNewDocument((t) => {
    localStorage.setItem('fitmotion-theme', t);
  }, theme);
}
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => { setTimeout(r, 500); });

await page.evaluate(async (routePoints) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const start = Date.parse('2026-08-01T02:00:00Z');
  const pts = [];
  for (let i = 0; i < routePoints; i += 1) {
    pts.push(`<trkpt lat="${(39.9 + i * 0.0009).toFixed(7)}" lon="${(116.4 + Math.sin(i / 120) * 0.02).toFixed(7)}">`
      + `<ele>${(50 + (i % 60)).toFixed(1)}</ele><time>${new Date(start + i * 15000).toISOString()}</time></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="shot" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await importFiles([new File([gpx], 'shot-ride.gpx')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  await new Promise((r) => { setTimeout(r, 400); });
  document.querySelector('#records-pane .rec')?.click();
}, routePoints);

// 等创作页缓存就绪（第一轮默认第一视角）
let ready = false;
for (let i = 0; i < 720; i += 1) {
  ready = await page.evaluate(() => window.__fitReady === true);
  if (ready) break;
  await new Promise((r) => { setTimeout(r, 250); });
}
await new Promise((r) => { setTimeout(r, 600); });

const shotAt = async (time, name) => {
  await page.evaluate(async (t) => {
    const stage = window.__fitStage;
    if (!stage) return;
    document.getElementById('play-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    stage.renderAt(t);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, time);
  const handle = await page.$('#stage-canvas');
  await handle.screenshot({ path: path.join(outDir, `${prefix}-${name}.png`) });
};

await shotAt(0, 'follow-cover');
await shotAt(6, 'follow-run');

// 切到全局视角，重建后等加载层消失（prepareStudio 完成才会 hideStageLoading）
await page.evaluate(() => {
  document.getElementById('view-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
let globalReady = false;
for (let i = 0; i < 720; i += 1) {
  globalReady = await page.evaluate(() => {
    const loading = document.getElementById('stage-loading');
    return window.__fitReady === true && loading?.classList.contains('is-hidden') === true;
  });
  if (globalReady) break;
  await new Promise((r) => { setTimeout(r, 250); });
}
await new Promise((r) => { setTimeout(r, 800); });

const ui = await page.evaluate(() => {
  const toggle = document.getElementById('view-toggle');
  return {
    toggleHidden: toggle?.hidden ?? null,
    toggleOn: toggle?.classList.contains('on') ?? null,
    device: document.getElementById('stage-device')?.textContent ?? '',
    help: document.getElementById('export-help')?.textContent ?? '',
  };
});

await shotAt(0, 'global-cover');
await shotAt(6, 'global-run');

await browser.close();
console.log(JSON.stringify({ ready, globalReady, ui, prefix, theme }, null, 2));
