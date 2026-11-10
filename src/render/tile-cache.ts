import { TILE_SIZE } from '../geo';

const DB_NAME = 'fit-motion-map-tiles';
const DB_VERSION = 1;
const STORE = 'tiles';
const TILE_URL = (z: number, x: number, y: number): string =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`;

type CacheDb = IDBDatabase | null;

let dbPromise: Promise<CacheDb> | null = null;
const memoryTiles = new Map<string, Blob>();
let memoryTilesBytes = 0;

/** 栅格瓦片内存驻留上限（低端机减半）；淘汰后 IDB 兜底，批量预读回来很快。 */
const MEMORY_TILES_BUDGET = (() => {
  try {
    const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (typeof gb === 'number' && gb > 0 && gb < 4) return 16 * 1024 * 1024;
  } catch {
    // 老内核没有 deviceMemory
  }
  return 32 * 1024 * 1024;
})();

function memoryTilesSet(key: string, blob: Blob): void {
  if (memoryTiles.has(key)) return;
  memoryTiles.set(key, blob);
  memoryTilesBytes += blob.size;
  while (memoryTilesBytes > MEMORY_TILES_BUDGET && memoryTiles.size > 1) {
    const oldest = memoryTiles.keys().next();
    if (oldest.done) break;
    const evicted = memoryTiles.get(oldest.value);
    memoryTiles.delete(oldest.value);
    if (evicted) memoryTilesBytes -= evicted.size;
  }
}

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

function openDb(): Promise<CacheDb> {
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

async function readCached(z: number, x: number, y: number): Promise<Blob | null> {
  const key = tileKey(z, x, y);
  const mem = memoryTiles.get(key);
  if (mem) return mem;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => {
        const value = request.result;
        if (value instanceof Blob) {
                  memoryTilesSet(key, value);
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

/**
 * 批量预读：一个 readonly 事务里发出全部 get，填充 memoryTiles。
 * 冷路径的瓶颈不在磁盘而在「每张瓦片一个事务」——IndexedDB 事务创建有
 * 毫秒级固定开销，几百张瓦片逐条读时纯开销就能到 2~3s。批量读后
 * fetchTileBlob 的 readCached 直接命中 memoryTiles，跳过 IDB。
 * 返回命中张数。
 */
export async function readCachedBatch(coords: Array<[number, number, number]>): Promise<number> {
  if (!coords.length) return 0;
  const missing = coords.filter(([z, x, y]) => !memoryTiles.has(tileKey(z, x, y)));
  if (missing.length === 0) return coords.length;
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
      for (const [z, x, y] of missing) {
        const key = tileKey(z, x, y);
        const request = store.get(key);
        request.onsuccess = () => {
          const value = request.result;
          if (value instanceof Blob) {
            memoryTilesSet(key, value);
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

async function writeCached(z: number, x: number, y: number, blob: Blob): Promise<void> {
  const key = tileKey(z, x, y);
  memoryTilesSet(key, blob);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function fetchTileBlob(z: number, x: number, y: number): Promise<Blob | null> {
  const cached = await readCached(z, x, y);
  if (cached) return cached;
  if (typeof fetch !== 'function') return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(TILE_URL(z, x, y), {
      mode: 'cors',
      signal: controller.signal,
      cache: 'force-cache',
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.size) return null;
    await writeCached(z, x, y, blob);
    return blob;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 栅格瓦片解码后的图像。优先用 ImageBitmap：解码发生在主线程之外、
 * 多张可并行，冷路径实测比 <img> 解码快数倍。
 */
export type TileImage = ImageBitmap | HTMLImageElement;

export async function loadTileImage(z: number, x: number, y: number): Promise<TileImage | null> {
  const blob = await fetchTileBlob(z, x, y);
  if (!blob) return null;
  if (typeof createImageBitmap === 'function') {
    try {
      // 预乘 alpha 与浏览器绘制一致，避免边缘发灰
      return await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
    } catch {
      // 老内核/Safari 某些版本对 blob 解码失败，落到 <img> 路径
    }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

export function openTileUrl(z: number, x: number, y: number): string {
  return TILE_URL(z, x, y);
}

export { TILE_SIZE, tileKey };


export async function clearBaseTileCache(): Promise<void> {
  memoryTiles.clear();
  memoryTilesBytes = 0;
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
