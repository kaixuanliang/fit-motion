import type { Activity } from '../fit/activity';
import { project, TILE_SIZE } from '../geo';
import type { VideoTheme } from './theme';
import { loadTileImage, readCachedBatch, type TileImage } from './tile-cache';
import { readMapSnapshot, writeMapSnapshot } from './snapshot-cache';

export interface MapRoutePoint {
  x: number;
  y: number;
}

export interface MapCamera {
  x: number;
  y: number;
  scale: number;
}

/**
 * 栅格底图成品快照（含 art 底 + 调色后的瓦片合成）。
 *
 * 每次进创作页都会 new 一个 TrackMap，若没有快照，整套「逐张解码 PNG →
 * 整幅两趟像素调色 + 连通域 → 合成」要原样重跑（热缓存实测 2.3s，是
 * 「正在缓存地图瓦片」的最大头）。而结果只取决于 zoom/原点/尺寸/主题/
 * 路线包围盒/中心点 —— 相同就逐像素相同，直接整幅复制即可。
 * 只保留最近一份（约 10~15MB）。
 */
let mapSnapshot: { key: string; canvas: CanvasImageSource } | null = null;

/**
 * A self-contained map stage. It paints an art-directed fallback immediately,
 * then streams Esri's label-free light-gray base. Only the road and water
 * linework is kept on top of the art blocks, so the background never shows a
 * place name.
 */
export class TrackMap {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  readonly originX: number;
  readonly originY: number;
  readonly route: MapRoutePoint[];
  readonly routeBounds: { minX: number; maxX: number; minY: number; maxY: number };
  usingTiles = false;
  tileProgress = 0;
  tilesFailed = 0;
  tilesComplete = false;
  private locked = false;

  private readonly activity: Activity;
  private readonly theme: VideoTheme;
  private rawCanvas: HTMLCanvasElement;
  private artCanvas: HTMLCanvasElement;
  private railCanvas: HTMLCanvasElement;
  private railCtx: CanvasRenderingContext2D;
  private waterCanvas: HTMLCanvasElement;
  private waterCtx: CanvasRenderingContext2D;
  private tilesDone = 0;
  private tilesTotal = 0;
  private update?: () => void;
  private darkPaletteApplied = false;

  constructor(activity: Activity, theme: VideoTheme, onUpdate?: () => void) {
    this.activity = activity;
    this.theme = theme;
    this.update = onUpdate;
    const { zoom, originX, originY, width, height } = layoutMap(activity);
    this.zoom = zoom;
    this.originX = originX;
    this.originY = originY;
    this.width = width;
    this.height = height;

    this.canvas = createCanvas(width, height);
    this.rawCanvas = createCanvas(width, height);
    this.artCanvas = createCanvas(width, height);
    this.railCanvas = createCanvas(width, height);
    this.railCtx = this.railCanvas.getContext('2d')!;
    this.waterCanvas = createCanvas(width, height);
    this.waterCtx = this.waterCanvas.getContext('2d')!;

    this.route = activity.points.map((point) => {
      const world = project(point.lat, point.lon, zoom);
      return { x: world.x - originX, y: world.y - originY };
    });
    this.routeBounds = boundsOf(this.route);

    paintArtMap(this.artCanvas, this.width, this.height, this.routeBounds, activity, theme);
    const ctx = this.canvas.getContext('2d')!;
    ctx.drawImage(this.artCanvas, 0, 0);
  }

