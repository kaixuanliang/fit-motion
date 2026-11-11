/** 把 GPX 轨迹画成 PNG，用于肉眼确认路线形状（不做地图底图）。 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const [, , input, output] = process.argv;
const text = fs.readFileSync(input, 'utf8');
const pts = [...text.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
if (pts.length < 2) throw new Error('没有轨迹点');

const W = 900;
const H = 900;
const lat0 = Math.min(...pts.map((p) => p[0]));
const lat1 = Math.max(...pts.map((p) => p[0]));
const lon0 = Math.min(...pts.map((p) => p[1]));
const lon1 = Math.max(...pts.map((p) => p[1]));
const k = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
const spanX = (lon1 - lon0) * k;
const spanY = lat1 - lat0;
const scale = Math.min((W - 80) / spanX, (H - 80) / spanY);
const px = (lon) => 40 + ((lon - lon0) * k) * scale + ((W - 80) - spanX * scale) / 2;
const py = (lat) => H - 40 - (lat - lat0) * scale - ((H - 80) - spanY * scale) / 2;

const png = new PNG({ width: W, height: H });
for (let i = 0; i < png.data.length; i += 4) {
  png.data[i] = 18; png.data[i + 1] = 22; png.data[i + 2] = 30; png.data[i + 3] = 255;
}
const dot = (x, y, r, g, b) => {
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const xx = Math.round(x) + dx;
      const yy = Math.round(y) + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const idx = (yy * W + xx) * 4;
      png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b;
    }
  }
};
for (let i = 1; i < pts.length; i += 1) {
  const x1 = px(pts[i - 1][1]); const y1 = py(pts[i - 1][0]);
  const x2 = px(pts[i][1]); const y2 = py(pts[i][0]);
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
  for (let s = 0; s <= steps; s += 1) {
    const f = s / steps;
    dot(x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, 80, 200, 255);
  }
}
dot(px(pts[0][1]), py(pts[0][0]), 90, 255, 120);          // 起点绿
dot(px(pts[pts.length - 1][1]), py(pts[pts.length - 1][0]), 255, 90, 90); // 终点红

fs.writeFileSync(output, PNG.sync.write(png));
console.log(`${path.basename(input)} → ${path.basename(output)}  ${pts.length} 点  包围盒 ${lat0.toFixed(3)}~${lat1.toFixed(3)}N ${lon0.toFixed(3)}~${lon1.toFixed(3)}E`);
