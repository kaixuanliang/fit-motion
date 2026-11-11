/**
 * 诊断：不同日期、同一条路线的记录合并时会发生什么。
 *
 * 做法：真实导入一份 fit → 复制成 3 条「同一条路线、日期相差 7/14 天」的记录
 * （点时间戳整体平移，几何完全一致）→ 走真实 mergeRecords 合并 →
 * 对比合并前后距离/时长/点数/平均速度，以及重载后轨迹覆盖的日期范围。
 *
 * 用法：node tools/merge-crossday-probe.mjs <fit路径>
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
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[merge]') || text.startsWith('[fit-motion]')) console.log(text);
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));

const out = await page.evaluate(async (data, name, dayMs) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { loadActivity, allMeta, saveParsed } = await import('/src/store/repo.ts');
  const { mergeRecords } = await import('/src/import/merge.ts');

  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await importFiles([new File([bytes], name)]);
  await new Promise((r) => setTimeout(r, 800));
  const metas = (await allMeta()).filter((m) => !m.deleted);
  const target = metas.find((m) => m.fileName === name) ?? metas[0];
  const base = await loadActivity(target.id);

  // 同一条路线骑三次，分别相隔 7 天、14 天
  const savedIds = [];
  for (let k = 0; k < 3; k += 1) {
    const shift = k * 7 * dayMs;
    const records = base.points.map((p) => ({
      timestamp: p.t + shift,
      lat: p.lat,
      lon: p.lon,
      altitude: p.altitude,
      speed: p.speed,
      heartRate: p.heartRate,
      cadence: p.cadence,
      power: p.power,
    }));
    const parsed = {
      sourceType: base.sourceType,
      hasTimestamps: true,
      name: `day${k + 1}`,
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
    };
    const res = await saveParsed({
      parsed,
      fileName: `day${k + 1}.tcx`,
      src: 'fit',
      bytes: new ArrayBuffer(0),
      keepFile: false,
      name: `day${k + 1}`,
      hashOverride: `probe-day${k + 1}-${Math.random().toString(36).slice(2)}`,
      skipDedupe: true,
    });
    console.log(`[merge] saveParsed day${k + 1}:`, JSON.stringify(res));
    if (res.id) savedIds.push(res.id);
  }
  console.log('[merge] savedIds:', JSON.stringify(savedIds));

  const merged = await mergeRecords(savedIds);
  const mergedActivity = merged.id ? await loadActivity(merged.id) : null;

  // 直接看合并写进库的 parsed（不经 buildActivity 重载）
  const db = await new Promise((res, rej) => {
    const req = indexedDB.open('fitmotion');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const raw = await new Promise((res, rej) => {
    const tx = db.transaction(['tracks'], 'readonly');
    const r = tx.objectStore('tracks').get(merged.id);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  db.close();

  const stat = (a) => {
    if (!a) return null;
    // 几何长度与最大相邻跳变：distance 是按统计距离等比缩放过的，看不出真假
    const hav = (la1, lo1, la2, lo2) => {
      const R = 6371000;
      const dLa = ((la2 - la1) * Math.PI) / 180;
      const dLo = ((lo2 - lo1) * Math.PI) / 180;
      const s = Math.sin(dLa / 2) ** 2
        + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };
    let geo = 0;
    let maxJump = 0;
    let maxJumpGapH = 0;
    const p = a.points;
    for (let i = 1; i < p.length; i += 1) {
      const d = hav(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
      geo += d;
      if (d > maxJump) {
        maxJump = d;
        maxJumpGapH = (p[i].t - p[i - 1].t) / 3600000;
      }
    }
    return {
      distanceM: Math.round(a.distanceM),
      geometricM: Math.round(geo),
      maxJumpM: Math.round(maxJump),
      maxJumpGapH: +maxJumpGapH.toFixed(2),
      durationSec: Math.round(a.durationSec),
      elapsedSec: Math.round(a.elapsedSec),
      avgSpeedKmh: +(a.avgSpeed * 3.6).toFixed(2),
      points: p.length,
      firstDay: new Date(p[0].t).toISOString().slice(0, 16),
      lastDay: new Date(p[p.length - 1].t).toISOString().slice(0, 16),
      spanDays: +((p[p.length - 1].t - p[0].t) / dayMs).toFixed(2),
    };
  };

  // 合并记录里最大的时间跳跃（段间断档）
  let maxGapHour = 0;
  if (mergedActivity) {
    const p = mergedActivity.points;
    for (let i = 1; i < p.length; i += 1) {
      maxGapHour = Math.max(maxGapHour, (p[i].t - p[i - 1].t) / 3600000);
    }
  }

  return {
    each: stat(base),
    dayCount: savedIds.length,
    mergeStatus: merged.status,
    storedSession: raw?.session ?? null,
    storedPoints: raw ? raw.t.length : 0,
    merged: mergedActivity ? stat(mergedActivity) : null,
    maxGapHour: +maxGapHour.toFixed(2),
  };
}, buf.toString('base64'), path.basename(fitPath), DAY);

console.log('单次（原始）:', JSON.stringify(out.each, null, 2));
console.log('落库段数:', out.dayCount, '合并 status:', out.mergeStatus);
console.log('库里 session:', JSON.stringify(out.storedSession));
console.log('库里点数量:', out.storedPoints);
console.log('合并后（重载）:', JSON.stringify(out.merged, null, 2));
console.log('合并后最大时间断档(小时):', out.maxGapHour);
await browser.close();
