import type { VectorTile } from '@mapbox/vector-tile';
import type { Rgb } from './theme';

/**
 * 矢量瓦片光栅化绘制（主线程回退与 Worker 共用同一份代码）。
 *
 * 从 vector-map.ts 抽出：两段绘制逻辑只依赖 theme.map 的颜色表，
 * 不依赖任何 DOM 实例状态，因此可以直接在 Worker 里跑
 * （OffscreenCanvas + Path2D），产出 ImageBitmap 转移回主线程。
 */

export type ThemeMapColors = VideoThemeMap;

interface VideoThemeMap {
  background: Rgb;
  water: Rgb;
  park: Rgb;
  building: Rgb;
  roadEdge: Rgb;
  road: Rgb;
  transit: Rgb;
  roadMajor: Rgb;
  roadPrimary: Rgb;
  roadMinor: Rgb;
  national: Rgb;
}

export type TilePoint = { x: number; y: number };
export type PaintCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const BITMAP_PAD = 8;

function rgb(color: Rgb): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

/**
 * 第一视角（z14 街道级）瓦片绘制。与 NativeVectorMap.paintTile 同一套
 * 制图规则：地块填充 → 水系 → 双通道道路（描边在下、路面在上）。
 */
export function paintFollowTile(
  target: PaintCtx,
  tile: VectorTile,
  extent: number,
  sizePx: number,
  viewW: number,
  viewH: number,
  map: ThemeMapColors,
): void {
  const unit = sizePx / extent;
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

  const layers = tile.layers as Record<string, any>;

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

/**
 * 总览（城市级）瓦片绘制。与 NativeVectorMap 总览制图一致：路宽按
 * 256px 瓦片基准、随光栅化尺寸等比缩放；小尺寸走稀疏模式（只留水面、
 * 公园、干道与国道），解码量少一大半。
 */
export function paintOverviewTile(
  target: PaintCtx,
  tile: VectorTile,
  extent: number,
  sizePx: number,
  viewW: number,
  viewH: number,
  map: ThemeMapColors,
  zoom: number,
): void {
  const unit = sizePx / extent;
  // Road widths are authored against a 256 px tile, exactly like the native
  // renderer. Scaling them by the raster/tile ratio keeps the stroke weight on
  // screen constant instead of ballooning when a tile is rasterised large.
  const widthScale = sizePx / 256;
  // 位图被压到 200px 出头时，一栋楼、一条支路在屏幕上不到 1px ——
  // 画它们纯属浪费（每张瓦片要为此遍历上千个 feature）。这种尺寸直接
  // 按稀疏模式画：只留水面、干道和高速，视觉上没有区别，解码量少一大半。
  const sparse = zoom <= 11 || sizePx < 256;
  const layers = tile.layers as Record<string, any>;
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
