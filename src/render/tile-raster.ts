import { TILE_WORKER_SOURCE } from './tile-worker.gen';

/**
 * 瓦片 Worker 光栅化客户端。
 *
 * - 单例 Worker，请求按消息队列串行消费；
 * - 原始 pbf 数据不 transfer（blobMemory 还持有同一份 ArrayBuffer，
 *   transfer 会把它 detach 掉，后续读缓存全部变空）——postMessage 结
 *   构化克隆一次（几十 KB 级，微秒成本）；
 * - Worker 创建失败 / 运行出错（老内核没有 OffscreenCanvas 等）自动
 *   熔断，调用方回退主线程同步光栅化，行为与旧版一致。
 */

export interface RasterResult {
  bitmap: ImageBitmap;
  /** 位图覆盖的瓦片边长（不含 pad），pad 恒为 8（BITMAP_PAD）。 */
  size: number;
  pad: number;
}

export type PaintMode = 'follow' | 'overview';

export type ThemeMapColors = Parameters<typeof paintTileOffThread>[4];

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, { resolve: (result: RasterResult | null) => void }>();

export function rasterOffThreadSupported(): boolean {
  return !broken
    && typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof ImageBitmap !== 'undefined';
}

function ensureWorker(): Worker | null {
  if (!rasterOffThreadSupported()) return null;
  if (worker) return worker;
  try {
    // 内联 bundle（tools/build-worker.mjs 生成）+ Blob URL：
    // APK 的 file:// 环境不允许加载外部 worker 文件，内联是唯一通路
    const url = URL.createObjectURL(new Blob([TILE_WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new Worker(url);
  } catch {
    broken = true;
    return null;
  }
  worker.onmessage = (ev: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string }>) => {
    const msg = ev.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    entry.resolve(msg.bitmap ? { bitmap: msg.bitmap, size: 0, pad: 8 } : null);
  };
  worker.onerror = () => {
    broken = true;
    for (const entry of pending.values()) entry.resolve(null);
    pending.clear();
    try {
      worker?.terminate();
    } catch {
      // 已终止
    }
    worker = null;
  };
  return worker;
}

/** 抛出请求后立即返回；结果经 resolve 异步送达（失败返回 null，调用方兜底）。 */
export function paintTileOffThread(
  data: ArrayBuffer,
  size: number,
  mode: PaintMode,
  map: {
    background: [number, number, number];
    water: [number, number, number];
    park: [number, number, number];
    building: [number, number, number];
    roadEdge: [number, number, number];
    road: [number, number, number];
    transit: [number, number, number];
    roadMajor: [number, number, number];
    roadPrimary: [number, number, number];
    roadMinor: [number, number, number];
    national: [number, number, number];
  },
  zoom: number,
): Promise<RasterResult | null> {
  const target = ensureWorker();
  if (!target) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    target.postMessage({ id, mode, data: data.slice(0), size, map, zoom });
  });
}
