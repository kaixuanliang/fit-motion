/**
 * 截图检查：合并行程卡片在创作页里的真实渲染效果。
 *
 * 用法：node tools/trip-card-shot.mjs <fit路径>
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const fitPath = process.argv[2];
if (!fitPath) throw new Error('缺少 fit 路径');
const buf = fs.readFileSync(fitPath);
const DAY = 86400000;
fs.mkdirSync('.workbuddy/tmp', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));

await page.evaluate(async (data, name, dayMs) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { loadActivity, allMeta, saveParsed } = await import('/src/store/repo.ts');
  const { mergeRecords } = await import('/src/import/merge.ts');

  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await importFiles([new File([bytes], name)]);
  await new Promise((r) => setTimeout(r, 900));
  const metas = (await allMeta()).filter((m) => !m.deleted);
  const target = metas.find((m) => m.fileName === name) ?? metas[0];
  const base = await loadActivity(target.id);

  const ids = [];
  for (let k = 0; k < 3; k += 1) {
    const records = base.points.map((p) => ({
      timestamp: p.t + k * 7 * dayMs,
      lat: p.lat,
      lon: p.lon,
      altitude: p.altitude,
      speed: p.speed,
      heartRate: p.heartRate,
      cadence: p.cadence,
      power: p.power,
    }));
    const res = await saveParsed({
      parsed: {
        sourceType: base.sourceType,
        hasTimestamps: true,
        name: `shot${k + 1}`,
        sportHint: base.sport,
        records,
        sessions: [{
          startTime: records[0].timestamp,
          elapsedTime: base.durationSec,
          timerTime: base.durationSec,
          distance: base.distanceM,
          sport: base.sport,
          subSport: base.subSport,
        }],
        laps: [],
      },
      fileName: `shot${k + 1}.tcx`,
      src: 'fit',
      bytes: new ArrayBuffer(0),
      keepFile: false,
      name: `shot${k + 1}`,
      hashOverride: `shot-${k}-${Math.random().toString(36).slice(2)}`,
      skipDedupe: true,
    });
    if (res.id) ids.push(res.id);
  }
  const merged = await mergeRecords(ids);
  window.__mergedId = merged.id ?? null;
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
}, buf.toString('base64'), path.basename(fitPath), DAY);

await new Promise((r) => setTimeout(r, 1200));

// 直接进创作页（不等地图缓存，只看数据卡）
await page.evaluate(() => {
  const id = window.__mergedId;
  const rows = Array.from(document.querySelectorAll('#record-list .rec'));
  const row = rows.find((el) => el.dataset.id === id) ?? rows[0];
  if (row) (row).click();
});
await new Promise((r) => setTimeout(r, 2500));

const info = await page.evaluate(() => {
  const card = document.getElementById('trip-card');
  const rect = document.querySelector('.metric-grid');
  return {
    tripHidden: card?.hidden ?? null,
    tripTitle: document.getElementById('trip-title')?.textContent,
    tripSub: document.getElementById('trip-sub')?.textContent,
    tripBadge: document.getElementById('trip-badge')?.textContent,
    note: document.getElementById('trip-note')?.textContent,
    legs: Array.from(document.querySelectorAll('.trip-leg')).map((el) => el.textContent?.replace(/\s+/g, ' ').trim()),
    metrics: {
      distance: document.getElementById('total-distance')?.textContent,
      elapsed: document.getElementById('total-elapsed')?.textContent,
      moving: document.getElementById('total-duration')?.textContent,
      maxSpeed: document.getElementById('max-speed')?.textContent,
      maxHr: document.getElementById('max-hr')?.textContent,
      maxAlt: document.getElementById('max-altitude')?.textContent,
      avgSpeed: document.getElementById('avg-speed')?.textContent,
    },
    hasGrid: Boolean(rect),
  };
});
console.log(JSON.stringify(info, null, 2));

const card = await page.$('#trip-card');
if (card) await card.screenshot({ path: '.workbuddy/tmp/trip-card.png' });
const grid = await page.$('.metric-grid');
if (grid) await grid.screenshot({ path: '.workbuddy/tmp/metric-grid.png' });
console.log('shots saved');
await browser.close();
