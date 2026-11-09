/** 真实文件导入体检：把 GPX/TCX 走完整 importFiles 管线，打印入库后的列表字段 */
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const path = process.argv[2];
const text = readFileSync(path, 'utf8');
const name = path.split(/[\\/]/).pop();

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const out = await page.evaluate(async (payload) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { listPage, loadActivity } = await import('/src/store/repo.ts');
  const file = new File([new TextEncoder().encode(payload.text)], payload.name);
  const outcome = await importFiles([file]);
  const page1 = await listPage({ limit: 5 });
  const detail = page1.items[0] ? await loadActivity(page1.items[0].id) : null;
  const rows = page1.items.map((m) => ({
    name: m.name,
    start: new Date(m.start).toString(),
    distanceKm: +(m.distance / 1000).toFixed(2),
    duration: `${Math.floor(m.duration / 60)}m${Math.round(m.duration % 60)}s`,
    avgKmh: +(m.avgSpeed * 3.6).toFixed(1),
    maxKmh: +(m.maxSpeed * 3.6).toFixed(1),
    climb: m.climb,
    ascent: detail?.ascent,
    descent: detail?.descent,
    maxAlt: m.maxAlt,
    points: m.points,
    src: m.src,
  }));
  return { status: outcome.results.map((r) => `${r.status}:${r.message ?? ''}`), rows };
}, { text, name });

console.log(JSON.stringify(out, null, 2));
console.log('errors', errors.slice(0, 3));
await browser.close();
