import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { paintFollowTile, paintOverviewTile } from './tile-painter';

/**
 * 瓦片光栅化 Worker：pbf 解码 + Canvas 绘制全部在这里跑，主线程只收
 * ImageBitmap。单消息单瓦片，串行消费（浏览器消息队列天然背压）。
 *
 * 通过 `?worker&inline` 打包 —— 会被 base64 内联进主 bundle，
 * 与 singleFile 插件（一切内联进 index.html）兼容，APK asset:// 也能用。
 */

interface PaintRequest {
  id: number;
  mode: 'follow' | 'overview';
  data: ArrayBuffer;
  size: number;
  map: Parameters<typeof paintFollowTile>[6];
  zoom: number;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<PaintRequest>) => void) | null;
  postMessage: (msg: Record<string, unknown>, transfer?: Transferable[]) => void;
};

scope.onmessage = (ev) => {
  const req = ev.data;
  try {
    const tile = new VectorTile(new Pbf(new Uint8Array(req.data)));
    const first = Object.values(tile.layers)[0] as { extent?: number } | undefined;
    const extent = first?.extent ?? 4096;
    const canvas = new OffscreenCanvas(req.size + 16, req.size + 16);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('offscreen 2d context unavailable');
    ctx.translate(8, 8);
    if (req.mode === 'follow') {
      paintFollowTile(ctx, tile, extent, req.size, req.size + 16, req.size + 16, req.map);
    } else {
      paintOverviewTile(ctx, tile, extent, req.size, req.size + 16, req.size + 16, req.map, req.zoom);
    }
    const bitmap = canvas.transferToImageBitmap();
    scope.postMessage({ id: req.id, bitmap }, [bitmap]);
  } catch (error) {
    scope.postMessage({ id: req.id, error: String(error) });
  }
};
