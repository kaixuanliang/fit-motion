import type { FitLap, FitRecord, FitSession, FitValue, ParsedFit } from './types';

const FIT_EPOCH_OFFSET = 631065600; // 1989-12-31T00:00:00Z, in seconds

const BASE_TYPE_SIZE: Record<number, number> = {
  0: 1, // enum
  1: 1, // sint8
  2: 1, // uint8
  3: 2, // sint16
  4: 2, // uint16
  5: 4, // sint32
  6: 4, // uint32
  7: 1, // string
  8: 4, // float32
  9: 8, // float64
  10: 1, // uint8z
  11: 2, // uint16z
  12: 4, // uint32z
  13: 1, // byte
  14: 8, // sint64
  15: 8, // uint64
  16: 8, // uint64z
};

interface FieldDef {
  number: number;
  size: number;
  type: number;
  littleEndian: boolean;
}

interface MessageDef {
  global: number;
  fields: FieldDef[];
  devFields: FieldDef[];
}

type RawValues = Map<number, FitValue>;

/**
 * Minimal, dependency-free FIT decoder. Supports normal + compressed timestamp
 * headers, little/big endian definitions, arrays, strings and developer fields.
 * It deliberately keeps only fields used by the motion renderer.
 */
export function parseFit(buffer: ArrayBuffer): ParsedFit {
  const parsed: ParsedFit = {
    sourceType: 'fit',
    hasTimestamps: false,
    records: [],
    sessions: [],
    laps: [],
  };
  let offset = 0;
  let chunks = 0;

  while (offset + 12 <= buffer.byteLength && chunks < 8) {
    const view = new DataView(buffer);
    const headerSize = view.getUint8(offset);
    if (headerSize !== 12 && headerSize !== 14) break;
    if (view.getUint8(offset + 8) !== 0x2e || view.getUint8(offset + 9) !== 0x46
      || view.getUint8(offset + 10) !== 0x49 || view.getUint8(offset + 11) !== 0x54) {
      break;
    }

    const dataSize = view.getUint32(offset + 4, true);
    const dataStart = offset + headerSize;
    const dataEnd = Math.min(buffer.byteLength, dataStart + dataSize);
    parseChunk(buffer, dataStart, dataEnd, parsed);
    chunks += 1;
    offset = dataEnd + 2; // skip trailing CRC
  }

  if (chunks === 0) throw new Error('不是有效的 FIT 文件（找不到 .FIT 文件头）');
  return parsed;
}

function parseChunk(buffer: ArrayBuffer, start: number, end: number, out: ParsedFit): void {
  const view = new DataView(buffer);
  const defs = new Map<number, MessageDef>();
  let offset = start;
  let lastTimestamp: number | undefined;

  while (offset < end) {
    const header = view.getUint8(offset++);
    let localType: number;
    let compressedOffset: number | undefined;

    if (header & 0x80) {
      localType = (header >> 5) & 0x03;
      compressedOffset = header & 0x1f;
    } else {
      localType = header & 0x0f;
      const isDefinition = (header & 0x40) !== 0;
      const hasDeveloperFields = (header & 0x20) !== 0;
      if (isDefinition) {
        if (offset + 5 > end) break;
        const arch = view.getUint8(offset + 1);
        const littleEndian = arch === 0;
        const global = view.getUint16(offset + 2, littleEndian);
        const count = view.getUint8(offset + 4);
        offset += 5;

        const fields: FieldDef[] = [];
        for (let i = 0; i < count && offset + 3 <= end; i += 1) {
          const number = view.getUint8(offset);
          const size = view.getUint8(offset + 1);
          const base = view.getUint8(offset + 2);
          offset += 3;
          fields.push({ number, size, type: base & 0x1f, littleEndian });
        }

        const devFields: FieldDef[] = [];
        if (hasDeveloperFields && offset < end) {
          const devCount = view.getUint8(offset++);
          for (let i = 0; i < devCount && offset + 3 <= end; i += 1) {
            const number = view.getUint8(offset);
            const size = view.getUint8(offset + 1);
            const devIndex = view.getUint8(offset + 2);
            offset += 3;
            devFields.push({ number: 1000 + devIndex, size, type: 13, littleEndian });
          }
        }
        defs.set(localType, { global, fields, devFields });
        continue;
      }
    }

    const def = defs.get(localType);
    if (!def) break;

    const values: RawValues = new Map();
    for (const field of def.fields) {
      if (offset + field.size > end) return;
      values.set(field.number, readField(view, offset, field));
      offset += field.size;
    }
    for (const field of def.devFields) {
      if (offset + field.size > end) return;
      offset += field.size;
    }

    let timestamp: number | undefined;
    if (compressedOffset !== undefined && lastTimestamp !== undefined) {
      timestamp = lastTimestamp + compressedOffset;
      values.set(253, timestamp);
    }
    const fieldTimestamp = values.get(253);
    if (typeof fieldTimestamp === 'number' && Number.isFinite(fieldTimestamp)) {
      timestamp = fieldTimestamp;
      lastTimestamp = fieldTimestamp;
    }

    consumeMessage(def.global, values, timestamp, out);
  }
}

