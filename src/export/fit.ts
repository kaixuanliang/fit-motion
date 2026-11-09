/**
 * FIT 导出：把 Activity 写回标准 .fit 二进制。
 *
 * 只写运动文件必需的四类消息（file_id / record / lap / session / activity），
 * 字段号、缩放与偏移按 Garmin FIT Profile，与本项目的解析器一一对应 ——
 * 导出的文件重新导入后，距离、时长、心率等不会漂移。
 */

import type { Activity } from '../fit/activity';

/** FIT 纪元：1989-12-31T00:00:00Z（UTC 秒） */
const FIT_EPOCH = 631065600;

/** 基础类型字节（FIT Profile 的 base type id） */
const T = {
  enum: 0x00,
  sint8: 0x01,
  uint8: 0x02,
  uint16: 0x84,
  sint32: 0x85,
  uint32: 0x86,
  uint32z: 0x8c,
} as const;

interface FieldDef {
  num: number;
  size: number;
  type: number;
}

const INVALID: Record<number, number> = {
  [T.sint8]: 0x7f,
  [T.enum]: 0xff,
  [T.uint8]: 0xff,
  [T.uint16]: 0xffff,
  [T.sint32]: 0x7fffffff,
  [T.uint32]: 0xffffffff,
  [T.uint32z]: 0xffffffff,
};

/** FIT SDK 的 CRC-16（多项式 0x8005，低位先行） */
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

function crcByte(crc: number, byte: number): number {
  let value = crc;
  let tmp = CRC_TABLE[value & 0x0f];
  value = (value >> 4) & 0x0fff;
  value ^= tmp ^ CRC_TABLE[byte & 0x0f];
  tmp = CRC_TABLE[value & 0x0f];
  value = (value >> 4) & 0x0fff;
  value ^= tmp ^ CRC_TABLE[(byte >> 4) & 0x0f];
  return value & 0xffff;
}

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) crc = crcByte(crc, bytes[i]);
  return crc & 0xffff;
}

class FitBuilder {
  private out: number[] = [];

  private defs: FieldDef[][] = [];

  define(local: number, global: number, fields: FieldDef[]): void {
    this.defs[local] = fields;
    this.out.push(0x40 | local, 0, 0);
    this.pushU16(global);
    this.out.push(fields.length);
    for (const field of fields) this.out.push(field.num, field.size, field.type);
  }

  /** values 顺序必须与 define 的字段顺序一致；null 写成 invalid */
  message(local: number, values: Array<number | null>): void {
    const fields = this.defs[local];
    if (!fields) throw new Error(`未定义的 FIT 局部消息 ${local}`);
    this.out.push(local);
    fields.forEach((field, index) => {
      const raw = values[index];
      const value = raw == null || !Number.isFinite(raw) ? INVALID[field.type] ?? 0xff : raw;
      this.pushValue(value, field.size);
    });
  }

  build(): Uint8Array {
    const data = new Uint8Array(this.out);
    const header = new Uint8Array(14);
    header[0] = 14; // header size
    header[1] = 0x10; // protocol version 1.0
    // profile version 21.12（小端）
    header[2] = 0x40;
    header[3] = 0x08;
    new DataView(header.buffer).setUint32(4, data.length, true);
    header[8] = 0x2e; // .FIT
    header[9] = 0x46;
    header[10] = 0x49;
    header[11] = 0x54;
    new DataView(header.buffer).setUint16(12, crc16(header.subarray(0, 12)), true);

    const file = new Uint8Array(header.length + data.length + 2);
    file.set(header, 0);
    file.set(data, header.length);
    new DataView(file.buffer).setUint16(file.length - 2, crc16(file.subarray(0, file.length - 2)), true);
    return file;
  }

  private pushU16(value: number): void {
    this.out.push(value & 0xff, (value >> 8) & 0xff);
  }

  private pushValue(value: number, size: number): void {
    if (size === 1) {
      this.out.push(value & 0xff);
      return;
    }
    if (size === 2) {
      this.pushU16(value);
      return;
    }
    const unsigned = value >>> 0;
    this.out.push(unsigned & 0xff, (unsigned >> 8) & 0xff, (unsigned >> 16) & 0xff, (unsigned >> 24) & 0xff);
  }
}

function semicircles(degrees: number): number {
  return Math.round((degrees * 2147483648) / 180);
}

