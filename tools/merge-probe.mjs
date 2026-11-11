/**
 * 诊断：合并路线的统计口径与轨迹几何是否自洽。
 *
 * 做法：真实导入一份 fit → 按点数切成 3 段 → 每段 buildActivity 后导出 TCX
 * 重新走真实导入管线 → 调 mergeRecords 合并 → 对比原记录与合并记录的
 * 距离/时长/速度/爬升，并检查段间是否被直线"桥接"、是否产生速度尖峰。
 *
 * 用法：node tools/merge-probe.mjs <fit路径>
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const fitPath = process.argv[2];
if (!fitPath) throw new Error('缺少 fit 路径');
const buf = fs.readFileSync(fitPath);

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[merge]')) console.log(text);
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));

const out = await page.evaluate(async (data, name) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { loadActivity, allMeta, deleteRecord } = await import('/src/store/repo.ts');
  const { buildActivity } = await import('/src/fit/activity.ts');
  const { activityToTcx } = await import('/src/export/track.ts');
  const { mergeRecords } = await import('/src/import/merge.ts');

  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await importFiles([new File([bytes], name)]);
  await new Promise((r) => setTimeout(r, 800));
  const metas = (await allMeta()).filter((m) => !m.deleted);
  const target = metas.find((m) => m.fileName === name) ?? metas[0];
  const original = await loadActivity(target.id);

  // 切成三段：60% / 25% / 15%，模拟设备把一趟长途切成多段
  const pts = original.points;
  const cuts = [0, Math.floor(pts.length * 0.6), Math.floor(pts.length * 0.85), pts.length];
  const segmentFiles = [];
  for (let i = 0; i < 3; i += 1) {
    const slice = pts.slice(cuts[i], cuts[i + 1]);
    if (slice.length < 2) continue;
    const records = slice.map((p) => ({
      timestamp: p.t,
      lat: p.lat,
      lon: p.lon,
      altitude: p.altitude,
      speed: p.speed,
      heartRate: p.heartRate,
      cadence: p.cadence,
      power: p.power,
    }));
    const segDistance = slice[slice.length - 1].distance - slice[0].distance;
    const parsed = {
      sourceType: original.sourceType,
      hasTimestamps: true,
      name: `段${i + 1}`,
      sportHint: original.sport,
      records,
      sessions: [{
        startTime: slice[0].t,
        elapsedTime: Math.round((slice[slice.length - 1].t - slice[0].t) / 1000),
        timerTime: Math.round((slice[slice.length - 1].t - slice[0].t) / 1000),
        distance: segDistance,
        sport: original.sport,
        subSport: original.subSport,
      }],
      laps: [],
    };
    const segActivity = buildActivity(parsed, `segment-${i + 1}.tcx`);
    segmentFiles.push({ name: `segment-${i + 1}.tcx`, content: activityToTcx(segActivity), segDistance, durationSec: segActivity.durationSec });
  }

  const files = segmentFiles.map((f) => new File([f.content], f.name, { type: 'application/xml' }));
  await importFiles(files);
  await new Promise((r) => setTimeout(r, 800));

  const after = (await allMeta()).filter((m) => !m.deleted);
  const segMetas = after.filter((m) => m.fileName.startsWith('segment-')).sort((a, b) => a.fileName.localeCompare(b.fileName));
  // 两种场景：连续三段全部合并；以及只合并首尾两段（中间有真实空间断档）
  const contiguous = await mergeRecords(segMetas.map((m) => m.id));
  const gapPick = [segMetas[0], segMetas[segMetas.length - 1]].filter(Boolean);
  const gapMerged = gapPick.length === 2 ? await mergeRecords(gapPick.map((m) => m.id)) : null;
  const mergedActivity = contiguous.id ? await loadActivity(contiguous.id) : null;
  const gapActivity = gapMerged?.id ? await loadActivity(gapMerged.id) : null;

  // 段间桥接检查：合并轨迹里相邻点的最大间距与对应速度
  const jumpOf = (a) => {
    if (!a) return { maxJumpMeters: 0, jumpSpeedKmh: 0 };
    let maxJump = 0;
    let jumpSpeed = 0;
    const p = a.points;
    for (let i = 1; i < p.length; i += 1) {
      const dt = p[i].t - p[i - 1].t;
      const dy = Math.abs(p[i].distance - p[i - 1].distance);
      if (dy > maxJump) {
        maxJump = dy;
        jumpSpeed = dt > 0 ? dy / dt : 0;
      }
    }
    return { maxJumpMeters: Math.round(maxJump), jumpSpeedKmh: +(jumpSpeed * 3.6).toFixed(1) };
  };

  const summary = (a) => a && ({
    title: a.title,
    distanceM: Math.round(a.distanceM),
    durationSec: Math.round(a.durationSec),
    elapsedSec: Math.round(a.elapsedSec),
    avgSpeedKmh: +(a.avgSpeed * 3.6).toFixed(1),
    maxSpeedKmh: +(a.maxSpeed * 3.6).toFixed(1),
    ascent: a.ascent,
    points: a.points.length,
    start: new Date(a.startTime).toISOString(),
  });

  return {
    original: summary(original),
    segments: segmentFiles.map((f) => ({ name: f.name, distanceM: Math.round(f.segDistance), durationSec: Math.round(f.durationSec) })),
    segCount: segMetas.length,
    mergeStatus: contiguous.status,
    merged: summary(mergedActivity),
    bridge: jumpOf(mergedActivity),
    gapStatus: gapMerged?.status ?? null,
    gapMerged: summary(gapActivity),
    gapBridge: jumpOf(gapActivity),
  };
}, buf.toString('base64'), path.basename(fitPath));

console.log('原始记录:', JSON.stringify(out.original, null, 2));
console.log('切段:', JSON.stringify(out.segments, null, 2), '导入成功段数:', out.segCount);
console.log('连续三段合并:', JSON.stringify(out.merged, null, 2), 'status:', out.mergeStatus);
console.log('  → 段间最大跳变:', JSON.stringify(out.bridge));
console.log('跳段合并(首+尾):', JSON.stringify(out.gapMerged, null, 2), 'status:', out.gapStatus);
console.log('  → 段间最大跳变:', JSON.stringify(out.gapBridge));
await browser.close();
