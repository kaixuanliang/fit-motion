/**
 * 回环校验：把 testdata/ 里生成的 FIT / GPX 再导入一次，
 * 确认里程、时长、心率、点数与生成时的口径一致（不漂移）。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const dir = path.resolve('testdata');
const files = fs.readdirSync(dir).filter((f) => /\.(fit|gpx)$/i.test(f)).sort();

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await page.evaluate(async () => {
  await import('/src/fit/parser.ts');
});

console.log('文件'.padEnd(38), '类型  里程km  运动h   总耗时h  点数    均速  最高  心率    爬升   >300km');
for (const name of files) {
  const buf = fs.readFileSync(path.join(dir, name));
  const payload = name.toLowerCase().endsWith('.fit')
    ? { kind: 'fit', data: buf.toString('base64') }
    : { kind: 'gpx', text: buf.toString('utf8') };

  const stats = await page.evaluate(async (input, fileName) => {
    const { parseFit } = await import('/src/fit/parser.ts');
    const { parseGpx } = await import('/src/gpx/parser.ts');
    const { buildActivity } = await import('/src/fit/activity.ts');
    let parsed;
    if (input.kind === 'fit') {
      const bytes = Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0));
      parsed = parseFit(bytes.buffer);
    } else {
      parsed = parseGpx(input.text, fileName);
    }
    const a = buildActivity(parsed, fileName);
    return {
      km: +(a.distanceM / 1000).toFixed(2),
      movingH: +(a.movingSec / 3600).toFixed(1),
      elapsedH: +(a.elapsedSec / 3600).toFixed(1),
      points: a.points.length,
      avg: +(a.avgSpeed * 3.6).toFixed(1),
      max: +(a.maxSpeed * 3.6).toFixed(1),
      hr: `${Math.round(a.avgHeartRate ?? 0)}/${a.maxHeartRate ?? 0}`,
      ascent: a.ascent ?? 0,
      hasTime: a.timeAvailable,
      place: a.place,
      start: new Date(a.startTime).toISOString().replace('T', ' ').slice(0, 16),
    };
  }, payload, name);

  console.log(
    name.padEnd(38),
    (name.endsWith('.fit') ? 'FIT ' : 'GPX ').padEnd(5),
    String(stats.km).padStart(7),
    String(stats.movingH).padStart(6),
    String(stats.elapsedH).padStart(8),
    String(stats.points).padStart(7),
    String(stats.avg).padStart(6),
    String(stats.max).padStart(5),
    stats.hr.padStart(8),
    String(stats.ascent).padStart(6),
    (stats.km > 300 ? '  ✓ 全局' : '  第一视角').padStart(9),
    '|', stats.start, stats.place, stats.hasTime ? '' : '(无时间)',
  );
}

await browser.close();
