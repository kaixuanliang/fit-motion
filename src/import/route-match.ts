/**
 * 合并行程前的几何判定：两段轨迹是不是同一条路线、能不能首尾衔接。
 *
 * 只做几何比较，不碰统计数据。要点：
 * - 重复路线用「覆盖率」判定：把候选段采样后逐点查主路线附近是否有轨迹
 *   （200m 栅格索引，避开 O(n²)），双向覆盖率都过阈值才算同一条路线。
 *   往返、同路线多刷、GPS 抖动都能命中。
 * - 衔接判定只看「上一段末点 → 下一段首点」的直线距离，超出阈值就不允许
 *   合并 —— 否则地图上会出现一条横穿地图的直线，第一视角还会瞬移。
 */

import { haversine } from '../geo';
import type { RoutePoint } from '../fit/activity';

/** 同一条路线的采样点命中半径：给 GPS 漂移与并线留余量。 */
const MATCH_TOLERANCE_M = 200;
/** 双向覆盖率阈值：85% 的点落在对方路线附近即视为同一条路。 */
const MATCH_COVERAGE = 0.85;
/** 主路线索引栅格边长（米）。 */
const GRID_CELL_M = 220;
/** 采样上限：再多也只是重复比较同一段路。 */
const MAX_SAMPLES = 600;

export interface RouteMatchOptions {
  toleranceM?: number;
  coverage?: number;
}

interface Sample {
  x: number;
  y: number;
}

/** 等距圆柱投影到局部米制平面：只用于比较距离，不需要精度。 */
function toXY(points: RoutePoint[], originLat: number): Sample[] {
  const cos = Math.cos((originLat * Math.PI) / 180);
  return points.map((point) => ({ x: point.lon * 111320 * cos, y: point.lat * 110540 }));
}

function sample(points: RoutePoint[], limit: number): RoutePoint[] {
  if (points.length <= limit) return points;
  const step = points.length / limit;
  const out: RoutePoint[] = [];
  for (let i = 0; i < limit; i += 1) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function gridKey(x: number, y: number): string {
  return `${Math.floor(x / GRID_CELL_M)}|${Math.floor(y / GRID_CELL_M)}`;
}

/** 建一条路线的栅格索引：cell → 落在其中的采样点坐标。 */
function buildIndex(points: RoutePoint[], originLat: number): Map<string, Sample[]> {
  const index = new Map<string, Sample[]>();
  for (const point of toXY(points, originLat)) {
    const key = gridKey(point.x, point.y);
    const bucket = index.get(key);
    if (bucket) bucket.push(point);
    else index.set(key, [point]);
  }
  return index;
}

/** 候选采样点里，有多少落在索引路线附近（按 point 数量占比）。 */
function coverageOf(index: Map<string, Sample[]>, points: Sample[], toleranceM: number): number {
  if (!points.length) return 0;
  let hit = 0;
  const limit = toleranceM * toleranceM;
  for (const point of points) {
    const cx = Math.floor(point.x / GRID_CELL_M);
    const cy = Math.floor(point.y / GRID_CELL_M);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx += 1) {
      for (let dy = -1; dy <= 1 && !found; dy += 1) {
        const bucket = index.get(`${cx + dx}|${cy + dy}`);
        if (!bucket) continue;
        for (const other of bucket) {
          const ddx = other.x - point.x;
          const ddy = other.y - point.y;
          if (ddx * ddx + ddy * ddy <= limit) {
            found = true;
            break;
          }
        }
      }
    }
    if (found) hit += 1;
  }
  return hit / points.length;
}

/**
 * 两段轨迹是不是同一条路线（含往返、同路线多刷）。
 *
 * 双向覆盖率都过阈值才算：只测一个方向时，「短段落在长段内」会被误判成
 * 同一条路线（例如只骑了半程）。
 */
export function sameRoute(a: RoutePoint[], b: RoutePoint[], options: RouteMatchOptions = {}): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const toleranceM = options.toleranceM ?? MATCH_TOLERANCE_M;
  const threshold = options.coverage ?? MATCH_COVERAGE;
  const originLat = (a[0].lat + b[0].lat) / 2;
  const sa = sample(a, MAX_SAMPLES);
  const sb = sample(b, MAX_SAMPLES);
  const indexA = buildIndex(sa, originLat);
  const indexB = buildIndex(sb, originLat);
  const forward = coverageOf(indexA, toXY(sb, originLat), toleranceM);
  if (forward < threshold) return false;
  const backward = coverageOf(indexB, toXY(sa, originLat), toleranceM);
  return backward >= threshold;
}

/** 上一段末点到下一段首点的距离（米）。 */
export function linkDistance(previous: RoutePoint[], next: RoutePoint[]): number {
  if (!previous.length || !next.length) return 0;
  const tail = previous[previous.length - 1];
  const head = next[0];
  return haversine(tail.lat, tail.lon, head.lat, head.lon);
}

/**
 * 允许的衔接距离：基础 2km，长途行程按段长放宽（单段越长，住得离终点远
 * 一点也合理），上限 8km。超出这个范围就不是「接着骑」，而是两次独立出行。
 */
export function linkLimitFor(previousMeters: number, nextMeters: number): number {
  const base = 2000;
  const relative = Math.max(previousMeters, nextMeters) * 0.02;
  return Math.round(Math.min(8000, Math.max(base, relative)));
}
