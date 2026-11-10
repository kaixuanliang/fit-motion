/**
 * 诊断：预览播放到第 N 秒时，底图清晰度是否下降。
 *
 * 做法：真实导入 .fit → 进创作页 → 暂停 → 逐帧 renderAt（与播放同一路径），
 * 每帧读 #stage-canvas 像素，在地图区域上算梯度能量（Laplacian/sobel 方差）。
 * 糊 = 高频能量掉。同时记录每帧的帧序号与时间。
 *
 * 用法：node tools/blur-probe.mjs <fit路径> [start] [end] [step]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const fitPath = process.argv[2];
if (!fitPath) throw new Error('缺少 fit 路径');
const start = Number(process.argv[3] ?? 10);
const end = Number(process.argv[4] ?? 15);
const step = Number(process.argv[5] ?? 0.1);

const buf = fs.readFileSync(fitPath);
const outDir = path.join(process.cwd(), '.workbuddy', 'tmp', 'blur-probe');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--enable-features=NetworkService'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[probe]')) console.log(text);
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));

const b64 = buf.toString('base64');
const info = await page.evaluate(async (data, name) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await importFiles([new File([bytes], name)]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  await new Promise((r) => setTimeout(r, 500));
  window.__fitReady = false;
  document.querySelector('#records-pane .rec')?.click();
  return true;
}, b64, path.basename(fitPath));

let ready = false;
for (let i = 0; i < 1200; i += 1) {
  ready = await page.evaluate(() => window.__fitReady === true);
  if (ready) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log('ready', ready, info);
await new Promise((r) => setTimeout(r, 1500));

// 停掉自动播放
await page.evaluate(() => {
  const stage = window.__fitStage;
  window.__probePaused = true;
  if (stage) {
    const btn = document.getElementById('play-btn');
    if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
  }
});
await new Promise((r) => setTimeout(r, 400));

const meta = await page.evaluate(() => {
  const stage = window.__fitStage;
  const map = stage?.map;
  return {
    duration: stage?.duration,
    intro: stage?.introDuration,
    run: stage?.runDuration,
    outro: stage?.outroDuration,
    posterStart: stage?.posterStart,
    followScale: stage?.followCameraScale,
    mapZoom: map?.zoom,
    mapSize: map ? [map.width, map.height] : null,
    distance: stage?.activity?.distanceM,
  };
});
console.log('meta', JSON.stringify(meta));

const frames = [];
for (let t = start; t <= end + 1e-6; t += step) {
  const stats = await page.evaluate(async (time) => {
    const stage = window.__fitStage;
    const canvas = document.getElementById('stage-canvas');
    window.__fmDrawDbg = { missActive: [], missBudget: [], lowRes: [], missActiveAmbient: [] };
    stage.renderAt(time);
    await new Promise((r) => requestAnimationFrame(() => r(0)));
    const ctx = canvas.getContext('2d');
    // 地图区域：避开顶部信息条与底部 HUD，取 180..900 竖直带
    const x0 = 0;
    const y0 = 300;
    const w = canvas.width;
    const h = 600;
    const img = ctx.getImageData(x0, y0, w, h).data;
    // 灰度 + Laplacian 方差
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < img.length; i += 4, p += 1) {
      gray[p] = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
    }
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const p = y * w + x;
        const lap = -4 * gray[p] + gray[p - 1] + gray[p + 1] + gray[p - w] + gray[p + w];
        sum += Math.abs(lap);
        sumSq += lap * lap;
        n += 1;
      }
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    const dbg = window.__fmDrawDbg;
    return {
      time,
      meanAbs: Number(mean.toFixed(3)),
      variance: Number(variance.toFixed(2)),
      camera: stage.cameraAtTime(time),
      missActive: dbg ? dbg.missActive.length : -1,
      missBudget: dbg ? dbg.missBudget.length : -1,
      lowRes: dbg ? dbg.lowRes.slice(0, 6) : [],
    };
  }, t);
  frames.push(stats);
  if (Math.abs(t - 12) < 1e-6 || Math.abs(t - 12.5) < 1e-6 || Math.abs(t - 11) < 1e-6) {
    const url = await page.evaluate(() => document.getElementById('stage-canvas').toDataURL('image/png'));
    fs.writeFileSync(path.join(outDir, `frame-${t.toFixed(2)}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  process.stdout.write(`${stats.time.toFixed(2)} ${stats.meanAbs.toFixed(2)}\n`);
}

// 稳定后重画同一时刻：如果变清晰，说明是逐帧光栅化没跟上
const stable = await page.evaluate(async (time) => {
  const stage = window.__fitStage;
  const canvas = document.getElementById('stage-canvas');
  for (let i = 0; i < 12; i += 1) {
    stage.renderAt(time);
    await new Promise((r) => requestAnimationFrame(() => r(0)));
  }
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = 600;
  const img = ctx.getImageData(0, 300, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < img.length; i += 4, p += 1) {
    gray[p] = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
  }
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      const lap = -4 * gray[p] + gray[p - 1] + gray[p + 1] + gray[p - w] + gray[p + w];
      sum += Math.abs(lap);
      n += 1;
    }
  }
  return Number((sum / n).toFixed(3));
}, 12);

const url = await page.evaluate(() => document.getElementById('stage-canvas').toDataURL('image/png'));
fs.writeFileSync(path.join(outDir, 'frame-12.00-stable.png'), Buffer.from(url.split(',')[1], 'base64'));

fs.writeFileSync(path.join(outDir, 'series.json'), JSON.stringify({ meta, frames, stable }, null, 2));
console.log('stable@12', stable);
console.log('saved', outDir);
await browser.close();
