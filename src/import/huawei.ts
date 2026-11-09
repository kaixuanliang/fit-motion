/**
 * 华为运动健康「数据副本」导入。
 *
 * 华为隐私中心导出的压缩包里，运动数据在 `motion path detail data.json`。
 * 目前见过两种版本：
 * 1. 新版（2026 起）：顶层数组每项是一条运动记录，轨迹整段塞在
 *    `detailData` 字符串里，行格式 `tp=lbs;k=0;lat=..;lon=..;t=..;`。
 *    官方字段说明：lbs 定位点（t 卫星时间，秒）、alti 海拔（米，约 5 秒
 *    粒度）、h-r 心率（bpm）。summaryData 里挂着官方统计（totalDistance、
 *    sportType=259 户外骑行等）。
 * 2. 旧版：轨迹数组可能叫 motionPathData、motionPath、path、trackPoints……
 *    坐标也可能是 1e-7 的整数。
 * 这里不去猜唯一一种格式，而是按「看起来像地理点」的特征去认，能识别的
 * 部分全部转成标准的 ParsedFit，认不出来的条目会在结果里报「缺 GPS」。
 */

import type { FitRecord, FitSession, ParsedFit } from '../fit/types';
import { haversine } from '../geo';

const LAT_KEYS = ['latitude', 'lat', 'startLatitude', 'gpsLat', 'lat_'];
const LON_KEYS = ['longitude', 'lon', 'lng', 'startLongitude', 'gpsLon', 'lon_'];
const TIME_KEYS = ['timestamp', 'time', 'recordTime', 'startTime', 't', 'trackTime'];
const ALT_KEYS = ['altitude', 'alt', 'elevation', 'ele', 'height'];
const HR_KEYS = ['heartRate', 'hr', 'heart_rate', 'heartrate'];
const SPEED_KEYS = ['speed', 'velocity', 'speedValue', 'speedKmh'];
const DIST_KEYS = ['totalDistance', 'distance', 'dist', 'distanceValue'];

const NAME_KEYS = ['name', 'activityName', 'sportName', 'title', 'remark'];
const SPORT_KEYS = ['sportType', 'activityType', 'sport', 'activityKind'];

const MAX_POINTS = 200_000;
const COORD_SCALE = 1e7;

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(bag: Bag, keys: string[]): number | null {
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function labelOf(bag: Bag, keys: string[]): string | null {
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function coord(value: number, limit: number): number | null {
  let scaled = value;
  if (Math.abs(scaled) > limit) scaled /= COORD_SCALE;
  if (!Number.isFinite(scaled) || Math.abs(scaled) > limit) return null;
  return scaled;
}

/** 归一化时间戳：秒 / 毫秒 / 秒的小数都可能出现。 */
function stamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value > 1e12) return Math.round(value);
  if (value > 1e9) return Math.round(value * 1000);
  return Math.round(value * 1000);
}

function looksLikePoint(value: unknown): value is Bag {
  if (!isBag(value)) return false;
  const lat = num(value, LAT_KEYS);
  const lon = num(value, LON_KEYS);
  if (lat == null || lon == null) return false;
  return Math.abs(coord(lat, 90) ?? 999) <= 90 && Math.abs(coord(lon, 180) ?? 999) <= 180;
}

interface Found {
  holder: Bag;
  points: Bag[];
}

/**
 * 在任意深度的 JSON 里找出「元素是地理点」的数组，并把它的宿主对象
 * 一起带出来（宿主里通常有 startTime / totalDistance 这类汇总字段）。
 */
function collect(value: unknown, out: Found[], seen: Set<unknown>, depth = 0): void {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    if (value.length > 1 && value.slice(0, 8).every(looksLikePoint)) {
      out.push({ holder: {}, points: value as Bag[] });
      return;
    }
    for (const item of value) collect(item, out, seen, depth + 1);
    return;
  }
  if (!isBag(value) || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child) && child.length > 1 && child.slice(0, 8).every(looksLikePoint)) {
      out.push({ holder: value, points: child as Bag[] });
      continue;
    }
    collect(child, out, seen, depth + 1);
  }
}

