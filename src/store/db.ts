/**
 * IndexedDB 封装。
 *
 * 只做三件事：打开（含升级）、事务包装、把 IDBRequest 变成 Promise。
 * 业务逻辑全部在 repo.ts，方便以后换存储（比如 Android 私有目录兜底）
 * 时只替换这一层。
 */

const DB_NAME = 'fitmotion';
const DB_VERSION = 1;

export const STORE = {
  activities: 'activities',
  tracks: 'tracks',
  files: 'files',
  queue: 'queue',
  settings: 'settings',
} as const;

let handle: Promise<IDBDatabase> | null = null;

export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function db(): Promise<IDBDatabase> {
  if (handle) return handle;
  handle = new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE.activities)) {
        const store = database.createObjectStore(STORE.activities, { keyPath: 'id' });
        // 列表默认按开始时间倒序翻页
        store.createIndex('by_start', 'start', { unique: false });
        store.createIndex('by_hash', 'fileHash', { unique: false });
        store.createIndex('by_src', 'src', { unique: false });
        store.createIndex('by_backup', 'backup', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE.tracks)) {
        database.createObjectStore(STORE.tracks, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORE.files)) {
        database.createObjectStore(STORE.files, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORE.queue)) {
        const store = database.createObjectStore(STORE.queue, { keyPath: 'id' });
        store.createIndex('by_activity', 'activityId', { unique: false });
        store.createIndex('by_next', 'nextAt', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE.settings)) {
        database.createObjectStore(STORE.settings, { keyPath: 'k' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    request.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'));
  });
  return handle;
}

export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

export async function tx<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const database = await db();
  const names = Array.isArray(stores) ? stores : [stores];
  const transaction = database.transaction(names, mode);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('事务中止'));
  });
  const result = await run(transaction);
  await done;
  return result;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const row = await tx(STORE.settings, 'readonly', (t) =>
      req(t.objectStore(STORE.settings).get(key)) as Promise<{ k: string; v: T } | undefined>);
    return row?.v ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await tx(STORE.settings, 'readwrite', (t) => {
    t.objectStore(STORE.settings).put({ k: key, v: value });
  });
}

/** 估算本地占用，设置页用来画容量条。 */
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  try {
    if (navigator.storage?.estimate) {
      const info = await navigator.storage.estimate();
      return { usage: info.usage ?? 0, quota: info.quota ?? 0 };
    }
  } catch {
    /* 隐私模式等场景拿不到，返回 0 让 UI 走兜底文案 */
  }
  return { usage: 0, quota: 0 };
}