function readField(view: DataView, offset: number, field: FieldDef): FitValue {
  const primitiveSize = BASE_TYPE_SIZE[field.type] ?? 1;
  if (field.type === 7) {
    let text = '';
    for (let i = 0; i < field.size; i += 1) {
      const code = view.getUint8(offset + i);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text;
  }

  if (field.size > primitiveSize) {
    const count = Math.floor(field.size / primitiveSize);
    const values: Array<number | string> = [];
    for (let i = 0; i < count; i += 1) {
      const value = readScalar(view, offset + i * primitiveSize, field.type, field.littleEndian);
      if (value !== null) values.push(value);
    }
    return values.length === 0 ? null : values;
  }
  return readScalar(view, offset, field.type, field.littleEndian);
}

function readScalar(view: DataView, offset: number, type: number, le: boolean): number | string | null {
  switch (type) {
    case 0:
    case 2:
    case 10: {
      const value = view.getUint8(offset);
      if (value === 0xff || (type === 10 && value === 0)) return null;
      return value;
    }
    case 1: {
      const value = view.getInt8(offset);
      return value === 0x7f ? null : value;
    }
    case 3: {
      const value = view.getInt16(offset, le);
      return value === 0x7fff ? null : value;
    }
    case 4: {
      const value = view.getUint16(offset, le);
      return value === 0xffff ? null : value;
    }
    case 5: {
      const value = view.getInt32(offset, le);
      return value === 0x7fffffff ? null : value;
    }
    case 6:
    case 12: {
      const value = view.getUint32(offset, le);
      if (type === 12 && value === 0) return null;
      return value === 0xffffffff ? null : value;
    }
    case 8: {
      const value = view.getFloat32(offset, le);
      return Number.isFinite(value) ? value : null;
    }
    case 9: {
      const value = view.getFloat64(offset, le);
      return Number.isFinite(value) ? value : null;
    }
    case 13: {
      const value = view.getUint8(offset);
      return value === 0xff ? null : value;
    }
    case 14:
    case 15:
    case 16:
      // 64-bit FIT fields are never used by the activity/renderer profile.
      return null;
    default:
      return null;
  }
}

function consumeMessage(global: number, values: RawValues, timestamp: number | undefined, out: ParsedFit): void {
  if (global === 0) {
    const fileType = values.get(0);
    if (typeof fileType === 'number') out.fileType = String(fileType);
    const manufacturer = values.get(1);
    if (typeof manufacturer === 'number') out.manufacturer = manufacturer;
    const productName = values.get(8);
    if (typeof productName === 'string' && productName.length > 0) out.productName = productName;
    const created = values.get(4);
    if (typeof created === 'number') out.timeCreated = fitTime(created);
    return;
  }

  if (global === 20) {
    const record: FitRecord = {};
    if (timestamp !== undefined) record.timestamp = fitTime(timestamp);
    const lat = numberValue(values.get(0));
    const lon = numberValue(values.get(1));
    if (lat !== undefined) record.lat = semicircles(lat);
    if (lon !== undefined) record.lon = semicircles(lon);
    const enhancedAltitude = numberValue(values.get(78));
    const altitude = enhancedAltitude ?? numberValue(values.get(2));
    if (altitude !== undefined) record.altitude = altitude / 5 - 500;
    const enhancedSpeed = numberValue(values.get(73));
    const speed = enhancedSpeed ?? numberValue(values.get(6));
    if (speed !== undefined) record.speed = speed / 1000;
    const distance = numberValue(values.get(5));
    if (distance !== undefined) record.distance = distance / 100;
    const heartRate = numberValue(values.get(3));
    if (heartRate !== undefined) record.heartRate = heartRate;
    const cadence = numberValue(values.get(4));
    if (cadence !== undefined) record.cadence = cadence;
    const power = numberValue(values.get(7));
    if (power !== undefined) record.power = power;
    const temperature = numberValue(values.get(13));
    if (temperature !== undefined) record.temperature = temperature;
    if (record.timestamp !== undefined) {
      out.records.push(record);
      out.hasTimestamps = true;
    }
    return;
  }

  if (global === 18) {
    const session: FitSession = {
      timestamp: timestamp !== undefined ? fitTime(timestamp) : undefined,
      startTime: timeValue(values.get(2)),
      sport: numberValue(values.get(5)),
      subSport: numberValue(values.get(6)),
      elapsedTime: scaled(values.get(7), 1000),
      timerTime: scaled(values.get(8), 1000),
      distance: scaled(values.get(9), 100),
      calories: numberValue(values.get(11)),
      avgSpeed: scaled(values.get(124), 1000) ?? scaled(values.get(14), 1000),
      maxSpeed: scaled(values.get(125), 1000) ?? scaled(values.get(15), 1000),
      avgHeartRate: numberValue(values.get(16)),
      maxHeartRate: numberValue(values.get(17)),
      avgCadence: numberValue(values.get(18)),
      maxCadence: numberValue(values.get(19)),
      avgPower: numberValue(values.get(20)),
      maxPower: numberValue(values.get(21)),
      ascent: numberValue(values.get(22)),
      descent: numberValue(values.get(23)),
      avgAltitude: scaled(values.get(49), 5, -500),
      maxAltitude: scaled(values.get(50), 5, -500),
      trainingEffect: scaled(values.get(24), 10),
    };
    out.sessions.push(session);
    return;
  }

  if (global === 19) {
    const lap: FitLap = {
      timestamp: timestamp !== undefined ? fitTime(timestamp) : undefined,
      startTime: timeValue(values.get(2)),
      elapsedTime: scaled(values.get(7), 1000),
      timerTime: scaled(values.get(8), 1000),
      distance: scaled(values.get(9), 100),
      calories: numberValue(values.get(11)),
      avgSpeed: scaled(values.get(13), 1000),
      maxSpeed: scaled(values.get(14), 1000),
      avgHeartRate: numberValue(values.get(15)),
      maxHeartRate: numberValue(values.get(16)),
      avgCadence: numberValue(values.get(17)),
      maxCadence: numberValue(values.get(18)),
      ascent: numberValue(values.get(21)),
      descent: numberValue(values.get(22)),
    };
    out.laps.push(lap);
  }
}

function numberValue(value: FitValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timeValue(value: FitValue | undefined): number | undefined {
  const seconds = numberValue(value);
  return seconds === undefined ? undefined : fitTime(seconds);
}

function scaled(value: FitValue | undefined, scale: number, offset = 0): number | undefined {
  const raw = numberValue(value);
  return raw === undefined ? undefined : raw / scale + offset;
}

function fitTime(seconds: number): number {
  return (seconds + FIT_EPOCH_OFFSET) * 1000;
}

function semicircles(value: number): number {
  return (value * 180) / 2147483648;
}
