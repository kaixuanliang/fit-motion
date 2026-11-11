/**
 * 合并行程回归：同一条路线多刷 / 多日接续 / 首尾不衔接 / 重载保真。
 *
 * 用法：node tools/merge-trip-test.mjs <fit路径>
 *
 * 断言：
 * 1) 同一条路线 ×3（相隔 7 天）→ 几何只留一遍（点数≈单次）、总里程累加、
 *    重复段标记为 repeat、极值取三遍里最大；
 * 2) 路线切成两半、第二天接着骑（首尾重合）→ 允许合并，点数≈原点数；
 * 3) 第二段平移到 1° 外（约 100km）→ 抛错且提示「可衔接范围」；
 * 4) loadActivity 重载后 trip 仍在（多日/重复信息不会丢）。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const fitPath = process.argv[2];
if (!fitPath) throw new Error('缺少 fit 路径');
const buf = fs.readFileSync(fitPath);
const DAY = 86400000;

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));

const out = await page.evaluate(async (data, name, dayMs) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { loadActivity, allMeta, saveParsed, deleteRecord } = await import('/src/store/repo.ts');
  const { mergeRecords } = await import('/src/import/merge.ts');

  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await importFiles([new File([bytes], name)]);
  await new Promise((r) => setTimeout(r, 900));
  const metas = (await allMeta()).filter((m) => !m.deleted);
  const target = metas.find((m) => m.fileName === name) ?? metas[0];
  const base = await loadActivity(target.id);

  const makeParsed = (slice, shiftMs, label, offsetDeg = 0) => {
    const records = slice.map((p) => ({
      timestamp: p.t + shiftMs,
      lat: p.lat + offsetDeg,
      lon: p.lon,
      altitude: p.altitude,
      speed: p.speed,
      heartRate: p.heartRate,
      cadence: p.cadence,
      power: p.power,
    }));
    const segDistance = slice[slice.length - 1].distance - slice[0].distance;
    return {
      parsed: {
        sourceType: base.sourceType,
        hasTimestamps: true,
        name: label,
        sportHint: base.sport,
        records,
        sessions: [{
          startTime: records[0].timestamp,
          elapsedTime: Math.round((records[records.length - 1].timestamp - records[0].timestamp) / 1000),
          timerTime: Math.round((records[records.length - 1].timestamp - records[0].timestamp) / 1000),
          distance: segDistance,
          sport: base.sport,
          subSport: base.subSport,
        }],
        laps: [],
      },
      segDistance,
    };
  };

  const save = async (parsed, label) => {
    const res = await saveParsed({
      parsed,
      fileName: `${label}.tcx`,
      src: 'fit',
      bytes: new ArrayBuffer(0),
      keepFile: false,
      name: label,
      hashOverride: `probe-${label}-${Math.random().toString(36).slice(2)}`,
      skipDedupe: true,
    });
    return res.id ?? null;
  };

  const summary = (a) => a && {
    distanceM: Math.round(a.distanceM),
    points: a.points.length,
    durationSec: Math.round(a.durationSec),
    movingSec: Math.round(a.movingSec),
    elapsedSec: Math.round(a.elapsedSec),
    avgSpeedKmh: +(a.avgSpeed * 3.6).toFixed(2),
    maxSpeedKmh: +(a.maxSpeed * 3.6).toFixed(1),
    maxHr: a.maxHeartRate,
    maxAlt: a.maxAltitude != null ? Math.round(a.maxAltitude) : null,
    trip: a.trip ? {
      legs: a.trip.legs.length,
      repeated: a.trip.repeated,
      multiDay: a.trip.multiDay,
      routeMeters: Math.round(a.trip.routeMeters),
      totalMeters: Math.round(a.trip.totalMeters),
      totalMovingSec: Math.round(a.trip.totalMovingSec),
      totalElapsedSec: Math.round(a.trip.totalElapsedSec),
      best: {
        maxSpeedKmh: a.trip.best.maxSpeed != null ? +(a.trip.best.maxSpeed * 3.6).toFixed(1) : null,
        maxHr: a.trip.best.maxHeartRate ?? null,
        maxAlt: a.trip.best.maxAltitude != null ? Math.round(a.trip.best.maxAltitude) : null,
        ascent: a.trip.best.ascent ?? null,
      },
      legFlags: a.trip.legs.map((leg) => `${leg.index}${leg.repeat ? `=D${leg.repeatOf}` : ''}`),
    } : null,
  };

  const pts = base.points;
  const half = Math.floor(pts.length / 2);
  const first = pts.slice(0, half + 1);
  const second = pts.slice(half);

  // 场景 1：同一条路线骑三次（相隔 7 天）
  const sameIds = [];
  for (let k = 0; k < 3; k += 1) {
    const { parsed } = makeParsed(pts, k * 7 * dayMs, `same${k + 1}`);
    const id = await save(parsed, `same${k + 1}`);
    if (id) sameIds.push(id);
  }
  const sameMerged = await mergeRecords(sameIds);
  const sameActivity = sameMerged.id ? await loadActivity(sameMerged.id) : null;

  // 场景 2：切成两半，第二天接着骑（首尾重合）
  const day1 = await save(makeParsed(first, 0, 'day1').parsed, 'day1');
  const day2 = await save(makeParsed(second, 1 * dayMs, 'day2').parsed, 'day2');
  const chainMerged = day1 && day2 ? await mergeRecords([day1, day2]) : null;
  const chainActivity = chainMerged?.id ? await loadActivity(chainMerged.id) : null;

  // 场景 3：第二段平移到 1°（约 100km）外，首尾接不上
  const far1 = await save(makeParsed(first, 0, 'far1').parsed, 'far1');
  const far2 = await save(makeParsed(second, 1 * dayMs, 'far2', 1.0).parsed, 'far2');
  let farError = null;
  if (far1 && far2) {
    try {
      await mergeRecords([far1, far2]);
      farError = '(没有报错)';
    } catch (error) {
      farError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    single: summary(base),
    sameMerge: { status: sameMerged.status, name: sameMerged.name, distanceM: Math.round(sameMerged.distanceM), repeated: sameMerged.repeated, days: sameMerged.days },
    sameActivity: summary(sameActivity),
    chainMerge: chainMerged ? { status: chainMerged.status, name: chainMerged.name, distanceM: Math.round(chainMerged.distanceM), repeated: chainMerged.repeated, days: chainMerged.days } : null,
    chainActivity: summary(chainActivity),
    farError,
    storedTrip: sameActivity?.trip ? { legs: sameActivity.trip.legs.length, totalMeters: Math.round(sameActivity.trip.totalMeters) } : null,
  };
}, buf.toString('base64'), path.basename(fitPath), DAY);

const line = (label, value) => console.log(label, JSON.stringify(value));

line('单次基线:', out.single);
line('同路线×3 合并:', out.sameMerge);
line('同路线×3 结果:', out.sameActivity);
line('多日接续 合并:', out.chainMerge);
line('多日接续 结果:', out.chainActivity);
line('不衔接报错:', out.farError);

const checks = [];
const same = out.sameActivity;
if (same) {
  checks.push(['重复段被标记', same.trip?.repeated === 2]);
  checks.push(['几何只留一遍（点数≈单次）', Math.abs(same.points - out.single.points) <= 5]);
  checks.push(['总里程累加', same.trip?.totalMeters > same.distanceM * 2]);
  checks.push(['距离口径=路线长度', Math.abs(same.distanceM - out.single.distanceM) <= 3000]);
  checks.push(['极值取三遍最优', same.trip?.best.maxSpeedKmh >= out.single.maxSpeedKmh]);
}
const chain = out.chainActivity;
if (chain) {
  checks.push(['接续段不被判重复', chain.trip?.repeated === 0]);
  checks.push(['接续后点数≈原记录', Math.abs(chain.points - out.single.points) <= 5]);
  checks.push(['接续后总里程正确', Math.abs(chain.trip?.totalMeters - out.single.distanceM) < 3000]);
  checks.push(['识别为多日行程', chain.trip?.multiDay === true]);
}
checks.push(['不衔接时抛出可衔接范围提示', typeof out.farError === 'string' && out.farError.includes('可衔接范围')]);
checks.push(['重载后 trip 仍在', out.storedTrip != null]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed += 1;
}
console.log(failed === 0 ? `全部通过（${checks.length} 项）` : `失败 ${failed}/${checks.length}`);
await browser.close();
process.exitCode = failed === 0 ? 0 : 1;
