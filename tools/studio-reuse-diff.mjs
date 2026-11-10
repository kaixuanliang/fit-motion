/**
 * 验证「首次渲染」与「快照/共享缓存复用」画面逐像素一致。
 * 同一次页面会话内：第一次进创作页（全量渲染）截帧 → 返回 →
 * 第二次进入（快照 + 共享位图命中）截帧 → 逐像素对比。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.join(process.cwd(), 'tools', 'downloads');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
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
});

const waitReady = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => window.__fitReady === true);
    if (done) return true;
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return false;
};

const enterStudio = async () => {
  await page.evaluate(() => {
    window.__fitReady = false;
    document.querySelector('#records-pane .rec')?.click();
  });
  return waitReady(180000);
};

const shotAt = async (time, name) => {
  await page.evaluate(async (t) => {
    // 暂停自动播放，保证两次进入在同一播放头截图（aria-label 反映播放状态）
    const playBtn = document.getElementById('play-btn');
    if (playBtn?.getAttribute('aria-label') === '暂停') playBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const stage = window.__fitStage;
    if (!stage) return;
    stage.renderAt(t);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, time);
  const frame = await page.$('#stage-frame');
  await frame.screenshot({ path: path.join(outDir, name) });
};

// 第一次进入：全量渲染
const firstOk = await enterStudio();
await new Promise((r) => { setTimeout(r, 300); });
// 立刻暂停自动播放，消除两次进入的播放头漂移
await page.evaluate(() => {
  const playBtn = document.getElementById('play-btn');
  if (playBtn?.getAttribute('aria-label') === '暂停') playBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await new Promise((r) => { setTimeout(r, 300); });
await shotAt(0.5, 'reuse-pass1-cover.png');
await shotAt(3, 'reuse-pass1-follow.png');

// 返回 → 第二次进入：快照 + 共享位图命中
await page.evaluate(() => document.getElementById('back-btn')?.click());
await new Promise((r) => { setTimeout(r, 1200); });
const secondOk = await enterStudio();
await new Promise((r) => { setTimeout(r, 300); });
await page.evaluate(() => {
  const playBtn = document.getElementById('play-btn');
  if (playBtn?.getAttribute('aria-label') === '暂停') playBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await new Promise((r) => { setTimeout(r, 300); });
await shotAt(0.5, 'reuse-pass2-cover.png');
await shotAt(3, 'reuse-pass2-follow.png');

await browser.close();

// 逐像素对比
const { PNG } = await import('pngjs').catch(() => ({ PNG: null }));
let diff = null;
if (PNG) {
  const { PNG: P } = await import('pngjs');
  const compare = (a, b) => {
    const ia = P.sync.read(fs.readFileSync(path.join(outDir, a)));
    const ib = P.sync.read(fs.readFileSync(path.join(outDir, b)));
    if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: true };
    let bad = 0;
    const total = ia.width * ia.height;
    for (let i = 0; i < ia.data.length; i += 4) {
      if (Math.abs(ia.data[i] - ib.data[i]) > 8
        || Math.abs(ia.data[i + 1] - ib.data[i + 1]) > 8
        || Math.abs(ia.data[i + 2] - ib.data[i + 2]) > 8) bad += 1;
    }
    return { total, bad, pct: Number(((bad / total) * 100).toFixed(3)) };
  };
  diff = {
    cover: compare('reuse-pass1-cover.png', 'reuse-pass2-cover.png'),
    follow: compare('reuse-pass1-follow.png', 'reuse-pass2-follow.png'),
  };
}
console.log(JSON.stringify({ firstOk, secondOk, errors, diff }, null, 2));
