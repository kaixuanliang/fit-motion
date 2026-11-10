/**
 * 复现「长途（~173km）预览时视频跑得比地图加载快，出现空白」：
 * 播放过程中按时间截图整块预览容器，并统计核心/延展区的「纯背景色」像素占比。
 * 用法：node tools/long-route-blank.mjs <前缀>
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const prefix = process.argv[2] ?? 'long';
const outDir = path.join(process.cwd(), 'tools', 'downloads');
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  const text = m.text();
  if (text.startsWith('[blank]')) console.log(text);
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => { setTimeout(r, 500); });

// 173km：沿一条略带弧度的路线布点，每点约 180m
const info = await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const start = Date.parse('2026-08-01T02:00:00Z');
  const pts = [];
  const total = 960;
  for (let i = 0; i < total; i += 1) {
    const t = i / total;
    const lat = 39.6 + t * 1.35 + Math.sin(t * 9) * 0.05;
    const lon = 116.0 + t * 0.45 + Math.sin(t * 14) * 0.08;
    pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">`
      + `<ele>${(40 + Math.sin(t * 20) * 30).toFixed(1)}</ele>`
      + `<time>${new Date(start + i * 35000).toISOString()}</time></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="long" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await importFiles([new File([gpx], 'long-173.gpx')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  await new Promise((r) => { setTimeout(r, 600); });
  window.__fitReady = false;
  document.querySelector('#records-pane .rec')?.click();
  return true;
});

let ready = false;
for (let i = 0; i < 1200; i += 1) {
  ready = await page.evaluate(() => window.__fitReady === true);
  if (ready) break;
  await new Promise((r) => { setTimeout(r, 250); });
}
await new Promise((r) => { setTimeout(r, 800); });

const facts = await page.evaluate(() => {
  const stage = window.__fitStage;
  const frame = document.getElementById('stage-frame').getBoundingClientRect();
  const core = document.getElementById('stage-canvas').getBoundingClientRect();
  return {
    duration: stage?.duration ?? null,
    frameW: Math.round(frame.width),
    frameH: Math.round(frame.height),
    coreW: Math.round(core.width),
    coreH: Math.round(core.height),
  };
});
console.log(JSON.stringify({ ...facts, ready }, null, 2));

// 真实播放（1×），每 2 秒统计一次「纯背景像素」占比
await page.evaluate(() => {
  window.__fmDrawDbg = { missActive: [], missActiveAmbient: [], missBudget: [] };
  window.__blankStats = [];
  const core = document.getElementById('stage-canvas');
  const ambient = document.getElementById('stage-ambient');
  const probe = () => {
    const stage = window.__fitStage;
    const out = { t: stage ? Number(window.__fitPlayhead ?? 0) : 0 };
    for (const [name, canvas] of [['core', core], ['ambient', ambient]]) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const data = ctx.getImageData(0, 0, w, h).data;
      // 统计「三种通道都接近同一深色背景」的像素比例：cream(244,242,231) 不算
      let blank = 0;
      let total = 0;
      for (let y = 0; y < h; y += 6) {
        for (let x = 0; x < w; x += 6) {
          const i = (y * w + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          total += 1;
          if (r < 40 && g < 40 && b < 45) blank += 1;
        }
      }
      out[name] = +(blank / total).toFixed(4);
    }
    window.__blankStats.push(out);
  };
  window.__blankProbe = probe;
});

for (let i = 0; i < 14; i += 1) {
  await new Promise((r) => { setTimeout(r, 1500); });
  const stats = await page.evaluate(() => {
    window.__blankProbe?.();
    const dbg = window.__fmDrawDbg;
    const out = window.__blankStats[window.__blankStats.length - 1] ?? null;
    const summary = {
      t: out?.t,
      missCore: [...new Set(dbg.missActive)].length,
      missAmbient: [...new Set(dbg.missActiveAmbient)].length,
      missBudget: [...new Set(dbg.missBudget)].length,
      missCoreSample: [...new Set(dbg.missActive)].slice(0, 4),
    };
    dbg.missActive.length = 0;
    dbg.missActiveAmbient.length = 0;
    dbg.missBudget.length = 0;
    return { out, summary };
  });
  console.log('[miss]', JSON.stringify(stats.summary));
  const frameEl = await page.$('#stage-frame');
  if (i >= 9) await frameEl.screenshot({ path: path.join(outDir, `${prefix}-p${i}.png`) });
  console.log('[blank]', JSON.stringify(stats));
}

await browser.close();