function scaled(value: number | undefined, factor: number, offset = 0): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const raw = Math.round((value + offset) * factor);
  return raw < 0 ? 0 : raw;
}

function intOrNull(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const raw = Math.round(value);
  return raw > 0 ? raw : null;
}

/** 海拔：uint16，(米 + 500) × 5 */
function altitudeRaw(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const raw = Math.round((value + 500) * 5);
  return Math.max(0, Math.min(65534, raw));
}

export function activityToFit(activity: Activity): Uint8Array {
  const builder = new FitBuilder();
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = Math.floor((activity.timeAvailable ? activity.startTime : Date.now()) / 1000);
  const endSec = Math.max(startSec + 1, Math.floor((activity.timeAvailable ? activity.endTime : Date.now()) / 1000));

  // file_id：type=4(activity), manufacturer=255(development), product=1
  builder.define(0, 0, [
    { num: 0, size: 1, type: T.enum },
    { num: 1, size: 2, type: T.uint16 },
    { num: 2, size: 2, type: T.uint16 },
    { num: 3, size: 4, type: T.uint32z },
    { num: 4, size: 4, type: T.uint32 },
  ]);
  builder.message(0, [4, 255, 1, 0x0f17a0d1, nowSec]);

  // record
  builder.define(1, 20, [
    { num: 253, size: 4, type: T.uint32 },
    { num: 0, size: 4, type: T.sint32 },
    { num: 1, size: 4, type: T.sint32 },
    { num: 2, size: 2, type: T.uint16 },
    { num: 3, size: 1, type: T.uint8 },
    { num: 4, size: 1, type: T.uint8 },
    { num: 5, size: 4, type: T.uint32 },
    { num: 6, size: 2, type: T.uint16 },
    { num: 7, size: 2, type: T.uint16 },
  ]);

  const points = activity.points;
  const totalSec = Math.max(1, activity.durationAvailable ? activity.durationSec : activity.elapsedSec);
  let lastSec = startSec - 1;
  points.forEach((point, index) => {
    // 没有时间戳的轨（部分 GPX/TCX）按总时长均分补一个，保证时间轴单调
    const planned = activity.timeAvailable && point.t > 0
      ? Math.floor(point.t / 1000)
      : startSec + Math.round((totalSec * index) / Math.max(1, points.length - 1));
    const sec = Math.max(lastSec + 1, planned);
    lastSec = sec;
    builder.message(1, [
      sec - FIT_EPOCH,
      semicircles(point.lat),
      semicircles(point.lon),
      altitudeRaw(point.altitude),
      intOrNull(point.heartRate),
      intOrNull(point.cadence),
      point.distance != null ? Math.max(0, Math.round(point.distance * 100)) : null,
      point.speed != null && point.speed > 0 ? Math.min(65534, Math.round(point.speed * 1000)) : null,
      point.power != null && point.power > 0 ? Math.min(65534, Math.round(point.power)) : null,
    ]);
  });

  const first = points[0];
  const last = points[points.length - 1];
  const distanceRaw = Math.max(0, Math.round(activity.distanceM * 100));
  const elapsed = Math.max(1, activity.elapsedAvailable ? activity.elapsedSec : activity.durationSec);
  const timer = Math.max(1, activity.durationAvailable ? activity.movingSec : activity.durationSec);
  const avgSpeed = activity.avgSpeedAvailable
    ? activity.avgSpeed
    : (activity.distanceM / Math.max(1, timer));
  const calories = activity.calories != null ? Math.max(0, Math.min(65534, Math.round(activity.calories))) : null;

  // lap（单圈 = 整段；重新导入时 buildActivity 以 session 为准，这里只保证数据自洽）
  builder.define(2, 19, [
    { num: 253, size: 4, type: T.uint32 },
    { num: 2, size: 4, type: T.uint32 },
    { num: 3, size: 4, type: T.sint32 },
    { num: 4, size: 4, type: T.sint32 },
    { num: 5, size: 4, type: T.sint32 },
    { num: 6, size: 4, type: T.sint32 },
    { num: 7, size: 4, type: T.uint32 },
    { num: 8, size: 4, type: T.uint32 },
    { num: 9, size: 4, type: T.uint32 },
    { num: 11, size: 2, type: T.uint16 },
    { num: 13, size: 2, type: T.uint16 },
    { num: 14, size: 2, type: T.uint16 },
    { num: 15, size: 1, type: T.uint8 },
    { num: 16, size: 1, type: T.uint8 },
    { num: 17, size: 1, type: T.uint8 },
    { num: 18, size: 1, type: T.uint8 },
    { num: 21, size: 2, type: T.uint16 },
    { num: 22, size: 2, type: T.uint16 },
  ]);
  builder.message(2, [
    endSec - FIT_EPOCH,
    startSec - FIT_EPOCH,
    first ? semicircles(first.lat) : null,
    first ? semicircles(first.lon) : null,
    last ? semicircles(last.lat) : null,
    last ? semicircles(last.lon) : null,
    Math.round(elapsed * 1000),
    Math.round(timer * 1000),
    distanceRaw,
    calories,
    Math.min(65534, Math.round(avgSpeed * 1000)),
    activity.maxSpeedAvailable ? Math.min(65534, Math.round(activity.maxSpeed * 1000)) : null,
    intOrNull(activity.avgHeartRate),
    intOrNull(activity.maxHeartRate),
    intOrNull(activity.avgCadence),
    intOrNull(activity.maxCadence),
    activity.ascent != null ? Math.max(0, Math.min(65534, Math.round(activity.ascent))) : null,
    activity.descent != null ? Math.max(0, Math.min(65534, Math.round(activity.descent))) : null,
  ]);

  // session
  builder.define(3, 18, [
    { num: 253, size: 4, type: T.uint32 },
    { num: 2, size: 4, type: T.uint32 },
    { num: 3, size: 4, type: T.sint32 },
    { num: 4, size: 4, type: T.sint32 },
    { num: 5, size: 1, type: T.enum },
    { num: 6, size: 1, type: T.enum },
    { num: 7, size: 4, type: T.uint32 },
    { num: 8, size: 4, type: T.uint32 },
    { num: 9, size: 4, type: T.uint32 },
    { num: 11, size: 2, type: T.uint16 },
    { num: 14, size: 2, type: T.uint16 },
    { num: 15, size: 2, type: T.uint16 },
    { num: 16, size: 1, type: T.uint8 },
    { num: 17, size: 1, type: T.uint8 },
    { num: 18, size: 1, type: T.uint8 },
    { num: 19, size: 1, type: T.uint8 },
    { num: 20, size: 2, type: T.uint16 },
    { num: 21, size: 2, type: T.uint16 },
    { num: 22, size: 2, type: T.uint16 },
    { num: 23, size: 2, type: T.uint16 },
    { num: 49, size: 2, type: T.uint16 },
    { num: 50, size: 2, type: T.uint16 },
  ]);
  builder.message(3, [
    endSec - FIT_EPOCH,
    startSec - FIT_EPOCH,
    first ? semicircles(first.lat) : null,
    first ? semicircles(first.lon) : null,
    activity.sport ?? 0,
    activity.subSport ?? 0,
    Math.round(elapsed * 1000),
    Math.round(timer * 1000),
    distanceRaw,
    calories,
    Math.min(65534, Math.round(avgSpeed * 1000)),
    activity.maxSpeedAvailable ? Math.min(65534, Math.round(activity.maxSpeed * 1000)) : null,
    intOrNull(activity.avgHeartRate),
    intOrNull(activity.maxHeartRate),
    intOrNull(activity.avgCadence),
    intOrNull(activity.maxCadence),
    activity.avgPower != null ? Math.min(65534, Math.round(activity.avgPower)) : null,
    activity.maxPower != null ? Math.min(65534, Math.round(activity.maxPower)) : null,
    activity.ascent != null ? Math.max(0, Math.min(65534, Math.round(activity.ascent))) : null,
    activity.descent != null ? Math.max(0, Math.min(65534, Math.round(activity.descent))) : null,
    null, // avg_altitude：Activity 没算平均海拔
    altitudeRaw(activity.altitudeAvailable ? activity.maxAltitude : undefined),
  ]);

  // activity
  builder.define(4, 34, [
    { num: 253, size: 4, type: T.uint32 },
    { num: 0, size: 4, type: T.uint32 },
    { num: 1, size: 2, type: T.uint16 },
    { num: 2, size: 1, type: T.enum },
    { num: 3, size: 1, type: T.enum },
    { num: 4, size: 1, type: T.enum },
  ]);
  builder.message(4, [
    endSec - FIT_EPOCH,
    Math.round(timer * 1000),
    1, // num_sessions
    0, // type = manual
    26, // event = activity
    1, // event_type = stop
  ]);

  return builder.build();
}
