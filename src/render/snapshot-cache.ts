/**
 * 栅格底图成品快照的 IndexedDB 持久层。
 *
 * map.ts 里已经有一份**内存**快照（同参数再进页直接 drawImage 复制），但它随
 * 页面销毁而失效——App 二次打开后的第一次进页仍要走完整管线：读 ~450 张瓦片
 * → 逐像素调色 → 连通域清标注 → 阴影合成 → 再截图，实测 ~4.5s。
 * 把快照编码成 WebP 存进 IDB 后，冷页面进页只需解码一张图（~100ms 级）。
 *
 * 键与内存快照一致（zoom|origin|尺寸|主题|路线范围|中心），参数一变自然失效。
 * 只保留最近 MAX_ENTRIES 张，避免主题/路线切换把配额堆满。
 */
const DB_NAME = 'fit-motion-map-snapshots';
const DB_VERSION = 1;
const STORE = 'snapshots';
const MAX_ENTRIES = 8;

let dbPromise: Promise<IDBDatabase | null> | null = null;

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
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
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

/** 读快照（返回已解码的图像）；没有就返回 null。 */
export async function readMapSnapshot(key: string): Promise<ImageBitmap | null> {
  const db = await openDb();
  if (!db) return null;
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => {
        const row = request.result as { key: string; blob: Blob; at: number } | undefined;
        resolve(row && row.blob instanceof Blob ? row.blob : null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  if (!blob) return null;
  try {
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise<ImageBitmap | null>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image as unknown as ImageBitmap);
        image.onerror = () => resolve(null);
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

/**
 * 存快照：优先 PNG（无损）。底图大部分像素是透明的，PNG 压缩后通常只有几百
 * KB；WebP 有损省不了多少空间，却会改变半透明描边的颜色，恢复后与实时构建
 * 有细微差异。PNG 编码失败再退回 WebP。
 */
export async function writeMapSnapshot(key: string, canvas: HTMLCanvasElement): Promise<void> {
  const encode = (type: string, quality?: number): Promise<Blob | null> =>
    new Promise((resolve) => {
      try {
        canvas.toBlob((value) => resolve(value), type, quality);
      } catch {
        resolve(null);
      }
    });
  const blob = (await encode('image/png')) ?? (await encode('image/webp', 0.95));
  if (!blob) return;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put({ key, blob, at: Date.now() });
      // 数量裁剪：按时间戳淘汰最旧的
      const cursorRequest = store.getAll();
      cursorRequest.onsuccess = () => {
        const rows = cursorRequest.result as Array<{ key: string; at: number }>;
        if (rows.length <= MAX_ENTRIES) return;
        rows.sort((a, b) => a.at - b.at);
        for (const row of rows.slice(0, rows.length - MAX_ENTRIES)) store.delete(row.key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearMapSnapshots(): Promise<void> {
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
