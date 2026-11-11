/**
 * 年度骑行回顾的数据聚合。
 *
 * 只读库、不发网络请求。元数据（ActivityMeta）承担绝大部分统计 —— 几百字节
 * 一条，全年几百条也只是毫秒级；轨迹只在两处按需加载：
 * - 多日合并记录：从 trip.legs 数「真实骑行天数」（meta.start 只有一天）；
 * - 常骑路线聚合：sameRoute 几何判定必须看点。
 */

import { listPage } from '../store/repo';
import { loadActivity } from '../store/repo';
import type { ActivityMeta } from '../store/types';
import { sameRoute } from '../import/route-match';
import type { Activity } from '../fit/activity';

export interface TopRoute {
  /** 代表名称：组内最常用名（几何聚合时取里程最大的那条） */
  name: string;
  count: number;
  /** Σ meta.distance（组内每次真实总里程） */
  totalMeters: number;
  /** 组内最快单次均速 m/s */
  bestAvgSpeed: number;
  /** 组内最高海拔 */
  maxAltM: number | null;
  /** 组内最长一次的日期（epoch ms），无则 0 */
  lastRideAt: number;
}

export interface LongestRide {
  id: string;
  name: string;
  date: number;
  meters: number;
  movingSec: number;
  /** 全程跨度（含住宿/休息），秒 */
  spanSec: number;
  days: number;
  /** 迷你路线图用的抽稀点（lat/lon），无轨迹时为空 */
  sketch: Array<{ lat: number; lon: number }>;
  place: string;
}

export interface YearTitle {
  emoji: string;
  name: string;
  desc: string;
}

export interface YearReview {
  year: number;
  /** Σ meta.distance */
  totalMeters: number;
  /** 骑行天数：普通记录按开始日期去重，多日合并记录按 trip.legs 日期去重 */
  rideDays: number;
  rides: number;
  avgPerRideM: number;
  /** Σ meta.duration（运动时长，不含休息） */
  movingSec: number;
  climbM: number;
  maxAltM: number | null;
  /** 12 个月的 Σ meta.distance（下标 0 = 1 月） */
  months: number[];
  longest: LongestRide | null;
  /** 年度最高速度（km/h）与其日期 */
  maxSpeedKmh: number;
  maxSpeedAt: number;
  /** 最快单次均速（km/h） */
  bestAvgKmh: number;
  maxHr: number | null;
  topRoutes: TopRoute[];
  title: YearTitle;
}

const PAGE = 500;
/** 几何聚合最多加载的轨迹条数：保护低端机（每条轨迹几 MB）。 */
const GEOMETRY_LOAD_LIMIT = 60;

async function metasOfYear(year: number): Promise<ActivityMeta[]> {
  const out: ActivityMeta[] = [];
  let before: number | null = null;
  for (;;) {
    const page = await listPage({ year, src: 'all', limit: PAGE, order: 'desc', before });
    out.push(...page.items);
    if (page.next == null) return out;
    before = page.next;
  }
}

