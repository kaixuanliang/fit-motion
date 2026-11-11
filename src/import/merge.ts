/**
 * 合并路线：把被切开的几段拼成一条，落成一条独立记录。
 *
 * 规则对齐华为运动健康「合并运动记录」：
 * - 只支持跑步、户外骑行，且必须是同一种运动；
 * - 按开始时间先后拼接，段间空档不计入运动时长；
 * - 距离、爬升、卡路里累加，平均速度用总距离 / 运动时长。
 * 原记录保留不动，新记录标 src='merged' 并记下来源，列表里能看出是合并来的。
 */

import type { Activity } from '../fit/activity';
import { mergeToParsed } from '../export/track';
import { allMeta, getMeta, loadActivity, saveParsed } from '../store/repo';
import { hashBytes } from '../store/fingerprint';
import type { ActivityMeta } from '../store/types';

export interface MergeOutcome {
  status: 'added' | 'duplicate-file' | 'no-gps' | 'error';
  id?: string;
  name: string;
  /** 合并后的总距离（米，含重复路线） */
  distanceM: number;
  /** 合并后的运动时长（秒，含重复路线） */
  durationSec: number;
  /** 参与合并的段数 */
  count: number;
  /** 跨了几个自然日 */
  days: number;
  /** 其中的重复路线段数（几何已去重） */
  repeated: number;
  message?: string;
}

/** 可合并的运动：和华为一致，只放跑步与骑行。 */
const MERGEABLE = new Set([1, 2, 21]);

export function mergeableSport(sport: number | undefined): boolean {
  return sport != null && MERGEABLE.has(sport);
}

export function sportLabel(sport: number | undefined): string {
  if (sport === 1) return '跑步';
  if (sport === 21) return '电助力骑行';
  if (sport === 2) return '骑行';
  return '运动';
}

/** 合并列表的数据源：最近的记录优先（华为也是一屏近期记录）。 */
export async function mergeCandidates(limit = 150): Promise<ActivityMeta[]> {
  const rows = await allMeta();
  return rows
    .filter((row) => !row.deleted)
    .sort((a, b) => b.start - a.start)
    .slice(0, limit);
}

export async function mergeRecords(ids: string[]): Promise<MergeOutcome> {
  const unique = Array.from(new Set(ids));
  if (unique.length < 2) throw new Error('至少选择两条记录');

  const metas: ActivityMeta[] = [];
  for (const id of unique) {
    const meta = await getMeta(id);
    if (meta) metas.push(meta);
  }
  if (metas.length < 2) throw new Error('选中的记录已被删除');

  metas.sort((a, b) => a.start - b.start);

  const activities: Activity[] = [];
  for (const meta of metas) {
    try {
      activities.push(await loadActivity(meta.id));
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      throw new Error(`读取「${meta.name}」的轨迹失败：${reason}`);
    }
  }

  // 早期导入的记录可能没写运动类型（sport=0），这时按「未知类型」放行：
  // 用户已经手动选了这几段，没必要因为缺元数据把合并挡死。
  const sports = activities.map((activity, index) => activity.sport || metas[index]?.sport || 0);
  const known = Array.from(new Set(sports.filter((value) => value > 0)));
  if (known.length > 1) {
    throw new Error(`只能合并同一种运动的记录（${known.map((value) => sportLabel(value)).join(' / ')}）`);
  }
  const sport = known[0] ?? 0;
  if (sport > 0 && !mergeableSport(sport)) {
    throw new Error(`只支持合并跑步与骑行记录（与华为运动健康一致），当前是${sportLabel(sport)}`);
  }

  const parsed = mergeToParsed(activities);
  const count = activities.length;
  const trip = parsed.trip;
  const days = trip ? new Set(trip.legs.map((leg) => new Date(leg.start).toDateString())).size : 1;
  const repeated = trip?.repeated ?? 0;
  const label = sport > 0 ? sportLabel(sport) : '运动';
  let name: string;
  if (repeated > 0 && repeated === count - 1) {
    // 全部是同一路线：体现「刷了几次」比「几段」更有意义
    name = `${label}同一路线 · ${count} 次`;
  } else if (days > 1) {
    name = `多日${label} · ${days} 天 ${count} 段`;
  } else {
    name = `合并${label} · ${count} 段`;
  }
  const key = `merge|${unique.sort().join(',')}|${count}`;
  const hash = await hashBytes(new TextEncoder().encode(key).buffer as ArrayBuffer);
  const result = await saveParsed({
    parsed,
    fileName: `${name}.tcx`,
    src: 'merged',
    bytes: new ArrayBuffer(0),
    keepFile: false,
    name,
    hashOverride: hash,
    skipDedupe: true,
    mergedFrom: metas.map((meta) => meta.id),
  }).catch((error: unknown) => {
    throw new Error(`写入合并记录失败：${error instanceof Error ? error.message : '未知错误'}`);
  });

  return {
    status: result.status === 'added' ? 'added'
      : result.status === 'duplicate-file' ? 'duplicate-file'
        : result.status === 'no-gps' ? 'no-gps' : 'error',
    id: result.id,
    name,
    distanceM: trip?.totalMeters ?? parsed.sessions[0]?.distance ?? 0,
    durationSec: trip?.totalMovingSec ?? parsed.sessions[0]?.timerTime ?? 0,
    count,
    days,
    repeated,
    message: result.message,
  };
}
