import { TILE_SIZE } from '../geo';

const DB_NAME = 'fit-motion-map-tiles';
const DB_VERSION = 1;
const STORE = 'tiles';
const TILE_URL = (z: number, x: number, y: number): string =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`;

type CacheDb = IDBDatabase | null;

let dbPromise: Promise<CacheDb> | null = null;
const memoryTiles = new Map<string, Blob>();

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
          memoryTiles.set(key, value);
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

async function writeCached(z: number, x: number, y: number, blob: Blob): Promise<void> {
  const key = tileKey(z, x, y);
  memoryTiles.set(key, blob);
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

export async function loadTileImage(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  const blob = await fetchTileBlob(z, x, y);
  if (!blob) return null;
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