  async loadTiles(onProgress?: (progress: number) => void): Promise<void> {
    if (this.locked) return;
    this.tilesDone = 0;
    this.tilesTotal = 0;
    this.tilesFailed = 0;
    this.tilesComplete = false;
    this.usingTiles = false;

    // 成品快照命中：整幅复制后立即就绪，跳过解码/调色/合成全流程。
    // 先查内存（同进程再进页），再查 IDB（App 二次打开后冷页面首次进页）。
    const snapshotKey = this.snapshotKey();
    const applySnapshot = (source: CanvasImageSource): void => {
      const ctx = this.canvas.getContext('2d')!;
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.drawImage(source, 0, 0);
      // 与 darkenTiles 收尾后的状态保持一致（rawCanvas 指向成品画布）
      this.rawCanvas = this.canvas;
      this.darkPaletteApplied = true;
      this.usingTiles = true;
      this.tilesComplete = true;
      this.tilesDone = 1;
      this.tilesTotal = 1;
      this.tileProgress = 1;
      onProgress?.(1);
      this.update?.();
    };
    if (mapSnapshot && mapSnapshot.key === snapshotKey) {
      applySnapshot(mapSnapshot.canvas);
      return;
    }
    const stored = await readMapSnapshot(snapshotKey);
    if (stored && !this.locked) {
      // 直接拿 ImageBitmap 当内存快照，省掉一次全幅复制
      mapSnapshot = { key: snapshotKey, canvas: stored };
      applySnapshot(stored);
      return;
    }

    const tileRange = this.tileRange();
    const tiles: Array<[number, number]> = [];
    for (let x = tileRange.x0; x <= tileRange.x1; x += 1) {
      for (let y = tileRange.y0; y <= tileRange.y1; y += 1) tiles.push([x, y]);
    }
    this.tilesTotal = tiles.length;
    if (tiles.length === 0) return;

    // 冷路径批量预读 IDB（一个事务全部 get），逐张 worker 直接命中内存
    const mark = (step: string): void => {
      try {
        performance.mark(`fm:raster:${step}`, { detail: { tiles: this.tilesTotal } });
      } catch { /* 老内核没有 mark */ }
    };
    mark('batch-start');
    await readCachedBatch(tiles.map(([x, y]) => [this.zoom, x, y] as [number, number, number]));
    mark('batch-done');

    const rawCtx = this.rawCanvas.getContext('2d')!;
    rawCtx.clearRect(0, 0, this.width, this.height);
    const concurrency = 8;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < tiles.length) {
        const [x, y] = tiles[cursor++];
        const image = await loadTile(this.zoom, x, y);
        if (image) {
          rawCtx.drawImage(
            image,
            x * TILE_SIZE - this.originX,
            y * TILE_SIZE - this.originY,
            TILE_SIZE,
            TILE_SIZE,
          );
        } else {
          this.tilesFailed += 1;
        }
        this.tilesDone += 1;
        this.tileProgress = this.tilesDone / this.tilesTotal;
        onProgress?.(this.tileProgress);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    mark('draw-done');

    if (this.tilesFailed > 0 || this.tilesDone < this.tilesTotal) return;
    if (this.locked) return;
    await this.darkenTiles();
    mark('darken-done');
    this.usingTiles = true;
    this.tilesComplete = true;
    // 保存成品快照，下次同参进页直接复制
    try {
      const snapshot = createCanvas(this.width, this.height);
      snapshot.getContext('2d')!.drawImage(this.canvas, 0, 0);
      mapSnapshot = { key: this.snapshotKey(), canvas: snapshot };
      // 持久化一份到 IDB：App 二次打开后的首次进页可直接恢复，
      // 跳过「读瓦片 → 逐像素调色 → 连通域清标注 → 阴影合成」整条 4s+ 管线
      void writeMapSnapshot(mapSnapshot.key, snapshot);
    } catch {
      // 快照失败不影响本次结果
    }
    this.update?.();
  }

  lock(): void {
    this.locked = true;
  }

  unlock(): void {
    this.locked = false;
  }