function guessSport(holder: Bag, avgSpeed: number): number {
  const label = (labelOf(holder, NAME_KEYS) ?? '').toLowerCase();
  const raw = num(holder, SPORT_KEYS);
  if (/骑|bike|cycl|riding/.test(label)) return 2;
  if (/跑|run|jog/.test(label)) return 1;
  if (/走|walk|hike|徒步/.test(label)) return 11;
  if (/游|swim/.test(label)) return 5;
  // 没有名字时按平均速度猜：>23 km/h 基本是骑行，>8 km/h 跑步，再慢是走路
  if (avgSpeed > 6.4) return 2;
  if (avgSpeed > 2.2) return 1;
  if (avgSpeed > 0.2) return 11;
  if (raw != null && raw >= 0 && raw <= 20) return raw | 0;
  return 2;
}

function toRecords(points: Bag[]): FitRecord[] {
  const records: FitRecord[] = [];
  let fallback = 0;
  let previous = 0;
  for (let i = 0; i < points.length && records.length < MAX_POINTS; i += 1) {
    const point = points[i];
    const lat = coord(num(point, LAT_KEYS) ?? NaN, 90);
    const lon = coord(num(point, LON_KEYS) ?? NaN, 180);
    if (lat == null || lon == null) continue;
    const rawTime = num(point, TIME_KEYS);
    let timestamp = rawTime != null ? stamp(rawTime) : 0;
    if (timestamp) {
      if (previous && timestamp < previous - 1000) {
        // 时间戳倒退：多半是「相对秒」混进来了，按上一点 +1s 兜底
        timestamp = previous + 1000;
      }
      previous = timestamp;
    } else {
      fallback += 1000;
      timestamp = 0;
    }
    const speed = num(point, SPEED_KEYS);
    records.push({
      timestamp: timestamp || undefined,
      lat,
      lon,
      altitude: num(point, ALT_KEYS) ?? undefined,
      heartRate: num(point, HR_KEYS) ?? undefined,
      // 华为的 speed 常是 m/s；大于 40 时按 km/h 处理
      speed: speed == null ? undefined : speed > 40 ? speed / 3.6 : speed,
      distance: num(point, DIST_KEYS) ?? undefined,
    });
  }
  return records;
}

export interface HuaweiActivity {
  name: string;
  parsed: ParsedFit;
}

export interface HuaweiParseResult {
  activities: HuaweiActivity[];
  /** 认出来的轨迹数组数量 vs 有 GPS 点的数量，用于给出准确的提示 */
  found: number;
  skipped: number;
}

/* ------------------------------------------------------------------ */
/* 新版格式：detailData 字符串（tp=lbs;... 分号分隔）                  */
/* ------------------------------------------------------------------ */

/** 华为 summaryData.sportType → FIT sport id，取自官方 Sport type 对照表。 */
const HUAWEI_SPORT_OF: Record<number, number> = {
  258: 1, // 户外跑步
  264: 1, // 室内跑步
  280: 1, // 越野跑
  259: 2, // 户外骑行
  265: 2, // 室内单车
  141: 2, // 动感单车
  260: 17, // 登山
};

interface DetailSeries {
  points: Array<{ t: number; lat: number; lon: number }>;
  altis: Map<number, number>;
  hrs: Map<number, number>;
}

