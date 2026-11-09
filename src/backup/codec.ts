/**
 * 远端轨迹的紧凑编码。
 *
 * 放云端的东西和放本地的不一样：本地有 IndexedDB，一条轨迹 1.5 MB 无所谓；
 * 云上按仓库容量算钱，一条 7 小时骑行要压到几百 KB 才敢存五年数据。
 *
 * 三个手段：
 * 1. 只存无法推导的字段。距离和速度在 buildActivity 里会按经纬度重算，
 *    存了也是白存 —— 直接砍掉，每点省 8 字节。
 * 2. 时间戳存「首点 f64 + 后续 u32 秒差」，比每点 8 字节少一半。
 * 3. 经纬度按 1e-7 度量化成 i32（FIT 原生精度，约 1.1 cm，远小于 GPS 误差）。
 *
 * 结果：38,795 点的一条骑行约 700 KB 原始，gzip 后 200~300 KB。
 * 文件内容是 `1g.<base64>` 或 `1r.<base64>`，纯文本，GitHub / Gitee 的
 * Contents API 都能安全搬运，不用担心二进制被当文本改写。
 */

import type { StoredSession, StoredTrack } from '../store/types';

const MAGIC = 0x42544d46; // 'F','M','T','B' 的小端 u32
const VERSION = 1;
const SCALE = 1e7;
const ALT_NULL = -32768;

const FLAG_TIME = 1;
const FLAG_ALT = 2;
const FLAG_HR = 4;

export interface TrackPayload {
  session: StoredSession;
  sportHint: number;
  hasTimestamps: boolean;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** StoredTrack → 二进制。读回来时距离、速度会由 buildActivity 重算。 */
export function encodeTrack(track: StoredTrack): Uint8Array {
  const count = track.lat.length;
  const hasTime = Boolean(track.hasTimestamps);
  const hasAlt = Boolean(track.alt);
  const hasHr = Boolean(track.hr);
  const flags = (hasTime ? FLAG_TIME : 0) | (hasAlt ? FLAG_ALT : 0) | (hasHr ? FLAG_HR : 0);

  const tail = new TextEncoder().encode(JSON.stringify({
    session: track.session ?? {},
    sportHint: track.sportHint ?? 0,
    hasTimestamps: hasTime,
  } satisfies TrackPayload));

  const bytesPer = 8 + (hasTime ? 4 : 0) + (hasAlt ? 2 : 0) + (hasHr ? 1 : 0);
  const size = 20 + count * bytesPer + 4 + tail.byteLength;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  const base = hasTime && count > 0 ? track.t[0] : 0;
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint8(6, flags);
  view.setUint8(7, 0);
  view.setUint32(8, count, true);
  view.setFloat64(12, base, true);

  let offset = 20;
  for (let i = 0; i < count; i += 1) {
    view.setInt32(offset, clampInt(track.lat[i] * SCALE, -2147483648, 2147483647), true);
    offset += 4;
  }
  for (let i = 0; i < count; i += 1) {
    view.setInt32(offset, clampInt(track.lon[i] * SCALE, -2147483648, 2147483647), true);
    offset += 4;
  }
  if (hasTime) {
    for (let i = 0; i < count; i += 1) {
      const delta = clampInt((track.t[i] - base) / 1000, 0, 0xffffffff);
      view.setUint32(offset, delta, true);
      offset += 4;
    }
  }
  if (hasAlt) {
    const alt = track.alt!;
    for (let i = 0; i < count; i += 1) {
      const value = alt[i];
      view.setInt16(offset, value >= 0 ? clampInt(value * 10, -32767, 32767) : ALT_NULL, true);
      offset += 2;
    }
  }
  if (hasHr) {
    const hr = track.hr!;
    for (let i = 0; i < count; i += 1) {
      const value = hr[i];
      view.setUint8(offset, value > 0 ? Math.min(255, Math.round(value)) : 0);
      offset += 1;
    }
  }
  view.setUint32(offset, tail.byteLength, true);
  offset += 4;
  out.set(tail, offset);
  return out;
}

export function decodeTrack(bytes: Uint8Array, id: string): StoredTrack {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('轨迹文件格式不对');
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`轨迹文件版本不支持（${version}）`);
  const flags = view.getUint8(6);
  const count = view.getUint32(8, true);
  const base = view.getFloat64(12, true);

  const lat = new Float32Array(count);
  const lon = new Float32Array(count);
  const t = new Float64Array(count);
  const alt = flags & FLAG_ALT ? new Float32Array(count) : null;
  const hr = flags & FLAG_HR ? new Int16Array(count) : null;

  let offset = 20;
  for (let i = 0; i < count; i += 1) {
    lat[i] = view.getInt32(offset, true) / SCALE;
    offset += 4;
  }
  for (let i = 0; i < count; i += 1) {
    lon[i] = view.getInt32(offset, true) / SCALE;
    offset += 4;
  }
  if (flags & FLAG_TIME) {
    for (let i = 0; i < count; i += 1) {
      t[i] = base + view.getUint32(offset, true) * 1000;
      offset += 4;
    }
  }
  if (alt) {
    for (let i = 0; i < count; i += 1) {
      const raw = view.getInt16(offset, true);
      alt[i] = raw === ALT_NULL ? -1 : raw / 10;
      offset += 2;
    }
  }
  if (hr) {
    for (let i = 0; i < count; i += 1) {
      const raw = view.getUint8(offset);
      hr[i] = raw === 0 ? -1 : raw;
      offset += 1;
    }
  }
  const jsonLen = view.getUint32(offset, true);
  offset += 4;
  const json = new TextDecoder().decode(bytes.subarray(offset, offset + jsonLen));
  let payload: TrackPayload = { session: {}, sportHint: 0, hasTimestamps: (flags & FLAG_TIME) > 0 };
  try {
    payload = { ...payload, ...(JSON.parse(json) as TrackPayload) };
  } catch {
    /* 元信息坏了也不该拦住轨迹本身 */
  }

  return {
    id,
    lat,
    lon,
    t,
    alt,
    hr,
    speed: null,
    dist: null,
    hasTimestamps: payload.hasTimestamps ?? (flags & FLAG_TIME) > 0,
    sportHint: payload.sportHint ?? 0,
    session: payload.session ?? {},
  };
}

/* ------------------------------- 文本封装 ------------------------------- */

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压');
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 轨迹 → 可放仓库的文本（`1g.` gzip / `1r.` 原始）。 */
export async function packTrack(track: StoredTrack): Promise<{ text: string; bytes: number }> {
  const raw = encodeTrack(track);
  const zipped = await gzip(raw);
  const body = zipped ?? raw;
  const text = `${zipped ? '1g' : '1r'}.${toBase64(body)}`;
  return { text, bytes: body.byteLength };
}

export async function unpackTrack(text: string, id: string): Promise<StoredTrack> {
  const trimmed = text.trim();
  const dot = trimmed.indexOf('.');
  if (dot < 0) throw new Error('轨迹文件缺少版本前缀');
  const tag = trimmed.slice(0, dot);
  const body = fromBase64(trimmed.slice(dot + 1));
  if (tag === '1g') return decodeTrack(await gunzip(body), id);
  if (tag === '1r') return decodeTrack(body, id);
  throw new Error(`未知的轨迹文件版本：${tag}`);
}
