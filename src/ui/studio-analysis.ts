/**
 * 创作页「数据」「解读」子页：图表自绘 + 规则引擎叙事。
 *
 * - 全部读当前 Activity 的逐点数据（海拔/速度/心率），零网络请求、零依赖。
 * - 主题色运行时从 CSS 变量取（--accent / --muted / --line），创作页没有
 *   独立主题开关——跟随设置页的全局 data-theme，切换后重绘即同步。
 * - 画布在子页可见时才渲染（display:none 下 clientWidth 为 0），由
 *   main.ts 在切页与主题变化时调用 renderAnalysis()。
 */
import type { Activity, RoutePoint, Split } from '../fit/activity';
import { formatDuration, formatSpeedKmh } from '../fit/activity';

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function kmLabel(meters: number): string {
  const km = meters / 1000;
  return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/** 心率区间定义：按最大心率的百分比划分（经典 5 区）。 */
const ZONES: Array<{ label: string; lo: number; hi: number }> = [
  { label: 'Z1 放松', lo: 0, hi: 0.6 },
  { label: 'Z2 耐力', lo: 0.6, hi: 0.7 },
  { label: 'Z3 有氧', lo: 0.7, hi: 0.8 },
  { label: 'Z4 阈值', lo: 0.8, hi: 0.9 },
  { label: 'Z5 极限', lo: 0.9, hi: Infinity },
];

/* ── 海拔与速度复合曲线 ───────────────────────────────────────── */

function bucketize(activity: Activity, buckets: number): Array<{ alt?: number; speed?: number }> {
  const points = activity.points;
  const total = activity.routeDistanceM || activity.distanceM || 1;
  const out: Array<{ altSum: number; altN: number; spSum: number; spN: number }> = [];
  for (let i = 0; i < buckets; i += 1) out.push({ altSum: 0, altN: 0, spSum: 0, spN: 0 });
  for (const point of points) {
    const ratio = Math.min(0.9999, Math.max(0, point.distance / total));
    const b = out[Math.floor(ratio * buckets)];
    if (point.altitude != null) { b.altSum += point.altitude; b.altN += 1; }
    if (point.speed != null) { b.spSum += point.speed; b.spN += 1; }
  }
  return out.map((b) => ({
    alt: b.altN > 0 ? b.altSum / b.altN : undefined,
    speed: b.spN > 0 ? b.spSum / b.spN : undefined,
  }));
}

function drawSeries(
  canvas: HTMLCanvasElement,
  activity: Activity,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 10 || h < 10) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const buckets = Math.max(40, Math.min(220, Math.floor(w / 2)));
  const data = bucketize(activity, buckets);
  // GPS 速度抖动明显：三点滑动平均压噪，海拔同样受益
  const smooth = (key: 'alt' | 'speed'): Array<number | undefined> => data.map((d, i) => {
    const vals = [data[i - 1]?.[key], d[key], data[i + 1]?.[key]].filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
  });
  const altSeries = smooth('alt');
  const speedSeries = smooth('speed');
  const accent = cssVar('--accent');
  const muted = cssVar('--muted');
  const soft = cssVar('--accent-soft') || 'rgba(128,128,128,0.12)';

  // 海拔轴：留 6px 上下余量
  const alts = altSeries.filter((v): v is number => v != null);
  if (alts.length >= 2) {
    let lo = Math.min(...alts);
    let hi = Math.max(...alts);
    if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = mid - 10; hi = mid + 10; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    const y = (v: number) => 4 + (1 - (v - lo) / (hi - lo)) * (h - 8);
    const x = (i: number) => (i / (buckets - 1)) * w;

    ctx.beginPath();
    ctx.moveTo(0, h);
    altSeries.forEach((v, i) => { if (v != null) ctx.lineTo(x(i), y(v)); });
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = soft;
    ctx.fill();

    ctx.beginPath();
    let started = false;
    altSeries.forEach((v, i) => {
      if (v == null) return;
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
      else ctx.lineTo(x(i), y(v));
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // 速度虚线：独立归一化到画布下半区（无轴示意，不与海拔共轴）
  const speeds = speedSeries.filter((v): v is number => v != null);
  if (speeds.length >= 2) {
    const hi = Math.max(...speeds) || 1;
    const y = (v: number) => h - 4 - (v / hi) * (h * 0.62);
    ctx.beginPath();
    let started = false;
    speedSeries.forEach((v, i) => {
      if (v == null) return;
      if (!started) { ctx.moveTo((i / (buckets - 1)) * w, y(v)); started = true; }
      else ctx.lineTo((i / (buckets - 1)) * w, y(v));
    });
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* ── 心率区间 ─────────────────────────────────────────────────── */

function renderHrCard(activity: Activity): void {
  const card = document.getElementById('hr-card');
  if (!card) return;
  const points = activity.points.filter((p) => p.heartRate != null && p.heartRate > 0) as RoutePoint[];
  if (!activity.heartRateAvailable || points.length < 10) {
    card.hidden = true;
    return;
  }
  const maxHr = activity.maxHeartRate ?? Math.max(...points.map((p) => p.heartRate as number));
  const counts = ZONES.map(() => 0);
  for (const p of points) {
    const ratio = (p.heartRate as number) / maxHr;
    const idx = ZONES.findIndex((z) => ratio >= z.lo && ratio < z.hi);
    counts[idx === -1 ? ZONES.length - 1 : idx] += 1;
  }
  const total = points.length;
  const maxCount = Math.max(...counts, 1);
  const wrap = document.getElementById('hr-zones');
  const totalEl = document.getElementById('hr-total');
  if (!wrap) return;
  wrap.innerHTML = '';
  ZONES.forEach((zone, i) => {
    const pct = Math.round((counts[i] / total) * 100);
    const row = document.createElement('div');
    row.className = 'zone';
    const fill = Math.max(4, Math.round((counts[i] / maxCount) * 100));
    row.innerHTML = `<span>${zone.label}</span>`
      + `<div class="bar" style="width:${fill}%;opacity:${(0.35 + 0.65 * (i / (ZONES.length - 1))).toFixed(2)}"></div>`
      + `<span class="pct">${pct}%</span>`;
    wrap.appendChild(row);
  });
  if (totalEl) totalEl.textContent = `全程 ${formatDuration(activity.movingSec, true)}`;
  card.hidden = false;
}

/* ── 解读：规则引擎叙事 ───────────────────────────────────────── */

function splitSpeedKmh(split: Split): number {
  return split.seconds > 0 ? (split.distanceM / split.seconds) * 3.6 : 0;
}

function longestClimb(activity: Activity): { meters: number; climbM: number } | null {
  if (!activity.altitudeAvailable) return null;
  const points = activity.points.filter((p) => p.altitude != null) as Required<Pick<RoutePoint, 'altitude' | 'distance'>>[];
  let best: { meters: number; climbM: number } | null = null;
  let start = 0;
  let climb = 0;
  let prevAlt = points[0]?.altitude ?? 0;
  for (let i = 1; i < points.length; i += 1) {
    const delta = points[i].altitude - prevAlt;
    if (delta > 0) {
      climb += delta;
    } else if (climb > 0) {
      const meters = points[i].distance - points[start].distance;
      if (!best || climb > best.climbM) best = { meters, climbM: climb };
      climb = 0;
      start = i;
    }
    prevAlt = points[i].altitude;
  }
  if (climb > 0) {
    const meters = points[points.length - 1].distance - points[start].distance;
    if (!best || climb > best.climbM) best = { meters, climbM: climb };
  }
  return best && best.climbM > 30 ? best : null;
}

export interface StudioStories {
  main: string;
  highlights: string;
  pace: string;
}

export function buildStories(activity: Activity): StudioStories {
  const splits = activity.splits;
  const avgKmh = activity.avgSpeedAvailable ? activity.avgSpeed * 3.6 : 0;

  // 今日故事：末段艰难 / 负分割 / 平稳，三选一
  let main = '';
  if (splits.length >= 4 && avgKmh > 0) {
    const tailN = Math.max(1, Math.round(splits.length * 0.2));
    const tail = splits.slice(-tailN);
    const tailSec = tail.reduce((a, s) => a + s.seconds, 0);
    const tailM = tail.reduce((a, s) => a + s.distanceM, 0);
    const tailKmh = tailSec > 0 ? (tailM / tailSec) * 3.6 : 0;
    const tailAscent = tail.reduce((a, s) => a + (s.ascent ?? 0), 0);
    const head = splits.slice(0, Math.floor(splits.length / 2));
    const headSec = head.reduce((a, s) => a + s.seconds, 0);
    const headM = head.reduce((a, s) => a + s.distanceM, 0);
    const headKmh = headSec > 0 ? (headM / headSec) * 3.6 : 0;

    if (tailAscent > 40 && tailKmh > 0 && tailKmh < avgKmh * 0.9) {
      main = `最难的 ${tailN} 公里在最后：末段爬升 ${Math.round(tailAscent)} 米、均速降到 ${tailKmh.toFixed(1)} km/h——你把最硬的一段留到了收尾。`;
    } else if (headKmh > 0 && tailKmh > headKmh * 1.03) {
      main = `后半程比前半程快 ${Math.round(((tailKmh / headKmh) - 1) * 100)}%。节奏越骑越好，储备还有富余。`;
    } else {
      main = `全程节奏平稳：均速 ${avgKmh.toFixed(1)} km/h，没有明显的掉速段。`;
    }
  } else {
    main = avgKmh > 0
      ? `全程均速 ${avgKmh.toFixed(1)} km/h${activity.ascent ? `，累计爬升 ${Math.round(activity.ascent)} 米` : ''}。`
      : '这段记录的节奏数据有限，先看看下面的曲线吧。';
  }

  // 亮点时刻：极值点 + 最长爬坡
  const bits: string[] = [];
  if (activity.maxSpeedPoint && activity.maxSpeedAvailable) {
    bits.push(`最快 ${formatSpeedKmh(activity.maxSpeed)} km/h 出现在 ${kmLabel(activity.maxSpeedPoint.distance)}`);
  }
  if (activity.maxHrPoint && activity.heartRateAvailable) {
    bits.push(`最高心率 ${activity.maxHrPoint.heartRate} 出现在 ${kmLabel(activity.maxHrPoint.distance)}`);
  }
  if (activity.maxAltitudePoint && activity.altitudeAvailable && activity.maxAltitude != null) {
    bits.push(`最高海拔 ${Math.round(activity.maxAltitude)} 米在 ${kmLabel(activity.maxAltitudePoint.distance)}`);
  }
  const climb = longestClimb(activity);
  if (climb) {
    bits.push(`最长连续爬坡 ${kmLabel(climb.meters)} / ${Math.round(climb.climbM)} 米`);
  }
  const highlights = bits.length > 0 ? `${bits.join('；')}。` : '这条记录缺少逐点数据，先导出一份 FIT 留档吧。';

  // 体力节奏：按四等分找状态最佳的一段
  let pace = '';
  if (splits.length >= 4) {
    const q = Math.ceil(splits.length / 4);
    const quarters = [0, 1, 2, 3].map((k) => {
      const slice = splits.slice(k * q, Math.min(splits.length, (k + 1) * q));
      const sec = slice.reduce((a, s) => a + s.seconds, 0);
      const m = slice.reduce((a, s) => a + s.distanceM, 0);
      const beats = slice.map((s) => s.heartRate).filter((v): v is number => typeof v === 'number' && v > 0);
      return {
        from: slice[0]?.index ?? 0,
        to: slice[slice.length - 1]?.index ?? 0,
        kmh: sec > 0 ? (m / sec) * 3.6 : 0,
        hr: beats.length > 0 ? Math.round(beats.reduce((a, b) => a + b, 0) / beats.length) : undefined,
      };
    }).filter((qr) => qr.kmh > 0);
    if (quarters.length >= 2) {
      const best = quarters.reduce((a, b) => (b.kmh > a.kmh ? b : a));
      const from = best.from === 0 ? 0 : best.from - 1;
      pace = `状态最佳在 ${from}–${best.to} km：均速 ${best.kmh.toFixed(1)} km/h`
        + (best.hr ? `、心率 ${best.hr}` : '')
        + '。';
      if (quarters[0].kmh > avgKmh * 1.08) {
        pace += '开局偏快，下次试着把强度留到中后段。';
      }
    }
  }
  if (!pace) pace = '分段数据不足，骑久一点再看节奏分析。';

  return { main, highlights, pace };
}

function renderStories(activity: Activity): void {
  const stories = buildStories(activity);
  const main = document.getElementById('story-main');
  const highlights = document.getElementById('story-highlights');
  const pace = document.getElementById('story-pace');
  if (main) main.textContent = stories.main;
  if (highlights) highlights.textContent = stories.highlights;
  if (pace) pace.textContent = stories.pace;
}

/* ── 入口 ─────────────────────────────────────────────────────── */

/** 渲染「数据」与「解读」两个子页。要求对应子页当前可见（画布需要宽度）。 */
export function renderAnalysis(activity: Activity): void {
  const elevCard = document.getElementById('elev-card');
  const canvas = document.getElementById('chart-elev') as HTMLCanvasElement | null;
  if (elevCard && canvas) {
    const hasAltitude = activity.altitudeAvailable
      && activity.points.some((p) => p.altitude != null);
    const hasSpeed = activity.points.some((p) => p.speed != null);
    if (hasAltitude || hasSpeed) {
      elevCard.hidden = false;
      drawSeries(canvas, activity);
    } else {
      elevCard.hidden = true;
    }
  }
  renderHrCard(activity);
  renderStories(activity);
}