function readDetailSeries(detail: string): DetailSeries | null {
  const points: DetailSeries['points'] = [];
  const altis = new Map<number, number>();
  const hrs = new Map<number, number>();
  let sawLbs = false;
  for (const raw of detail.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('tp=')) continue;
    const bag: Record<string, string> = {};
    for (const seg of line.split(';')) {
      const eq = seg.indexOf('=');
      if (eq > 0) bag[seg.slice(0, eq)] = seg.slice(eq + 1);
    }
    if (bag.tp === 'lbs') {
      const t = Number(bag.t);
      const lat = Number(bag.lat);
      const lon = Number(bag.lon);
      if (Number.isFinite(t) && Number.isFinite(lat) && Number.isFinite(lon)) {
        points.push({ t, lat, lon });
        sawLbs = true;
      }
    } else if (bag.tp === 'alti') {
      const k = Number(bag.k);
      const v = Number(bag.v);
      if (Number.isFinite(k) && Number.isFinite(v)) altis.set(Math.round(k), v);
    } else if (bag.tp === 'h-r') {
      const k = Number(bag.k);
      const v = Number(bag.v);
      if (Number.isFinite(k) && Number.isFinite(v) && v > 0 && v < 250) hrs.set(Math.round(k), v);
    }
  }
  return sawLbs ? { points, altis, hrs } : null;
}

/** 在有序时间戳里找离 tMs 最近的一项，超出容差返回 undefined。 */
function nearestValue(keys: number[], map: Map<number, number>, tMs: number, windowMs: number): number | undefined {
  if (!keys.length) return undefined;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < tMs) lo = mid + 1;
    else hi = mid;
  }
  let bestKey: number | undefined;
  let bestDelta = Infinity;
  for (const idx of lo > 0 ? [lo - 1, lo] : [0]) {
    if (idx >= keys.length) continue;
    const delta = Math.abs(keys[idx] - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestKey = keys[idx];
    }
  }
  return bestKey !== undefined && bestDelta <= windowMs ? map.get(bestKey) : undefined;
}

/** 华为定位漂移会把点甩到极点（实测出现过 lat=90, lon=-80），必须过滤。 */
const MAX_PLAUSIBLE_SPEED = 56; // m/s ≈ 200 km/h，骑行不可能

