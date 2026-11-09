/**
 * 记录卡缩略图：把整条轨迹压成 44×44 的 SVG path。
 *
 * 列表里一眼能认出「环形通勤」「一条直线」「沿江折返」，比一张 30KB 的
 * 海报小图省得多，386 条记录的缩略图加起来也就一百多 KB。
 */

const BOX = 44;
const PAD = 4;
const MAX_POINTS = 72;

export function thumbPath(lat: number[], lon: number[]): string {
  if (lat.length < 2) return '';
  const step = Math.max(1, Math.ceil(lat.length / MAX_POINTS));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < lat.length; i += step) {
    xs.push(lon[i]);
    ys.push(lat[i]);
  }
  const last = lat.length - 1;
  if ((last % step) !== 0) {
    xs.push(lon[last]);
    ys.push(lat[last]);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  // 纬度越高，经度方向越窄，这里按 cos(lat) 校正，避免北方城市被压扁
  const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
  const kx = Math.max(1e-6, Math.cos(midLat));
  const spanX = Math.max(1e-9, (maxX - minX) * kx);
  const spanY = Math.max(1e-9, maxY - minY);
  const scale = (BOX - PAD * 2) / Math.max(spanX, spanY);
  const offsetX = (BOX - spanX * scale) / 2;
  const offsetY = (BOX - spanY * scale) / 2;

  let path = '';
  for (let i = 0; i < xs.length; i += 1) {
    const x = offsetX + ((xs[i] - minX) * kx) * scale;
    const y = BOX - offsetY - (ys[i] - minY) * scale;
    path += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return path;
}
