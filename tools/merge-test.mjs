/**
 * 合并路线回归：造两段同类型轨迹 → 导入 → 合并 → 校验距离/时长/来源标记。
 */
import puppeteer from 'puppeteer-core';

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

const out = await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { mergeRecords } = await import('/src/import/merge.ts');
  const { listPage } = await import('/src/store/repo.ts');

  const makeGpx = (startIso, seconds, offsetLat) => {
    const start = Date.parse(startIso);
    const pts = [];
    const count = seconds; // 1s 一个点
    for (let i = 0; i < count; i += 1) {
      const lat = (39.9 + offsetLat + i * 0.00009).toFixed(6);
      const lon = (116.4 + i * 0.00002).toFixed(6);
      const t = new Date(start + i * 1000).toISOString();
      pts.push(`<trkpt lat="${lat}" lon="${lon}"><ele>${(50 + i * 0.1).toFixed(1)}</ele><time>${t}</time></trkpt>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?><gpx creator="Health" version="1.0" xmlns="http://www.topografix.com/GPX/1/0"><trk><type>户外骑行</type><extensions><totalTime>${seconds}</totalTime><cumulativeClimb>${Math.round(seconds * 0.1)}</cumulativeClimb><cumulativeDecrease>0</cumulativeDecrease></extensions><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  };

  const a = new File([makeGpx('2026-05-01T01:00:00.000Z', 600, 0)], 'seg-a.gpx', { type: 'application/gpx+xml' });
  const b = new File([makeGpx('2026-05-01T01:30:00.000Z', 300, 0.02)], 'seg-b.gpx', { type: 'application/gpx+xml' });
  const first = await importFiles([a, b]);
  const before = await listPage({ limit: 10 });
  const ids = before.items.map((m) => m.id);
  const merged = await mergeRecords(ids);
  const after = await listPage({ limit: 10 });
  return {
    imported: first.results.map((r) => r.status),
    segmentSumKm: +(before.items.reduce((s, m) => s + m.distance, 0) / 1000).toFixed(3),
    segmentSumSec: Math.round(before.items.reduce((s, m) => s + m.duration, 0)),
    merged,
    rows: after.items.map((m) => ({
      name: m.name,
      src: m.src,
      km: +(m.distance / 1000).toFixed(3),
      sec: m.duration,
      climb: m.climb,
      mergedFrom: m.mergedFrom?.length ?? 0,
      avgKmh: +(m.avgSpeed * 3.6).toFixed(1),
    })),
  };
});

console.log(JSON.stringify(out, null, 2));
console.log('errors', errors.slice(0, 3));
await browser.close();
