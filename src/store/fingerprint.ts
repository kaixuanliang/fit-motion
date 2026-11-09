/**
 * 两层去重指纹。
 *
 * - 文件指纹：整份文件的 SHA-256，命中说明「同一个文件又导入了一次」。
 * - 运动指纹：开始时间 + 时长 + 距离，命中说明「同一趟运动」——通常是
 *   手表和码表各记了一份，内容不同但运动相同。
 */

import type { MotionFp } from './types';

/** 开始时间容忍窗口：两侧各 2 分钟。 */
const START_WINDOW_MS = 120_000;

/**
 * 计算文件指纹。优先用 SubtleCrypto；file:// 之类非安全上下文里
 * `crypto.subtle` 不存在，退回 64 位 FNV-1a，去重够用且不阻塞主线程。
 */
export async function hashBytes(data: ArrayBuffer, onProgress?: (ratio: number) => void): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', data);
      onProgress?.(1);
      return toHex(new Uint8Array(digest));
    } catch {
      /* 某些 WebView 会拒绝大 buffer，走下面的兜底 */
    }
  }
  return fnv1a64(new Uint8Array(data), onProgress);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function fnv1a64(bytes: Uint8Array, onProgress?: (ratio: number) => void): string {
  // 两路不同初值的 FNV-1a 交叉，降低短文件撞车概率
  let a = 0xcbf29ce4;
  let b = 0x84222325;
  const total = bytes.length;
  for (let i = 0; i < total; i += 1) {
    a ^= bytes[i];
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= bytes[total - 1 - i];
    b = Math.imul(b, 0x01000193) >>> 0;
    if (onProgress && (i & 0x3ffff) === 0) onProgress(i / total);
  }
  onProgress?.(1);
  return 'f' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') + total.toString(16);
}

export function motionFp(start: number, duration: number, distance: number): MotionFp {
  return {
    start: Math.round(start / 1000) * 1000,
    duration: Math.round(duration),
    distance: Math.round(distance),
  };
}

/** 同一趟运动的判定：时间窗口内，时长与距离都在容差内。 */
export function sameMotion(a: MotionFp, b: MotionFp): boolean {
  if (Math.abs(a.start - b.start) > START_WINDOW_MS) return false;
  const durTolerance = Math.max(120, b.duration * 0.02);
  const distTolerance = Math.max(200, b.distance * 0.02);
  return Math.abs(a.duration - b.duration) <= durTolerance
    && Math.abs(a.distance - b.distance) <= distTolerance;
}

export { START_WINDOW_MS };
