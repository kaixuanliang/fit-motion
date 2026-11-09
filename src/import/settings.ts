/**
 * 导入偏好：最小距离阈值。
 *
 * 华为导出的数据副本一次会有几百条运动，里面混着大量「3 公里的通勤/买菜」。
 * 阈值只保存在本机（localStorage），导入时低于阈值的文件直接跳过，
 * 不写库、不占空间，报告里单独列出来。
 */

const KEY = 'fitmotion-min-distance-km';

/** 0 表示不限制。 */
export function getMinDistanceKm(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function setMinDistanceKm(value: number): void {
  try {
    const safe = Number.isFinite(value) && value > 0 ? Math.min(1000, value) : 0;
    if (safe === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(safe));
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}
