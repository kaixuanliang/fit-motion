/**
 * 生成测试数据：环北京六环外 >300km 骑行 / 北京→郑州多日骑行。
 *
 * 输出 FIT + GPX 到 testdata/，轨迹用项目自己的 buildActivity / activityToFit /
 * activityToGpx 生成，保证导入后里程、时长、心率口径与真实码表一致。
 *
 * 用法：node tools/make-testdata.mjs [ring|bjzz|all]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = path.resolve('testdata');
const only = process.argv[2] ?? 'all';

const RING = {
  kind: 'ring',
  lat0: 39.9042,
  lon0: 116.4074,
  meanKm: 49.5,
  amps: [[3.4, 3, 0.7], [1.7, 7, 2.1], [0.9, 13, 4.3]],
  sampleSec: 2,
  days: [{ start: '2026-09-19T06:30:00+08:00', base: 26.5 }],
};

const BJZZ = {
  kind: 'polyline',
  sampleSec: 3,
  waypoints: [
    [39.9042, 116.4074], [39.7800, 116.3300], [39.6300, 116.1400],
    [39.4860, 115.9740], [39.3300, 115.8700], [39.1000, 115.7000],
    [38.8700, 115.4600], [38.6500, 115.2000], [38.5200, 114.9900],
    [38.3000, 114.8000], [38.1500, 114.6000], [38.0400, 114.5100],
    [37.7500, 114.5500], [37.6000, 114.6000], [37.3500, 114.6000],
    [37.0700, 114.5000], [36.8500, 114.5500], [36.6300, 114.4900],
    [36.3500, 114.4500], [36.1000, 114.3900], [35.8500, 114.3500],
    [35.6000, 114.3000], [35.3000, 113.9300], [35.0500, 113.7500],
    [34.7466, 113.6254],
  ],
  // 在石家庄、安阳各过一夜
  splits: [[38.0400, 114.5100], [36.1000, 114.3900]],
  days: [
    { start: '2026-09-24T06:10:00+08:00', base: 27.5 },
    { start: '2026-09-25T06:20:00+08:00', base: 26.8 },
    { start: '2026-09-26T06:15:00+08:00', base: 26.2 },
  ],
};

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('  [page]', msg.text());
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 500));

fs.mkdirSync(OUT, { recursive: true });

/** 页面内：几何构建 + 骑行模拟 + 编码（含 FIT/GPX 两路） */
const build = (cfg) => page.evaluate(async (config) => {
  const { buildActivity } = await import('/src/fit/activity.ts');
  const { activityToFit } = await import('/src/export/fit.ts');
  const { activityToGpx } = await import('/src/export/track.ts');

  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const hav = (a, b, c, d) => {
    const p1 = rad(a); const p2 = rad(c);
    const dp = p2 - p1; const dl = rad(d - b);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mulberry32 = (seed) => () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ── 高程：环线按北京地形（西、北山多，东南平原）／京郑沿 107 国道（华北平原） ──
  const ringAlt = (lat, lon, m) => {
    const west = clamp((116.30 - lon) / 0.62, 0, 1);
    const north = clamp((lat - 39.95) / 0.48, 0, 1);
    const hill = 0.35 + 0.65 * Math.max(west, north * 0.85);
    // 大尺度地形 + 山区的局部起伏（真实山路 2~4km 一个坡）
    return 42
      + 400 * west ** 1.7
      + 130 * north ** 1.4
      + hill * (120 * Math.sin(m / 6200 + 0.4) + 58 * Math.sin(m / 2700 + 1.9)
        + 26 * Math.sin(m / 1150 + 3.1) + 12 * Math.sin(m / 480 + 0.6));
  };
  const plainAlt = (lat, lon, m) => 62
    + 26 * Math.sin(m / 21000)
    + 16 * Math.sin(m / 8600 + 1.1)
    + 7 * Math.sin(m / 2900 + 0.3)
    + 3 * Math.sin(m / 900 + 2.4)
    - (lat - 34.9) * 3.2;

  // ── 几何 ──
  const buildRing = (c) => {
    // 周长先按平均半径估，再按 80m 步长离散
    const perimeter = 2 * Math.PI * c.meanKm * 1000;
    const n = Math.ceil(perimeter / 80);
    const coords = [];
    for (let i = 0; i <= n; i += 1) {
      const th = (2 * Math.PI * i) / n;
      const r = c.meanKm + c.amps.reduce((sum, [a, k, p]) => sum + a * Math.sin(k * th + p), 0);
      const lat = c.lat0 + ((r * 1000) / 110574) * Math.sin(th);
      const lon = c.lon0 + ((r * 1000) / (111320 * Math.cos(rad(c.lat0)))) * Math.cos(th);
      coords.push([lat, lon, 0]);
    }
    return finish(coords);
  };

  const buildLine = (c) => {
    const coords = [];
    let acc = 0;
    for (let i = 1; i < c.waypoints.length; i += 1) {
      const [lat1, lon1] = c.waypoints[i - 1];
      const [lat2, lon2] = c.waypoints[i];
      const seg = hav(lat1, lon1, lat2, lon2);
      const steps = Math.max(2, Math.ceil(seg / 70));
      for (let s = 0; s < steps; s += 1) {
        const f = s / steps;
        let lat = lat1 + (lat2 - lat1) * f;
        let lon = lon1 + (lon2 - lon1) * f;
        // 沿法线加缓弯，避免出现「直线段拼接」的假轨迹
        const off = 150 * Math.sin((acc + seg * f) / 950) + 70 * Math.sin((acc + seg * f) / 260);
        const dLat = (lat2 - lat1) * 111320;
        const dLon = (lon2 - lon1) * 111320 * Math.cos(rad(lat));
        const len = Math.hypot(dLat, dLon) || 1;
        lat += ((-dLon / len) * off) / 110574;
        lon += ((dLat / len) * off) / (111320 * Math.cos(rad(lat)));
        coords.push([lat, lon, 0]);
      }
      acc += seg;
    }
    coords.push([...c.waypoints[c.waypoints.length - 1], 0]);
    return finish(coords);
  };

  const finish = (coords) => {
    const cum = [0];
    for (let i = 1; i < coords.length; i += 1) {
      cum.push(cum[i - 1] + hav(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    }
    const total = cum[cum.length - 1];
    const altFn = config.kind === 'ring' ? ringAlt : plainAlt;
    for (let i = 0; i < coords.length; i += 1) {
      coords[i][2] = altFn(coords[i][0], coords[i][1], cum[i]);
    }
    return { coords, cum, total };
  };

  const geom = config.kind === 'ring' ? buildRing(config) : buildLine(config);

  /** 按里程插值取点 */
  const at = (m) => {
    const { coords, cum } = geom;
    const d = clamp(m, 0, geom.total);
    let lo = 0; let hi = cum.length - 1;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const span = cum[hi] - cum[lo];
    const f = span > 0 ? (d - cum[lo]) / span : 0;
    return {
      lat: coords[lo][0] + (coords[hi][0] - coords[lo][0]) * f,
      lon: coords[lo][1] + (coords[hi][1] - coords[lo][1]) * f,
      alt: coords[lo][2] + (coords[hi][2] - coords[lo][2]) * f,
    };
  };

  const nearestM = (lat, lon) => {
    let best = 0; let bestD = Infinity;
    for (let i = 0; i < geom.coords.length; i += 1) {
      const d = (geom.coords[i][0] - lat) ** 2 + (geom.coords[i][1] - lon) ** 2;
      if (d < bestD) { bestD = d; best = geom.cum[i]; }
    }
    return best;
  };

  // ── 单日骑行模拟 ──
  const ride = (fromM, toM, startMs, base, seed) => {
    const rnd = mulberry32(seed);
    const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    const dt = config.sampleSec;
    const span = toM - fromM;
    // 休息点：每 45~70km 一次，另加一次午饭长休
    const stops = [];
    let cursor = fromM + 42000 + rnd() * 16000;
    while (cursor < toM - 8000) {
      stops.push({ at: cursor, dur: Math.round(240 + rnd() * 420) });
      cursor += 45000 + rnd() * 25000;
    }
    const lunch = fromM + span * (0.5 + rnd() * 0.1);
    stops.push({ at: lunch, dur: Math.round(1500 + rnd() * 600) });
    stops.sort((a, b) => a.at - b.at);

    const hrBase = 121 + rnd() * 8;
    const pts = [];
    let s = fromM;
    let t = startMs;
    let stopIdx = 0;
    let guard = 0;

    const pushPoint = (speedMs, hr, cad, power) => {
      const p = at(s);
      pts.push({
        timestamp: t,
        lat: Number(p.lat.toFixed(7)),
        lon: Number(p.lon.toFixed(7)),
        altitude: Number(p.alt.toFixed(1)),
        speed: Number(speedMs.toFixed(3)),
        heartRate: Math.round(hr),
        cadence: Math.round(cad),
        power: Math.round(power),
      });
    };

    while (s < toM - 0.5 && guard < 600000) {
      guard += 1;
      const grade = (at(s + 160).alt - at(s - 160).alt) / 320;
      const noise = 0.5 * Math.sin(s / 1500 + ph[0]) + 0.32 * Math.sin(s / 430 + ph[1])
        + 0.18 * Math.sin(s / 170 + ph[2]);
      const climb = clamp(grade, 0, 1);
      const desc = clamp(-grade, 0, 1);
      // 平路巡航 + 爬坡掉速 + 下坡放坡，另加偶发冲刺
      const sprint = Math.max(0, Math.sin(s / 5200 + ph[0] * 2) - 0.86) * 5.5;
      let v = base * (1 - climb * 7.2) * (1 + desc * 16) * (0.94 + 0.13 * noise) + sprint;
      v *= 1 - 0.09 * ((s - fromM) / span); // 后程体力衰减
      const tired = 1 - 0.06 * ((s - fromM) / span);
      v = clamp(v, 9, 52);
      const vMs = v / 3.6;

      // 到休息点：原地停车，心率回落
      if (stopIdx < stops.length && s >= stops[stopIdx].at) {
        const stop = stops[stopIdx];
        stopIdx += 1;
        const steps = Math.max(1, Math.round(stop.dur / dt));
        const hrStart = hrBase + 22 * tired;
        for (let k = 1; k <= steps; k += 1) {
          const f = k / steps;
          t += dt * 1000;
          pushPoint(0, hrStart - 34 * Math.min(1, f * 1.6), 0, 0);
        }
        continue;
      }

      const hr = clamp(hrBase + 14 * tired + 430 * climb + 6 * Math.sin(s / 2600 + ph[1])
        + 4 * noise, 92, 176);
      const cad = clamp(84 + 9 * Math.sin(s / 700 + ph[2]) + (v - base) * 0.6, 55, 108);
      const power = clamp(120 + v * 4.4 + climb * 2600, 85, 430);
      pushPoint(vMs, hr, cad, power);
      s += vMs * dt;
      t += dt * 1000;
    }
    // 终点
    s = toM;
    pushPoint(0, hrBase + 12, 0, 0);
    return { pts, elapsedSec: Math.round((t - startMs) / 1000) };
  };

  // ── 组装 ──
  const encodeFit = (bytes) => {
    let bin = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  };

  const makeParsed = (records, meta) => ({
    sourceType: 'fit',
    hasTimestamps: true,
    name: meta.name,
    records,
    sessions: [{
      startTime: meta.startTime,
      sport: 2,
      subSport: 5,
      elapsedTime: meta.elapsedSec,
      timerTime: meta.timerTime,
      distance: meta.distanceM,
      maxSpeed: meta.maxSpeed,
      avgHeartRate: meta.avgHr,
      maxHeartRate: meta.maxHr,
      calories: Math.round(meta.distanceM / 1000 * 32),
      ascent: meta.ascent,
      descent: meta.descent,
    }],
    laps: [],
  });

  /** 逐点累计爬升（3m 迟滞，避免采样噪声虚增） */
  const climbOf = (records) => {
    let ref = null;
    let gain = 0;
    let loss = 0;
    for (const r of records) {
      if (r.altitude == null) continue;
      if (ref == null) { ref = r.altitude; continue; }
      if (r.altitude - ref >= 3) { gain += r.altitude - ref; ref = r.altitude; }
      else if (ref - r.altitude >= 3) { loss += ref - r.altitude; ref = r.altitude; }
    }
    return { gain: Math.round(gain), loss: Math.round(loss) };
  };

  const finishActivity = (records, meta, fileName) => {
    const climb = climbOf(records);
    const activity = buildActivity(makeParsed(records, {
      ...meta, ascent: climb.gain, descent: climb.loss,
    }), fileName);
    const fit = activityToFit(activity);
    const gpx = activityToGpx(activity);
    return {
      fit: encodeFit(fit),
      gpx,
      stats: {
        distanceKm: +(activity.distanceM / 1000).toFixed(1),
        movingH: +(activity.movingSec / 3600).toFixed(2),
        elapsedH: +(activity.elapsedSec / 3600).toFixed(2),
        points: activity.points.length,
        maxSpeed: +(activity.maxSpeed * 3.6).toFixed(1),
        avgSpeed: +(activity.avgSpeed * 3.6).toFixed(1),
        maxHr: activity.maxHeartRate,
        avgHr: activity.avgHeartRate,
        ascent: activity.ascent,
        maxAlt: Math.round(activity.maxAltitude ?? 0),
        title: activity.title,
        place: activity.place,
      },
    };
  };

  const summarise = (records) => {
    const speeds = records.map((r) => r.speed).filter((v) => v != null);
    const hrs = records.map((r) => r.heartRate).filter((v) => v != null);
    return {
      maxSpeed: Math.max(...speeds),
      maxHr: Math.max(...hrs),
      avgHr: Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length),
    };
  };

  const totalM = geom.total;

  if (config.kind === 'ring') {
    const d = config.days[0];
    const start = Date.parse(d.start);
    const r = ride(0, totalM, start, d.base, 20260919);
    const sum = summarise(r.pts);
    const movingSec = r.pts.filter((p) => p.speed > 0.7).length * config.sampleSec;
    return {
      totalKm: +(totalM / 1000).toFixed(1),
      files: [{
        name: 'ring',
        ...finishActivity(r.pts, {
          name: '环北京六环外一圈',
          startTime: start,
          elapsedSec: r.elapsedSec,
          timerTime: movingSec,
          distanceM: totalM,
          maxSpeed: sum.maxSpeed,
          avgHr: sum.avgHr,
          maxHr: sum.maxHr,
        }, 'beijing-ring6-outside.fit'),
      }],
    };
  }

  // 京郑：按途经点切天
  const cutM = config.splits.map(([lat, lon]) => nearestM(lat, lon));
  const bounds = [0, ...cutM, totalM];
  const days = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const d = config.days[i];
    const start = Date.parse(d.start);
    const r = ride(bounds[i], bounds[i + 1], start, d.base, 20260924 + i * 7);
    const sum = summarise(r.pts);
    const movingSec = r.pts.filter((p) => p.speed > 0.7).length * config.sampleSec;
    days.push({
      fromM: bounds[i], toM: bounds[i + 1], start, pts: r.pts, elapsedSec: r.elapsedSec,
      movingSec, sum, d,
    });
  }

  const files = days.map((day, i) => ({
    name: `day${i + 1}`,
    ...finishActivity(day.pts, {
      name: `北京→郑州 第${i + 1}天`,
      startTime: day.start,
      elapsedSec: day.elapsedSec,
      timerTime: day.movingSec,
      distanceM: day.toM - day.fromM,
      maxSpeed: day.sum.maxSpeed,
      avgHr: day.sum.avgHr,
      maxHr: day.sum.maxHr,
    }, `beijing-zhengzhou-d${i + 1}.fit`),
  }));

  // 全程单文件（一个 session、跨 3 天）
  const allPts = days.flatMap((d) => d.pts);
  const first = days[0].start;
  const lastEnd = days[days.length - 1].pts[days[days.length - 1].pts.length - 1].timestamp;
  const allSum = summarise(allPts);
  const allMoving = days.reduce((sum, d) => sum + d.movingSec, 0);
  files.push({
    name: 'all',
    ...finishActivity(allPts, {
      name: '北京→郑州 全程',
      startTime: first,
      elapsedSec: Math.round((lastEnd - first) / 1000),
      timerTime: allMoving,
      distanceM: totalM,
      maxSpeed: allSum.maxSpeed,
      avgHr: allSum.avgHr,
      maxHr: allSum.maxHr,
    }, 'beijing-zhengzhou-3day.fit'),
  });

  return { totalKm: +(totalM / 1000).toFixed(1), files };
}, cfg);

const writeOut = (label, result) => {
  console.log(`\n${label}: 几何长度 ${result.totalKm} km`);
  for (const file of result.files) {
    const baseName = file.name === 'ring' ? 'beijing-ring6-outside'
      : file.name === 'all' ? 'beijing-zhengzhou-3day'
        : `beijing-zhengzhou-${file.name}`;
    fs.writeFileSync(path.join(OUT, `${baseName}.fit`), Buffer.from(file.fit, 'base64'));
    fs.writeFileSync(path.join(OUT, `${baseName}.gpx`), file.gpx);
    const s = file.stats;
    console.log(
      `  ${baseName}.fit/.gpx  ${s.distanceKm}km  ${s.movingH}h 运动 / ${s.elapsedH}h 总耗时`
      + `  ${s.points}点  均速${s.avgSpeed}  最高${s.maxSpeed}  HR ${s.avgHr}/${s.maxHr}`
      + `  爬升${s.ascent}m  海拔${s.maxAlt}m`,
    );
  }
};

if (only === 'ring' || only === 'all') writeOut('环北京六环外', await build(RING));
if (only === 'bjzz' || only === 'all') writeOut('北京→郑州', await build(BJZZ));

await browser.close();
console.log(`\n输出目录：${OUT}`);