  draw(ctx: CanvasRenderingContext2D, camera: MapCamera, stageWidth: number, stageHeight: number): void {
    const scale = camera.scale;
    const dx = stageWidth / 2 - camera.x * scale;
    const dy = stageHeight / 2 - camera.y * scale;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.canvas, dx, dy, this.width * scale, this.height * scale);
    ctx.restore();
  }

  screenPoint(point: MapRoutePoint, camera: MapCamera, stageWidth: number, stageHeight: number): { x: number; y: number } {
    return {
      x: stageWidth / 2 + (point.x - camera.x) * camera.scale,
      y: stageHeight / 2 + (point.y - camera.y) * camera.scale,
    };
  }

  /** 成品画布只取决于这些输入，全部相同即逐像素相同（见 mapSnapshot 注释）。 */
  private snapshotKey(): string {
    const b = this.routeBounds;
    return `${this.zoom}|${Math.round(this.originX)}|${Math.round(this.originY)}|${this.width}x${this.height}`
      + `|${this.theme.id}|${Math.round(b.minX)},${Math.round(b.minY)},${Math.round(b.maxX)},${Math.round(b.maxY)}`
      + `|${Math.round(this.activity.center.lat * 1000)},${Math.round(this.activity.center.lon * 1000)}`;
  }

  private tileRange(): { x0: number; x1: number; y0: number; y1: number } {
    const minTileX = Math.floor((this.originX - 32) / TILE_SIZE);
    const maxTileX = Math.floor((this.originX + this.width + 32) / TILE_SIZE);
    const minTileY = Math.floor((this.originY - 32) / TILE_SIZE);
    const maxTileY = Math.floor((this.originY + this.height + 32) / TILE_SIZE);
    return { x0: minTileX, x1: maxTileX, y0: minTileY, y1: maxTileY };
  }

  private paintRailTile(image: TileImage, tileX: number, tileY: number): void {
    const tile = document.createElement('canvas');
    tile.width = TILE_SIZE;
    tile.height = TILE_SIZE;
    const tileCtx = tile.getContext('2d', { willReadFrequently: true })!;
    tileCtx.drawImage(image, 0, 0);
    const data = tileCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    const pixels = data.data;
    const transit = this.theme.map.transit;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 24) continue;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      // Only the yellow rail dashes are kept; dark labels and station text are
      // deliberately excluded.
      const isRail = r > 170 && g > 130 && b < 125;
      if (!isRail) {
        pixels[i + 3] = 0;
        continue;
      }
      pixels[i] = transit[0];
      pixels[i + 1] = transit[1];
      pixels[i + 2] = transit[2];
      pixels[i + 3] = 210;
    }

    tileCtx.putImageData(data, 0, 0);
    this.railCtx.drawImage(tile, tileX * TILE_SIZE - this.originX, tileY * TILE_SIZE - this.originY);
  }

  private paintWaterTile(image: TileImage, tileX: number, tileY: number): void {
    const tile = document.createElement('canvas');
    tile.width = TILE_SIZE;
    tile.height = TILE_SIZE;
    const tileCtx = tile.getContext('2d', { willReadFrequently: true })!;
    tileCtx.drawImage(image, 0, 0);
    const data = tileCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    const pixels = data.data;
    const water = this.theme.map.water;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 24) {
        pixels[i + 3] = 0;
        continue;
      }
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const light = r * 0.299 + g * 0.587 + b * 0.114;
      if (b > r + 4 && light < 240) {
        pixels[i] = water[0];
        pixels[i + 1] = water[1];
        pixels[i + 2] = water[2];
        pixels[i + 3] = 225;
      } else {
        pixels[i + 3] = 0;
      }
    }

    // Keep broad water bodies and rivers, drop blue place/river labels.
    const size = TILE_SIZE;
    const visited = new Uint8Array(size * size);
    const stack: number[] = [];
    for (let p = 0; p < size * size; p += 1) {
      if (visited[p] || pixels[p * 4 + 3] === 0) continue;
      stack.length = 0;
      stack.push(p);
      visited[p] = 1;
      const component: number[] = [];
      let minX = size;
      let maxX = 0;
      let minY = size;
      let maxY = 0;
      while (stack.length) {
        const current = stack.pop()!;
        component.push(current);
        const cx = current % size;
        const cy = Math.floor(current / size);
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        for (const next of [current - 1, current + 1, current - size, current + size]) {
          if (next < 0 || next >= size * size) continue;
          if (Math.abs((next % size) - cx) > 1) continue;
          if (visited[next] || pixels[next * 4 + 3] === 0) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
      const spanX = maxX - minX;
      const spanY = maxY - minY;
      if ((spanX < 72 && spanY < 18) || Math.max(spanX, spanY) < 24) {
        for (const pixel of component) pixels[pixel * 4 + 3] = 0;
      }
    }
    tileCtx.putImageData(data, 0, 0);
    this.waterCtx.drawImage(tile, tileX * TILE_SIZE - this.originX, tileY * TILE_SIZE - this.originY);
  }

  /** setTimeout(0) 让出主线程。长路线的调色有几百万像素，必须分块。 */
  private static yieldFrame(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * 栅格底图调色（压暗 + 只留路网/水系长线条）。
   *
   * 整幅画布可达 1700×1500（250 万像素）× 两趟全像素扫描 + 连通域标记，
   * 一口气跑完会把主线程冻住 1~3 秒（创作页缓存中段卡死就来自这里）——
   * 按行分块，每块之间让出一拍。
   */
  private async darkenTiles(): Promise<void> {
    if (this.locked) return;
    try {
      const rawCtx = this.rawCanvas.getContext('2d', { willReadFrequently: true })!;
      const image = rawCtx.getImageData(0, 0, this.width, this.height);
      const data = image.data;
      const map = this.theme.map;
      const total = this.width * this.height;
      const CHUNK = 160_000; // 像素数，约 2~4ms 一块
      for (let start = 0; start < total; start += CHUNK) {
        const end = Math.min(total, start + CHUNK);
        for (let p = start; p < end; p += 1) {
          const i = p * 4;
          if (data[i + 3] < 24) {
            data[i + 3] = 0;
            continue;
          }
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const light = r * 0.299 + g * 0.587 + b * 0.114;
          // The light-gray base is label-free: keep road surfaces and water,
          // leave the rest transparent for the colour-block art layer.
          if (light > 248) {
            const grain = ((i * 1103515245 + 12345) >>> 16) % 4 - 2;
            data[i] = map.road[0] + grain;
            data[i + 1] = map.road[1] + grain;
            data[i + 2] = map.road[2] + grain;
            // A whole-city frame holds every lane in the base; at full opacity it
            // turns the poster into grey mesh. Keep it as quiet texture so the
            // route stays the only thing that reads.
            data[i + 3] = 118;
          } else if (light < 230 && b > r + 6) {
            const grain = ((i * 1103515245 + 12345) >>> 16) % 4 - 2;
            data[i] = map.water[0] + grain;
            data[i + 1] = map.water[1] + grain;
            data[i + 2] = map.water[2] + grain;
            data[i + 3] = 232;
          } else {
            data[i + 3] = 0;
          }
        }
        await TrackMap.yieldFrame();
      }

      // Only keep long road/rail linework. Small isolated components are
      // road-name glyphs, route shields, station names or intersection labels.
      const w = this.width;
      const h = this.height;
      const visited = new Uint8Array(w * h);
      const stack: number[] = [];
      for (let start = 0; start < w * h; start += CHUNK) {
        const end = Math.min(w * h, start + CHUNK);
        for (let p = start; p < end; p += 1) {
          if (visited[p] || data[p * 4 + 3] === 0) continue;
          stack.length = 0;
          stack.push(p);
          visited[p] = 1;
          const component: number[] = [];
          let minX = w;
          let maxX = 0;
          let minY = h;
          let maxY = 0;
          while (stack.length) {
            const current = stack.pop()!;
            component.push(current);
            const cx = current % w;
            const cy = Math.floor(current / w);
            minX = Math.min(minX, cx);
            maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy);
            maxY = Math.max(maxY, cy);
            for (const next of [current - 1, current + 1, current - w, current + w]) {
              if (next < 0 || next >= w * h) continue;
              if (Math.abs((next % w) - cx) > 1) continue;
              if (visited[next] || data[next * 4 + 3] === 0) continue;
              visited[next] = 1;
              stack.push(next);
            }
          }
          const spanX = maxX - minX;
          const spanY = maxY - minY;
          if ((spanX < 100 && spanY < 20) || (spanX < 32 && spanY < 32) || Math.max(spanX, spanY) < 28) {
            for (const pixel of component) data[pixel * 4 + 3] = 0;
          }
        }
        await TrackMap.yieldFrame();
      }

      rawCtx.putImageData(image, 0, 0);
      const ctx = this.canvas.getContext('2d')!;
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.drawImage(this.artCanvas, 0, 0);
      const edge = this.theme.map.roadEdge;
      ctx.save();
      ctx.shadowColor = `rgb(${edge[0]}, ${edge[1]}, ${edge[2]})`;
      ctx.shadowBlur = 3;
      ctx.drawImage(this.rawCanvas, 0, 0);
      ctx.restore();
      ctx.drawImage(this.rawCanvas, 0, 0);
      this.darkPaletteApplied = true;
      this.rawCanvas = this.canvas;
    } catch {
      this.darkPaletteApplied = false;
    }
  }
}

