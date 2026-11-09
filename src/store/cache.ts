/**
 * 本地轨迹的 LRU 缓存。
 *
 * 云端已经有正文了，本地留轨迹只为了「点开就能看」。所以给个预算：
 * 超过就把最久没打开的那几条删掉 —— 只删轨迹，索引和缩略图都留着，
 * 列表该有的样子一点不变，点开时再从云端拉回来。
 */

import { allMeta, deleteTrack, hasTrack, trackBytes } from './repo';
import type { ActivityMeta } from './types';

export const CACHE_BUDGET = 500 * 1024 * 1024;
const MAX_EVICT_PER_RUN = 40;

export interface TrimResult {
  evicted: number;
  freed: number;
  kept: number;
}

function backed(meta: ActivityMeta): boolean {
  return Object.keys(meta.where ?? {}).length > 0;
}

export async function cacheFootprint(): Promise<{ cached: number; bytes: number }> {
  const rows = (await allMeta()).filter((row) => !row.deleted);
  let cached = 0;
  let bytes = 0;
  for (const row of rows) {
    if (!(await hasTrack(row.id))) continue;
    cached += 1;
    bytes += trackBytes(row);
  }
  return { cached, bytes };
}

export async function trimCache(budget = CACHE_BUDGET): Promise<TrimResult> {
  const rows = (await allMeta()).filter((row) => !row.deleted);
  const candidates: ActivityMeta[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (!(await hasTrack(row.id))) continue;
    candidates.push(row);
    bytes += trackBytes(row);
  }
  if (bytes <= budget) return { evicted: 0, freed: 0, kept: candidates.length };

  // 已备份的才敢删；只存在本地的记录删了就真没了
  candidates.sort((a, b) => (a.opened ?? a.added) - (b.opened ?? b.added));
  let evicted = 0;
  let freed = 0;
  for (const row of candidates) {
    if (bytes <= budget || evicted >= MAX_EVICT_PER_RUN) break;
    if (!backed(row)) continue;
    await deleteTrack(row.id);
    bytes -= trackBytes(row);
    freed += trackBytes(row);
    evicted += 1;
  }
  return { evicted, freed, kept: candidates.length - evicted };
}
