/**
 * TCX 时长验证：用真实华为导出文件验证
 * - 运动时间 = Lap TotalTimeSeconds（3h47m54s），而非轨迹点跨度（4h35m）
 * - 平均速度 = 距离 / 计时时间（≈20 km/h）
 */
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const path = process.argv[2] ?? 'C:/Users/admin/AppData/Local/Temp/tcx-check/ride.tcx';
const expectedTimer = Number(process.argv[3] ?? 13674);
const expectedKmh = Number(process.argv[4] ?? 76.17 / (13674 / 3600));
const text = readFileSync(path, 'utf8');

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

const out = await page.evaluate(async (xml) => {
  const { parseTcx } = await import('/src/tcx/parser.ts');
  const { parseGpx } = await import('/src/gpx/parser.ts');
  const { buildActivity } = await import('/src/fit/activity.ts');
  const isTcx = /<TrainingCenterDatabase/i.test(xml);
  const parsed = isTcx ? parseTcx(xml, 'ride.tcx') : parseGpx(xml, 'ride.gpx');
  const s = parsed.sessions[0];
  const a = buildActivity(parsed, '20251019户外骑行.tcx');
  const fmt = (sec) => `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m${String(Math.round(sec % 60)).padStart(2, '0')}s`;
  return {
    pointSpanSec: s.elapsedTime,
    timerTimeSec: s.timerTime,
    sessionAvgSpeedMs: s.avgSpeed,
    durationSec: a.durationSec,
    movingSec: a.movingSec,
    avgSpeedKmh: a.avgSpeed * 3.6,
    distanceKm: a.distanceM / 1000,
  };
}, text);
await browser.close();

const fmt = (sec) => (sec == null ? 'undefined' : `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m${String(Math.round(sec % 60)).padStart(2, '0')}s`);
console.log('点跨度   :', fmt(out.pointSpanSec), `(${Math.round(out.pointSpanSec)}s)`);
console.log('计时时间 :', fmt(out.timerTimeSec), `(${Math.round(out.timerTimeSec)}s)`);
console.log('活动时长 :', fmt(out.durationSec));
console.log('移动时间 :', fmt(out.movingSec));
console.log('平均速度 :', out.avgSpeedKmh.toFixed(2), 'km/h');
console.log('距离     :', out.distanceKm.toFixed(2), 'km');
console.log('errors:', errors.length, errors.slice(0, 3));

const ok = Math.round(out.timerTimeSec) === expectedTimer
  && Math.abs(out.avgSpeedKmh - expectedKmh) < 0.25;
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
