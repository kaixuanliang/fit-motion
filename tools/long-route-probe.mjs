/**
 * 超长距离成片调研：300km 阈值上下（173km / 518km / 1036km / 2072km）
 * 走一遍真实创作页管线，量化缓存耗时、瓦片驻留、播放帧率、内存。
 *
 * 做法：把同一份 fit 的轨迹点按经纬度平移后首尾相接（衔接距离 0），
 * 构造不同总里程的 ParsedFit 直接 saveParsed，再进创作页采样。
 *
 * 用法：node tools/long-route-probe.mjs <fit路径>
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
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[probe]')) console.log(text);
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 600));

const out = await page.evaluate(async (data, name) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { loadActivity, allMeta, saveParsed, removeActivity } = await import('/src/store/repo.ts');

  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await importFiles([new File([bytes], name)]);
  await new Promise((r) => setTimeout(r, 900));
  const metas = (await allMeta()).filter((m) => !m.deleted);
  const target = metas.find((m) => m.fileName === name) ?? metas[0];
  const base = await loadActivity(target.id);

  /** 把轨迹点平移 offsetDeg 后与原轨迹首尾相接，重复 times 次 */
  const makeLong = (times) => {
    const records = [];
    let offsetLat = 0;
    let lastT = 0;
    for (let k = 0; k < times; k += 1) {
      for (const p of base.points) {
        const t = p.t + k * base.durationSec * 1000;
        if (t <= lastT) continue;
        lastT = t;
        records.push({
          timestamp: t,
          lat: p.lat + offsetLat,
          lon: p.lon,
          altitude: p.altitude,
          speed: p.speed,
          heartRate: p.heartRate,
          cadence: p.cadence,
          power: p.power,
        });
      }
      offsetLat += 0.35; // 每一段向东偏 39km，段间首尾相接
    }
    return {
      sourceType: base.sourceType,
      hasTimestamps: true,
      name: `long${times}`,
      sportHint: base.sport,
      records,
      sessions: [{
        startTime: records[0].timestamp,
        elapsedTime: Math.round((records[records.length - 1].timestamp - records[0].timestamp) / 1000),
        timerTime: Math.round((records[records.length - 1].timestamp - records[0].timestamp) / 1000),
        distance: base.distanceM * times,
        sport: base.sport,
        subSport: base.subSport,
      }],
      laps: [],
    };
  };

  const results = [];
  for (const times of [1, 3]) {
    const id = await saveParsed({
      parsed: makeLong(times),
      fileName: `long${times}.tcx`,
      src: 'fit',
      bytes: new ArrayBuffer(0),
      keepFile: false,
      name: `long${times}`,
      hashOverride: `long-${times}-${Math.random().toString(36).slice(2)}`,
      skipDedupe: true,
    }).then((r) => r.id);
    if (!id) continue;
    window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
    await new Promise((r) => setTimeout(r, 1500));
    const activity = await loadActivity(id);

    // 进创作页，量缓存各阶段耗时
    performance.clearMarks();
    performance.clearMeasures();
    window.__fitReady = false;
    document.querySelector(`#record-list .rec[data-id="${id}"]`)?.click();
    for (let i = 0; i < 900; i += 1) {
      if (window.__fitReady === true) break;
      if (i % 20 === 0) console.log(`[probe] ${times}x waiting cache ${i * 0.25 | 0}s`);
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 800));
    const ready = window.__fitReady === true;
    const marks = {};
    let baseTime = 0;
    for (const m of performance.getEntriesByType('mark').filter((m) => m.name.startsWith('fm:'))) {
      if (!baseTime) baseTime = m.startTime;
      marks[m.name.replace('fm:', '')] = Math.round(m.startTime - baseTime);
    }
    const stage = window.__fitStage;
    const follow = stage ? stage.follow : null;
    const tiles = follow ? follow.active.size : 0;

    // 播放帧成本：step 30 帧（模拟 1 秒 @30fps），测平均单帧耗时
    let frameMs = 0;
    if (stage && ready) {
      const duration = Math.min(stage.duration, 30);
      const t0 = performance.now();
      for (let i = 0; i < 30; i += 1) stage.renderAt((duration * i) / 30);
      frameMs = +(performance.now() - t0).toFixed(1);
    }
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;

    results.push({
      times,
      km: Math.round(activity.distanceM / 1000),
      points: activity.points.length,
      ready,
      cacheMs: marks,
      tiles,
      videoSec: stage ? +stage.duration.toFixed(1) : null,
      speedKmPerSec: stage ? +(activity.distanceM / 1000 / Math.max(1, stage.duration - 3.5)).toFixed(1) : null,
      frameMs,
      heapMB: mem,
    });

    // 清理再测下一条，避免互相影响
    document.getElementById('back-btn')?.click();
    await new Promise((r) => setTimeout(r, 500));
    await removeActivity(id);
    await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}, buf.toString('base64'), path.basename(fitPath));

console.table(out.map((r) => ({
  km: r.km,
  points: r.points,
  ready: r.ready,
  tiles: r.tiles,
  videoSec: r.videoSec,
  kmPerSec: r.speedKmPerSec,
  frame30ms: r.frameMs,
  heapMB: r.heapMB,
})));
for (const r of out) {
  console.log(`${r.km}km cache marks:`, JSON.stringify(r.cacheMs));
}
await browser.close();
