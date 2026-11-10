/**
 * 对比「第一次实时构建底图」与「整页重载后从 IDB 快照恢复」的创作页画面。
 * 只关心是否出现可见差异：输出 bad 像素比例与最大通道差。
 */
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';

const base = 'http://127.0.0.1:5178';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();

async function shot(name) {
  const el = await page.$('#stage-canvas');
  const buf = await el.screenshot({ type: 'png' });
  return PNG.sync.read(Buffer.from(buf));
}

async function importRide() {
  await page.evaluate(async () => {
    const { importFiles } = await import('/src/import/batch.ts');
    const start = Date.parse('2026-09-03T02:00:00Z');
    const pts = [];
    for (let i = 0; i < 600; i += 1) {
      const lat = 39.9 + i * 0.001;
      const lon = 116.4 + Math.sin(i / 90) * 0.02;
      pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${(40 + (i % 50))}</ele><time>${new Date(start + i * 10000).toISOString()}</time></trkpt>`);
    }
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="diff" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>snap-diff</name><type>户外骑行</type><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
    await importFiles([new File([gpx], 'snap-diff.gpx')]);
    window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  });
}

async function enterStudio() {
  await page.evaluate(() => {
    window.__fitReady = false;
    document.querySelector('#records-pane .rec')?.click();
  });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__fitReady === true)) return true;
    await sleep(250);
  }
  return false;
}

// 1) 首次：实时构建
await page.goto(`${base}/`, { waitUntil: 'networkidle2' });
await sleep(500);
await importRide();
await sleep(500);
console.log('first enter:', await enterStudio());
// 暂停 + 拖到 0 秒：两轮都停在同一帧，排除播放头漂移
await page.evaluate(() => {
  const btn = document.querySelector('#play-btn');
  const playing = btn?.getAttribute('aria-label')?.includes('暂停');
  if (playing) btn?.click();
  const track = document.querySelector('#timeline');
  if (track) {
    const r = track.getBoundingClientRect();
    const opts = { clientX: r.left + 1, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1 };
    track.dispatchEvent(new PointerEvent('pointerdown', opts));
    track.dispatchEvent(new PointerEvent('pointerup', opts));
  }
});
await sleep(2500);
const a = await shot('live');

// 2) 整页重载（内存快照丢失），走 IDB 快照；同一暂停位置截图
await page.goto(`${base}/`, { waitUntil: 'networkidle2' });
await sleep(500);
console.log('second enter:', await enterStudio());
await page.evaluate(() => {
  const btn = document.querySelector('#play-btn');
  const playing = btn?.getAttribute('aria-label')?.includes('暂停');
  if (playing) btn?.click();
  const track = document.querySelector('#timeline');
  if (track) {
    const r = track.getBoundingClientRect();
    const opts = { clientX: r.left + 1, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1 };
    track.dispatchEvent(new PointerEvent('pointerdown', opts));
    track.dispatchEvent(new PointerEvent('pointerup', opts));
  }
});
await sleep(2500);
const b = await shot('idb');

let bad = 0;
let maxDelta = 0;
const total = Math.min(a.data.length, b.data.length) / 4;
for (let i = 0; i < a.data.length && i < b.data.length; i += 4) {
  const d = Math.max(
    Math.abs(a.data[i] - b.data[i]),
    Math.abs(a.data[i + 1] - b.data[i + 1]),
    Math.abs(a.data[i + 2] - b.data[i + 2]),
  );
  if (d > 8) bad += 1;
  if (d > maxDelta) maxDelta = d;
}
console.log(JSON.stringify({ pixels: total, bad, pct: +(bad / total * 100).toFixed(3), maxDelta }));
await browser.close();
