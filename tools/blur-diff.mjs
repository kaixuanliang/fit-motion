/** 对比两张同尺寸 PNG：整幅 MAD + 分块高频能量差，定位糊的区域。 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const dir = path.join(process.cwd(), '.workbuddy', 'tmp', 'blur-probe');
const a = PNG.sync.read(fs.readFileSync(path.join(dir, process.argv[2] ?? 'frame-12.00.png')));
const b = PNG.sync.read(fs.readFileSync(path.join(dir, process.argv[3] ?? 'frame-12.00-stable.png')));
const { width: w, height: h } = a;
const gray = (png) => {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < png.data.length; i += 4, p += 1) {
    out[p] = png.data[i] * 0.299 + png.data[i + 1] * 0.587 + png.data[i + 2] * 0.114;
  }
  return out;
};
const ga = gray(a);
const gb = gray(b);
let mad = 0;
let diffPixels = 0;
const maxDelta = { v: 0, x: 0, y: 0 };
for (let p = 0; p < w * h; p += 1) {
  const d = Math.abs(ga[p] - gb[p]);
  mad += d;
  if (d > 10) diffPixels += 1;
  if (d > maxDelta.v) { maxDelta.v = d; maxDelta.x = p % w; maxDelta.y = Math.floor(p / w); }
}
console.log(JSON.stringify({
  size: [w, h],
  mad: Number((mad / (w * h)).toFixed(3)),
  diffPct: Number(((diffPixels / (w * h)) * 100).toFixed(3)),
  maxDelta,
}));

// 16x16 分块 MAD 热点
const CELLS = 16;
const cw = Math.floor(w / CELLS);
const chh = Math.floor(h / CELLS);
const cells = [];
for (let cy = 0; cy < CELLS; cy += 1) {
  for (let cx = 0; cx < CELLS; cx += 1) {
    let s = 0;
    let n = 0;
    for (let y = cy * chh; y < (cy + 1) * chh; y += 1) {
      for (let x = cx * cw; x < (cx + 1) * cw; x += 1) {
        s += Math.abs(ga[y * w + x] - gb[y * w + x]);
        n += 1;
      }
    }
    cells.push({ cx, cy, mad: Number((s / n).toFixed(1)) });
  }
}
cells.sort((p, q) => q.mad - p.mad);
console.log('top cells', JSON.stringify(cells.slice(0, 8)));
