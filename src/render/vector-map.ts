import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { Activity } from '../fit/activity';
import { project, TILE_SIZE } from '../geo';
import type { MapCamera, TrackMap } from './map';
import type { VideoTheme } from './theme';

const VECTOR_ZOOM = 14;
const SEGMENT_METERS = 100_000;
/** 核心画面视野：相机窗口约 2 张瓦片宽，路线贴瓦片边时也只超出 ±1 张。 */
const TILE_BUFFER = 1;
/**
 * 延展区走廊：预览容器满宽，左右两侧延展地图比核心宽约 50%，加上路线
 * 贴瓦片边的余量，按 ±2 张取。超出核心走廊的部分在后台补抓补解码，
 * 不阻塞「正在缓存地图瓦片」的门（首次缓存的等待时间不变）。
 */
const AMBIENT_BUFFER = 2;
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const DB_NAME = 'fit-motion-vector-tiles';
const DB_VERSION = 1;
const STORE = 'tiles';

interface Segment {
  index: number;
  keys: string[];
}

interface ParsedTile {
  tile: VectorTile;
  extent: number;
}

type TilePoint = { x: number; y: number };

let dbPromise: Promise<IDBDatabase | null> | null = null;
let templatePromise: Promise<string | null> | null = null;
const blobMemory = new Map<string, ArrayBuffer>();
let blobMemoryBytes = 0;

/**
 * 原始 PBF 瓦片的内存驻留上限：低端机（deviceMemory < 4GB）24MB，其余 48MB。
 * 淘汰只是出内存不落盘——IDB 里都有，批量预读（readBlobsBatch）回来很快。
 * 不设上限的话长路线（几百张 × 数十 KB）会在低端机上白白常驻几十 MB。
 */
const BLOB_MEMORY_BUDGET = (() => {
  try {
    const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (typeof gb === 'number' && gb > 0 && gb < 4) return 24 * 1024 * 1024;
  } catch {
    // 老内核没有 deviceMemory
  }
  return 48 * 1024 * 1024;
})();