function detailToRecords(series: DetailSeries): FitRecord[] {
  const points = series.points
    .filter((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)
    .sort((a, b) => a.t - b.t);
  const altKeys = Array.from(series.altis.keys()).sort((a, b) => a - b);
  const hrKeys = Array.from(series.hrs.keys()).sort((a, b) => a - b);

  const records: FitRecord[] = [];
  let lastT = 0;
  let last: { lat: number; lon: number } | null = null;
  for (const p of points) {
    if (lastT && p.t - lastT < 0.5) continue; // 同一秒的重复点
    // 飞点过滤：与上一点相邻但距离在物理上不可能（华为定位漂移）
    if (last && lastT > 0) {
      const dt = Math.max(1, p.t - lastT);
      if (haversine(last.lat, last.lon, p.lat, p.lon) / dt > MAX_PLAUSIBLE_SPEED) continue;
    }
    lastT = p.t;
    last = { lat: p.lat, lon: p.lon };
    const timestamp = stamp(p.t);
    const tMs = timestamp || 0;
    records.push({
      timestamp: timestamp || undefined,
      lat: p.lat,
      lon: p.lon,
      // lbs 自带的 alt 全是 0，真实海拔在 alti 行（约 5 秒一条），就近合并
      altitude: nearestValue(altKeys, series.altis, tMs, 60_000),
      heartRate: nearestValue(hrKeys, series.hrs, tMs, 30_000),
    });
  }
  return records;
}

function sportNameOf(sport: number): string {
  if (sport === 1) return '跑步';
  if (sport === 2) return '骑行';
  if (sport === 11) return '步行';
  if (sport === 17) return '徒步';
  if (sport === 5) return '游泳';
  return '运动';
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseHuaweiDetailRecord(record: Bag): HuaweiActivity | null {
  const detail = record.detailData;
  if (typeof detail !== 'string' || !detail.includes('tp=')) return null;
  const series = readDetailSeries(detail);
  if (!series) return null;
  const records = detailToRecords(series);
  if (records.length < 2) return null;

  const summary = typeof record.summaryData === 'string'
    ? (() => {
        try {
          return JSON.parse(record.summaryData) as unknown;
        } catch {
          return null;
        }
      })()
    : record.summaryData;
  const bag = isBag(summary) ? summary : {};

  const start = num(record, ['startTime']) ?? records[0].timestamp ?? 0;
  const end = num(record, ['endTime']) ?? records[records.length - 1].timestamp ?? start;
  const elapsed = start && end > start ? Math.round((end - start) / 1000) : records.length;
  const declared = num(bag, ['totalDistance']);
  let distance = declared ?? 0;
  if (!distance) {
    for (let i = 1; i < records.length; i += 1) {
      distance += haversine(records[i - 1].lat!, records[i - 1].lon!, records[i].lat!, records[i].lon!);
    }
  }
  const avgSpeed = elapsed > 0 ? distance / elapsed : 0;
  const sportRaw = num(bag, SPORT_KEYS);
  const mapped = sportRaw != null ? HUAWEI_SPORT_OF[sportRaw] : undefined;
  const sport = mapped ?? guessSport(bag, avgSpeed);

  // 官方统计字段：creepingWave/mTotalDescent 单位分米，totalCalories 单位卡
  const alts = records.map((r) => r.altitude).filter((v): v is number => typeof v === 'number');
  const hrs = records.map((r) => r.heartRate).filter((v): v is number => typeof v === 'number');
  const officialAscent = num(bag, ['creepingWave']);
  const officialDescent = num(bag, ['mTotalDescent']);
  const climbFromSeries = () => {
    let gain = 0;
    for (let i = 1; i < alts.length; i += 1) {
      const delta = alts[i] - alts[i - 1];
      if (delta > 0.4) gain += delta;
    }
    return Math.round(gain) || undefined;
  };

  const totalTimeMs = num(bag, ['totalTime']);
  const timerTime = totalTimeMs != null && totalTimeMs > 0 && totalTimeMs <= elapsed * 1.05 * 1000
    ? Math.round(totalTimeMs / 1000)
    : elapsed;

  const session: FitSession = {
    startTime: start || undefined,
    elapsedTime: elapsed,
    timerTime,
    distance,
    calories: (() => {
      const cal = num(bag, ['totalCalories']);
      return cal != null && cal > 0 ? cal / 1000 : undefined;
    })(),
    ascent: officialAscent != null && officialAscent > 0 ? Math.round(officialAscent / 10) : climbFromSeries(),
    descent: officialDescent != null && officialDescent > 0 ? Math.round(officialDescent / 10) : undefined,
    avgHeartRate: num(bag, ['avgHeartRate']) ?? (hrs.length ? Math.round(hrs.reduce((s, v) => s + v, 0) / hrs.length) : undefined),
    maxHeartRate: num(bag, ['maxHeartRate']) ?? (hrs.length ? Math.max(...hrs) : undefined),
    avgSpeed: avgSpeed || undefined,
    maxSpeed: undefined,
    maxAltitude: num(bag, ['mMaxAlti']) ?? (alts.length ? Math.max(...alts) : undefined),
    avgAltitude: alts.length ? alts.reduce((s, v) => s + v, 0) / alts.length : undefined,
    sport,
  };

  const name = start ? `${sportNameOf(sport)} ${formatStamp(start)}` : sportNameOf(sport);
  return {
    name,
    parsed: {
      sourceType: 'gpx',
      hasTimestamps: records.some((r) => r.timestamp != null),
      sportHint: session.sport,
      records,
      sessions: [session],
      laps: [],
    },
  };
}

/** 递归找出所有带 detailData 字符串的运动记录（新版导出）。 */
function collectDetailRecords(value: unknown, out: Bag[], seen: Set<unknown>, depth = 0): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectDetailRecords(item, out, seen, depth + 1);
    return;
  }
  if (!isBag(value) || seen.has(value)) return;
  seen.add(value);
  const detail = value.detailData;
  if (typeof detail === 'string' && detail.includes('tp=lbs')) {
    out.push(value);
    return;
  }
  for (const child of Object.values(value)) collectDetailRecords(child, out, seen, depth + 1);
}