/** 抽稀到 ≤max 点，保住首尾。 */
function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr.slice();
  const stride = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function bboxOf(points: Array<{ lat: number; lon: number }>): {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
} {
  let minLat = 90; let maxLat = -90; let minLon = 180; let maxLon = -180;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/** 两轨迹包围盒的间隔（纬度差折算米），用于 sameRoute 前的廉价预筛。 */
function bboxGapM(a: ReturnType<typeof bboxOf>, b: ReturnType<typeof bboxOf>): number {
  const dLat = Math.max(a.minLat - b.maxLat, b.minLat - a.maxLat, 0);
  const dLon = Math.max(a.minLon - b.maxLon, b.minLon - a.maxLon, 0);
  return Math.hypot(dLat * 111_000, dLon * 111_000 * Math.cos(((a.minLat + a.maxLat) / 2) * Math.PI / 180));
}

/** 称号分档：按总里程 + 最长单骑 + 爬升 + 速度依次匹配。 */
function pickTitle(review: Omit<YearReview, 'title'>): YearTitle {
  const km = review.totalMeters / 1000;
  const longestKm = (review.longest?.meters ?? 0) / 1000;
  if (km >= 3000 && longestKm >= 500) {
    return { emoji: '🚴', name: '长途远征者', desc: `年度里程突破 ${Math.round(km / 500) * 500} 公里<br>并且完成了一次 500 公里以上的远征` };
  }
  if (review.climbM >= 10_000) {
    return { emoji: '⛰️', name: '巅峰攀登者', desc: `年度总爬升 ${Math.round(review.climbM / 1000)} 公里高度<br>足以从山脚登上两座泰山` };
  }
  if (review.rideDays >= 100) {
    return { emoji: '📅', name: '百日轮不停', desc: `今年有 ${review.rideDays} 天在车上<br>超过三分之二的日子与你同行` };
  }
  if (review.maxSpeedKmh >= 60) {
    return { emoji: '💨', name: '风驰骑士', desc: `年度极速 ${review.maxSpeedKmh.toFixed(1)} km/h<br>城市快速路上的风都追不上你` };
  }
  if (km >= 1000) {
    return { emoji: '🛣️', name: '千公里骑士', desc: `年度里程 ${Math.round(km)} 公里<br>车轮碾过的路连成一条省道` };
  }
  if (km >= 300) {
    return { emoji: '🌆', name: '城市漫游者', desc: `年度里程 ${Math.round(km)} 公里<br>把熟悉的街道骑成了自己的地图` };
  }
  return { emoji: '✨', name: '启程之星', desc: `今年骑了 ${Math.round(km)} 公里<br>每一段路都是新的开始` };
}

/** 里程的趣味类比。 */
function distanceAnalogy(km: number): string {
  if (km >= 8000) return '相当于从北京一路骑到巴黎';
  if (km >= 1900) return '相当于从北京骑到广州，再骑回石家庄';
  if (km >= 500) return '相当于沿 G107 从北京骑到郑州';
  if (km >= 65) return `相当于绕北京四环 ${Math.max(1, Math.round(km / 65))} 圈`;
  return '每一段路都算数';
}

export { distanceAnalogy };

export async function computeYearReview(year: number): Promise<YearReview | null> {
  const metas = await metasOfYear(year);
  if (metas.length === 0) return null;

  const months = new Array<number>(12).fill(0);
  let totalMeters = 0;
  let movingSec = 0;
  let climbM = 0;
  let maxAltM: number | null = null;
  let maxSpeedKmh = 0;
  let maxSpeedAt = 0;
  let bestAvgKmh = 0;
  let maxHr: number | null = null;

  // 天数：先按「开始日期」去重收集，多日记录再单独补 leg 日期。
  // 应用内合并的记录有 mergedFrom；外部导入的多日 FIT 没有，但运动时长
  // 一定跨天（≥20h），用时长兜底检出，避免全年天数被少算。
  const dayKeys = new Set<string>();
  const mergedMetas = metas.filter((meta) =>
    (meta.mergedFrom?.length ?? 0) > 0 || meta.duration >= 20 * 3600);

  let longestMeta: ActivityMeta | null = null;
  for (const meta of metas) {
    totalMeters += meta.distance;
    movingSec += meta.duration;
    climbM += meta.climb || 0;
    if (meta.maxAlt != null && (maxAltM == null || meta.maxAlt > maxAltM)) maxAltM = meta.maxAlt;
    if (meta.maxSpeed > maxSpeedKmh / 3.6) {
      maxSpeedKmh = meta.maxSpeed * 3.6;
      maxSpeedAt = meta.start;
    }
    if (meta.avgSpeed * 3.6 > bestAvgKmh) bestAvgKmh = meta.avgSpeed * 3.6;
    if (meta.maxHr != null && (maxHr == null || meta.maxHr > maxHr)) maxHr = meta.maxHr;
    const date = new Date(meta.start);
    months[date.getMonth()] += meta.distance;
    dayKeys.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
    if (!longestMeta || meta.distance > longestMeta.distance) longestMeta = meta;
  }

  // 多日合并记录：加载轨迹拿 trip.legs 的分段日期，补进天数集合
  for (const meta of mergedMetas.slice(0, 24)) {
    try {
      const activity = await loadActivity(meta.id);
      const legDates = activity.trip?.legs ?? [];
      for (const leg of legDates) {
        const d = new Date(leg.start);
        dayKeys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
      }
      if (activity.trip?.legs.length) {
        dayKeys.add(`${new Date(meta.start).getFullYear()}-${new Date(meta.start).getMonth()}-${new Date(meta.start).getDate()}`);
      }
    } catch {
      // 轨迹已被清理：退回开始日期（已在集合里）
    }
  }

  // 最长单骑：加载轨迹拿行程信息 + 迷你路线点
  let longest: LongestRide | null = null;
  if (longestMeta) {
    let sketch: LongestRide['sketch'] = [];
    let spanSec = longestMeta.duration;
    let days = 1;
    try {
      const activity = await loadActivity(longestMeta.id);
      sketch = downsample(activity.points, 120).map((p) => ({ lat: p.lat, lon: p.lon }));
      spanSec = Math.max(activity.elapsedSec || longestMeta.duration, longestMeta.duration);
      const legDates = activity.trip?.legs ?? [];
      const legDays = new Set(legDates.map((leg) => new Date(leg.start).toDateString()));
      days = Math.max(1, legDays.size || Math.ceil(spanSec / 86400));
    } catch {
      // 无轨迹：只给数字
    }
    longest = {
      id: longestMeta.id,
      name: longestMeta.name,
      date: longestMeta.start,
      meters: longestMeta.distance,
      movingSec: longestMeta.duration,
      spanSec,
      days,
      sketch,
      place: '',
    };
  }

  // 常骑路线：同名分组（零成本）+ 限量几何聚合（sameRoute）
  const topRoutes = await topRoutesOf(metas, longestMeta?.id ?? '');

  const base: Omit<YearReview, 'title'> = {
    year,
    totalMeters,
    rideDays: dayKeys.size,
    rides: metas.length,
    avgPerRideM: totalMeters / metas.length,
    movingSec,
    climbM,
    maxAltM,
    months,
    longest,
    maxSpeedKmh,
    maxSpeedAt,
    bestAvgKmh,
    maxHr,
    topRoutes,
  };
  return { ...base, title: pickTitle(base) };
}

interface RouteGroup {
  members: ActivityMeta[];
  name: string;
}

async function topRoutesOf(metas: ActivityMeta[], skipId: string): Promise<TopRoute[]> {
  if (metas.length < 2) return [];
  // 1) 同名分组（不加载轨迹，零成本）：同名的必然先归一组
  const byName = new Map<string, ActivityMeta[]>();
  for (const meta of metas) {
    const key = meta.name.trim();
    if (!key) continue;
    const bucket = byName.get(key);
    if (bucket) bucket.push(meta);
    else byName.set(key, [meta]);
  }
  const groups: RouteGroup[] = [];
  const grouped = new Set<string>();
  for (const [name, members] of byName) {
    if (members.length < 2) continue;
    for (const meta of members) grouped.add(meta.id);
    groups.push({ members, name });
  }

  // 2) 几何聚合：只看最长的 N 条（跨名同名/无名路线的重复也能命中）
  const candidates = metas
    .filter((meta) => meta.id !== skipId && meta.points >= 40)
    .sort((a, b) => b.distance - a.distance)
    .slice(0, GEOMETRY_LOAD_LIMIT);
  const loaded = new Map<string, { points: Array<{ lat: number; lon: number }>; box: ReturnType<typeof bboxOf> }>();
  for (const meta of candidates) {
    try {
      const activity = await loadActivity(meta.id);
      if (activity.points.length < 40) continue;
      const points = downsample(activity.points, 300).map((p) => ({ lat: p.lat, lon: p.lon }));
      loaded.set(meta.id, { points, box: bboxOf(points) });
    } catch {
      // 轨迹缺失，跳过
    }
  }
  const geoGroups: RouteGroup[] = [];
  const geoAssigned = new Set<string>();
  for (const [id, entry] of loaded) {
    if (geoAssigned.has(id)) continue;
    const members: ActivityMeta[] = [];
    const memberMeta = candidates.find((meta) => meta.id === id);
    if (!memberMeta) continue;
    members.push(memberMeta);
    geoAssigned.add(id);
    for (const [otherId, other] of loaded) {
      if (geoAssigned.has(otherId) || otherId === id) continue;
      if (bboxGapM(entry.box, other.box) > 2000) continue;
      // sameRoute 只读 lat/lon；几何判定用不到 t/distance，这里按形状比较
      if (!sameRoute(entry.points as unknown as Parameters<typeof sameRoute>[0], other.points as unknown as Parameters<typeof sameRoute>[0])) continue;
      const otherMeta = candidates.find((meta) => meta.id === otherId);
      if (otherMeta) members.push(otherMeta);
      geoAssigned.add(otherId);
    }
    if (members.length >= 2) {
      const rep = members.reduce((a, b) => (b.distance > a.distance ? b : a));
      geoGroups.push({ members, name: rep.name });
    }
  }
  // 名字组并入几何组：代表路线在几何组里的成员并集去重
  for (const geo of geoGroups) {
    const geoIds = new Set(geo.members.map((meta) => meta.id));
    const absorbed: RouteGroup[] = [];
    for (const named of groups) {
      const overlap = named.members.some((meta) => geoIds.has(meta.id));
      if (overlap) absorbed.push(named);
    }
    for (const named of absorbed) {
      for (const meta of named.members) {
        if (!geoIds.has(meta.id)) {
          geo.members.push(meta);
          geoIds.add(meta.id);
        }
        grouped.add(meta.id);
      }
    }
  }
  const all = [...geoGroups, ...groups.filter((g) => !g.members.every((meta) => grouped.has(meta.id)))];

  // 3) 汇总极值，按次数排序取 Top 3
  const routes: TopRoute[] = all.map((group) => {
    const ids = new Set(group.members.map((meta) => meta.id));
    const members = metas.filter((meta) => ids.has(meta.id));
    const maxAlt = members.reduce<number | null>((acc, meta) => {
      if (meta.maxAlt == null) return acc;
      return acc == null || meta.maxAlt > acc ? meta.maxAlt : acc;
    }, null);
    const best = members.reduce((acc, meta) => Math.max(acc, meta.avgSpeed), 0);
    const last = members.reduce((acc, meta) => Math.max(acc, meta.start), 0);
    return {
      name: group.name,
      count: members.length,
      totalMeters: members.reduce((total, meta) => total + meta.distance, 0),
      bestAvgSpeed: best,
      maxAltM: maxAlt,
      lastRideAt: last,
    };
  }).filter((route) => route.count >= 2)
    .sort((a, b) => b.count - a.count || b.totalMeters - a.totalMeters)
    .slice(0, 3);
  return routes;
}

/** 最长单骑地点名（创作页同款 place 字段在 meta 里没有，单独补一次）。 */
export async function fillPlace(longest: LongestRide): Promise<void> {
  if (!longest || longest.place) return;
  try {
    const activity: Activity = await loadActivity(longest.id);
    longest.place = activity.place || activity.city || '';
  } catch {
    // 忽略
  }
}