function layoutMap(activity: Activity): { zoom: number; originX: number; originY: number; width: number; height: number } {
  const minLat = activity.bounds.minLat;
  const maxLat = activity.bounds.maxLat;
  const minLon = activity.bounds.minLon;
  const maxLon = activity.bounds.maxLon;

  // Keep the route around 1.2–1.7k map pixels: enough detail without allocating
  // a 4k canvas on a phone. A 23 km ride lands at z13, a 6 km run at z15.
  let zoom = 17;
  for (; zoom >= 10; zoom -= 1) {
    const a = project(minLat, minLon, zoom);
    const b = project(maxLat, maxLon, zoom);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (Math.max(w, h) <= 1700) break;
  }
  const topLeft = project(maxLat, minLon, zoom);
  const bottomRight = project(minLat, maxLon, zoom);
  const routeW = Math.max(64, Math.abs(bottomRight.x - topLeft.x));
  const routeH = Math.max(64, Math.abs(bottomRight.y - topLeft.y));

  // Match the stage's fit/result scales so the tile canvas always covers a 1080×1920 frame.
  const fitScale = Math.min(940 / routeW, 1050 / routeH, 9);
  const resultScale = Math.min(980 / routeW, 560 / routeH, fitScale * 1.1);
  const coverScale = Math.min(fitScale, resultScale);
  const desiredW = Math.max(routeW * 1.28, (1080 / coverScale) * 1.18);
  const desiredH = Math.max(routeH * 1.28, (1920 / coverScale) * 1.18);
  const width = Math.min(3840, Math.ceil(desiredW / TILE_SIZE) * TILE_SIZE);
  const height = Math.min(4096, Math.ceil(desiredH / TILE_SIZE) * TILE_SIZE);

  const routeCenterX = (topLeft.x + bottomRight.x) / 2;
  const routeCenterY = (topLeft.y + bottomRight.y) / 2;
  const originX = Math.floor((routeCenterX - width / 2) / TILE_SIZE) * TILE_SIZE;
  const originY = Math.floor((routeCenterY - height / 2) / TILE_SIZE) * TILE_SIZE;
  return { zoom, originX, originY, width, height };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function boundsOf(points: MapRoutePoint[]): { minX: number; maxX: number; minY: number; maxY: number } {
  return points.reduce(
    (box, point) => ({
      minX: Math.min(box.minX, point.x),
      maxX: Math.max(box.maxX, point.x),
      minY: Math.min(box.minY, point.y),
      maxY: Math.max(box.maxY, point.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
}

function loadTile(zoom: number, x: number, y: number): Promise<TileImage | null> {
  return loadTileImage(zoom, x, y);
}

export function makeMapTile(image: TileImage, theme: VideoTheme): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = TILE_SIZE;
  tile.height = TILE_SIZE;
  const ctx = tile.getContext('2d', { willReadFrequently: true })!;
  ctx.filter = 'blur(0.9px)';
  ctx.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE);
  ctx.filter = 'none';
  const frame = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const data = frame.data;
  const map = theme.map;
  const bg = map.background;

  const smoothstep = (edge0: number, edge1: number, value: number): number => {
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  const mix = (from: readonly number[], to: readonly number[], amount: number): [number, number, number] => [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const light = r * 0.299 + g * 0.587 + b * 0.114;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);

    // Per-pixel soft weights keep the anti-aliased edge pixels from the source
    // instead of turning roads into a hard black/white mask.
    const road = smoothstep(246, 254, light);
    const water =
      smoothstep(4, 14, b - r) *
      smoothstep(160, 195, light) *
      (1 - smoothstep(236, 250, light));
    const park =
      smoothstep(3, 11, g - r) *
      smoothstep(3, 9, g - b) *
      smoothstep(170, 205, light) *
      (1 - water) *
      (1 - smoothstep(238, 250, light));
    const building =
      smoothstep(208, 218, light) *
      (1 - smoothstep(235, 245, light)) *
      (1 - smoothstep(8, 18, saturation)) *
      (1 - road) *
      (1 - water) *
      (1 - park);

    let color: [number, number, number] = [bg[0], bg[1], bg[2]];
    color = mix(color, map.building, building);
    color = mix(color, map.park, park);
    color = mix(color, map.water, water);
    color = mix(color, map.road, road);

    const grain = ((i * 1103515245 + 12345) >>> 16) % 3 - 1;
    data[i] = Math.max(0, Math.min(255, Math.round(color[0] + grain)));
    data[i + 1] = Math.max(0, Math.min(255, Math.round(color[1] + grain)));
    data[i + 2] = Math.max(0, Math.min(255, Math.round(color[2] + grain)));
    data[i + 3] = 255;
  }
  ctx.putImageData(frame, 0, 0);
  return tile;
}

function loadRailTile(zoom: number, x: number, y: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.src = `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${zoom}/${y}/${x}`;
    const timeout = window.setTimeout(() => {
      image.src = '';
      resolve(null);
    }, 7000);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      resolve(null);
    };
  });
}

