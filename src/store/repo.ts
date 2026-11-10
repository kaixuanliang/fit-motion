/**
 * 记录库的读写入口。列表、导入、去重、重建 Activity 都在这里。
 */

import { buildActivity, type Activity } from '../fit/activity';
import type { FitRecord, ParsedFit } from '../fit/types';
import { STORE, req, tx } from './db';
import { hashBytes, motionFp, sameMotion, START_WINDOW_MS } from './fingerprint';
import { thumbPath } from './thumb';
import type {
  ActivityMeta,
  BackupProviderId,
  ImportResult,
  LibraryStats,
  ListPage,
  ListQuery,
  QueueItem,
  QueueKind,
  SourceKind,
  StoredFile,
  StoredSession,
  StoredTrack,
} from './types';

export const PAGE_SIZE = 20;

/**
 * 轨迹不在本地时的回源钩子。sync 层注册，避免 repo ←→ sync 的循环依赖。
 *
 * 挂在 globalThis 而不是模块变量上：dev 环境下 HMR 会让同一个模块出现
 * 两个实例，模块级变量会跟着分裂，globalThis 上的槽位不会。
 */
type TrackResolver = (id: string) => Promise<StoredTrack | null>;
const RESOLVER_KEY = '__fitmotionTrackResolver';

function resolverSlot(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

export function setRemoteTrackResolver(fn: TrackResolver): void {
  resolverSlot()[RESOLVER_KEY] = fn;
}

export function currentRemoteResolver(): TrackResolver | null {
  const fn = resolverSlot()[RESOLVER_KEY];
  return typeof fn === 'function' ? (fn as TrackResolver) : null;
}

/** 自检用：回源钩子挂上了没有。 */
export function hasRemoteResolver(): boolean {
  return currentRemoteResolver() !== null;
}

let statsCache: { key: string; value: Stats } | null = null;

function invalidate(): void {
  statsCache = null;
}

function uid(): string {
  const random = crypto.getRandomValues(new Uint8Array(6));
  return Date.now().toString(36) + Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 从运动类型与开始时刻生成一个顺手的名字：晨骑 / 夜跑 / 下班通勤。 */
function nameFor(activity: Activity): string {
  const hour = new Date(activity.startTime).getHours();
  const ride = activity.sportKey === 'ride';
  const run = activity.sportKey === 'run';
  const hike = activity.sportKey === 'hike';
  let slot = '骑行';
  if (hour >= 5 && hour < 10) slot = '晨';
  else if (hour >= 10 && hour < 14) slot = '午间';
  else if (hour >= 14 && hour < 18) slot = '下午';
  else if (hour >= 18 && hour < 22) slot = '夜';
  else slot = '深夜';
  const action = ride ? '骑' : run ? '跑' : hike ? '徒步' : '运动';
  // 通勤只用于「短途 + 工作日时段」，200 公里的长距离骑行不该叫早高峰
  const shortTrip = activity.distanceM < 40_000 && activity.durationSec < 7200;
  if (ride && shortTrip && hour >= 7 && hour <= 9) return '早高峰通勤';
  if (ride && shortTrip && hour >= 17 && hour <= 19) return '下班通勤';
  return slot + action;
}

function packTrack(activity: Activity, id: string, session: StoredSession): StoredTrack {
  const count = activity.points.length;
  const lat = new Float32Array(count);
  const lon = new Float32Array(count);
  const t = new Float64Array(count);
  const alt = new Float32Array(count);
  const hr = new Int16Array(count);
  const speed = new Float32Array(count);
  const dist = new Float32Array(count);
  const cad = new Int16Array(count);
  const pwr = new Int16Array(count);
  let hasAlt = false;
  let hasHr = false;
  let hasSpeed = false;
  let hasCad = false;
  let hasPwr = false;
  for (let i = 0; i < count; i += 1) {
    const point = activity.points[i];
    lat[i] = point.lat;
    lon[i] = point.lon;
    t[i] = point.t || 0;
    alt[i] = point.altitude ?? -1;
    hr[i] = point.heartRate != null ? Math.round(point.heartRate) : -1;
    speed[i] = point.speed ?? -1;
    dist[i] = point.distance;
    cad[i] = point.cadence != null ? Math.min(32767, Math.round(point.cadence)) : -1;
    pwr[i] = point.power != null ? Math.min(32767, Math.round(point.power)) : -1;
    if (point.altitude != null) hasAlt = true;
    if (point.heartRate != null) hasHr = true;
    if (point.speed != null) hasSpeed = true;
    if (point.cadence != null) hasCad = true;
    if (point.power != null) hasPwr = true;
  }
  return {
    id,
    lat,
    lon,
    t,
    alt: hasAlt ? alt : null,
    hr: hasHr ? hr : null,
    speed: hasSpeed ? speed : null,
    dist,
    cad: hasCad ? cad : null,
    pwr: hasPwr ? pwr : null,
    hasTimestamps: activity.timeAvailable && count > 0 && t[count - 1] > t[0],
    sportHint: activity.sport,
    session,
  };
}

function sessionOf(activity: Activity): StoredSession {
  return {
    startTime: activity.startTime,
    elapsedTime: activity.durationSec,
    timerTime: activity.durationSec,
    distance: activity.distanceM,
    calories: activity.calories,
    ascent: activity.ascent,
    descent: activity.descent,
    avgHeartRate: activity.avgHeartRate,
    maxHeartRate: activity.maxHeartRate,
    avgSpeed: activity.avgSpeed,
    maxSpeed: activity.maxSpeed,
    maxAltitude: activity.maxAltitude,
    sport: activity.sport,
  };
}

function metaOf(activity: Activity, source: { id: string; fileHash: string; src: SourceKind; fileName: string; size: number; name?: string; mergedFrom?: string[] }): ActivityMeta {
  const lat = activity.points.map((point) => point.lat);
  const lon = activity.points.map((point) => point.lon);
  return {
    id: source.id,
    name: source.name ?? nameFor(activity),
    src: source.src,
    fileName: source.fileName,
    start: activity.startTime,
    duration: activity.durationSec,
    distance: activity.distanceM,
    avgSpeed: activity.avgSpeed,
    maxSpeed: activity.maxSpeed,
    sport: activity.sport,
    avgHr: activity.avgHeartRate ?? null,
    maxHr: activity.maxHeartRate ?? null,
    climb: activity.ascent ?? 0,
    maxAlt: activity.maxAltitude ?? null,
    calories: activity.calories ?? null,
    points: activity.points.length,
    thumb: thumbPath(lat, lon),
    fileHash: source.fileHash,
    fp: motionFp(activity.startTime, activity.durationSec, activity.distanceM),
    backup: 0,
    added: Date.now(),
    updated: Date.now(),
    size: source.size,
    deleted: 0,
    mergedFrom: source.mergedFrom,
  };
}

export interface SaveInput {
  parsed: ParsedFit;
  fileName: string;
  src: SourceKind;
  bytes: ArrayBuffer;
  /** 原始文件是否归档（FIT/GPX/TCX 保留原件，华为导出的 JSON 不入库） */
  keepFile: boolean;
  /** 覆盖默认命名（华为记录自带运动名时用） */
  name?: string;
  /** 覆盖文件指纹：一份华为 JSON 里包含多条运动，按条计算 */
  hashOverride?: string;
  /** 跳过「同一趟运动」判定：合并路线与首段共用开始时间，会误判成重复 */
  skipDedupe?: boolean;
  /** 合并路线的来源记录 id */
  mergedFrom?: string[];
}

export async function findByHash(fileHash: string): Promise<ActivityMeta | null> {
  const rows = await tx(STORE.activities, 'readonly', (t) =>
    req(t.objectStore(STORE.activities).index('by_hash').getAll(fileHash)) as Promise<ActivityMeta[]>);
  return rows.find((row) => !row.deleted) ?? null;
}

/** 时间窗口内的候选记录，用来做运动级去重。 */
export async function findNearby(start: number): Promise<ActivityMeta[]> {
  const range = IDBKeyRange.bound(start - START_WINDOW_MS, start + START_WINDOW_MS);
  const rows = await tx(STORE.activities, 'readonly', (t) =>
    req(t.objectStore(STORE.activities).index('by_start').getAll(range)) as Promise<ActivityMeta[]>);
  return rows.filter((row) => !row.deleted);
}

/**
 * 数据完整度评分：重复导入时对比新旧两份数据谁更全。
 * 心率权重最高（华为 JSON 有、码表 FIT 常没有），其余等权。
 */
function activityScore(a: Activity): number {
  let score = 0;
  if (a.maxHeartRate != null || a.avgHeartRate != null) score += 2;
  if (a.maxAltitude != null) score += 1;
  if (a.maxSpeed > 0) score += 1;
  if (a.calories != null) score += 1;
  const km = a.distanceM / 1000;
  if (km > 0 && a.points.length / km >= 5) score += 1;
  return score;
}

function metaScore(m: ActivityMeta): number {
  let score = 0;
  if (m.maxHr != null || m.avgHr != null) score += 2;
  if (m.maxAlt != null) score += 1;
  if (m.maxSpeed > 0) score += 1;
  if (m.calories != null) score += 1;
  const km = m.distance / 1000;
  if (km > 0 && m.points / km >= 5) score += 1;
  return score;
}

/** 新数据比既有记录更完整（严格更高）才算值得替换。 */
function worthReplacing(activity: Activity, existing: ActivityMeta): boolean {
  return activityScore(activity) > metaScore(existing);
}

/**
 * 用新解析的数据替换既有记录：沿用 id（云端 tracks/<id>.fmt 直接覆盖，
 * 备份 commit 不膨胀），保留用户改过的名字与备份状态；meta.updated 刷新后
 * 对账同步会把新版本推上云端。
 */
async function replaceRecord(activity: Activity, existing: ActivityMeta, input: SaveInput, fileHash: string): Promise<ImportResult> {
  const meta = metaOf(activity, {
    id: existing.id,
    fileHash,
    src: input.src,
    fileName: input.fileName,
    size: input.bytes.byteLength,
    name: existing.name,
  });
  // 保留备份状态与时间戳语义：added 是首次入库时间，updated 是本次替换时间
  meta.added = existing.added;
  meta.opened = existing.opened;
  meta.mergedFrom = existing.mergedFrom ?? input.mergedFrom;
  const track = packTrack(activity, existing.id, sessionOf(activity));
  await tx([STORE.activities, STORE.tracks, STORE.files], 'readwrite', (t) => {
    t.objectStore(STORE.activities).put(meta);
    t.objectStore(STORE.tracks).put(track);
    if (input.keepFile) {
      const file: StoredFile = {
        id: existing.id,
        name: input.fileName,
        type: input.fileName.split('.').pop() ?? '',
        size: input.bytes.byteLength,
        blob: new Blob([input.bytes]),
        added: existing.added,
      };
      t.objectStore(STORE.files).put(file);
    }
  });
  invalidate();
  const gained = activityScore(activity) - metaScore(existing);
  return {
    status: 'replaced',
    name: meta.name,
    id: existing.id,
    existing: existing.id,
    message: `已用更完整的数据替换「${meta.name}」（新增 ${gained} 项信息）`,
  };
}

export async function saveParsed(input: SaveInput): Promise<ImportResult> {
  const name = input.name ?? input.fileName;
  const fileHash = input.hashOverride ?? (await hashBytes(input.bytes));

  let activity: Activity;
  try {
    activity = buildActivity(input.parsed, input.fileName);
  } catch (error) {
    return { status: 'no-gps', name, message: error instanceof Error ? error.message : '没有可用的轨迹点' };
  }

  const sameFile = await findByHash(fileHash);
  if (sameFile) {
    if (worthReplacing(activity, sameFile)) {
      return replaceRecord(activity, sameFile, input, fileHash);
    }
    return { status: 'duplicate-file', name, id: sameFile.id, existing: sameFile.id, message: '同一个文件之前已导入' };
  }

  if (!input.skipDedupe) {
    const nearby = await findNearby(activity.startTime);
    const duplicate = nearby.find((row) => sameMotion(row.fp, motionFp(activity.startTime, activity.durationSec, activity.distanceM)));
    if (duplicate) {
      if (worthReplacing(activity, duplicate)) {
        return replaceRecord(activity, duplicate, input, fileHash);
      }
      return {
        status: 'duplicate-motion',
        name,
        id: duplicate.id,
        existing: duplicate.id,
        message: `与「${duplicate.name}」是同一趟运动，且已有数据更完整`,
      };
    }
  }

  const id = uid();
  const meta = metaOf(activity, {
    id,
    fileHash,
    src: input.src,
    fileName: input.fileName,
    size: input.bytes.byteLength,
    name: input.name,
    mergedFrom: input.mergedFrom,
  });
  const track = packTrack(activity, id, sessionOf(activity));

  await tx([STORE.activities, STORE.tracks, STORE.files], 'readwrite', (t) => {
    t.objectStore(STORE.activities).put(meta);
    t.objectStore(STORE.tracks).put(track);
    if (input.keepFile) {
      const file: StoredFile = {
        id,
        name: input.fileName,
        type: input.fileName.split('.').pop() ?? '',
        size: input.bytes.byteLength,
        blob: new Blob([input.bytes]),
        added: Date.now(),
      };
      t.objectStore(STORE.files).put(file);
    }
  });
  invalidate();
  return { status: 'added', name, id };
}

export async function listPage(query: ListQuery): Promise<ListPage> {
  const limit = query.limit ?? PAGE_SIZE;
  const year = query.year ?? 'all';
  const src = query.src ?? 'all';
  const srcMatch = (row: ActivityMeta): boolean => matchesSource(row, src);
  const asc = query.order === 'asc';

  let bound: IDBKeyRange | null = null;
  if (asc) {
    if (query.after != null) bound = IDBKeyRange.lowerBound(query.after, true);
    else if (year !== 'all') bound = IDBKeyRange.bound(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1), false, true);
  } else {
    if (query.before != null) bound = IDBKeyRange.upperBound(query.before, true);
    else if (year !== 'all') bound = IDBKeyRange.bound(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1), false, true);
  }

  const items: ActivityMeta[] = [];
  let last: number | null = null;
  let exhausted = true;

  await tx(STORE.activities, 'readonly', (t) => new Promise<void>((resolve, reject) => {
    const request = t.objectStore(STORE.activities).index('by_start').openCursor(bound, asc ? 'next' : 'prev');
    request.onerror = () => reject(request.error ?? new Error('读取记录失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const meta = cursor.value as ActivityMeta;
      const metaYear = new Date(meta.start).getFullYear();
      if (meta.deleted || !srcMatch(meta) || (year !== 'all' && metaYear !== year)) {
        cursor.continue();
        return;
      }
      items.push(meta);
      last = meta.start;
      if (items.length >= limit) {
        exhausted = false;
        resolve();
        return;
      }
      cursor.continue();
    };
  }));

  const stats = await libraryStats();
  const total = stats.byBoth[`${year}|${src}`] ?? 0;
  return { items, next: exhausted ? null : last, total };
}

/** 来源筛选：GPX 分类把华为 JSON 归进来（同类点串数据），卡片上用「华为」徽标区分 */
function matchesSource(row: ActivityMeta, src: SourceKind | 'all'): boolean {
  return src === 'all'
    || row.src === src
    || (src === 'gpx' && row.src === 'huawei');
}

/**
 * 当前筛选条件下的全部记录 id（不分页）。
 * 批量「全选」用它 —— 只选已加载的那 20 条会让用户误以为删干净了。
 */
export async function listIds(query: { year?: number | 'all'; src?: SourceKind | 'all' } = {}): Promise<string[]> {
  const year = query.year ?? 'all';
  const src = query.src ?? 'all';
  const ids: string[] = [];
  await tx(STORE.activities, 'readonly', (t) => new Promise<void>((resolve, reject) => {
    const request = t.objectStore(STORE.activities).index('by_start').openCursor(null, 'next');
    request.onerror = () => reject(request.error ?? new Error('读取记录失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const meta = cursor.value as ActivityMeta;
      const metaYear = new Date(meta.start).getFullYear();
      if (!meta.deleted && matchesSource(meta, src) && (year === 'all' || metaYear === year)) {
        ids.push(meta.id);
      }
      cursor.continue();
    };
  }));
  return ids;
}

/** 批量删除：一个事务里给全部命中记录打墓碑，避免逐条开事务（几百条时会卡） */
export async function removeActivities(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const want = new Set(ids);
  const now = Date.now();
  await tx(STORE.activities, 'readwrite', async (t) => {
    const store = t.objectStore(STORE.activities);
    const rows = await req(store.getAll()) as ActivityMeta[];
    for (const meta of rows) {
      if (!want.has(meta.id)) continue;
      meta.deleted = now;
      meta.updated = now;
      store.put(meta);
    }
  });
  invalidate();
}

/** 批量恢复（撤销删除）：与单条恢复同口径，清掉备份位置让下次同步重新上传 */
export async function restoreActivities(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const want = new Set(ids);
  const now = Date.now();
  await tx(STORE.activities, 'readwrite', async (t) => {
    const store = t.objectStore(STORE.activities);
    const rows = await req(store.getAll()) as ActivityMeta[];
    for (const row of rows) {
      if (!want.has(row.id)) continue;
      row.deleted = 0;
      row.updated = now;
      row.where = {};
      row.home = {};
      row.backup = 0;
      store.put(row);
    }
  });
  invalidate();
}

export interface Stats extends LibraryStats {
  byYear: Record<string, number>;
  bySrc: Record<string, number>;
  /** 年份 × 来源的交叉计数，列表页的「共 N 条」直接用 */
  byBoth: Record<string, number>;
}

export async function libraryStats(): Promise<Stats> {
  const key = 'v1';
  if (statsCache && statsCache.key === key) return statsCache.value;

  const rows = await tx(STORE.activities, 'readonly', (t) =>
    req(t.objectStore(STORE.activities).getAll()) as Promise<ActivityMeta[]>);
  const byYear: Record<string, number> = {};
  const bySrc: Record<string, number> = {};
  const byBoth: Record<string, number> = {};
  let count = 0;
  let distanceM = 0;
  let durationSec = 0;
  let first = 0;
  let last = 0;
  for (const row of rows) {
    if (row.deleted) continue;
    count += 1;
    distanceM += row.distance;
    durationSec += row.duration;
    if (!first || row.start < first) first = row.start;
    if (row.start > last) last = row.start;
    const year = String(new Date(row.start).getFullYear());
    // 展示分组：华为 JSON 归入 GPX 组（列表卡片另有「华为」徽标）
    const group = row.src === 'huawei' ? 'gpx' : row.src;
    byYear[year] = (byYear[year] ?? 0) + 1;
    bySrc[group] = (bySrc[group] ?? 0) + 1;
    const yk = `${year}|${group}`;
    byBoth[yk] = (byBoth[yk] ?? 0) + 1;
    byBoth[`${year}|all`] = (byBoth[`${year}|all`] ?? 0) + 1;
    byBoth[`all|${group}`] = (byBoth[`all|${group}`] ?? 0) + 1;
    byBoth['all|all'] = (byBoth['all|all'] ?? 0) + 1;
  }
  const value = { count, distanceM, durationSec, first, last, byYear, bySrc, byBoth };
  statsCache = { key, value };
  return value;
}

export async function getMeta(id: string): Promise<ActivityMeta | null> {
  const row = await tx(STORE.activities, 'readonly', (t) => req(t.objectStore(STORE.activities).get(id)) as Promise<ActivityMeta | undefined>);
  return row && !row.deleted ? row : null;
}

function unpackRecords(track: StoredTrack): FitRecord[] {
  const records: FitRecord[] = [];
  for (let i = 0; i < track.lat.length; i += 1) {
    records.push({
      timestamp: track.t[i] || undefined,
      lat: track.lat[i],
      lon: track.lon[i],
      altitude: track.alt ? (track.alt[i] >= 0 ? track.alt[i] : undefined) : undefined,
      heartRate: track.hr ? (track.hr[i] > 0 ? track.hr[i] : undefined) : undefined,
      speed: track.speed ? (track.speed[i] >= 0 ? track.speed[i] : undefined) : undefined,
      cadence: track.cad ? (track.cad[i] >= 0 ? track.cad[i] : undefined) : undefined,
      power: track.pwr ? (track.pwr[i] >= 0 ? track.pwr[i] : undefined) : undefined,
      distance: track.dist ? track.dist[i] : undefined,
    });
  }
  return records;
}

/** 把入库的轨迹还原成渲染与导出用的 Activity。 */
export async function loadActivity(id: string): Promise<Activity> {
  const meta = await getMeta(id);
  if (!meta) throw new Error('记录不存在或已删除');
  let track = await tx(STORE.tracks, 'readonly', (t) => req(t.objectStore(STORE.tracks).get(id)) as Promise<StoredTrack | undefined>);
  if (!track) {
    // 本地只留了索引，轨迹还在云端：拉回来顺手落缓存
    const fetched = await currentRemoteResolver()?.(id);
    if (!fetched) throw new Error('这条记录的轨迹还没同步到本机，连上网络后会自动补齐');
    await putStoredTrack(fetched);
    track = fetched;
  }
  void touchOpened(id);
  const parsed: ParsedFit = {
    sourceType: meta.src === 'fit' ? 'fit' : 'gpx',
    hasTimestamps: track.hasTimestamps,
    sportHint: track.sportHint,
    records: unpackRecords(track),
    sessions: [track.session],
    laps: [],
  };
  const activity = buildActivity(parsed, meta.fileName);
  // 旧口径迁移：均速曾是「距离÷总耗时」，打开记录时用新口径（距离÷运动时长）
  // 重算并回写 meta，列表页逐渐自愈。误差 <1% 视为一致，不动。
  if (Math.abs(activity.avgSpeed - meta.avgSpeed) > Math.max(0.05, meta.avgSpeed * 0.01)) {
    meta.avgSpeed = activity.avgSpeed;
    await putMeta(meta);
  }
  return activity;
}

export async function loadFileBlob(id: string): Promise<Blob | null> {
  const row = await tx(STORE.files, 'readonly', (t) => req(t.objectStore(STORE.files).get(id)) as Promise<StoredFile | undefined>);
  return row?.blob ?? null;
}

/** 墓碑删除：列表立刻消失，但云端同步需要这个标记。 */
export async function removeActivity(id: string): Promise<void> {
  const meta = await getMeta(id);
  if (!meta) return;
  meta.deleted = Date.now();
  meta.updated = Date.now();
  await tx(STORE.activities, 'readwrite', (t) => {
    t.objectStore(STORE.activities).put(meta);
  });
  invalidate();
}

export async function restoreActivity(id: string): Promise<void> {
  const row = await tx(STORE.activities, 'readonly', (t) => req(t.objectStore(STORE.activities).get(id)) as Promise<ActivityMeta | undefined>);
  if (!row) return;
  row.deleted = 0;
  row.updated = Date.now();
  // 云端那份已经在删除时被移走了，本地不能还留着「已备份」的记录：
  // 不清 where 的话，恢复后列表会立刻显示「已同步」，而远端其实只剩墓碑。
  // 清空后 backup=0（待备份），下次同步会重新上传。
  row.where = {};
  row.home = {};
  row.backup = 0;
  await tx(STORE.activities, 'readwrite', (t) => {
    t.objectStore(STORE.activities).put(row);
  });
  invalidate();
}

/* ------------------------------- 回收站 ------------------------------- */

/** 回收站保留天数：超过这个天数的删除，只留下墓碑，轨迹与原件清掉。 */
export const TRASH_KEEP_DAYS = 30;

export async function listDeleted(): Promise<ActivityMeta[]> {
  const rows = await allMeta();
  return rows
    .filter((row) => row.deleted > 0 && !row.purged)
    .sort((a, b) => b.deleted - a.deleted);
}

export async function deletedCount(): Promise<number> {
  const rows = await allMeta();
  return rows.reduce((sum, row) => (row.deleted > 0 && !row.purged ? sum + 1 : sum), 0);
}

/** 一条墓碑记录还能回收多少本地空间（轨迹估算 + 原始文件）。 */
export function trashBytes(meta: ActivityMeta): number {
  return trackBytes(meta) + (meta.size ?? 0);
}

/**
 * 清掉一条墓碑记录的本地载荷：轨迹、原始文件、备份队列。
 *
 * 元数据本身**不删**。云端对账靠这条墓碑判断「是用户主动删的」，
 * 抹掉之后下次同步会把它当成云上有、本地没有的记录重新拉回来。
 * 墓碑只有几百字节，留着比删了安全。
 */
export async function purgeTrash(id: string): Promise<void> {
  const row = await getRawMeta(id);
  if (!row || row.deleted <= 0) return;
  await tx([STORE.tracks, STORE.files], 'readwrite', (t) => {
    t.objectStore(STORE.tracks).delete(id);
    t.objectStore(STORE.files).delete(id);
  });
  const keys = await tx(STORE.queue, 'readonly', (t) =>
    req(t.objectStore(STORE.queue).index('by_activity').getAllKeys(id))) as IDBValidKey[];
  if (keys.length) {
    await tx(STORE.queue, 'readwrite', (t) => {
      const store = t.objectStore(STORE.queue);
      for (const key of keys) store.delete(key);
    });
  }
  row.purged = Date.now();
  await putMeta(row);
}

/** 清空回收站，返回清掉的条数。 */
export async function purgeAllTrash(): Promise<number> {
  const rows = await listDeleted();
  for (const row of rows) await purgeTrash(row.id);
  return rows.length;
}

/** 到期自动清理：删除满 N 天的记录不再占本地空间。启动时跑一次。 */
export async function purgeExpiredTrash(days = TRASH_KEEP_DAYS): Promise<number> {
  const cutoff = Date.now() - days * 86_400_000;
  const rows = await allMeta();
  let cleaned = 0;
  for (const row of rows) {
    if (row.deleted > 0 && !row.purged && row.deleted < cutoff) {
      await purgeTrash(row.id);
      cleaned += 1;
    }
  }
  return cleaned;
}

export async function setBackupState(id: string, backup: 0 | 1 | 2): Promise<void> {
  const row = await tx(STORE.activities, 'readonly', (t) => req(t.objectStore(STORE.activities).get(id)) as Promise<ActivityMeta | undefined>);
  if (!row) return;
  row.backup = backup;
  row.updated = Date.now();
  await tx(STORE.activities, 'readwrite', (t) => {
    t.objectStore(STORE.activities).put(row);
  });
}

/* ------------------------------- 备份队列 ------------------------------- */

export async function enqueue(activityId: string, kind: QueueKind, provider: QueueItem['provider']): Promise<void> {
  const item: QueueItem = {
    id: `${activityId}:${kind}:${provider}`,
    activityId,
    kind,
    provider,
    attempts: 0,
    nextAt: Date.now(),
    message: '',
  };
  await tx(STORE.queue, 'readwrite', (t) => {
    t.objectStore(STORE.queue).put(item);
  });
}

export async function pendingQueue(): Promise<QueueItem[]> {
  const rows = await tx(STORE.queue, 'readonly', (t) =>
    req(t.objectStore(STORE.queue).getAll()) as Promise<QueueItem[]>);
  return rows.sort((a, b) => a.nextAt - b.nextAt);
}

export async function dropQueue(itemId: string): Promise<void> {
  await tx(STORE.queue, 'readwrite', (t) => {
    t.objectStore(STORE.queue).delete(itemId);
  });
}

export async function updateQueue(item: QueueItem): Promise<void> {
  await tx(STORE.queue, 'readwrite', (t) => {
    t.objectStore(STORE.queue).put(item);
  });
}

/** 记录库里所有未删除记录的元数据，备份对账用。 */
export async function allMeta(): Promise<ActivityMeta[]> {
  const rows = await tx(STORE.activities, 'readonly', (t) =>
    req(t.objectStore(STORE.activities).getAll()) as Promise<ActivityMeta[]>);
  return rows;
}

/* --------------------------- 备份 / 缓存相关的原子操作 --------------------------- */

/** 含墓碑的原始元数据：同步对账需要看到已删除的记录。 */
export async function getRawMeta(id: string): Promise<ActivityMeta | null> {
  const row = await tx(STORE.activities, 'readonly', (t) => req(t.objectStore(STORE.activities).get(id)) as Promise<ActivityMeta | undefined>);
  return row ?? null;
}

/** 直接落一条元数据（云端 manifest 合并进本地时用）。 */
export async function putMeta(meta: ActivityMeta): Promise<void> {
  await tx(STORE.activities, 'readwrite', (t) => {
    t.objectStore(STORE.activities).put(meta);
  });
  invalidate();
}

export async function putStoredTrack(track: StoredTrack): Promise<void> {
  await tx(STORE.tracks, 'readwrite', (t) => {
    t.objectStore(STORE.tracks).put(track);
  });
}

export async function getStoredTrack(id: string): Promise<StoredTrack | null> {
  const row = await tx(STORE.tracks, 'readonly', (t) => req(t.objectStore(STORE.tracks).get(id)) as Promise<StoredTrack | undefined>);
  return row ?? null;
}

/** 只问「有没有」，不把几万个点的数组搬进内存。 */
export async function hasTrack(id: string): Promise<boolean> {
  const key = await tx(STORE.tracks, 'readonly', (t) => req(t.objectStore(STORE.tracks).getKey(id)));
  return key != null;
}

export async function deleteTrack(id: string): Promise<void> {
  await tx(STORE.tracks, 'readwrite', (t) => {
    t.objectStore(STORE.tracks).delete(id);
  });
}

/** 标记载荷已推到某一端，顺带刷新 backup 位（0 未备份 / 1 单端 / 2 双端）。
 *  homeKey：这一版轨迹写进了该端的哪个仓库（owner/repo），删除和回源按它定位。 */
export async function markBacked(
  id: string,
  provider: BackupProviderId,
  version: number,
  homeKey = '',
): Promise<ActivityMeta | null> {
  const row = await getRawMeta(id);
  if (!row) return null;
  row.where = { ...(row.where ?? {}), [provider]: version };
  if (homeKey) row.home = { ...(row.home ?? {}), [provider]: homeKey };
  row.backup = Object.keys(row.where).length >= 2 ? 2 : 1;
  await putMeta(row);
  return row;
}

export async function touchOpened(id: string): Promise<void> {
  const row = await getRawMeta(id);
  if (!row) return;
  row.opened = Date.now();
  await tx(STORE.activities, 'readwrite', (t) => {
    t.objectStore(STORE.activities).put(row);
  });
}

/**
 * 还需要备份的记录数：按「绑定的端」逐个比对 where 里的时间戳。
 * 比单独维护一个队列更可靠 —— 队列会丢，元数据不会。
 */
export async function unsyncedMeta(providers: BackupProviderId[]): Promise<ActivityMeta[]> {
  if (!providers.length) return [];
  const rows = await allMeta();
  return rows.filter((row) => {
    const where = row.where ?? {};
    if (row.deleted > 0) {
      // 删除只在「这一端确实还有旧版本」时才需要推一次；
      // 推完 where 会更新到删除时间，不该永远算作待备份。
      return providers.some((id) => where[id] != null && where[id] < row.updated);
    }
    return providers.some((id) => (where[id] ?? 0) < row.updated);
  });
}

/** 本地轨迹占用的字节数（按编码后的实际大小估，一条 3.9 万点约 700 KB）。 */
export function trackBytes(meta: ActivityMeta): number {
  return Math.round(meta.points * 18);
}