function blobMemorySet(key: string, data: ArrayBuffer): void {
  if (blobMemory.has(key)) return;
  blobMemory.set(key, data);
  blobMemoryBytes += data.byteLength;
  while (blobMemoryBytes > BLOB_MEMORY_BUDGET && blobMemory.size > 1) {
    const oldest = blobMemory.keys().next();
    if (oldest.done) break;
    const evicted = blobMemory.get(oldest.value);
    blobMemory.delete(oldest.value);
    if (evicted) blobMemoryBytes -= evicted.byteLength;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function cacheKey(key: string): string {
  return `v1/${key}`;
}

async function readBlob(key: string): Promise<ArrayBuffer | null> {
  const memory = blobMemory.get(key);
  if (memory) return memory;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(cacheKey(key));
      request.onsuccess = () => {
        const value = request.result;
        if (value instanceof ArrayBuffer) {
          blobMemorySet(key, value);
          resolve(value);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** 批量预读：一个 readonly 事务填充 blobMemory，冷路径省掉逐条事务开销。返回命中数。 */
async function readBlobsBatch(keys: string[]): Promise<number> {
  const missing = keys.filter((key) => !blobMemory.has(key));
  if (missing.length === 0) return keys.length;
  const db = await openDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      let hits = 0;
      let done = 0;
      const total = missing.length;
      const finish = (): void => {
        done += 1;
        if (done >= total) resolve(hits);
      };
      for (const key of missing) {
        const request = store.get(cacheKey(key));
        request.onsuccess = () => {
          const value = request.result;
          if (value instanceof ArrayBuffer) {
            blobMemorySet(key, value);
            hits += 1;
          }
          finish();
        };
        request.onerror = finish;
      }
      tx.onerror = () => resolve(hits);
      tx.onabort = () => resolve(hits);
    } catch {
      resolve(0);
    }
  });
}

async function writeBlob(key: string, data: ArrayBuffer): Promise<void> {
  blobMemorySet(key, data);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, cacheKey(key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function tileTemplate(): Promise<string | null> {
  if (templatePromise) return templatePromise;
  templatePromise = (async () => {
    try {
      const stored = localStorage.getItem('fit-motion-vector-template');
      if (stored) return stored;
    } catch {
      // no storage
    }
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 12_000);
      const response = await fetch(TILEJSON_URL, { signal: controller.signal, mode: 'cors' });
      window.clearTimeout(timer);
      if (!response.ok) return null;
      const json = await response.json() as { tiles?: string[] };
      const template = json.tiles?.[0] ?? null;
      if (template) {
        try {
          localStorage.setItem('fit-motion-vector-template', template);
        } catch {
          // no storage
        }
      }
      return template;
    } catch {
      return null;
    }
  })();
  return templatePromise;
}

function expandTemplate(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

async function fetchVectorTile(z: number, x: number, y: number): Promise<ArrayBuffer | null> {
  const key = `${z}/${x}/${y}`;
  const cached = await readBlob(key);
  if (cached) return cached;
  const template = await tileTemplate();
  if (!template) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(expandTemplate(template, z, x, y), {
      mode: 'cors',
      cache: 'force-cache',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    if (!data.byteLength) return null;
    await writeBlob(key, data);
    return data;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function tileCoords(lat: number, lon: number): { x: number; y: number } {
  const world = project(lat, lon, VECTOR_ZOOM);
  return { x: Math.floor(world.x / TILE_SIZE), y: Math.floor(world.y / TILE_SIZE) };
}

function buildSegments(activity: Activity, buffer: number): Segment[] {
  const count = Math.max(1, Math.ceil(activity.distanceM / SEGMENT_METERS));
  const segments: Segment[] = Array.from({ length: count }, (_, index) => ({ index, keys: [] }));
  const seen = new Set<string>();
  for (const point of activity.points) {
    const segment = segments[Math.min(count - 1, Math.floor(point.distance / SEGMENT_METERS))];
    const tile = tileCoords(point.lat, point.lon);
    for (let dx = -buffer; dx <= buffer; dx += 1) {
      for (let dy = -buffer; dy <= buffer; dy += 1) {
        const key = `${VECTOR_ZOOM}/${tile.x + dx}/${tile.y + dy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        segment.keys.push(key);
      }
    }
  }
  return segments;
}

function parseTile(data: ArrayBuffer): ParsedTile | null {
  try {
    const tile = new VectorTile(new Pbf(new Uint8Array(data)));
    const first = Object.values(tile.layers)[0];
    return { tile, extent: first?.extent ?? 4096 };
  } catch {
    return null;
  }
}

/**
 * 让出主线程。MVT 解码是同步重活，预取一批瓦片时不交还事件循环，
 * 创作页的滚动/触摸会整段卡死 —— 每张瓦片处理完停一拍。
 */
const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 让出节拍器。
 *
 * 旧写法是「每张瓦片 yieldToUi()」，但 setTimeout 有 4ms 下限：
 * 一条长途骑行有近 300 张总览瓦片，光排队就白等 1.2s，而单张光栅化
 * 也才十几毫秒。改为累计忙够 SLICE_MS 才让出一拍 —— 加载页是静态画面，
 * 单次卡顿几十毫秒无感，进度条照样在动。
 *
 * 多个 worker 必须共用同一道闸门：各自 await 自己的 setTimeout 时，
 * 先醒的那个继续跑，其余接着排队，主线程照样被饿住。
 */
const SLICE_MS = 32;
let sliceStartedAt = 0;
let pauseGate: Promise<void> | null = null;

async function yieldIfBusy(): Promise<void> {
  const now = performance.now();
  if (!sliceStartedAt) sliceStartedAt = now;
  if (now - sliceStartedAt < SLICE_MS) return;
  if (!pauseGate) {
    pauseGate = yieldToUi().then(() => {
      pauseGate = null;
    });
  }
  await pauseGate;
  sliceStartedAt = performance.now();
}

function rgb(color: number[]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/**
 * Small Canvas2D vector renderer for the first-person camera. It reads cached
 * OpenStreetMap/OpenMapTiles PBF tiles, draws only the visible tile range and
 * keeps roads as real vector paths, so no raster road edge can be upscaled.
 */
interface TileBitmap {
  canvas: HTMLCanvasElement;
  size: number;
  pad: number;
}

const BITMAP_PAD = 8;
/**
 * 瓦片位图缓存上限（Map 插入序 FIFO 淘汰）。旧值 64：视口 ~20 张 + 预热
 * 前方瓦片不断插入时，刚升级的全尺寸位图几帧内就被挤出、重新用兜底位图
 * 顶上 —— 表现为部分路网持续停留在低清。96 张 @450px ≈ 84MB，与位图共享
 * 缓存预算（112MB）同量级；低内存设备维持 56。
 */
const BITMAP_CACHE_LIMIT = (() => {
  try {
    const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (typeof gb === 'number' && gb > 0 && gb < 4) return 56;
  } catch {
    // 老内核没有 deviceMemory
  }
  return 96;
})();
/**
 * 每帧允许现烤（首次光栅化）的时间预算。旧实现固定每帧 2 张，实测桌面端
 * 一张 450px 全尺寸瓦片只要 1.3~2.1ms，镜头扫过新瓦片时 2 张根本不够，
 * 其余瓦片整帧都用 128px 兜底位图拉伸 3.5 倍绘制 —— 表现为播放中道路网
 * 「糊一下再变清晰」（长途骑行 13km/s 的地图流速下几乎全程存在）。
 * 改为按时间预算：桌面一帧能升 5~8 张即时清晰，慢设备自动少烤几张开不冻。
 */
const RASTER_BUDGET_MS = 10;
/** 单帧光栅化张数硬上限，防止个别超大瓦片把预算拖穿后仍无限烤。 */
const RASTER_MAX_TILES_PER_FRAME = 16;
/** 兜底位图边长：预算用完时的临时画面（约全尺寸 1/3 成本）。 */
const HURRY_SIZE = 256;
/** 总览层位图缓存字节预算：必须装得下一条长路线的全部瓦片（见 bitmapFor）。 */
const OVERVIEW_BITMAP_BUDGET = 192 * 1024 * 1024;

/**
 * 跨实例共享的 pbf 解析缓存。
 *
 * 每次进创作页都会重建图层实例，实例里的 parsed/active 全部作废，pbf 要
 * 重新解码。结果只取决于瓦片内容（与主题无关），共享后热进页可直接复用。
 * 上限按一次长途行程的瓦片量（总览 ~300 + 第一视角 ~200）再留余量。
 */
const parsedShared = new Map<string, ParsedTile>();
const PARSED_SHARED_LIMIT = 1600;

function sharedParsedGet(key: string): ParsedTile | undefined {
  return parsedShared.get(key);
}

function sharedParsedSet(key: string, parsed: ParsedTile): void {
  if (parsedShared.has(key)) return;
  parsedShared.set(key, parsed);
  if (parsedShared.size > PARSED_SHARED_LIMIT) {
    const oldest = parsedShared.keys().next();
    if (!oldest.done) parsedShared.delete(oldest.value);
  }
}

/**
 * 跨实例共享的位图缓存（光栅化结果）。键带主题 id（不同主题颜色不同）
 * 与 @尺寸，按字节预算淘汰。热进页时预热循环只剩让出，不再重烤。
 *
 * 预算必须盖住一次长途行程的完整工作集（实测 120km ≈ 67MB：总览 289 张
 * @139px ≈ 28MB + 第一视角 64 张 @~380px ≈ 39MB），否则 FIFO 预热顺序
 * 「先总览后第一视角」会互相挤掉，命中归零。按设备内存自适应：低端机
 * 缩水到 56MB（总览优先保住，第一视角部分命中）。
 */
const bitmapShared = new Map<string, TileBitmap>();
let bitmapSharedBytes = 0;
const BITMAP_SHARED_BUDGET = (() => {
  try {
    const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (typeof gb === 'number' && gb > 0 && gb < 4) return 56 * 1024 * 1024;
  } catch {
    // 老内核没有 deviceMemory
  }
  return 112 * 1024 * 1024;
})();

function bitmapEntryBytes(entry: TileBitmap): number {
  return (entry.size + BITMAP_PAD * 2) ** 2 * 4;
}

function sharedBitmapGet(themeId: string, cacheKey: string): TileBitmap | undefined {
  return bitmapShared.get(`${themeId}|${cacheKey}`);
}

function sharedBitmapSet(themeId: string, cacheKey: string, entry: TileBitmap): void {
  const key = `${themeId}|${cacheKey}`;
  if (bitmapShared.has(key)) return;
  bitmapShared.set(key, entry);
  bitmapSharedBytes += bitmapEntryBytes(entry);
  while (bitmapSharedBytes > BITMAP_SHARED_BUDGET && bitmapShared.size > 1) {
    const oldest = bitmapShared.keys().next();
    if (oldest.done) break;
    const evicted = bitmapShared.get(oldest.value);
    bitmapShared.delete(oldest.value);
    if (evicted) bitmapSharedBytes -= bitmapEntryBytes(evicted);
  }
}

export class VectorFollowLayer {
  readonly zoom = VECTOR_ZOOM;
  readonly segments: Segment[];
  readonly totalTiles: number;
  private readonly activity: Activity;
  private readonly theme: VideoTheme;
  /** 延展区专用位图缓存（key@aSize），与核心的 bitmaps 分开，避免两套尺寸互踢。 */
  private readonly ambientBitmaps = new Map<string, TileBitmap>();
  private readonly base: TrackMap;
  private readonly allKeys: string[];
  /** 缓存门内的核心走廊（±1 张），决定「正在缓存地图瓦片」的等待时间。 */
  private readonly coreKeys: string[];
  /** 延展走廊超出核心的部分（±2 张差集），后台补抓补解码。 */
  private readonly extraKeys: string[];
  private readonly active = new Map<string, ParsedTile>();
  private readonly parsed = new Map<string, ParsedTile>();
  private prefetched = false;
  private failed = 0;
  private priming: Promise<void> | null = null;
  private lastRequested = -1;
  private primed: number[] = [];
  private renderScale: number | null = null;
  private readonly bitmaps = new Map<string, TileBitmap>();

  constructor(activity: Activity, theme: VideoTheme, base: TrackMap) {
    this.activity = activity;
    this.theme = theme;
    this.base = base;
    this.segments = buildSegments(activity, TILE_BUFFER);
    const coreKeys = [...new Set(this.segments.flatMap((segment) => segment.keys))];
    // 扩展走廊（±2 张）供满宽预览的两侧延展地图使用；超出核心走廊的部分
    // 不阻塞缓存门，后台补齐（见 prefetchExtras）。
    const wide = buildSegments(activity, AMBIENT_BUFFER);
    const wideKeys = [...new Set(wide.flatMap((segment) => segment.keys))];
    const coreSet = new Set(coreKeys);
    this.coreKeys = coreKeys;
    this.extraKeys = wideKeys.filter((key) => !coreSet.has(key));
    this.allKeys = [...coreKeys, ...this.extraKeys];
    this.totalTiles = coreKeys.length;
  }

  get failedTiles(): number {
    return this.failed;
  }

  get ready(): boolean {
    return this.prefetched;
  }

  get activeCount(): number {
    return this.active.size;
  }

  async prefetch(onProgress?: (done: number, total: number) => void): Promise<void> {
    this.failed = 0;
    this.prefetched = false;
    // 冷路径批量预读 IDB，已缓存瓦片跳过逐条事务
    await readBlobsBatch(this.coreKeys);
    let cursor = 0;
    let done = 0;
    let aborted = false;
    const worker = async (): Promise<void> => {
      while (cursor < this.coreKeys.length && !aborted) {
        const key = this.coreKeys[cursor++];
        const [z, x, y] = key.split('/').map(Number);
        const blob = await fetchVectorTile(z, x, y);
        if (!blob) {
          this.failed += 1;
          // Fail fast when the device is offline instead of waiting for every
          // missing tile to time out. Successful tiles stay in IndexedDB.
          if (this.failed >= 8) aborted = true;
        }
        done += 1;
        onProgress?.(done, this.coreKeys.length);
      }
    };
    // 纯网络抓取（下载 + IndexedDB 写入），每步本来就是异步挂起的，
    // 不占主线程 —— 不再逐张让出，让连接保持打满。
    await Promise.all(Array.from({ length: 12 }, () => worker()));
    this.prefetched = this.failed === 0;
  }

  /** 后台补齐延展走廊：下载（IDB）→ 解码 → 进 active。不阻塞任何门。 */
  private async prefetchExtras(): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < this.extraKeys.length) {
        const key = this.extraKeys[cursor++];
        if (this.active.has(key)) continue;
        const sharedParsed = sharedParsedGet(key);
        if (sharedParsed) {
          this.parsed.set(key, sharedParsed);
          this.active.set(key, sharedParsed);
          continue;
        }
        const [z, x, y] = key.split('/').map(Number);
        const data = await fetchVectorTile(z, x, y);
        const parsed = data ? parseTile(data) : null;
        if (parsed) {
          sharedParsedSet(key, parsed);
          this.parsed.set(key, parsed);
          this.active.set(key, parsed);
        }
        await yieldIfBusy();
      }
    };
    await Promise.all(Array.from({ length: 4 }, () => worker()));
  }

  async primeAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.primed.length === this.segments.length && this.active.size >= this.coreKeys.length * 0.95) return;
    this.priming = this.primeKeys(this.coreKeys, onProgress);
    try {
      await this.priming;
    } finally {
      this.priming = null;
    }
    const missing = this.coreKeys.filter((key) => !this.active.has(key)).length;
    if (missing > 0) {
      throw new Error(`矢量缓存缺少 ${missing} 张瓦片`);
    }
    this.primed = this.segments.map((segment) => segment.index);
    this.lastRequested = this.segments.length - 1;
  }

  /**
   * 预渲染瓦片位图：缓存完成后、首次绘制前，把路线前段瓦片按目标屏幕尺寸
   * 逐张光栅化好（每张让出一拍，UI 保持可交互）。否则第一帧要现烤十几张
   * 瓦片，主线程冻住一两秒 —— 表现为「缓存完成后页面不能滑、点播放没反应」。
   */
  async warmBitmaps(scale: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    if (!this.active.size) return;
    const worldScale = 2 ** (VECTOR_ZOOM - this.base.zoom);
    const tilePixels = (TILE_SIZE / worldScale) * scale;
    this.renderScale = scale;
    const keys = this.allKeys.slice(0, BITMAP_CACHE_LIMIT);
    let done = 0;
    for (const key of keys) {
      const parsed = this.active.get(key);
      if (parsed) this.bitmapFor(parsed, tilePixels, key);
      done += 1;
      onProgress?.(done, keys.length);
      await yieldIfBusy();
    }
    // 预热独占主线程的阶段结束了，才让延展走廊在后台补抓补解码，
    // 避免和预热抢 CPU 拖慢「正在生成地图画面」。
    void this.prefetchExtras();
  }

  async prime(progress: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.primed.length === this.segments.length) return;
    const index = Math.min(this.segments.length - 1, Math.max(0, Math.floor(progress * this.segments.length)));
    const wanted = [index, Math.min(this.segments.length - 1, index + 1)];
    if (this.priming) await this.priming;
    if (this.lastRequested === index && wanted.every((value) => this.primed.includes(value))) return;
    this.lastRequested = index;
    this.priming = this.primeSegments(wanted, onProgress);
    try {
      await this.priming;
    } finally {
      this.priming = null;
    }
  }

  ensureForProgress(progress: number, onProgress?: (done: number, total: number) => void): void {
    void this.prime(progress, onProgress);
  }

  private async primeSegments(wanted: number[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const keys = [...new Set(wanted.flatMap((index) => this.segments[index].keys))];
    await this.primeKeys(keys, onProgress);
  }

  private async primeKeys(keys: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    // 注意：绝不 clear()。旧实现在换段 prime 时清空整个 active 再异步重建，
    // 重建的窗口期里视野内的瓦片全部缺失 —— 表现为播放中地图整块消失。
    // parsed 本来就保留全部解码结果，active 只增不减（内存与 parsed 持平，
    // 清它省不出任何东西）。
    let done = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < keys.length) {
        const key = keys[cursor++];
        if (!this.active.has(key)) {
          let parsed = this.parsed.get(key);
          if (!parsed) parsed = sharedParsedGet(key);
          if (!parsed) {
            const [z, x, y] = key.split('/').map(Number);
            const data = await fetchVectorTile(z, x, y);
            if (data) {
              parsed = parseTile(data) ?? undefined;
              if (parsed) {
                sharedParsedSet(key, parsed);
                this.parsed.set(key, parsed);
              }
            }
          }
          if (parsed) this.active.set(key, parsed);
        }
        done += 1;
        onProgress?.(done, keys.length);
        // parseTile 是同步解码。长距离骑行走线走廊有上百张瓦片，一路不让出
        // 会把主线程冻住数秒（创作页 85% 进度卡死就是这么来的）。8 个 worker
        // 会在同一轮事件循环里背靠背各解一张，所以必须每张必让出一拍。
        await yieldIfBusy();
      }
    };
    await Promise.all(Array.from({ length: 8 }, () => worker()));
  }

  /**
   * 预热镜头即将进入的瓦片（烤成全尺寸）。播放中 renderAt 每帧调用一次：
   * 按未来相机位置算可见范围，把还没到全尺寸的瓦片在镜头到达前烤好，
   * 与 draw 共用同一帧光栅化时间预算。这样路网在进入视野前就是清晰的，
   * 而不是进入视野后先用兜底位图顶一秒多（长途骑行 13km/s 的地图流速下
   * 表现为全程道路网发糊）。
   */
  prewarm(
    camera: MapCamera,
    stageWidth: number,
    stageHeight: number,
    deadline: { until: number } | null,
    maxTiles = 4,
  ): void {
    if (!this.active.size) return;
    const scale = camera.scale;
    // 与 draw 快路径同一条件：比例对不上时预热出来的尺寸会被丢弃，不做
    if (this.renderScale !== null && Math.abs(scale - this.renderScale) >= 0.002) return;
    const diff = VECTOR_ZOOM - this.base.zoom;
    const worldScale = 2 ** diff;
    const tileBaseSize = TILE_SIZE / worldScale;
    const tilePixels = Math.max(32, Math.round(tileBaseSize * scale));
    const left = camera.x - stageWidth / 2 / scale;
    const right = camera.x + stageWidth / 2 / scale;
    const top = camera.y - stageHeight / 2 / scale;
    const bottom = camera.y + stageHeight / 2 / scale;
    const x0 = Math.floor(((left + this.base.originX) * worldScale) / TILE_SIZE);
    const x1 = Math.floor(((right + this.base.originX) * worldScale) / TILE_SIZE);
    const y0 = Math.floor(((top + this.base.originY) * worldScale) / TILE_SIZE);
    const y1 = Math.floor(((bottom + this.base.originY) * worldScale) / TILE_SIZE);
    let done = 0;
    for (let tileX = x0; tileX <= x1; tileX += 1) {
      for (let tileY = y0; tileY <= y1; tileY += 1) {
        const key = `${VECTOR_ZOOM}/${tileX}/${tileY}`;
        const parsed = this.active.get(key);
        if (!parsed) continue;
        const cached = this.bitmaps.get(key);
        if (cached && cached.size === tilePixels) continue;
        if (done >= maxTiles || deadline === null || performance.now() >= deadline.until) return;
        this.bitmapFor(parsed, tilePixels, key);
        done += 1;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, camera: MapCamera, stageWidth: number, stageHeight: number, deadline?: { until: number } | null): boolean {
    if (!this.active.size) return false;
    const diff = VECTOR_ZOOM - this.base.zoom;
    const worldScale = 2 ** diff;
    const tileBaseSize = TILE_SIZE / worldScale;
    const scale = camera.scale;
    const left = camera.x - stageWidth / 2 / scale;
    const right = camera.x + stageWidth / 2 / scale;
    const top = camera.y - stageHeight / 2 / scale;
    const bottom = camera.y + stageHeight / 2 / scale;
    const x0 = Math.floor(((left + this.base.originX) * worldScale) / TILE_SIZE) - 1;
    const x1 = Math.floor(((right + this.base.originX) * worldScale) / TILE_SIZE) + 1;
    const y0 = Math.floor(((top + this.base.originY) * worldScale) / TILE_SIZE) - 1;
    const y1 = Math.floor(((bottom + this.base.originY) * worldScale) / TILE_SIZE) + 1;

    ctx.save();
    ctx.fillStyle = rgb(this.theme.map.background);
    ctx.fillRect(0, 0, stageWidth, stageHeight);

    // Fast path: the follow camera only pans, so camera.scale stays equal to the
    // scale each tile was rasterised at. Blitting the cached tile images keeps
    // the same pixels per tile as the vector path below (1:1, integer offsets,
    // no rescaling) while removing thousands of per-frame strokes.
    const tilePixels = tileBaseSize * scale;
    if (this.renderScale === null) this.renderScale = scale;
    const deadlineUntil = deadline?.until ?? performance.now() + RASTER_BUDGET_MS;
    if (Math.abs(scale - this.renderScale) < 0.002) {
      const fastX0 = Math.floor(((left + this.base.originX) * worldScale) / TILE_SIZE);
      const fastX1 = Math.floor(((right + this.base.originX) * worldScale) / TILE_SIZE);
      const fastY0 = Math.floor(((top + this.base.originY) * worldScale) / TILE_SIZE);
      const fastY1 = Math.floor(((bottom + this.base.originY) * worldScale) / TILE_SIZE);
      let painted = 0;
      let rasterized = 0;
      const rasterBudgetLeft = (): boolean =>
        rasterized < RASTER_MAX_TILES_PER_FRAME
        && performance.now() < deadlineUntil;
      const dbg = (window as unknown as { __fmDrawDbg?: unknown }).__fmDrawDbg;
      for (let tileX = fastX0; tileX <= fastX1; tileX += 1) {
        for (let tileY = fastY0; tileY <= fastY1; tileY += 1) {
          const key = `${VECTOR_ZOOM}/${tileX}/${tileY}`;
          const parsed = this.active.get(key);
          if (!parsed) {
            if (dbg) (dbg as { missActive: string[] }).missActive.push(key);
            continue;
          }
          let cached = this.bitmaps.get(key);
          if (cached && cached.size === Math.max(32, Math.round(tilePixels))) {
            // LRU touch：重插把命中位图移到队尾，避免纯 FIFO 淘汰把
            // 视野内常用瓦片挤出（预热每帧都在往队尾插新瓦片）
            this.bitmaps.delete(key);
            this.bitmaps.set(key, cached);
          } else {
            if (!rasterBudgetLeft()) {
              // 预算用完也不留白：复用任何现成位图，或现烤一张约 256px 的
              // 低清兜底（像素量约 1/3，成本 1/3），先把画面顶上去；
              // 之后帧有预算时走 bitmapFor 自动升级成全尺寸位图。
              cached = this.hurryBitmapFor(parsed, key) ?? undefined;
              if (!cached) {
                if (dbg) (dbg as { missBudget: string[] }).missBudget.push(key);
                continue;
              }
            } else {
              rasterized += 1;
              cached = this.bitmapFor(parsed, tilePixels, key);
            }
          }
          const bitmap = cached;
          if (dbg && bitmap.size < Math.max(32, Math.round(tilePixels)) - 1) {
            (dbg as { lowRes: string[] }).lowRes.push(`${key}@${bitmap.size}<${Math.round(tilePixels)}`);
          }
          const screenX = stageWidth / 2 + (tileX * tileBaseSize - this.base.originX - camera.x) * scale;
          const screenY = stageHeight / 2 + (tileY * tileBaseSize - this.base.originY - camera.y) * scale;
          // 位图边长可能与屏幕瓦片尺寸不同（兜底位图更小）：按比例拉伸绘制，
          // pad 边距同步缩放，保证瓦片内容对齐屏幕网格。
          const k = tilePixels / bitmap.size;
          ctx.drawImage(
            bitmap.canvas,
            Math.round(screenX - BITMAP_PAD * k),
            Math.round(screenY - BITMAP_PAD * k),
            Math.ceil(bitmap.canvas.width * k),
            Math.ceil(bitmap.canvas.height * k),
          );
          painted += 1;
        }
      }
      if (painted > 0) {
        ctx.restore();
        return true;
      }
    }

    const projectPoint = (tileX: number, tileY: number, point: TilePoint, extent: number): { x: number; y: number } => {      const worldX = tileX * tileBaseSize + (point.x / extent) * tileBaseSize - this.base.originX;
      const worldY = tileY * tileBaseSize + (point.y / extent) * tileBaseSize - this.base.originY;
      return {
        x: stageWidth / 2 + (worldX - camera.x) * scale,
        y: stageHeight / 2 + (worldY - camera.y) * scale,
      };
    };

    const visible = (x: number, y: number): boolean =>
      x > 0 && x < stageWidth && y > 0 && y < stageHeight;

    const paintPolygon = (
      tileX: number,
      tileY: number,
      parsed: ParsedTile,
      feature: any,
      fill: string,
      alpha = 1,
    ): void => {
      const rings = feature.loadGeometry() as TilePoint[][];
      const path = new Path2D();
      let hasPoint = false;
      for (const ring of rings) {
        let started = false;
        for (const point of ring) {
          const screen = projectPoint(tileX, tileY, point, parsed.extent);
          if (!started) {
            path.moveTo(screen.x, screen.y);
            started = true;
          } else {
            path.lineTo(screen.x, screen.y);
          }
          hasPoint = true;
        }
        path.closePath();
      }
      if (!hasPoint) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fill(path, 'evenodd');
      ctx.globalAlpha = 1;
    };

    const paintLine = (
      tileX: number,
      tileY: number,
      parsed: ParsedTile,
      feature: any,
      color: string,
      width: number,
    ): void => {
      const geometry = feature.loadGeometry() as TilePoint[][];
      for (const line of geometry) {
        if (line.length < 2) continue;
        ctx.beginPath();
        let started = false;
        let visibleLine = false;
        for (const point of line) {
          const screen = projectPoint(tileX, tileY, point, parsed.extent);
          if (!started) {
            ctx.moveTo(screen.x, screen.y);
            started = true;
          } else {
            ctx.lineTo(screen.x, screen.y);
          }
          if (visible(screen.x, screen.y)) visibleLine = true;
        }
        if (!visibleLine) continue;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    };

    const range: Array<{ x: number; y: number; parsed: ParsedTile }> = [];
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const parsed = this.active.get(`${VECTOR_ZOOM}/${x}/${y}`);
        if (parsed) range.push({ x, y, parsed });
      }
    }
    if (!range.length) {
      ctx.restore();
      return false;
    }

    const map = this.theme.map;
    const layers = ['landcover', 'landuse', 'park', 'building', 'water'];
    for (const layerName of layers) {
      for (const item of range) {
        const layer = item.parsed.tile.layers[layerName] as any;
        if (!layer) continue;
        for (let index = 0; index < layer.length; index += 1) {
          const feature = layer.feature(index);
          if (feature.type !== 3) continue;
          const fill = layerName === 'water' ? rgb(map.water) : layerName === 'park' ? rgb(map.park) : rgb(map.building);
          paintPolygon(item.x, item.y, item.parsed, feature, fill, layerName === 'landcover' ? 0.55 : 0.9);
        }
      }
    }

    // Buildings and water lines.
    for (const item of range) {
      const waterway = item.parsed.tile.layers.waterway as any;
      if (waterway) {
        for (let index = 0; index < waterway.length; index += 1) {
          const feature = waterway.feature(index);
          if (feature.type === 2) paintLine(item.x, item.y, item.parsed, feature, rgb(map.water), 3);
        }
      }
    }

    // Two-pass roads: casing under a crisp fill.
    const classes: Record<string, number> = {
      motorway: 7,
      trunk: 6.5,
      primary: 5.5,
      secondary: 4.5,
      tertiary: 3.6,
      minor: 2.8,
      service: 1.7,
      path: 1.2,
      rail: 1.2,
    };
    for (const item of range) {
      const roads = item.parsed.tile.layers.transportation as any;
      if (!roads) continue;
      for (let index = 0; index < roads.length; index += 1) {
        const feature = roads.feature(index);
        if (feature.type !== 2) continue;
        const className = String(feature.properties.class ?? 'minor');
        const width = classes[className] ?? 1.5;
        if (className === 'rail') {
          paintLine(item.x, item.y, item.parsed, feature, rgb(map.transit), width);
          continue;
        }
        paintLine(item.x, item.y, item.parsed, feature, rgb(map.roadEdge), width + 2.4);
      }
    }
    for (const item of range) {
      const roads = item.parsed.tile.layers.transportation as any;
      if (!roads) continue;
      for (let index = 0; index < roads.length; index += 1) {
        const feature = roads.feature(index);
        if (feature.type !== 2) continue;
        const className = String(feature.properties.class ?? 'minor');
        if (className === 'rail') continue;
        const width = classes[className] ?? 1.5;
        paintLine(item.x, item.y, item.parsed, feature, rgb(map.road), width);
      }
    }
    ctx.restore();
    return true;
  }

  /**
   * Rasterise one tile at exactly the size it will be drawn on screen. The
   * result is pixel-for-pixel what the vector path would paint, so caching it
   * costs no quality — only the repeated work of projecting and stroking a few
   * thousand features per frame.
   */
  private bitmapFor(parsed: ParsedTile, sizePx: number, key: string): TileBitmap {
    const size = Math.max(32, Math.round(sizePx));
    const cached = this.bitmaps.get(key);
    if (cached && cached.size === size) return cached;
    // 跨实例共享：重建图层后位图不再重烤（预热只剩让出，毫秒级）
    const shared = sharedBitmapGet(this.theme.id, `${key}@${size}`);
    if (shared) {
      if (this.bitmaps.size >= BITMAP_CACHE_LIMIT) {
        const oldest = this.bitmaps.keys().next();
        if (!oldest.done) this.bitmaps.delete(oldest.value);
      }
      this.bitmaps.set(key, shared);
      return shared;
    }
    const entry = this.rasterizeTile(parsed, size);
    if (this.bitmaps.size >= BITMAP_CACHE_LIMIT) {
      const oldest = this.bitmaps.keys().next();
      if (!oldest.done) this.bitmaps.delete(oldest.value);
    }
    this.bitmaps.set(key, entry);
    sharedBitmapSet(this.theme.id, `${key}@${size}`, entry);
    return entry;
  }

  /**
   * 低清兜底位图：光栅化预算用完时的「不空白」保险。256px 现烤一张顶上
   * （相对 450px 全尺寸像素量约 1/3、成本 1/3），拉伸倍率从旧 128 方案的
   * 3.5x 降到 1.76x —— 兜底帧的路网只是略柔，不再是明显糊掉的粗线；
   * key 与全尺寸位图共用，之后帧有预算时自动升级。
   */
  private hurryBitmapFor(parsed: ParsedTile, key: string): TileBitmap | null {
    const cached = this.bitmaps.get(key);
    // 已有任何尺寸的位图（哪怕不是当前屏幕尺寸）都比空白强，直接复用，
    // 绘制端会按 tilePixels/bitmap.size 拉伸对齐。
    if (cached) return cached;
    const shared = sharedBitmapGet(this.theme.id, `${key}@${HURRY_SIZE}`);
    if (shared) return shared;
    const entry = this.rasterizeTile(parsed, HURRY_SIZE);
    if (this.bitmaps.size >= BITMAP_CACHE_LIMIT) {
      const oldest = this.bitmaps.keys().next();
      if (!oldest.done) this.bitmaps.delete(oldest.value);
    }
    this.bitmaps.set(key, entry);
    sharedBitmapSet(this.theme.id, `${key}@${HURRY_SIZE}`, entry);
    return entry;
  }

  /** 每张瓦片的标签候选（世界坐标，每张只解码一次，绘制只做投影+碰撞）。 */
  private labelCandidates = new Map<string, Array<{ name: string; kind: string; score: number; wx: number; wy: number; road?: boolean }>>();

  /**
   * 解码一张瓦片的标签候选。以前 drawLabels 每帧对视野内全部瓦片跑
   * loadGeometry()（pbf 解码 + 数组分配），一帧可达数百毫秒 —— 是预览全程
   * 掉帧、结尾成绩卡段时间冻住、播完页面冻结的主源。改为按瓦片缓存后，
   * 绘制循环里只剩投影和少量文本测量。
   */
  private labelCandidatesFor(tileX: number, tileY: number, parsed: ParsedTile): Array<{ name: string; kind: string; score: number; wx: number; wy: number; road?: boolean }> {
    const tileBaseSize = TILE_SIZE / 2 ** (VECTOR_ZOOM - this.base.zoom);
    const world = (point: TilePoint, extent: number): { wx: number; wy: number } => ({
      wx: tileX * tileBaseSize + (point.x / extent) * tileBaseSize - this.base.originX,
      wy: tileY * tileBaseSize + (point.y / extent) * tileBaseSize - this.base.originY,
    });
    const out: Array<{ name: string; kind: string; score: number; wx: number; wy: number; road?: boolean }> = [];
    const allowed: Record<string, { max: number; kind: string; priority: number }> = {
      attraction: { max: 12, kind: 'star', priority: 2 },
      museum: { max: 12, kind: 'museum', priority: 1 },
      monument: { max: 10, kind: 'monument', priority: 1 },
      castle: { max: 10, kind: 'castle', priority: 2 },
      place_of_worship: { max: 8, kind: 'temple', priority: 3 },
      park: { max: 6, kind: 'tree', priority: 4 },
      mountain_peak: { max: 10, kind: 'mountain', priority: 1 },
    };
    const poi = parsed.tile.layers.poi as any;
    if (poi) {
      for (let index = 0; index < poi.length; index += 1) {
        const feature = poi.feature(index);
        const props = feature.properties;
        const rule = allowed[String(props.class ?? '')];
        if (!rule) continue;
        const name = String(props.name ?? '').trim();
        if (!name) continue;
        const rank = Number(props.rank ?? 99);
        if (!Number.isFinite(rank) || rank > rule.max) continue;
        const geometry = feature.loadGeometry() as TilePoint[][];
        const point = geometry[0]?.[0];
        if (!point) continue;
        const { wx, wy } = world(point, parsed.extent);
        out.push({ name, kind: rule.kind, score: rule.priority * 100 + rank, wx, wy });
      }
    }
    const peaks = parsed.tile.layers.mountain_peak as any;
    if (peaks) {
      for (let index = 0; index < peaks.length; index += 1) {
        const feature = peaks.feature(index);
        const name = String(feature.properties.name ?? '').trim();
        if (!name) continue;
        const rank = Number(feature.properties.rank ?? 99);
        if (!Number.isFinite(rank) || rank > 10) continue;
        const geometry = feature.loadGeometry() as TilePoint[][];
        const point = geometry[0]?.[0];
        if (!point) continue;
        const { wx, wy } = world(point, parsed.extent);
        out.push({ name, kind: 'mountain', score: 100 + rank, wx, wy });
      }
    }
    const names = parsed.tile.layers.transportation_name as any;
    if (names) {
      const classPriority: Record<string, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3 };
      for (let index = 0; index < names.length; index += 1) {
        const feature = names.feature(index);
        const props = feature.properties;
        const refs = String(props.ref ?? '').split(';').map((ref) => ref.trim()).filter((ref) => /^G\d{1,3}$/.test(ref));
        if (!refs.length) continue;
        const geometry = feature.loadGeometry() as TilePoint[][];
        let line = geometry[0];
        for (const candidate of geometry) if (candidate.length > (line?.length ?? 0)) line = candidate;
        if (!line || line.length < 2) continue;
        const middle = line[Math.floor(line.length / 2)];
        const { wx, wy } = world(middle, parsed.extent);
        out.push({ name: refs[0], kind: 'road', score: (classPriority[String(props.class)] ?? 4) * 100, wx, wy, road: true });
      }
    }
    return out;
  }

  /** 把一张瓦片按目标像素尺寸光栅化成离屏画布（bitmapFor / drawAmbient 共用）。 */
  private rasterizeTile(parsed: ParsedTile, size: number): TileBitmap {
    const canvas = document.createElement('canvas');
    canvas.width = size + BITMAP_PAD * 2;
    canvas.height = size + BITMAP_PAD * 2;
    const target = canvas.getContext('2d');
    if (target) {
      target.translate(BITMAP_PAD, BITMAP_PAD);
      this.paintTile(target, parsed, size, size + BITMAP_PAD * 2, size + BITMAP_PAD * 2);
    }
    return { canvas, size, pad: BITMAP_PAD };
  }

  /**
   * 延展区绘制（预览视频核心两侧的低清氛围地图）：与核心同一相机视角的
   * 左右延伸。位图优先从核心位图降采样派生（纯 drawImage，零解码成本，
   * 也不会和核心互踢缓存），没有核心位图时才现烤；延展是压暗的氛围图，
   * 低清没有观感代价，但绝不能留底色空白（播放快于光栅化时整侧发灰）。
   */
  drawAmbient(ctx: CanvasRenderingContext2D, camera: MapCamera, stageWidth: number, stageHeight: number): boolean {
    if (!this.active.size) return false;
    const diff = VECTOR_ZOOM - this.base.zoom;
    const worldScale = 2 ** diff;
    const tileBaseSize = TILE_SIZE / worldScale;
    const scale = camera.scale;
    const left = camera.x - stageWidth / 2 / scale;
    const right = camera.x + stageWidth / 2 / scale;
    const top = camera.y - stageHeight / 2 / scale;
    const bottom = camera.y + stageHeight / 2 / scale;
    const x0 = Math.floor(((left + this.base.originX) * worldScale) / TILE_SIZE) - 1;
    const x1 = Math.floor(((right + this.base.originX) * worldScale) / TILE_SIZE) + 1;
    const y0 = Math.floor(((top + this.base.originY) * worldScale) / TILE_SIZE) - 1;
    const y1 = Math.floor(((bottom + this.base.originY) * worldScale) / TILE_SIZE) + 1;

    ctx.fillStyle = rgb(this.theme.map.background);
    ctx.fillRect(0, 0, stageWidth, stageHeight);

    const tilePixels = tileBaseSize * scale;
    let painted = 0;
    for (let tileX = x0; tileX <= x1; tileX += 1) {
      for (let tileY = y0; tileY <= y1; tileY += 1) {
        const key = `${VECTOR_ZOOM}/${tileX}/${tileY}`;
        const parsed = this.active.get(key);
        if (!parsed) {
          const dbgA = (window as unknown as { __fmDrawDbg?: unknown }).__fmDrawDbg;
          if (dbgA) (dbgA as { missActiveAmbient: string[] }).missActiveAmbient.push(key);
          continue;
        }
        const screenX = stageWidth / 2 + (tileX * tileBaseSize - this.base.originX - camera.x) * scale;
        const screenY = stageHeight / 2 + (tileY * tileBaseSize - this.base.originY - camera.y) * scale;
        const size = Math.max(32, Math.round(tilePixels));
        const cacheKey = `${key}@a${size}`;
        let bitmap = this.ambientBitmaps.get(cacheKey);
        if (!bitmap) {
          bitmap = this.deriveAmbientBitmap(key, size);
          if (this.ambientBitmaps.size >= 96) {
            const oldest = this.ambientBitmaps.keys().next();
            if (!oldest.done) this.ambientBitmaps.delete(oldest.value);
          }
          this.ambientBitmaps.set(cacheKey, bitmap);
        }
        ctx.drawImage(bitmap.canvas, Math.round(screenX) - bitmap.pad, Math.round(screenY) - bitmap.pad);
        painted += 1;
      }
    }
    return painted > 0;
  }

  /**
   * 生成一张延展位图：优先把核心位图（任意尺寸）降采样到目标尺寸 —— 两侧
   * 是压暗低清氛围，缩放的柔化正好；核心位图还没有时才现场光栅化一张小图。
   */
  private deriveAmbientBitmap(key: string, size: number): TileBitmap {
    const core = this.bitmaps.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = size + BITMAP_PAD * 2;
    canvas.height = size + BITMAP_PAD * 2;
    const target = canvas.getContext('2d');
    if (target && core) {
      target.imageSmoothingEnabled = true;
      target.imageSmoothingQuality = 'high';
      target.drawImage(core.canvas, 0, 0, core.canvas.width, core.canvas.height, 0, 0, canvas.width, canvas.height);
      return { canvas, size, pad: BITMAP_PAD };
    }
    if (target) {
      const parsed = this.active.get(key);
      if (parsed) {
        target.translate(BITMAP_PAD, BITMAP_PAD);
        this.paintTile(target, parsed, size, size + BITMAP_PAD * 2, size + BITMAP_PAD * 2);
      }
    }
    return { canvas, size, pad: BITMAP_PAD };
  }

  /** Draws one tile in its own pixel space; the caller supplies the origin. */
  private paintTile(
    target: CanvasRenderingContext2D,
    parsed: ParsedTile,
    sizePx: number,
    viewW: number,
    viewH: number,
  ): void {
    const unit = sizePx / parsed.extent;
    const inView = (x: number, y: number): boolean => x > -16 && x < viewW + 16 && y > -16 && y < viewH + 16;

    const fillPolygon = (feature: any, fill: string, alpha: number): void => {
      const rings = feature.loadGeometry() as TilePoint[][];
      const path = new Path2D();
      let hasPoint = false;
      for (const ring of rings) {
        let started = false;
        for (const point of ring) {
          const x = point.x * unit;
          const y = point.y * unit;
          if (!started) {
            path.moveTo(x, y);
            started = true;
          } else {
            path.lineTo(x, y);
          }
          hasPoint = true;
        }
        path.closePath();
      }
      if (!hasPoint) return;
      target.globalAlpha = alpha;
      target.fillStyle = fill;
      target.fill(path, 'evenodd');
      target.globalAlpha = 1;
    };

    const strokeLine = (feature: any, color: string, width: number): void => {
      const geometry = feature.loadGeometry() as TilePoint[][];
      for (const line of geometry) {
        if (line.length < 2) continue;
        target.beginPath();
        let started = false;
        let visibleLine = false;
        for (const point of line) {
          const x = point.x * unit;
          const y = point.y * unit;
          if (!started) {
            target.moveTo(x, y);
            started = true;
          } else {
            target.lineTo(x, y);
          }
          if (inView(x, y)) visibleLine = true;
        }
        if (!visibleLine) continue;
        target.strokeStyle = color;
        target.lineWidth = width;
        target.lineCap = 'round';
        target.lineJoin = 'round';
        target.stroke();
      }
    };

    const map = this.theme.map;
    const layers = parsed.tile.layers as Record<string, any>;

    // Polygons stay inside their own tile; a 1px bleed keeps edges seamless.
    target.save();
    target.beginPath();
    target.rect(-1, -1, viewW + 2, viewH + 2);
    target.clip();
    for (const name of ['landcover', 'landuse', 'park', 'building', 'water']) {
      const layer = layers[name];
      if (!layer) continue;
      const fill = name === 'water' ? rgb(map.water) : name === 'park' ? rgb(map.park) : rgb(map.building);
      const alpha = name === 'landcover' ? 0.55 : 0.9;
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        if (feature.type !== 3) continue;
        fillPolygon(feature, fill, alpha);
      }
    }
    target.restore();

    const waterway = layers.waterway;
    if (waterway) {
      for (let index = 0; index < waterway.length; index += 1) {
        const feature = waterway.feature(index);
        if (feature.type === 2) strokeLine(feature, rgb(map.water), 3);
      }
    }

    // Two-pass roads: casing under a crisp fill, mirroring the vector path.
    const classes: Record<string, number> = {
      motorway: 7,
      trunk: 6.5,
      primary: 5.5,
      secondary: 4.5,
      tertiary: 3.6,
      minor: 2.8,
      service: 1.7,
      path: 1.2,
      rail: 1.2,
    };
    const roads = layers.transportation;
    if (!roads) return;
    for (let index = 0; index < roads.length; index += 1) {
      const feature = roads.feature(index);
      if (feature.type !== 2) continue;
      const className = String(feature.properties.class ?? 'minor');
      const width = classes[className] ?? 1.5;
      if (className === 'rail') {
        strokeLine(feature, rgb(map.transit), width);
        continue;
      }
      strokeLine(feature, rgb(map.roadEdge), width + 2.4);
    }
    for (let index = 0; index < roads.length; index += 1) {
      const feature = roads.feature(index);
      if (feature.type !== 2) continue;
      const className = String(feature.properties.class ?? 'minor');
      if (className === 'rail') continue;
      strokeLine(feature, rgb(map.road), classes[className] ?? 1.5);
    }
  }

  drawFinalLabels(ctx: CanvasRenderingContext2D, camera: MapCamera, stageWidth: number, stageHeight: number): void {
    const scale = camera.scale;
    const zoom = this.base.zoom;
    const worldToScreen = (worldX: number, worldY: number): { x: number; y: number } => ({
      x: stageWidth / 2 + (worldX - this.base.originX - camera.x) * scale,
      y: stageHeight / 2 + (worldY - this.base.originY - camera.y) * scale,
    });
    const safeTop = 92;
    const safeBottom = stageHeight - 430;
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    const overlaps = (x: number, y: number, w: number, h: number): boolean =>
      boxes.some((box) => x < box.x + box.w + 10 && x + w + 10 > box.x && y < box.y + box.h + 8 && y + h + 8 > box.y);

    const drawPill = (x: number, y: number, w: number, h: number, accent: string, radius: number): void => {
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radius);
      else ctx.rect(x, y, w, h);
      ctx.fillStyle = 'rgba(5, 17, 24, 0.88)';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    };

    const tryPlace = (px: number, py: number, w: number, h: number): { x: number; y: number } | null => {
      const positions: Array<[number, number]> = [
        [px - w / 2, py - h / 2],
        [px - w / 2, py - h - 20],
        [px - w / 2, py + 20],
        [px + 20, py - h / 2],
        [px - w - 20, py - h / 2],
      ];
      const angles = [-Math.PI / 2, -Math.PI / 3, (-2 * Math.PI) / 3, 0, Math.PI, Math.PI / 3, (2 * Math.PI) / 3, -Math.PI / 6, (-5 * Math.PI) / 6, Math.PI / 6, (5 * Math.PI) / 6];
      for (const radius of [38, 64, 92, 124, 156]) {
        for (const angle of angles) {
          positions.push([px + Math.cos(angle) * radius - w / 2, py + Math.sin(angle) * radius - h / 2]);
        }
      }
      for (const [rawX, rawY] of positions) {
        const x = Math.max(18, Math.min(stageWidth - w - 18, rawX));
        const y = Math.max(safeTop, Math.min(safeBottom - h, rawY));
        if (!overlaps(x, y, w, h)) {
          boxes.push({ x, y, w, h });
          return { x, y };
        }
      }
      return null;
    };

    const drawLeader = (px: number, py: number, x: number, y: number, w: number, h: number): void => {
      const lx = Math.max(x, Math.min(x + w, px));
      const ly = Math.max(y, Math.min(y + h, py));
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(lx, ly);
      ctx.strokeStyle = 'rgba(216, 255, 62, 0.58)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = '#d8ff3e';
      ctx.fill();
    };

    const roads: Array<{ name: string; x: number; y: number; priority: number }> = [];
    const seenRoads = new Set<string>();
    const diff = VECTOR_ZOOM - zoom;
    const worldScale = 2 ** diff;
    const tileBaseSize = TILE_SIZE / worldScale;
    for (const [key, parsed] of this.active) {
      const [tileX, tileY] = key.split('/').map(Number);
      const layer = parsed.tile.layers.transportation_name as any;
      if (!layer) continue;
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        const props = feature.properties;
        const refs = String(props.ref ?? '').split(';').map((ref) => ref.trim()).filter((ref) => /^G\d{1,3}$/.test(ref));
        if (!refs.length || seenRoads.has(refs[0])) continue;
        const geometry = feature.loadGeometry() as TilePoint[][];
        let line = geometry[0];
        for (const candidate of geometry) if (candidate.length > (line?.length ?? 0)) line = candidate;
        if (!line || line.length < 2) continue;
        const point = line[Math.floor(line.length / 2)];
        const worldX = tileX * tileBaseSize + (point.x / parsed.extent) * tileBaseSize;
        const worldY = tileY * tileBaseSize + (point.y / parsed.extent) * tileBaseSize;
        const screen = worldToScreen(worldX, worldY);
        if (screen.x < 24 || screen.x > stageWidth - 24 || screen.y < safeTop || screen.y > safeBottom) continue;
        seenRoads.add(refs[0]);
        const priorities: Record<string, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3 };
        roads.push({ name: refs[0], x: screen.x, y: screen.y, priority: priorities[String(props.class)] ?? 4 });
      }
    }
    roads.sort((a, b) => a.priority - b.priority);
    const zhFont = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    const displayFont = '"Barlow Condensed", "PingFang SC", sans-serif';
    let roadCount = 0;
    for (const item of roads) {
      if (roadCount >= 4) break;
      ctx.font = `600 18px ${displayFont}`;
      const refWidth = ctx.measureText(item.name).width;
      ctx.font = `500 10px ${zhFont}`;
      const unitWidth = ctx.measureText('国道').width;
      const width = 32 + refWidth + unitWidth + 16;
      const height = 36;
      const placed = tryPlace(item.x, item.y, width, height);
      if (!placed) continue;
      drawLeader(item.x, item.y, placed.x, placed.y, width, height);
      drawPill(placed.x, placed.y, width, height, 'rgba(216, 255, 62, 0.62)', 9);
      ctx.beginPath();
      ctx.arc(placed.x + 17, placed.y + height / 2, 9, 0, Math.PI * 2);
      ctx.strokeStyle = '#d8ff3e';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(placed.x + 12, placed.y + 22);
      ctx.lineTo(placed.x + 17, placed.y + 12);
      ctx.lineTo(placed.x + 22, placed.y + 22);
      ctx.stroke();
      ctx.font = `600 18px ${displayFont}`;
      ctx.fillStyle = '#d8ff3e';
      ctx.textAlign = 'left';
      ctx.fillText(item.name, placed.x + 31, placed.y + 23);
      ctx.font = `500 10px ${zhFont}`;
      ctx.fillStyle = '#a4b37a';
      ctx.fillText('国道', placed.x + 31 + refWidth + 4, placed.y + 22);
      roadCount += 1;
    }
  }

  drawLabels(ctx: CanvasRenderingContext2D, camera: MapCamera, stageWidth: number, stageHeight: number): void {
    if (!this.active.size) return;
    const scale = camera.scale;
    const left = camera.x - stageWidth / 2 / scale;
    const right = camera.x + stageWidth / 2 / scale;
    const top = camera.y - stageHeight / 2 / scale;
    const bottom = camera.y + stageHeight / 2 / scale;
    const x0 = Math.floor(((left + this.base.originX) * 2 ** (VECTOR_ZOOM - this.base.zoom)) / TILE_SIZE) - 1;
    const x1 = Math.floor(((right + this.base.originX) * 2 ** (VECTOR_ZOOM - this.base.zoom)) / TILE_SIZE) + 1;
    const y0 = Math.floor(((top + this.base.originY) * 2 ** (VECTOR_ZOOM - this.base.zoom)) / TILE_SIZE) - 1;
    const y1 = Math.floor(((bottom + this.base.originY) * 2 ** (VECTOR_ZOOM - this.base.zoom)) / TILE_SIZE) + 1;

    const safeTop = 278;
    const safeBottom = stageHeight - 480;
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
    const overlaps = (x: number, y: number, w: number, h: number): boolean =>
      boxes.some((box) => x < box.x + box.w + 8 && x + w + 8 > box.x && y < box.y + box.h + 6 && y + h + 6 > box.y);
    const clampX = (x: number, w: number): number => Math.max(18, Math.min(stageWidth - w - 18, x));
    const clampY = (y: number, h: number): number => Math.max(safeTop, Math.min(safeBottom - h, y));

    const zhFont = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    const displayFont = '"Barlow Condensed", "PingFang SC", sans-serif';

    const drawPill = (x: number, y: number, w: number, h: number, accent: string): void => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 9);
      ctx.fillStyle = 'rgba(5, 18, 26, 0.82)';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    // 从缓存取视野内候选（世界坐标 → 屏幕坐标），每帧最多现解码 2 张新瓦片
    let decoded = 0;
    const projected: Array<{ name: string; score: number; x: number; y: number; road?: boolean }> = [];
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${VECTOR_ZOOM}/${x}/${y}`;
        const parsed = this.active.get(key);
        if (!parsed) continue;
        let list = this.labelCandidates.get(key);
        if (!list) {
          if (decoded >= 2) continue;
          decoded += 1;
          list = this.labelCandidatesFor(x, y, parsed);
          this.labelCandidates.set(key, list);
        }
        for (const item of list) {
          const px = stageWidth / 2 + (item.wx - camera.x) * scale;
          const py = stageHeight / 2 + (item.wy - camera.y) * scale;
          if (item.road) {
            if (px < 24 || px > stageWidth - 24 || py < safeTop || py > safeBottom) continue;
          } else if (px < 18 || px > stageWidth - 18 || py < safeTop || py > safeBottom) {
            continue;
          }
          projected.push({ name: item.name, score: item.score, x: px, y: py, road: item.road });
        }
      }
    }

    const landmarks = projected
      .filter((item) => !item.road)
      .sort((a, b) => a.score - b.score);
    const seenNames = new Set<string>();
    const uniqueLandmarks: Array<{ name: string; x: number; y: number }> = [];
    for (const item of landmarks) {
      if (seenNames.has(item.name)) continue;
      seenNames.add(item.name);
      uniqueLandmarks.push({ name: item.name, x: item.x, y: item.y });
    }
    let landmarkCount = 0;
    for (const item of uniqueLandmarks) {
      if (landmarkCount >= 4) break;
      ctx.font = `500 15px ${zhFont}`;
      const textWidth = Math.min(176, ctx.measureText(item.name).width);
      // Text-only labels: the illustrated landmark badges were dropped so the
      // live preview matches the exported video, which shows names alone.
      const width = textWidth + 22;
      const height = 30;
      const x = clampX(item.x - width / 2, width);
      const y = clampY(item.y - height / 2, height);
      if (overlaps(x, y, width, height)) continue;
      drawPill(x, y, width, height, 'rgba(216, 255, 62, 0.35)');
      ctx.font = `500 15px ${zhFont}`;
      ctx.fillStyle = '#efffe8';
      ctx.textAlign = 'left';
      ctx.fillText(item.name, x + 11, y + 20);
      boxes.push({ x, y, w: width, h: height });
      landmarkCount += 1;
    }

    const roadAll = projected
      .filter((item) => item.road)
      .sort((a, b) => a.score - b.score);
    const roads: Array<{ name: string; x: number; y: number }> = [];
    const seenRoads = new Set<string>();
    for (const item of roadAll) {
      if (seenRoads.has(item.name)) continue;
      seenRoads.add(item.name);
      roads.push({ name: item.name, x: item.x, y: item.y });
    }
    let roadCount = 0;
    for (const item of roads) {
      if (roadCount >= 3) break;
      ctx.font = `600 16px ${displayFont}`;
      const refWidth = ctx.measureText(item.name).width;
      ctx.font = `500 10px ${zhFont}`;
      const unitWidth = ctx.measureText('国道').width;
      const width = 26 + refWidth + unitWidth + 16;
      const height = 30;
      const x = clampX(item.x - width / 2, width);
      const y = clampY(item.y - height / 2, height);
      if (overlaps(x, y, width, height)) continue;
      drawPill(x, y, width, height, 'rgba(216, 255, 62, 0.5)');
      ctx.beginPath();
      ctx.arc(x + 14, y + height / 2, 8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(216, 255, 62, 0.9)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.font = `600 16px ${displayFont}`;
      ctx.fillStyle = '#d8ff3e';
      ctx.textAlign = 'left';
      ctx.fillText(item.name, x + 25, y + 20);
      ctx.font = `500 10px ${zhFont}`;
      ctx.fillStyle = '#9caf72';
      ctx.fillText('国道', x + 25 + refWidth + 4, y + 19);
      boxes.push({ x, y, w: width, h: height });
      roadCount += 1;
    }
  }

  clear(): void {
    this.active.clear();
    this.parsed.clear();
    this.bitmaps.clear();
    this.ambientBitmaps.clear();
    this.labelCandidates.clear();
    this.primed = [];
    this.priming = null;
  }
}

/**
 * Whole-route vector layer for the cover and result shots.
 *
 * The follow layer only covers the street-level corridor at z14; the poster
 * framing needs the opposite view — a city-scale map with rivers, arterials,
 * national-road shields and district names. The native exporter has always
 * drawn that from the same OpenMapTiles source, so the Web preview reuses it
 * here instead of the label-free Esri raster, and the two renders finally show
 * the same map furniture.
 */
export class OverviewVectorLayer {
  readonly zoom: number;
  private readonly theme: VideoTheme;
  private readonly base: TrackMap;
  private readonly tiles = new Map<string, ParsedTile>();
  private readonly bitmaps = new Map<string, TileBitmap>();
  private bitmapBytes = 0;
  /** 位图光栅化锁定比例（warmBitmaps 时确定，draw 按当前缩放拉伸）。 */
  private rasterScale: number | null = null;
  /** 本次预热实际使用的位图边长（像素），供性能诊断。 */
  lastRasterSize = 0;
  private failed = 0;
  private loaded = 0;
  private wanted = 0;

  constructor(theme: VideoTheme, base: TrackMap) {
    this.theme = theme;
    this.base = base;
    // Same rule as NativeScene.overviewZoom: pick the level whose route box is
    // near 1700 px so the poster is neither a web of lanes nor a blank sheet.
    const bounds = base.routeBounds;
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    let zoom = Math.min(14, base.zoom);
    while (zoom > 8 && span * 2 ** (zoom - base.zoom) > 1700) zoom -= 1;
    this.zoom = zoom;
    /** Map pixels one overview tile covers, expressed in base-zoom coordinates. */
    this.tileBase = TILE_SIZE * 2 ** (base.zoom - zoom);
  }

  private readonly tileBase: number;

  get ready(): boolean {
    return this.wanted > 0 && this.loaded >= this.wanted * 0.7;
  }

  get failedTiles(): number {
    return this.failed;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /** Cover framing used by MotionStage.cameraAt(1, 1, …). */
  private coverCamera(): { x: number; y: number; scale: number } {
    const bounds = this.base.routeBounds;
    const routeW = Math.max(1, bounds.maxX - bounds.minX);
    const routeH = Math.max(1, bounds.maxY - bounds.minY);
    const fit = Math.min(940 / routeW, 1050 / routeH, 9);
    const result = Math.min(980 / routeW, 560 / routeH, fit * 1.1);
    const scale = Math.min(fit, result);
    return {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2 + (1920 / 2 - 700) / result,
      scale,
    };
  }

  private range(camera: { x: number; y: number; scale: number }, width: number, height: number): {
    x0: number; x1: number; y0: number; y1: number;
  } {
    const left = camera.x - width / 2 / camera.scale;
    const right = camera.x + width / 2 / camera.scale;
    const top = camera.y - height / 2 / camera.scale;
    const bottom = camera.y + height / 2 / camera.scale;
    return {
      x0: Math.floor((left + this.base.originX) / this.tileBase),
      x1: Math.floor((right + this.base.originX) / this.tileBase),
      y0: Math.floor((top + this.base.originY) / this.tileBase),
      y1: Math.floor((bottom + this.base.originY) / this.tileBase),
    };
  }

  async prefetch(onProgress?: (done: number, total: number) => void): Promise<void> {
    const camera = this.coverCamera();
    // 宽度按创作页满宽预览的延展区加宽（核心 9:16 两侧还要延伸地图），
    // 否则延展区两侧超出预取范围，封面/成绩卡段两侧补不上地图
    const box = this.range(camera, 1080 * 1.8, 1920);
    const keys: string[] = [];
    for (let x = box.x0 - 1; x <= box.x1 + 1; x += 1) {
      for (let y = box.y0 - 1; y <= box.y1 + 1; y += 1) {
        keys.push(`${this.zoom}/${x}/${y}`);
      }
    }
    this.wanted = keys.length;
    this.loaded = 0;
    this.failed = 0;
    // 冷路径批量预读 IDB，已缓存瓦片跳过逐条事务
    await readBlobsBatch(keys);
    let cursor = 0;
    let abort = false;
    const worker = async (): Promise<void> => {
      while (cursor < keys.length && !abort) {
        const key = keys[cursor++];
        if (this.tiles.has(key)) {
          this.loaded += 1;
          onProgress?.(this.loaded, this.wanted);
          continue;
        }
        const sharedParsed = sharedParsedGet(key);
        if (sharedParsed) {
          this.tiles.set(key, sharedParsed);
          this.loaded += 1;
          onProgress?.(this.loaded, this.wanted);
          continue;
        }
        const [z, x, y] = key.split('/').map(Number);
        const data = await fetchVectorTile(z, x, y);
        const parsed = data ? parseTile(data) : null;
        if (parsed) {
          sharedParsedSet(key, parsed);
          this.tiles.set(key, parsed);
        } else {
          this.failed += 1;
          if (this.failed >= 10) abort = true;
        }
        this.loaded += 1;
        onProgress?.(this.loaded, this.wanted);
        // parseTile 是同步解码，10 个 worker 会背靠背各解一张 —— 必须每张
        // 让出一拍，否则长路线会把主线程冻住数秒
        await yieldIfBusy();
      }
    };
    await Promise.all(Array.from({ length: 10 }, () => worker()));
  }

  /**
   * 预渲染总览瓦片位图：封面、成绩卡和末帧海报都画在这一层，而末帧整帧会被
   * 截成图片缓存。逐张预热（每张让出一拍）能保证截帧时位图已就绪，既不冻页面
   * 也不会截到缺块的画面。
   */
  async warmBitmaps(scale: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    if (!this.tiles.size) return;
    // 锁定光栅化比例：成绩卡揭示动画期间相机缩放逐帧变化，若按当前缩放现烤，
    // 每帧都要重烤全部视野瓦片（冻页数秒、动画卡成跳帧）。位图一律按这个
    // 比例烤，绘制时按当前缩放拉伸（见 draw）。
    this.rasterScale = scale;
    this.lastRasterSize = Math.max(128, Math.min(768, Math.round(this.tileBase * scale)));
    const keys = Array.from(this.tiles.keys());
    let done = 0;
    for (const key of keys) {
      const parsed = this.tiles.get(key);
      if (parsed) this.bitmapFor(parsed, this.tileBase * scale, key);
      done += 1;
      onProgress?.(done, keys.length);
      await yieldIfBusy();
    }
  }

  private bitmapFor(parsed: ParsedTile, sizePx: number, key: string): TileBitmap {
    const size = Math.max(128, Math.min(768, Math.round(sizePx)));
    const cacheKey = `${key}@${size}`;
    const cached = this.bitmaps.get(cacheKey);
    if (cached) return cached;
    // 跨实例共享：重建图层后位图不再重烤（预热只剩让出，毫秒级）
    const shared = sharedBitmapGet(this.theme.id, cacheKey);
    if (shared) {
      this.bitmaps.set(cacheKey, shared);
      return shared;
    }
    const canvas = document.createElement('canvas');
    canvas.width = size + BITMAP_PAD * 2;
    canvas.height = size + BITMAP_PAD * 2;
    const target = canvas.getContext('2d');
    if (target) {
      target.translate(BITMAP_PAD, BITMAP_PAD);
      this.paint(target, parsed, size, size + BITMAP_PAD * 2, size + BITMAP_PAD * 2);
    }
    const entry: TileBitmap = { canvas, size, pad: BITMAP_PAD };
    // 关键修复：位图缓存必须装得下全部瓦片。长路线的总览瓦片有数百张，
    // 旧实现固定 128 条 + 插入序淘汰 —— 预热第 129 张就挤掉第 1 张，永远
    // 热不满；播放时封面/成绩卡一帧要画全部瓦片，每帧数百张未命中 ×
    // ~20ms 全量矢量重烤 = 单帧数秒，rAF 被饿死（表现为视频冻结、页面
    // 卡死）。改为按字节预算淘汰：装满为止，超出预算才挤最旧的。
    this.bitmapBytes += (size + BITMAP_PAD * 2) ** 2 * 4;
    this.bitmaps.set(cacheKey, entry);
    sharedBitmapSet(this.theme.id, cacheKey, entry);
    while (this.bitmapBytes > OVERVIEW_BITMAP_BUDGET && this.bitmaps.size > 1) {
      const oldest = this.bitmaps.keys().next();
      if (oldest.done) break;
      const evicted = this.bitmaps.get(oldest.value);
      this.bitmaps.delete(oldest.value);
      if (evicted) this.bitmapBytes -= (evicted.size + BITMAP_PAD * 2) ** 2 * 4;
    }
    return entry;
  }

  /** Same cartography as NativeVectorMap.paintTile, reduced to what reads at city scale. */
  private paint(
    target: CanvasRenderingContext2D,
    parsed: ParsedTile,
    sizePx: number,
    viewW: number,
    viewH: number,
  ): void {
    const unit = sizePx / parsed.extent;
    // Road widths are authored against a 256 px tile, exactly like the native
    // renderer. Scaling them by the raster/tile ratio keeps the stroke weight on
    // screen constant instead of ballooning when a tile is rasterised large.
    const widthScale = sizePx / 256;
    const map = this.theme.map;
    // 位图被压到 200px 出头时，一栋楼、一条支路在屏幕上不到 1px ——
    // 画它们纯属浪费（每张瓦片要为此遍历上千个 feature）。这种尺寸直接
    // 按稀疏模式画：只留水面、干道和高速，视觉上没有区别，解码量少一大半。
    const sparse = this.zoom <= 11 || sizePx < 256;
    const layers = parsed.tile.layers as Record<string, any>;
    const inView = (x: number, y: number): boolean => x > -24 && x < viewW + 24 && y > -24 && y < viewH + 24;

    const fillPolygon = (feature: any, fill: string, alpha: number): void => {
      const rings = feature.loadGeometry() as TilePoint[][];
      const path = new Path2D();
      let any = false;
      for (const ring of rings) {
        let started = false;
        for (const point of ring) {
          const x = point.x * unit;
          const y = point.y * unit;
          if (!started) {
            path.moveTo(x, y);
            started = true;
          } else {
            path.lineTo(x, y);
          }
          any = true;
        }
        path.closePath();
      }
      if (!any) return;
      target.globalAlpha = alpha;
      target.fillStyle = fill;
      target.fill(path, 'evenodd');
      target.globalAlpha = 1;
    };

    const strokeGeometry = (geometry: TilePoint[][], color: string, width: number, alpha = 1): void => {
      for (const line of geometry) {
        if (line.length < 2) continue;
        target.beginPath();
        let started = false;
        let visible = false;
        for (const point of line) {
          const x = point.x * unit;
          const y = point.y * unit;
          if (!started) {
            target.moveTo(x, y);
            started = true;
          } else {
            target.lineTo(x, y);
          }
          if (inView(x, y)) visible = true;
        }
        if (!visible) continue;
        target.globalAlpha = alpha;
        target.strokeStyle = color;
        target.lineWidth = width;
        target.lineCap = 'round';
        target.lineJoin = 'round';
        target.stroke();
        target.globalAlpha = 1;
      }
    };
    const strokeLine = (feature: any, color: string, width: number, alpha = 1): void =>
      strokeGeometry(feature.loadGeometry() as TilePoint[][], color, width, alpha);

    const parkTint = `rgb(${map.park[0]}, ${map.park[1]}, ${map.park[2]})`;
    const builtTint = `rgb(${map.building[0]}, ${map.building[1]}, ${map.building[2]})`;

    target.save();
    target.beginPath();
    target.rect(-1, -1, viewW + 2, viewH + 2);
    target.clip();
    // 小位图（总览预热常见 140px 上下）上，地块/土地利用只是一层几乎看不出的
    // 色差，却要为此解码成千上万个多边形 —— 直接跳过，只留水面和公园。
    const tinyRaster = sizePx < 256;
    for (const name of ['landcover', 'landuse', 'park', 'water']) {
      if (tinyRaster && (name === 'landcover' || name === 'landuse')) continue;
      const layer = layers[name];
      if (!layer) continue;
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        if (feature.type !== 3) continue;
        if (name === 'water') fillPolygon(feature, `rgb(${map.water[0]}, ${map.water[1]}, ${map.water[2]})`, 1);
        else if (name === 'park') fillPolygon(feature, parkTint, 0.66);
        else if (name === 'landcover') fillPolygon(feature, parkTint, 0.4);
        else fillPolygon(feature, builtTint, 0.5);
      }
    }
    if (!sparse && layers.building) {
      const layer = layers.building;
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index);
        if (feature.type === 3) fillPolygon(feature, builtTint, 0.9);
      }
    }
    target.restore();

    const waterway = layers.waterway;
    if (waterway) {
      for (let index = 0; index < waterway.length; index += 1) {
        const feature = waterway.feature(index);
        if (feature.type === 2) {
          strokeLine(feature, `rgb(${map.water[0]}, ${map.water[1]}, ${map.water[2]})`, (sparse ? 2.2 : 3) * widthScale);
        }
      }
    }

    const widthOf = (kind: string): number => {
      if (kind === 'motorway') return 7;
      if (kind === 'trunk') return 6.5;
      if (kind === 'primary') return 5.5;
      if (kind === 'secondary') return 4.5;
      if (kind === 'tertiary') return 3.6;
      if (kind === 'minor') return 2.8;
      if (kind === 'service') return 1.7;
      if (kind === 'path') return 1.2;
      if (kind === 'rail') return 1.2;
      return 1.5;
    };
    const colorOf = (kind: string): string => {
      if (kind === 'motorway' || kind === 'trunk') return `rgb(${map.roadMajor[0]}, ${map.roadMajor[1]}, ${map.roadMajor[2]})`;
      if (kind === 'primary') return `rgb(${map.roadPrimary[0]}, ${map.roadPrimary[1]}, ${map.roadPrimary[2]})`;
      if (kind === 'secondary' || kind === 'tertiary') return `rgb(${map.road[0]}, ${map.road[1]}, ${map.road[2]})`;
      if (kind === 'minor' || kind === 'service' || kind === 'path') {
        return `rgb(${map.roadMinor[0]}, ${map.roadMinor[1]}, ${map.roadMinor[2]})`;
      }
      return `rgb(${map.road[0]}, ${map.road[1]}, ${map.road[2]})`;
    };
    const arterial = (kind: string): boolean =>
      kind === 'motorway' || kind === 'trunk' || kind === 'primary' || kind === 'secondary';
    const lane = (kind: string): boolean => kind === 'minor' || kind === 'service' || kind === 'path';
    const roadAlpha = (kind: string): number =>
      kind === 'motorway' || kind === 'trunk' ? 0.9 : kind === 'primary' ? 0.62 : 0.4;

    const roads = layers.transportation;
    if (roads) {
      const edge = `rgb(${map.roadEdge[0]}, ${map.roadEdge[1]}, ${map.roadEdge[2]})`;
      // 描边（pass 0）和路面（pass 1）必须分两轮画，否则后画的路面会盖掉
      // 前一条路的描边。但两轮用的是同一份几何，第一次解码后留下来复用：
      // loadGeometry() 每次调用都要重新解 pbf，是这层最贵的操作。
      const geometry: Array<TilePoint[][] | undefined> = [];
      for (let pass = 0; pass < 2; pass += 1) {
        for (let index = 0; index < roads.length; index += 1) {
          const feature = roads.feature(index);
          if (feature.type !== 2) continue;
          const kind = String(feature.properties.class ?? 'minor');
          if (kind === 'rail') {
            if (pass === 1) strokeLine(feature, `rgb(${map.transit[0]}, ${map.transit[1]}, ${map.transit[2]})`, 1.2 * widthScale);
            continue;
          }
          if (pass === 0 && sparse && !arterial(kind)) continue;
          if (pass === 1 && sparse && lane(kind)) continue;
          let rings = geometry[index];
          if (!rings) {
            rings = feature.loadGeometry() as TilePoint[][];
            geometry[index] = rings;
          }
          if (pass === 0) {
            strokeGeometry(rings, edge, (widthOf(kind) + (sparse ? 1.4 : 2.4)) * widthScale, sparse ? 0.5 : 1);
          } else {
            const width = sparse ? widthOf(kind) * 0.8 : widthOf(kind);
            strokeGeometry(rings, colorOf(kind), width * widthScale, sparse ? roadAlpha(kind) : 1);
          }
        }
      }
    }

    // National roads (G refs) only carry their number in transportation_name, so
    // restroke those geometries in the highway colour — the shield alone was not
    // enough to read a 200 km ride at city scale.
    const names = layers.transportation_name;
    if (names) {
      const national = `rgb(${map.national[0]}, ${map.national[1]}, ${map.national[2]})`;
      for (let index = 0; index < names.length; index += 1) {
        const feature = names.feature(index);
        if (feature.type !== 2) continue;
        const ref = String(feature.properties.ref ?? '').split(';')[0].trim();
        if (!/^G\d{1,3}$/.test(ref)) continue;
        const kind = String(feature.properties.class ?? 'primary');
        strokeLine(feature, national, Math.max(widthOf(kind), sparse ? 4.4 : 5.2) * widthScale, sparse ? 0.85 : 1);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, camera: MapCamera, stageWidth: number, stageHeight: number): boolean {
    if (!this.tiles.size) return false;
    const scale = camera.scale;
    const box = this.range(camera, stageWidth, stageHeight);
    let hit = 0;
    let total = 0;
    let painted = 0;
    ctx.save();
    ctx.fillStyle = `rgb(${this.theme.map.background[0]}, ${this.theme.map.background[1]}, ${this.theme.map.background[2]})`;
    ctx.fillRect(0, 0, stageWidth, stageHeight);
    for (let tileX = box.x0; tileX <= box.x1; tileX += 1) {
      for (let tileY = box.y0; tileY <= box.y1; tileY += 1) {
        total += 1;
        const key = `${this.zoom}/${tileX}/${tileY}`;
        const parsed = this.tiles.get(key);
        if (!parsed) continue;
        hit += 1;
        const screenX = stageWidth / 2 + (tileX * this.tileBase - this.base.originX - camera.x) * scale;
        const screenY = stageHeight / 2 + (tileY * this.tileBase - this.base.originY - camera.y) * scale;
        if (screenX > stageWidth + 8 || screenX + this.tileBase * scale < -8) continue;
        if (screenY > stageHeight + 8 || screenY + this.tileBase * scale < -8) continue;
        // 这里不能做「每帧限量」：末帧整帧会被 posterCache 截走，若此刻只画了
        // 一部分瓦片，残缺画面就被永久缓存，末帧地图会缺块。改为在缓存阶段用
        // warmBitmaps 逐张预热（见 VectorFollowLayer 的同名方法）。
        // 位图按锁定比例光栅化、按当前缩放拉伸：揭示动画期间缩放逐帧变，
        // 重烤一次就是冻帧一次，拉伸 blit 则近乎免费。
        const raster = this.rasterScale ?? scale;
        this.rasterScale ??= scale;
        const bitmap = this.bitmapFor(parsed, this.tileBase * raster, key);
        const factor = (this.tileBase * scale) / bitmap.size;
        const padX = bitmap.pad * factor;
        ctx.drawImage(
          bitmap.canvas,
          Math.round(screenX) - padX,
          Math.round(screenY) - padX,
          this.tileBase * scale + padX * 2,
          this.tileBase * scale + padX * 2,
        );
        painted += 1;
      }
    }
    ctx.restore();
    // A handful of missing tiles at the seam is fine; a big hole means the
    // network is down and the raster base is the better fallback.
    return painted > 0 && hit >= Math.max(1, total * 0.6);
  }

  /** 标签候选缓存（世界坐标；buildLabelCache 在缓存阶段构建，绘制零解码）。 */
  private labelCache: Array<{ name: string; cls: string; rank: number; wx: number; wy: number; ref?: string; prio?: number }> | null = null;

  /**
   * 预构建标签候选：把 place / 国道编号一次性解码成世界坐标。不预构建的话，
   * 封面和成绩卡每帧都要对全城视野的瓦片跑 loadGeometry()（pbf 解码），
   * 一帧几百毫秒 —— 表现为封面卡顿、结尾时间显示冻住、播完页面冻结。
   */
  async buildLabelCache(onProgress?: (done: number, total: number) => void): Promise<void> {
    const sparse = this.zoom <= 11;
    const cache: Array<{ name: string; cls: string; rank: number; wx: number; wy: number; ref?: string; prio?: number }> = [];
    const seenRefs = new Set<string>();
    const keys = Array.from(this.tiles.keys());
    let done = 0;
    for (const key of keys) {
      const parsed = this.tiles.get(key);
      if (parsed) {
        const [z, x, y] = key.split('/').map(Number);
        const world = (point: TilePoint, extent: number): { wx: number; wy: number } => ({
          wx: x * this.tileBase + (point.x / extent) * this.tileBase - this.base.originX,
          wy: y * this.tileBase + (point.y / extent) * this.tileBase - this.base.originY,
        });
        const layer = parsed.tile.layers.place as any;
        if (layer) {
          for (let index = 0; index < layer.length; index += 1) {
            const feature = layer.feature(index);
            const props = feature.properties as Record<string, unknown>;
            const name = String(props['name:zh'] ?? props.name ?? '').trim();
            const cls = String(props.class ?? '');
            if (!name) continue;
            if (cls !== 'city' && cls !== 'town' && !(sparse ? false : cls === 'village' || cls === 'suburb' || cls === 'quarter')) continue;
            const rank = Number(props.rank ?? 99);
            if (cls === 'city' && rank > 24) continue;
            if (cls === 'town' && rank > 16) continue;
            const geometry = feature.loadGeometry() as TilePoint[][];
            const point = geometry[0]?.[0];
            if (!point) continue;
            const { wx, wy } = world(point, parsed.extent);
            cache.push({ name, cls, rank, wx, wy });
          }
        }
        const tn = parsed.tile.layers.transportation_name as any;
        if (tn) {
          for (let index = 0; index < tn.length; index += 1) {
            const feature = tn.feature(index);
            const props = feature.properties as Record<string, unknown>;
            const ref = String(props.ref ?? '').split(';')[0].trim();
            if (!/^G\d{1,3}$/.test(ref) || seenRefs.has(ref)) continue;
            const geometry = feature.loadGeometry() as TilePoint[][];
            let line = geometry[0];
            for (const candidate of geometry) if (candidate.length > (line?.length ?? 0)) line = candidate;
            if (!line || line.length < 2) continue;
            const middle = line[Math.floor(line.length / 2)];
            const { wx, wy } = world(middle, parsed.extent);
            seenRefs.add(ref);
            const cls = String(props.class ?? '');
            cache.push({ name: ref, cls, rank: 0, wx, wy, ref, prio: cls === 'motorway' ? 0 : cls === 'trunk' ? 1 : 2 });
          }
        }
      }
      done += 1;
      onProgress?.(done, keys.length);
      await yieldIfBusy();
    }
    this.labelCache = cache;
  }

  /**
   * Place names and national-road shields, painted in screen space so a district
   * name keeps the same optical size as the native renderer at any zoom.
   */
  drawLabels(ctx: CanvasRenderingContext2D, camera: MapCamera, stageWidth: number, stageHeight: number): void {
    const cache = this.labelCache;
    if (!cache) return;
    const scale = camera.scale;
    if (scale > 1.6) return;
    const sparse = this.zoom <= 11;
    const zhFont = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    const displayFont = '"Barlow Condensed", "PingFang SC", sans-serif';
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = [
      { x: 0, y: 0, w: stageWidth, h: 300 },
      { x: 0, y: 1000, w: stageWidth, h: stageHeight - 1000 },
    ];
    const overlaps = (x: number, y: number, w: number, h: number): boolean =>
      boxes.some((b) => x < b.x + b.w + 8 && x + w + 8 > b.x && y < b.y + b.h + 6 && y + h + 6 > b.y);

    const places: Array<{ name: string; cls: string; rank: number; x: number; y: number }> = [];
    for (const item of cache) {
      if (item.ref) continue;
      const x = stageWidth / 2 + (item.wx - camera.x) * scale;
      const y = stageHeight / 2 + (item.wy - camera.y) * scale;
      if (x < 40 || x > stageWidth - 40 || y < 330 || y > stageHeight - 620) continue;
      places.push({ name: item.name, cls: item.cls, rank: item.rank, x, y });
    }
    places.sort((a, b) => (a.cls === 'city' ? 0 : 1) - (b.cls === 'city' ? 0 : 1) || a.rank - b.rank);
    let labels = 0;
    for (const place of places) {
      if (labels >= (sparse ? 18 : 10)) break;
      const size = place.cls === 'city' ? 26 : place.cls === 'town' ? 22 : 18;
      ctx.font = `600 ${size}px ${zhFont}`;
      const width = ctx.measureText(place.name).width;
      const x = Math.max(20, Math.min(stageWidth - width - 20, place.x - width / 2));
      const y = place.y - size;
      if (overlaps(x, y, width, size + 6)) continue;
      boxes.push({ x, y, w: width, h: size + 6 });
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = this.theme.map.labelHalo;
      ctx.lineWidth = size * 0.24;
      ctx.strokeText(place.name, x, place.y);
      ctx.fillStyle = this.theme.map.label;
      ctx.fillText(place.name, x, place.y);
      labels += 1;
    }

    // National-road shields, same pill + leader language as the native poster.
    const refs: Array<{ ref: string; x: number; y: number; priority: number }> = [];
    for (const item of cache) {
      if (!item.ref) continue;
      const x = stageWidth / 2 + (item.wx - camera.x) * scale;
      const y = stageHeight / 2 + (item.wy - camera.y) * scale;
      if (x < 70 || x > stageWidth - 70 || y < 340 || y > stageHeight - 640) continue;
      refs.push({ ref: item.ref, x, y, priority: item.prio ?? 2 });
    }
    refs.sort((a, b) => a.priority - b.priority);
    const accent = `rgb(${this.theme.map.national[0]}, ${this.theme.map.national[1]}, ${this.theme.map.national[2]})`;
    let shields = 0;
    for (const item of refs) {
      if (shields >= 4) break;
      ctx.font = `600 19px ${displayFont}`;
      const refWidth = ctx.measureText(item.ref).width;
      ctx.font = `500 10px ${zhFont}`;
      const unitWidth = ctx.measureText('国道').width;
      const width = 30 + refWidth + unitWidth + 16;
      const height = 34;
      let x = Math.max(18, Math.min(stageWidth - width - 18, item.x - width / 2));
      let y = Math.max(340, Math.min(stageHeight - 640 - height, item.y - height / 2));
      if (overlaps(x, y, width, height)) continue;
      boxes.push({ x, y, w: width, h: height });
      ctx.beginPath();
      ctx.moveTo(item.x, item.y);
      ctx.lineTo(x + width / 2, y + height / 2);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, 9);
      ctx.fillStyle = 'rgba(5, 18, 26, 0.86)';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.font = `600 19px ${displayFont}`;
      ctx.fillStyle = accent;
      ctx.textAlign = 'left';
      ctx.fillText(item.ref, x + 15, y + 23);
      ctx.font = `500 10px ${zhFont}`;
      ctx.fillStyle = this.theme.muted;
      ctx.fillText('国道', x + 17 + refWidth, y + 22);
      shields += 1;
    }
  }

  clear(): void {
    this.tiles.clear();
    this.bitmaps.clear();
    this.loaded = 0;
    this.wanted = 0;
  }
}


export async function clearVectorTileCache(): Promise<void> {
  blobMemory.clear();
  blobMemoryBytes = 0;
  templatePromise = null;
  try {
    localStorage.removeItem('fit-motion-vector-template');
  } catch {
    // storage unavailable
  }
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