function loadWaterTile(zoom: number, x: number, y: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.src = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${zoom}/${y}/${x}`;
    const timeout = window.setTimeout(() => {
      image.src = '';
      resolve(null);
    }, 5000);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      resolve(null);
    };
  });
}

function paintArtMap(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  routeBounds: { minX: number; maxX: number; minY: number; maxY: number },
  activity: Activity,
  theme: VideoTheme,
): void {
  const ctx = canvas.getContext('2d')!;
  const seed = hashSeed(activity.center.lat * 1000 + activity.center.lon * 1000);
  const random = mulberry32(seed);
  const cx = (routeBounds.minX + routeBounds.maxX) / 2;
  const cy = (routeBounds.minY + routeBounds.maxY) / 2;
  const span = Math.max(routeBounds.maxX - routeBounds.minX, routeBounds.maxY - routeBounds.minY);

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, theme.art.bg1);
  background.addColorStop(0.55, theme.art.bg2);
  background.addColorStop(1, theme.art.bg2);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // Soft city glow around the route.
  const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, span * 0.95);
  glow.addColorStop(0, theme.art.glow);
  glow.addColorStop(0.55, theme.art.glow);
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // A river / green belt that gives the abstract map a sense of place.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-18 + random() * 14) * (Math.PI / 180));
  const riverY = (random() - 0.5) * span * 0.45;
  ctx.beginPath();
  ctx.moveTo(-span, riverY - span * 0.2);
  ctx.bezierCurveTo(-span * 0.4, riverY - span * 0.36, span * 0.2, riverY + span * 0.24, span, riverY + span * 0.05);
  ctx.strokeStyle = theme.art.water;
  ctx.lineWidth = Math.max(18, span * 0.035);
  ctx.stroke();
  ctx.restore();

  // Street grid: deliberately slightly irregular to avoid a graph-paper look.
  ctx.save();
  ctx.translate(cx, cy);
  const angle = (-12 + random() * 10) * (Math.PI / 180);
  ctx.rotate(angle);
  const spacing = Math.max(48, Math.min(120, span / 22));
  const reach = span * 2.2;
  for (let gx = -reach; gx <= reach; gx += spacing) {
    const major = Math.abs(Math.round(gx / spacing)) % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(gx + (random() - 0.5) * 8, -reach);
    ctx.lineTo(gx + (random() - 0.5) * 8, reach);
    ctx.strokeStyle = major ? theme.art.block : theme.art.grid;
    ctx.lineWidth = major ? 2 : 0.9;
    ctx.stroke();
  }
  for (let gy = -reach; gy <= reach; gy += spacing) {
    const major = Math.abs(Math.round(gy / spacing)) % 5 === 0;
    ctx.beginPath();
    ctx.moveTo(-reach, gy + (random() - 0.5) * 8);
    ctx.lineTo(reach, gy + (random() - 0.5) * 8);
    ctx.strokeStyle = major ? theme.art.block : theme.art.grid;
    ctx.lineWidth = major ? 2 : 0.9;
    ctx.stroke();
  }
  ctx.restore();

  // Blocks, parks and a handful of contour rings.
  for (let i = 0; i < 92; i += 1) {
    const x = cx + (random() - 0.5) * span * 2;
    const y = cy + (random() - 0.5) * span * 2;
    const w = 26 + random() * Math.min(150, span * 0.1);
    const h = 22 + random() * Math.min(110, span * 0.08);
    if (random() > 0.66) {
      ctx.beginPath();
      ctx.ellipse(x, y, w * 0.7, h * 0.55, random() * Math.PI, 0, Math.PI * 2);
      ctx.fillStyle = theme.art.park;
      ctx.fill();
    } else {
      ctx.fillStyle = theme.art.block;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = theme.art.blockStroke;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(x, y, w, h);
    }
  }

  for (let c = 0; c < 4; c += 1) {
    const ox = cx + (random() - 0.5) * span;
    const oy = cy + (random() - 0.5) * span;
    const radius = span * (0.08 + random() * 0.14);
    for (let ring = 0; ring < 7; ring += 1) {
      ctx.beginPath();
      const wobble = 0.82 + random() * 0.2;
      ctx.ellipse(ox, oy, radius * (1 + ring * 0.09), radius * wobble * (1 + ring * 0.07), 0.3 + c, 0, Math.PI * 2);
      ctx.strokeStyle = theme.art.contour;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 0.035;
  for (let i = 0; i < 900; i += 1) {
    ctx.fillStyle = random() > 0.5 ? theme.art.blockStroke : theme.art.block;
    ctx.fillRect(random() * width, random() * height, 1, 1);
  }
  ctx.globalAlpha = 1;
}

function hashSeed(value: number): number {
  let hash = Math.floor(value * 1000) | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
