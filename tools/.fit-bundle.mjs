// src/fit/parser.ts
var FIT_EPOCH_OFFSET = 631065600;
var BASE_TYPE_SIZE = {
  0: 1,
  // enum
  1: 1,
  // sint8
  2: 1,
  // uint8
  3: 2,
  // sint16
  4: 2,
  // uint16
  5: 4,
  // sint32
  6: 4,
  // uint32
  7: 1,
  // string
  8: 4,
  // float32
  9: 8,
  // float64
  10: 1,
  // uint8z
  11: 2,
  // uint16z
  12: 4,
  // uint32z
  13: 1,
  // byte
  14: 8,
  // sint64
  15: 8,
  // uint64
  16: 8
  // uint64z
};
function parseFit(buffer) {
  const parsed = {
    sourceType: "fit",
    hasTimestamps: false,
    records: [],
    sessions: [],
    laps: []
  };
  let offset = 0;
  let chunks = 0;
  while (offset + 12 <= buffer.byteLength && chunks < 8) {
    const view = new DataView(buffer);
    const headerSize = view.getUint8(offset);
    if (headerSize !== 12 && headerSize !== 14) break;
    if (view.getUint8(offset + 8) !== 46 || view.getUint8(offset + 9) !== 70 || view.getUint8(offset + 10) !== 73 || view.getUint8(offset + 11) !== 84) {
      break;
    }
    const dataSize = view.getUint32(offset + 4, true);
    const dataStart = offset + headerSize;
    const dataEnd = Math.min(buffer.byteLength, dataStart + dataSize);
    parseChunk(buffer, dataStart, dataEnd, parsed);
    chunks += 1;
    offset = dataEnd + 2;
  }
  if (chunks === 0) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 FIT \u6587\u4EF6\uFF08\u627E\u4E0D\u5230 .FIT \u6587\u4EF6\u5934\uFF09");
  return parsed;
}
function parseChunk(buffer, start, end, out) {
  const view = new DataView(buffer);
  const defs = /* @__PURE__ */ new Map();
  let offset = start;
  let lastTimestamp;
  while (offset < end) {
    const header = view.getUint8(offset++);
    let localType;
    let compressedOffset;
    if (header & 128) {
      localType = header >> 5 & 3;
      compressedOffset = header & 31;
    } else {
      localType = header & 15;
      const isDefinition = (header & 64) !== 0;
      const hasDeveloperFields = (header & 32) !== 0;
      if (isDefinition) {
        if (offset + 5 > end) break;
        const arch = view.getUint8(offset + 1);
        const littleEndian = arch === 0;
        const global = view.getUint16(offset + 2, littleEndian);
        const count = view.getUint8(offset + 4);
        offset += 5;
        const fields = [];
        for (let i = 0; i < count && offset + 3 <= end; i += 1) {
          const number = view.getUint8(offset);
          const size = view.getUint8(offset + 1);
          const base = view.getUint8(offset + 2);
          offset += 3;
          fields.push({ number, size, type: base & 31, littleEndian });
        }
        const devFields = [];
        if (hasDeveloperFields && offset < end) {
          const devCount = view.getUint8(offset++);
          for (let i = 0; i < devCount && offset + 3 <= end; i += 1) {
            const number = view.getUint8(offset);
            const size = view.getUint8(offset + 1);
            const devIndex = view.getUint8(offset + 2);
            offset += 3;
            devFields.push({ number: 1e3 + devIndex, size, type: 13, littleEndian });
          }
        }
        defs.set(localType, { global, fields, devFields });
        continue;
      }
    }
    const def = defs.get(localType);
    if (!def) break;
    const values = /* @__PURE__ */ new Map();
    for (const field of def.fields) {
      if (offset + field.size > end) return;
      values.set(field.number, readField(view, offset, field));
      offset += field.size;
    }
    for (const field of def.devFields) {
      if (offset + field.size > end) return;
      offset += field.size;
    }
    let timestamp;
    if (compressedOffset !== void 0 && lastTimestamp !== void 0) {
      timestamp = lastTimestamp + compressedOffset;
      values.set(253, timestamp);
    }
    const fieldTimestamp = values.get(253);
    if (typeof fieldTimestamp === "number" && Number.isFinite(fieldTimestamp)) {
      timestamp = fieldTimestamp;
      lastTimestamp = fieldTimestamp;
    }
    consumeMessage(def.global, values, timestamp, out);
  }
}
function readField(view, offset, field) {
  const primitiveSize = BASE_TYPE_SIZE[field.type] ?? 1;
  if (field.type === 7) {
    let text = "";
    for (let i = 0; i < field.size; i += 1) {
      const code = view.getUint8(offset + i);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text;
  }
  if (field.size > primitiveSize) {
    const count = Math.floor(field.size / primitiveSize);
    const values = [];
    for (let i = 0; i < count; i += 1) {
      const value = readScalar(view, offset + i * primitiveSize, field.type, field.littleEndian);
      if (value !== null) values.push(value);
    }
    return values.length === 0 ? null : values;
  }
  return readScalar(view, offset, field.type, field.littleEndian);
}
function readScalar(view, offset, type, le) {
  switch (type) {
    case 0:
    case 2:
    case 10: {
      const value = view.getUint8(offset);
      if (value === 255 || type === 10 && value === 0) return null;
      return value;
    }
    case 1: {
      const value = view.getInt8(offset);
      return value === 127 ? null : value;
    }
    case 3: {
      const value = view.getInt16(offset, le);
      return value === 32767 ? null : value;
    }
    case 4: {
      const value = view.getUint16(offset, le);
      return value === 65535 ? null : value;
    }
    case 5: {
      const value = view.getInt32(offset, le);
      return value === 2147483647 ? null : value;
    }
    case 6:
    case 12: {
      const value = view.getUint32(offset, le);
      if (type === 12 && value === 0) return null;
      return value === 4294967295 ? null : value;
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
      return value === 255 ? null : value;
    }
    case 14:
    case 15:
    case 16:
      return null;
    default:
      return null;
  }
}
function consumeMessage(global, values, timestamp, out) {
  if (global === 0) {
    const fileType = values.get(0);
    if (typeof fileType === "number") out.fileType = String(fileType);
    const manufacturer = values.get(1);
    if (typeof manufacturer === "number") out.manufacturer = manufacturer;
    const productName = values.get(8);
    if (typeof productName === "string" && productName.length > 0) out.productName = productName;
    const created = values.get(4);
    if (typeof created === "number") out.timeCreated = fitTime(created);
    return;
  }
  if (global === 20) {
    const record = {};
    if (timestamp !== void 0) record.timestamp = fitTime(timestamp);
    const lat = numberValue(values.get(0));
    const lon = numberValue(values.get(1));
    if (lat !== void 0) record.lat = semicircles(lat);
    if (lon !== void 0) record.lon = semicircles(lon);
    const enhancedAltitude = numberValue(values.get(78));
    const altitude = enhancedAltitude ?? numberValue(values.get(2));
    if (altitude !== void 0) record.altitude = altitude / 5 - 500;
    const enhancedSpeed = numberValue(values.get(73));
    const speed = enhancedSpeed ?? numberValue(values.get(6));
    if (speed !== void 0) record.speed = speed / 1e3;
    const distance = numberValue(values.get(5));
    if (distance !== void 0) record.distance = distance / 100;
    const heartRate = numberValue(values.get(3));
    if (heartRate !== void 0) record.heartRate = heartRate;
    const cadence = numberValue(values.get(4));
    if (cadence !== void 0) record.cadence = cadence;
    const power = numberValue(values.get(7));
    if (power !== void 0) record.power = power;
    const temperature = numberValue(values.get(13));
    if (temperature !== void 0) record.temperature = temperature;
    if (record.timestamp !== void 0) {
      out.records.push(record);
      out.hasTimestamps = true;
    }
    return;
  }
  if (global === 18) {
    const session = {
      timestamp: timestamp !== void 0 ? fitTime(timestamp) : void 0,
      startTime: timeValue(values.get(2)),
      sport: numberValue(values.get(5)),
      subSport: numberValue(values.get(6)),
      elapsedTime: scaled(values.get(7), 1e3),
      timerTime: scaled(values.get(8), 1e3),
      distance: scaled(values.get(9), 100),
      calories: numberValue(values.get(11)),
      avgSpeed: scaled(values.get(124), 1e3) ?? scaled(values.get(14), 1e3),
      maxSpeed: scaled(values.get(125), 1e3) ?? scaled(values.get(15), 1e3),
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
      trainingEffect: scaled(values.get(24), 10)
    };
    out.sessions.push(session);
    return;
  }
  if (global === 19) {
    const lap = {
      timestamp: timestamp !== void 0 ? fitTime(timestamp) : void 0,
      startTime: timeValue(values.get(2)),
      elapsedTime: scaled(values.get(7), 1e3),
      timerTime: scaled(values.get(8), 1e3),
      distance: scaled(values.get(9), 100),
      calories: numberValue(values.get(11)),
      avgSpeed: scaled(values.get(13), 1e3),
      maxSpeed: scaled(values.get(14), 1e3),
      avgHeartRate: numberValue(values.get(15)),
      maxHeartRate: numberValue(values.get(16)),
      avgCadence: numberValue(values.get(17)),
      maxCadence: numberValue(values.get(18)),
      ascent: numberValue(values.get(21)),
      descent: numberValue(values.get(22))
    };
    out.laps.push(lap);
  }
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function timeValue(value) {
  const seconds = numberValue(value);
  return seconds === void 0 ? void 0 : fitTime(seconds);
}
function scaled(value, scale, offset = 0) {
  const raw = numberValue(value);
  return raw === void 0 ? void 0 : raw / scale + offset;
}
function fitTime(seconds) {
  return (seconds + FIT_EPOCH_OFFSET) * 1e3;
}
function semicircles(value) {
  return value * 180 / 2147483648;
}

// src/fit/activity.ts
var SPORTS = {
  0: { name: "\u8FD0\u52A8", key: "other" },
  1: { name: "\u8DD1\u6B65", key: "run" },
  2: { name: "\u9A91\u884C", key: "ride" },
  3: { name: "\u8F6C\u6362", key: "other" },
  4: { name: "\u5065\u8EAB", key: "other" },
  5: { name: "\u6E38\u6CF3", key: "swim" },
  6: { name: "\u7BEE\u7403", key: "other" },
  7: { name: "\u8DB3\u7403", key: "other" },
  8: { name: "\u7F51\u7403", key: "other" },
  11: { name: "\u6B65\u884C", key: "hike" },
  12: { name: "\u8D8A\u91CE\u6ED1\u96EA", key: "other" },
  13: { name: "\u9AD8\u5C71\u6ED1\u96EA", key: "other" },
  14: { name: "\u5355\u677F\u6ED1\u96EA", key: "other" },
  15: { name: "\u5212\u8239", key: "other" },
  16: { name: "\u767B\u5C71", key: "hike" },
  17: { name: "\u5F92\u6B65", key: "hike" },
  18: { name: "\u591A\u9879\u8FD0\u52A8", key: "other" },
  19: { name: "\u76AE\u5212\u8247", key: "other" },
  21: { name: "\u7535\u52A9\u529B\u9A91\u884C", key: "ride" },
  25: { name: "\u9AD8\u5C14\u592B", key: "other" },
  30: { name: "\u8F6E\u6ED1", key: "other" },
  31: { name: "\u6500\u5CA9", key: "other" },
  33: { name: "\u6ED1\u51B0", key: "other" },
  35: { name: "\u96EA\u978B", key: "hike" },
  37: { name: "\u6868\u677F", key: "other" },
  38: { name: "\u51B2\u6D6A", key: "other" },
  41: { name: "\u76AE\u5212\u8247", key: "other" },
  42: { name: "\u6F02\u6D41", key: "other" },
  44: { name: "\u98CE\u7B5D\u51B2\u6D6A", key: "other" },
  48: { name: "\u6500\u5CA9", key: "other" },
  49: { name: "\u68D2\u7403", key: "other" },
  53: { name: "\u745C\u4F3D", key: "other" },
  62: { name: "\u5BA4\u5185\u6500\u5CA9", key: "other" }
};
var CITIES = [
  ["\u5317\u4EAC", 39.9042, 116.4074],
  ["\u4E0A\u6D77", 31.2304, 121.4737],
  ["\u5E7F\u5DDE", 23.1291, 113.2644],
  ["\u6DF1\u5733", 22.5431, 114.0579],
  ["\u676D\u5DDE", 30.2741, 120.1551],
  ["\u6210\u90FD", 30.5728, 104.0668],
  ["\u91CD\u5E86", 29.563, 106.5516],
  ["\u6B66\u6C49", 30.5928, 114.3055],
  ["\u897F\u5B89", 34.3416, 108.9398],
  ["\u5357\u4EAC", 32.0603, 118.7969],
  ["\u5929\u6D25", 39.3434, 117.3616],
  ["\u82CF\u5DDE", 31.2989, 120.5853],
  ["\u957F\u6C99", 28.2282, 112.9388],
  ["\u90D1\u5DDE", 34.7466, 113.6254],
  ["\u9752\u5C9B", 36.0671, 120.3826],
  ["\u53A6\u95E8", 24.4798, 118.0894],
  ["\u798F\u5DDE", 26.0745, 119.2965],
  ["\u6D4E\u5357", 36.6512, 117.1201],
  ["\u6606\u660E", 24.8801, 102.8329],
  ["\u5408\u80A5", 31.8206, 117.2272],
  ["\u5B81\u6CE2", 29.8683, 121.544],
  ["\u65E0\u9521", 31.4912, 120.3119],
  ["\u5927\u8FDE", 38.914, 121.6147],
  ["\u6C88\u9633", 41.8057, 123.4315],
  ["\u54C8\u5C14\u6EE8", 45.8038, 126.5349],
  ["\u957F\u6625", 43.8171, 125.3235],
  ["\u77F3\u5BB6\u5E84", 38.0428, 114.5149],
  ["\u592A\u539F", 37.8706, 112.5489],
  ["\u5357\u660C", 28.682, 115.8579],
  ["\u5357\u5B81", 22.817, 108.3665],
  ["\u8D35\u9633", 26.647, 106.6302],
  ["\u5170\u5DDE", 36.0611, 103.8343],
  ["\u4E4C\u9C81\u6728\u9F50", 43.8256, 87.6168],
  ["\u62C9\u8428", 29.652, 91.1721],
  ["\u6D77\u53E3", 20.044, 110.1999],
  ["\u4E09\u4E9A", 18.2528, 109.5119]
];
function buildActivity(parsed, fileName) {
  const sessions = [...parsed.sessions].sort((a, b) => (b.distance ?? 0) - (a.distance ?? 0));
  const primary = sessions[0];
  const session = primary ?? {};
  const allRecords = parsed.records.filter(isUsableRecord);
  let records = allRecords;
  if (primary?.startTime != null) {
    const start = primary.startTime;
    const durationMs = Math.max(primary.elapsedTime ?? 0, primary.timerTime ?? 0) * 1e3;
    const end = durationMs > 0 ? start + durationMs + 5e3 : Infinity;
    const filtered = allRecords.filter((record) => (record.timestamp ?? 0) >= start - 2e3 && (record.timestamp ?? 0) <= end);
    if (filtered.length >= 2) records = filtered;
  }
  if (records.length < 2) throw new Error("\u8FD9\u4E2A FIT / GPX \u6587\u4EF6\u4E2D\u6CA1\u6709\u53EF\u7528\u7684 GPS \u8F68\u8FF9\u70B9");
  const cleaned = [];
  let driftDropped = 0;
  for (let i = 0; i < records.length; i += 1) {
    const current = records[i];
    if (i > 0 && i < records.length - 1) {
      const previous = records[i - 1];
      const next = records[i + 1];
      const dPrev = haversine(previous.lat, previous.lon, current.lat, current.lon);
      const dNext = haversine(current.lat, current.lon, next.lat, next.lon);
      const direct = haversine(previous.lat, previous.lon, next.lat, next.lon);
      const dt = ((current.timestamp ?? 0) - (previous.timestamp ?? 0)) / 1e3;
      if (dt > 0 && dPrev / dt > 55 && dNext > 180 && direct < Math.max(dPrev, dNext) * 0.45) {
        driftDropped += 1;
        continue;
      }
    }
    if (cleaned.length > 0 && current.timestamp != null && current.timestamp <= (cleaned[cleaned.length - 1].timestamp ?? 0)) {
      continue;
    }
    const last = cleaned[cleaned.length - 1];
    if (last?.lat != null && last.lon != null && last.timestamp != null && current.lat != null && current.lon != null && current.timestamp != null) {
      const dt = (current.timestamp - last.timestamp) / 1e3;
      if (dt > 0 && haversine(last.lat, last.lon, current.lat, current.lon) / dt > 55) {
        driftDropped += 1;
        continue;
      }
    }
    cleaned.push(current);
  }
  if (driftDropped > 0) {
    console.info(`[fit-motion] \u5DF2\u5254\u9664 ${driftDropped} \u4E2A GPS \u6F02\u79FB\u70B9`);
  }
  if (cleaned.length < 2) throw new Error("\u8FD9\u4E2A FIT / GPX \u6587\u4EF6\u4E2D\u6CA1\u6709\u8DB3\u591F\u7684 GPS \u8F68\u8FF9\u70B9");
  const points = [];
  let cumulative = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const record = cleaned[i];
    if (i > 0) {
      cumulative += haversine(
        cleaned[i - 1].lat,
        cleaned[i - 1].lon,
        record.lat,
        record.lon
      );
    }
    points.push({
      lat: record.lat,
      lon: record.lon,
      t: record.timestamp ?? 0,
      distance: cumulative,
      altitude: record.altitude,
      heartRate: record.heartRate,
      speed: record.speed,
      cadence: record.cadence,
      power: record.power
    });
  }
  const routeDistanceM = points[points.length - 1].distance;
  if (routeDistanceM < 10) throw new Error("GPS \u8F68\u8FF9\u8FC7\u77ED\uFF0C\u65E0\u6CD5\u751F\u6210\u52A8\u6001\u89C6\u9891");
  const startTime = session.startTime ?? points[0].t;
  const endTime = points[points.length - 1].t;
  const timeAvailable = parsed.hasTimestamps && startTime > 0;
  const recordDuration = Math.max(0, (endTime - startTime) / 1e3);
  const durationAvailable = timeAvailable && ((session.elapsedTime ?? 0) > 0 || (session.timerTime ?? 0) > 0 || recordDuration > 0);
  const actualDuration = session.timerTime && session.timerTime > 0 ? session.timerTime : session.elapsedTime ?? recordDuration;
  const durationSec = durationAvailable ? Math.max(1, actualDuration) : Math.max(20, routeDistanceM / 3.6);
  const elapsedSec = durationAvailable ? Math.max(1, session.elapsedTime ?? recordDuration) : durationSec;
  const elapsedAvailable = durationAvailable && (session.elapsedTime ?? 0) > 0;
  const distanceM = session.distance && session.distance > 0 ? session.distance : routeDistanceM;
  const scale = distanceM / routeDistanceM;
  for (const point of points) point.distance *= scale;
  const stopThreshold = STOP_SPEED_BY_KEY[sportKeyOf(session.sport)];
  const nativeTimer = session.timerTime && session.timerTime > 0 && (elapsedSec <= 0 || session.timerTime < elapsedSec * 0.995) ? session.timerTime : null;
  const estimatedMoving = timeAvailable && elapsedSec > 0 ? estimateMovingSec(points, elapsedSec, stopThreshold) : null;
  const movingSec = durationAvailable ? Math.max(1, Math.min(
    elapsedSec,
    nativeTimer ?? estimatedMoving ?? actualDuration
  )) : durationSec;
  const recordedSpeeds = points.map((point) => point.speed).filter(isNumber);
  const hasRecordedSpeeds = recordedSpeeds.length > 0;
  const speedValues = smoothSpeeds(points, movingSec, distanceM);
  for (let i = 0; i < points.length; i += 1) {
    if (speedValues[i] != null) points[i].speed = speedValues[i];
  }
  const validHeartRates = points.map((point) => point.heartRate).filter(isNumber);
  const recordMaxHr = validHeartRates.length ? Math.max(...validHeartRates) : void 0;
  const maxHeartRate = session.maxHeartRate && session.maxHeartRate > 0 ? session.maxHeartRate : recordMaxHr;
  const heartRateAvailable = maxHeartRate != null;
  const avgHeartRate = session.avgHeartRate && session.avgHeartRate > 0 ? session.avgHeartRate : validHeartRates.length ? Math.round(validHeartRates.reduce((sum, value) => sum + value, 0) / validHeartRates.length) : void 0;
  const maxSpeedAvailable = (session.maxSpeed ?? 0) > 0 || hasRecordedSpeeds || timeAvailable;
  const computedMaxSpeed = hasRecordedSpeeds ? Math.max(...recordedSpeeds) : percentile(points.map((point) => point.speed).filter(isNumber), 0.995);
  const maxSpeed = maxSpeedAvailable ? session.maxSpeed && session.maxSpeed > 0 ? session.maxSpeed : computedMaxSpeed : 0;
  const avgSpeedAvailable = (session.avgSpeed ?? 0) > 0 || durationAvailable || hasRecordedSpeeds;
  const avgSpeed = avgSpeedAvailable ? durationAvailable && distanceM > 0 && movingSec > 0 ? distanceM / movingSec : session.avgSpeed && session.avgSpeed > 0 ? session.avgSpeed : recordedSpeeds.length ? recordedSpeeds.reduce((sum, value) => sum + value, 0) / recordedSpeeds.length : 0 : 0;
  const sportInfo = SPORTS[session.sport ?? -1] ?? { name: "\u8FD0\u52A8", key: "other" };
  const midpoint = points[Math.max(0, Math.floor(points.length / 2))];
  const peakHeart = points.reduce((best, point) => {
    if (point.heartRate == null) return best;
    if (!best || (best.heartRate ?? -Infinity) < point.heartRate) return point;
    return best;
  }, void 0);
  const maxHrPoint = points.find((point) => point.heartRate != null && point.heartRate >= (recordMaxHr ?? Infinity)) ?? peakHeart ?? (heartRateAvailable ? midpoint : void 0);
  const peakSpeed = points.reduce((best, point) => {
    if (point.speed == null) return best;
    if (!best || (best.speed ?? -Infinity) < point.speed) return point;
    return best;
  }, void 0);
  const maxSpeedPoint = maxSpeedAvailable ? points.find((point) => point.speed != null && point.speed >= computedMaxSpeed * 0.96) ?? peakSpeed ?? midpoint : void 0;
  const altitudeValues = points.map((point) => point.altitude).filter(isNumber);
  const maxAltitude = altitudeValues.length ? Math.max(...altitudeValues) : session.maxAltitude ?? void 0;
  const altitudeAvailable = maxAltitude != null;
  const peakAltitude = points.reduce((best, point) => {
    if (point.altitude == null) return best;
    if (!best || (best.altitude ?? -Infinity) < point.altitude) return point;
    return best;
  }, void 0);
  const maxAltitudePoint = maxAltitude != null ? points.find((point) => point.altitude != null && point.altitude >= maxAltitude - 0.01) ?? peakAltitude ?? midpoint : void 0;
  const bounds = points.reduce(
    (box, point) => ({
      minLat: Math.min(box.minLat, point.lat),
      maxLat: Math.max(box.maxLat, point.lat),
      minLon: Math.min(box.minLon, point.lon),
      maxLon: Math.max(box.maxLon, point.lon)
    }),
    { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 }
  );
  const center = {
    lat: (bounds.minLat + bounds.maxLat) / 2,
    lon: (bounds.minLon + bounds.maxLon) / 2
  };
  const city = nearestCity(center.lat, center.lon);
  const place = city ?? `${formatCoord(center.lat, "N", "S")} \xB7 ${formatCoord(center.lon, "E", "W")}`;
  const ascent = session.ascent ?? elevationGain(points);
  const descent = session.descent ?? elevationLoss(points);
  const calories = session.calories && session.calories > 0 ? session.calories : estimateCalories(distanceM, durationSec, avgSpeed, avgHeartRate, sportInfo.key, durationAvailable);
  return {
    fileName,
    sourceType: parsed.sourceType,
    sport: session.sport ?? 0,
    sportName: sportInfo.name,
    sportKey: sportInfo.key,
    subSport: session.subSport,
    title: activityTitle(sportInfo.key),
    startTime,
    endTime,
    timeAvailable,
    durationAvailable,
    durationSec,
    movingSec,
    elapsedSec,
    elapsedAvailable,
    distanceM,
    routeDistanceM,
    maxHeartRate,
    avgHeartRate,
    heartRateAvailable,
    maxSpeed,
    maxSpeedAvailable,
    avgSpeed,
    avgSpeedAvailable,
    maxAltitude,
    altitudeAvailable,
    calories,
    ascent,
    descent,
    avgCadence: session.avgCadence,
    maxCadence: session.maxCadence,
    avgPower: session.avgPower,
    maxPower: session.maxPower,
    points,
    splits: timeAvailable ? buildSplits(points, startTime, distanceM) : [],
    bounds,
    center,
    place,
    city: city ?? void 0,
    sessionCount: parsed.sessions.length,
    laps: parsed.laps,
    maxHrPoint,
    maxSpeedPoint,
    maxAltitudePoint
  };
}
var STOP_SPEED_BY_KEY = {
  ride: 0.7,
  run: 0.4,
  hike: 0.35,
  swim: 0.3,
  other: 0.5
};
function estimateMovingSec(points, elapsedSec, stopSpeed) {
  let moving = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dt = (points[i].t - points[i - 1].t) / 1e3;
    if (dt <= 0 || dt > 120) continue;
    const dd = points[i].distance - points[i - 1].distance;
    if (dd / dt >= stopSpeed) moving += dt;
  }
  const scaled2 = elapsedSec > 0 ? moving : 0;
  return scaled2 >= 1 ? scaled2 : elapsedSec;
}
function sportKeyOf(sport) {
  return SPORTS[sport ?? -1]?.key ?? "other";
}
function buildSplits(points, startTime, totalDistance) {
  const splits = [];
  const count = Math.ceil(totalDistance / 1e3);
  let previousTime = startTime;
  let previousIndex = 0;
  for (let i = 0; i < count; i += 1) {
    const target = Math.min(totalDistance, (i + 1) * 1e3);
    let index = findDistanceIndex(points, target);
    if (index <= previousIndex) index = Math.min(points.length - 1, previousIndex + 1);
    const point = points[index];
    const time = interpolateTimeAtDistance(points, target);
    const seconds = Math.max(0, (time - previousTime) / 1e3);
    const distanceM = Math.max(0, target - i * 1e3);
    const slice = points.slice(previousIndex, index + 1);
    const heartRates = slice.map((item) => item.heartRate).filter(isNumber);
    splits.push({
      index: i + 1,
      distanceM,
      seconds,
      speed: distanceM / Math.max(1, seconds),
      heartRate: heartRates.length ? Math.round(heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length) : void 0,
      ascent: elevationGain(slice)
    });
    previousTime = time;
    previousIndex = index;
  }
  return splits;
}
function interpolateTimeAtDistance(points, distance) {
  const index = findDistanceIndex(points, distance);
  if (index <= 0) return points[0].t;
  const a = points[index - 1];
  const b = points[index];
  const span = b.distance - a.distance;
  const local = span > 0 ? (distance - a.distance) / span : 0;
  return a.t + (b.t - a.t) * local;
}
function findDistanceIndex(points, distance) {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (points[mid].distance < distance) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function smoothSpeeds(points, movingSec, distanceM) {
  const raw = points.map((point) => point.speed);
  for (let i = 0; i < points.length; i += 1) {
    if (raw[i] != null) continue;
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dt = (b.t - a.t) / 1e3;
    if (dt > 0) raw[i] = Math.max(0, (b.distance - a.distance) / dt);
  }
  const fallback = distanceM / Math.max(1, movingSec);
  const filled = raw.map((value) => value != null && Number.isFinite(value) ? value : fallback);
  const radius = points.length > 1500 ? 2 : 3;
  const smoothed = [];
  for (let i = 0; i < filled.length; i += 1) {
    let sum = 0;
    let weight = 0;
    for (let j = -radius; j <= radius; j += 1) {
      const value = filled[i + j];
      if (value == null) continue;
      const w = radius + 1 - Math.abs(j);
      sum += value * w;
      weight += w;
    }
    smoothed.push(weight > 0 ? sum / weight : fallback);
  }
  return smoothed;
}
function elevationGain(points) {
  const altitudes = points.map((point) => point.altitude).filter(isNumber);
  if (altitudes.length < 2) return void 0;
  let gain = 0;
  for (let i = 1; i < altitudes.length; i += 1) {
    const delta = altitudes[i] - altitudes[i - 1];
    if (delta > 0.4) gain += delta;
  }
  return Math.round(gain);
}
function elevationLoss(points) {
  const altitudes = points.map((point) => point.altitude).filter(isNumber);
  if (altitudes.length < 2) return void 0;
  let loss = 0;
  for (let i = 1; i < altitudes.length; i += 1) {
    const delta = altitudes[i - 1] - altitudes[i];
    if (delta > 0.4) loss += delta;
  }
  return Math.round(loss);
}
function activityTitle(key) {
  if (key === "run") return "\u6211\u7684\u8DD1\u6B65";
  if (key === "hike") return "\u6211\u7684\u5F92\u6B65";
  if (key === "ride") return "\u6211\u7684\u9A91\u884C";
  return "\u6211\u7684\u8FD0\u52A8";
}
function estimateCalories(distanceM, durationSec, avgSpeed, avgHeartRate, sportKey, durationAvailable) {
  if (!durationAvailable || distanceM <= 0 || durationSec <= 0) return void 0;
  const speedKmh = avgSpeed > 0 ? avgSpeed * 3.6 : distanceM / 1e3 / (durationSec / 3600);
  let met;
  if (sportKey === "ride") {
    met = speedKmh < 16 ? 4 : speedKmh < 20 ? 6.8 : speedKmh < 25 ? 8.2 : speedKmh < 30 ? 10 : 12;
  } else if (sportKey === "run") {
    met = Math.max(4, Math.min(20, 1.5 + speedKmh * 0.9));
  } else if (sportKey === "hike") {
    met = speedKmh < 4 ? 3.5 : speedKmh < 6 ? 5 : 6.5;
  } else {
    met = Math.max(2.5, Math.min(12, 2 + speedKmh * 0.35));
  }
  if (avgHeartRate && avgHeartRate > 60) {
    const hrMet = Math.max(2, Math.min(16, 1.2 + (avgHeartRate - 60) * 0.12));
    met = met * 0.65 + hrMet * 0.35;
  }
  return Math.round(met * 65 * (durationSec / 3600));
}
function nearestCity(lat, lon) {
  let best;
  for (const [name, cityLat, cityLon] of CITIES) {
    const distance = haversine(lat, lon, cityLat, cityLon);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best && best.distance < 55e3 ? best.name : void 0;
}
function isUsableRecord(record) {
  return record.lat != null && record.lon != null && Number.isFinite(record.lat) && Number.isFinite(record.lon) && Math.abs(record.lat) <= 90 && Math.abs(record.lon) <= 180 && !(Math.abs(record.lat) < 1e-4 && Math.abs(record.lon) < 1e-4) && record.timestamp != null;
}
function haversine(lat1, lon1, lat2, lon2) {
  const radius = 6371e3;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}
function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)));
  return sorted[index];
}
function formatCoord(value, positive, negative) {
  return `${Math.abs(value).toFixed(2)}\xB0${value >= 0 ? positive : negative}`;
}
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
export {
  buildActivity,
  parseFit
};