export function parseHuaweiJson(text: string): HuaweiParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('这个 JSON 解析失败，请确认是华为导出的 motion path detail data.json');
  }

  // 新版导出：先认 detailData 字符串格式（tp=lbs;...），这是当前
  // 华为「运动记录详情」的主格式；旧版结构化点数组作为回退路径。
  const detailBags: Bag[] = [];
  collectDetailRecords(root, detailBags, new Set());
  if (detailBags.length) {
    const activities: HuaweiActivity[] = [];
    let skipped = 0;
    for (const record of detailBags) {
      const activity = parseHuaweiDetailRecord(record);
      if (activity) activities.push(activity);
      else skipped += 1;
    }
    if (activities.length) {
      return { activities, found: activities.length, skipped };
    }
    // 全都认不出来时继续走旧版路径，拿更贴切的报错信息
  }

  const found: Found[] = [];
  collect(root, found, new Set());

  const activities: HuaweiActivity[] = [];
  let skipped = 0;
  for (const item of found) {
    const records = toRecords(item.points);
    if (records.length < 2) {
      skipped += 1;
      continue;
    }
    const first = records[0];
    const last = records[records.length - 1];
    const start = first.timestamp ?? num(item.holder, TIME_KEYS) ?? 0;
    const end = last.timestamp ?? num(item.holder, ['endTime']) ?? start;
    const elapsed = start && end > start ? Math.round((end - start) / 1000) : records.length;
    const declared = num(item.holder, ['totalDistance', 'distance', 'totalMileage']);
    let distance = declared ?? 0;
    if (!distance) {
      for (let i = 1; i < records.length; i += 1) {
        distance += haversine(records[i - 1].lat!, records[i - 1].lon!, records[i].lat!, records[i].lon!);
      }
    }
    const avgSpeed = elapsed > 0 ? distance / elapsed : 0;
    const hrs = records.map((r) => r.heartRate).filter((v): v is number => typeof v === 'number');
    const alts = records.map((r) => r.altitude).filter((v): v is number => typeof v === 'number');
    let ascent = 0;
    for (let i = 1; i < alts.length; i += 1) {
      const delta = alts[i] - alts[i - 1];
      if (delta > 0) ascent += delta;
    }
    let maxSpeed = 0;
    for (const record of records) {
      const speed = record.speed ?? 0;
      if (speed > maxSpeed) maxSpeed = speed;
    }

    const session: FitSession = {
      startTime: start || undefined,
      elapsedTime: elapsed,
      timerTime: elapsed,
      distance,
      calories: num(item.holder, ['calorie', 'calories', 'totalCalorie']) ?? undefined,
      ascent: Math.round(ascent) || undefined,
      avgHeartRate: hrs.length ? Math.round(hrs.reduce((s, v) => s + v, 0) / hrs.length) : undefined,
      maxHeartRate: hrs.length ? Math.max(...hrs) : undefined,
      avgSpeed: avgSpeed || undefined,
      maxSpeed: maxSpeed || undefined,
      maxAltitude: alts.length ? Math.max(...alts) : undefined,
      sport: guessSport(item.holder, avgSpeed),
    };

    const name = labelOf(item.holder, NAME_KEYS) ?? '';
    activities.push({
      name,
      parsed: {
        sourceType: 'gpx',
        hasTimestamps: records.some((r) => r.timestamp != null),
        sportHint: session.sport,
        records,
        sessions: [session],
        laps: [],
      },
    });
  }

  if (!activities.length) {
    throw new Error(found.length
      ? '找到了轨迹数据，但没有可用的 GPS 点（可能是室内运动）'
      : '没在 JSON 里找到运动轨迹，请确认选的是 motion path detail data.json');
  }
  return { activities, found: found.length, skipped };
}
