import type { Activity } from '../fit/activity';
import { project, TILE_SIZE } from '../geo';
import type { MapCamera, TrackMap } from './map';
import { makeMapTile } from './map';
import type { VideoTheme } from './theme';
import { fetchTileBlob, loadTileImage } from './tile-cache';

const SEGMENT_METERS = 100_000;
const TILE_BUFFER = 1;
const RENDER_SIZE = 256;

interface Segment {
  index: number;
  startDistance: number;
  endDistance: number;
  keys: string[];
}

function keyOf(zoom: number, x: number, y: number): string {
  return `${zoom}/${x}/${y}`;
}

function parseKey(key: string): [number, number, number] {
  const [z, x, y] = key.split('/').map(Number);
  return [z, x, y];
}

function tileCoords(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const world = project(lat, lon, zoom);
  return { x: Math.floor(world.x / TILE_SIZE), y: Math.floor(world.y / TILE_SIZE) };
}

function buildSegments(activity: Activity, zoom: number): Segment[] {
  const count = Math.max(1, Math.ceil(activity.distanceM / SEGMENT_METERS));
  const segments: Segment[] = Array.from({ length: count }, (_, index) => ({
    index,
    startDistance: index * SEGMENT_METERS,
    endDistance: Math.min(activity.distanceM, (index + 1) * SEGMENT_METERS),
    keys: [],
  }));
  const seen = new Set<string>();
  for (const point of activity.points) {
    const segmentIndex = Math.min(count - 1, Math.floor(point.distance / SEGMENT_METERS));
    const segment = segments[segmentIndex];
    const tile = tileCoords(point.lat, point.lon, zoom);
    for (let dx = -TILE_BUFFER; dx <= TILE_BUFFER; dx += 1) {
      for (let dy = -TILE_BUFFER; dy <= TILE_BUFFER; dy += 1) {
        const key = keyOf(zoom, tile.x + dx, tile.y + dy);
        if (seen.has(key)) continue;
        seen.add(key);
        segment.keys.push(key);
      }
    }
  }
  // A route can revisit the same tiles in another segment; make sure the first
  // segment still owns a copy so priming either segment is safe.
  for (const segment of segments) {
    if (segment.keys.length) continue;
    const fallback = segments.find((item) => item.keys.length > 0);
    if (fallback) segment.keys = fallback.keys.slice(0, 1);
  }
  return segments;
}

function resizeTile(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = RENDER_SIZE;
  canvas.height = RENDER_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, RENDER_SIZE, RENDER_SIZE);
  return canvas;
}

/**
 * High-resolution map for the follow camera. It uses an absolute z15/z16 tile
 * store and draws only the visible tiles, so the overview z11 raster is never
 * upscaled for the first-person shot.
 */
export class FollowTileLayer {
  readonly zoom: number;
  readonly segments: Segment[];
  readonly totalTiles: number;
  private readonly theme: VideoTheme;
  private readonly base: TrackMap;
  private readonly active = new Map<string, HTMLCanvasElement>();
  private readonly allKeys: string[];
  private prefetched = false;
  private prefetchFailed = 0;
  private priming: Promise<void> | null = null;
  private primed: number[] = [];
  private lastRequested = -1;

  constructor(activity: Activity, theme: VideoTheme, base: TrackMap) {
    this.theme = theme;
    this.base = base;
    this.zoom = Math.max(14, base.zoom);
    this.segments = buildSegments(activity, this.zoom);
    const keys = new Set<string>();
    for (const segment of this.segments) {
      for (const key of segment.keys) keys.add(key);
    }
    this.allKeys = [...keys];
    this.totalTiles = this.allKeys.length;
  }

  get failedTiles(): number {
    return this.prefetchFailed;
  }

  get ready(): boolean {
    return this.prefetched;
  }

  async prefetch(onProgress?: (done: number, total: number) => void): Promise<void> {
    let cursor = 0;
    let done = 0;
    const workers = 12;
    const run = async (): Promise<void> => {
      while (cursor < this.allKeys.length) {
        const key = this.allKeys[cursor++];
        const [z, x, y] = parseKey(key);
        const blob = await fetchTileBlob(z, x, y);
        if (!blob) this.prefetchFailed += 1;
        done += 1;
        onProgress?.(done, this.allKeys.length);
        // 让出主线程：连续解码会让创作页滚动卡死
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    await Promise.all(Array.from({ length: workers }, () => run()));
    this.prefetched = true;
  }

  async prime(progress: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    const index = Math.min(this.segments.length - 1, Math.max(0, Math.floor(progress * this.segments.length)));
    const wanted = [index, Math.min(this.segments.length - 1, index + 1)];
    if (this.priming) {
      await this.priming;
    }
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
    const keep = new Set<number>(wanted);
    for (const key of [...this.active.keys()]) {
      // Keep active tiles only while one of their segments is still wanted.
      if (!wanted.some((index) => this.segments[index].keys.includes(key))) {
        this.active.delete(key);
      }
    }
    const keys = [...new Set(wanted.flatMap((index) => this.segments[index].keys))];
    let done = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < keys.length) {
        const key = keys[cursor++];
        if (!this.active.has(key)) {
          const [z, x, y] = parseKey(key);
          const image = await loadTileImage(z, x, y);
          if (image) this.active.set(key, resizeTile(makeMapTile(image, this.theme)));
        }
        done += 1;
        onProgress?.(done, keys.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, () => worker()));
    this.primed = [...new Set([...this.primed.filter((index) => keep.has(index)), ...wanted])];
  }

  draw(ctx: CanvasRenderingContext2D, camera: MapCamera, stageWidth: number, stageHeight: number): void {
    if (!this.active.size) return;
    const diff = this.zoom - this.base.zoom;
    const worldScale = 2 ** diff;
    const scale = camera.scale;
    const left = camera.x - stageWidth / 2 / scale;
    const right = camera.x + stageWidth / 2 / scale;
    const top = camera.y - stageHeight / 2 / scale;
    const bottom = camera.y + stageHeight / 2 / scale;
    const x0 = Math.floor(((left + this.base.originX) * worldScale) / TILE_SIZE) - 1;
    const x1 = Math.floor(((right + this.base.originX) * worldScale) / TILE_SIZE) + 1;
    const y0 = Math.floor(((top + this.base.originY) * worldScale) / TILE_SIZE) - 1;
    const y1 = Math.floor(((bottom + this.base.originY) * worldScale) / TILE_SIZE) + 1;
    const screenSize = (TILE_SIZE * scale) / worldScale;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const tile = this.active.get(keyOf(this.zoom, x, y));
        if (!tile) continue;
        const worldX = (x * TILE_SIZE) / worldScale - this.base.originX;
        const worldY = (y * TILE_SIZE) / worldScale - this.base.originY;
        const sx = stageWidth / 2 + (worldX - camera.x) * scale;
        const sy = stageHeight / 2 + (worldY - camera.y) * scale;
        ctx.drawImage(tile, sx, sy, screenSize + 0.6, screenSize + 0.6);
      }
    }
    ctx.restore();
  }

  clear(): void {
    this.active.clear();
    this.primed = [];
    this.priming = null;
  }
}
