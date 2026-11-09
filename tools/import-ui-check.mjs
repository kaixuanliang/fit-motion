/**
 * 导入页 UI 回归：距离门槛生效、合并弹层能打开且不溢出。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const out = await page.evaluate(async () => {
  const { showPane } = await import('/src/ui/router.ts');
  const { importFiles } = await import('/src/import/batch.ts');
  const { getMinDistanceKm, setMinDistanceKm } = await import('/src/import/settings.ts');

  // 门槛：3 km 的轨迹在 5 km 门槛下应被跳过
  const gpx = (offset) => {
    const pts = [];
    const start = Date.parse('2026-06-01T02:00:00.000Z');
    for (let i = 0; i < 300; i += 1) {
      pts.push(`<trkpt lat="${(39.9 + offset + i * 0.00009).toFixed(6)}" lon="${(116.4 + i * 0.00002).toFixed(6)}"><time>${new Date(start + i * 1000).toISOString()}</time></trkpt>`);
    }
    return `<?xml version="1.0"?><gpx creator="Health" version="1.0" xmlns="http://www.topografix.com/GPX/1/0"><trk><type>户外骑行</type><extensions><totalTime>300</totalTime><totalDistance>3035</totalDistance></extensions><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  };
  const file = new File([gpx(0)], 'short.gpx', { type: 'application/gpx+xml' });
  const skip = await importFiles([file], undefined, { minDistanceM: 5000 });
  const pass = await importFiles([file], undefined, { minDistanceM: 1000 });

  setMinDistanceKm(0);
  showPane('import');
  return {
    skipStatus: skip.results.map((r) => `${r.status}:${r.message ?? ''}`),
    skipFiltered: skip.filtered,
    passStatus: pass.results.map((r) => r.status),
    defaultMin: getMinDistanceKm(),
  };
});

await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: 'screenshots/import-pane.png' });

// 合并弹层
await page.evaluate(() => {
  const button = document.getElementById('merge-open');
  button?.click();
});
await new Promise((r) => setTimeout(r, 700));
const mergeBox = await page.evaluate(() => {
  const overlay = document.getElementById('merge-overlay');
  const modal = overlay?.querySelector('.merge-modal');
  const rect = modal?.getBoundingClientRect();
  return {
    open: overlay ? !overlay.hidden : false,
    width: rect ? Math.round(rect.width) : 0,
    height: rect ? Math.round(rect.height) : 0,
    viewport: { w: innerWidth, h: innerHeight },
    rows: document.querySelectorAll('#merge-list .merge-row').length,
    hint: document.getElementById('merge-hint')?.textContent ?? '',
    confirmDisabled: (document.getElementById('merge-confirm'))?.disabled,
  };
});
await page.screenshot({ path: 'screenshots/merge-overlay.png' });

console.log(JSON.stringify({ ...out, mergeBox }, null, 2));
console.log('errors', errors.slice(0, 3));
await browser.close();
