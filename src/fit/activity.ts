import type { FitLap, FitRecord, FitSession, ParsedFit } from './types';

export interface RoutePoint {
  lat: number;
  lon: number;
  t: number;
  distance: number;
  altitude?: number;
  heartRate?: number;
  speed?: number;
  cadence?: number;
  power?: number;
}

export interface Split {
  index: number;
  distanceM: number;
  seconds: number;
  speed: number;
  heartRate?: number;
  ascent?: number;
}

export interface Activity {
  fileName: string;
  sourceType: 'fit' | 'gpx' | 'tcx';
  sport: number;
  sportName: string;
  sportKey: 'run' | 'ride' | 'hike' | 'swim' | 'other';
  subSport?: number;
  title: string;
  startTime: number;
  endTime: number;
  timeAvailable: boolean;
  durationAvailable: boolean;
  durationSec: number;
  movingSec: number;
  distanceM: number;
  routeDistanceM: number;
  maxHeartRate?: number;
  avgHeartRate?: number;
  heartRateAvailable: boolean;
  maxSpeed: number;
  maxSpeedAvailable: boolean;
  avgSpeed: number;
  avgSpeedAvailable: boolean;
  maxAltitude?: number;
  altitudeAvailable: boolean;
  calories?: number;
  ascent?: number;
  descent?: number;
  avgCadence?: number;
  maxCadence?: number;
  avgPower?: number;
  maxPower?: number;
  points: RoutePoint[];
  splits: Split[];
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  center: { lat: number; lon: number };
  place: string;
  city?: string;
  sessionCount: number;
  laps: FitLap[];
  maxHrPoint?: RoutePoint;
  maxSpeedPoint?: RoutePoint;
  maxAltitudePoint?: RoutePoint;
}

const SPORTS: Record<number, { name: string; key: Activity['sportKey'] }> = {
  0: { name: '运动', key: 'other' },
  1: { name: '跑步', key: 'run' },
  2: { name: '骑行', key: 'ride' },
  3: { name: '转换', key: 'other' },
  4: { name: '健身', key: 'other' },
  5: { name: '游泳', key: 'swim' },
  6: { name: '篮球', key: 'other' },
  7: { name: '足球', key: 'other' },
  8: { name: '网球', key: 'other' },
  11: { name: '步行', key: 'hike' },
  12: { name: '越野滑雪', key: 'other' },
  13: { name: '高山滑雪', key: 'other' },
  14: { name: '单板滑雪', key: 'other' },
  15: { name: '划船', key: 'other' },
  16: { name: '登山', key: 'hike' },
  17: { name: '徒步', key: 'hike' },
  18: { name: '多项运动', key: 'other' },
  19: { name: '皮划艇', key: 'other' },
  21: { name: '电助力骑行', key: 'ride' },
  25: { name: '高尔夫', key: 'other' },
  30: { name: '轮滑', key: 'other' },
  31: { name: '攀岩', key: 'other' },
  33: { name: '滑冰', key: 'other' },
  35: { name: '雪鞋', key: 'hike' },
  37: { name: '桨板', key: 'other' },
  38: { name: '冲浪', key: 'other' },
  41: { name: '皮划艇', key: 'other' },
  42: { name: '漂流', key: 'other' },
  44: { name: '风筝冲浪', key: 'other' },
  48: { name: '攀岩', key: 'other' },
  49: { name: '棒球', key: 'other' },
  53: { name: '瑜伽', key: 'other' },
  62: { name: '室内攀岩', key: 'other' },
};

const CITIES = [
  ['北京', 39.9042, 116.4074],
  ['上海', 31.2304, 121.4737],
  ['广州', 23.1291, 113.2644],
  ['深圳', 22.5431, 114.0579],
  ['杭州', 30.2741, 120.1551],
  ['成都', 30.5728, 104.0668],
  ['重庆', 29.563, 106.5516],
  ['武汉', 30.5928, 114.3055],
  ['西安', 34.3416, 108.9398],
  ['南京', 32.0603, 118.7969],
  ['天津', 39.3434, 117.3616],
  ['苏州', 31.2989, 120.5853],
  ['长沙', 28.2282, 112.9388],
  ['郑州', 34.7466, 113.6254],
  ['青岛', 36.0671, 120.3826],
  ['厦门', 24.4798, 118.0894],
  ['福州', 26.0745, 119.2965],
  ['济南', 36.6512, 117.1201],
  ['昆明', 24.8801, 102.8329],
  ['合肥', 31.8206, 117.2272],
  ['宁波', 29.8683, 121.544],
  ['无锡', 31.4912, 120.3119],
  ['大连', 38.914, 121.6147],
  ['沈阳', 41.8057, 123.4315],
  ['哈尔滨', 45.8038, 126.5349],
  ['长春', 43.8171, 125.3235],
  ['石家庄', 38.0428, 114.5149],
  ['太原', 37.8706, 112.5489],
  ['南昌', 28.682, 115.8579],
  ['南宁', 22.817, 108.3665],
  ['贵阳', 26.647, 106.6302],
  ['兰州', 36.0611, 103.8343],
  ['乌鲁木齐', 43.8256, 87.6168],
  ['拉萨', 29.652, 91.1721],
  ['海口', 20.044, 110.1999],
  ['三亚', 18.2528, 109.5119],
] as const;

export function buildActivity(parsed: ParsedFit, fileName: string): Activity {
  const sessions = [...parsed.sessions].sort((a, b) => (b.distance ?? 0) - (a.distance ?? 0));
  const primary = sessions[0];
  const session: FitSession = primary ?? {};
  const allRecords = parsed.records.filter(isUsableRecord);

  let records = allRecords;
  if (primary?.startTime != null) {
    const start = primary.startTime;
    const durationMs = Math.max(primary.elapsedTime ?? 0, primary.timerTime ?? 0) * 1000;
    const end = durationMs > 0 ? start + durationMs + 5000 : Infinity;
    const filtered = allRecords.filter((record) => (record.timestamp ?? 0) >= start - 2000
      && (record.timestamp ?? 0) <= end);
    if (filtered.length >= 2) records = filtered;
  }
  if (records.length < 2) throw new Error('这个 FIT / GPX 文件中没有可用的 GPS 轨迹点');

  // Remove obvious GPS jumps where the point leaves and immediately returns.
  const cleaned: FitRecord[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const current = records[i];
    if (i > 0 && i < records.length - 1) {
      const previous = records[i - 1];
      const next = records[i + 1];
      const dPrev = haversine(previous.lat!, previous.lon!, current.lat!, current.lon!);
      const dNext = haversine(current.lat!, current.lon!, next.lat!, next.lon!);
      const direct = haversine(previous.lat!, previous.lon!, next.lat!, next.lon!);
      const dt = ((current.timestamp ?? 0) - (previous.timestamp ?? 0)) / 1000;
      if (dt > 0 && dPrev / dt > 55 && dNext > 180 && direct < Math.max(dPrev, dNext) * 0.45) {
        continue;
      }
    }
    if (cleaned.length > 0 && current.timestamp != null
      && current.timestamp <= (cleaned[cleaned.length - 1].timestamp ?? 0)) {
      continue;
    }
    cleaned.push(current);
  }
  if (cleaned.length < 2) throw new Error('这个 FIT / GPX 文件中没有足够的 GPS 轨迹点');

  const points: RoutePoint[] = [];
  let cumulative = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const record = cleaned[i];
    if (i > 0) {
      cumulative += haversine(
        cleaned[i - 1].lat!,
        cleaned[i - 1].lon!,
        record.lat!,
        record.lon!,
      );
    }
    points.push({
      lat: record.lat!,
      lon: record.lon!,
      t: record.timestamp ?? 0,
      distance: cumulative,
      altitude: record.altitude,
      heartRate: record.heartRate,
      speed: record.speed,
      cadence: record.cadence,
      power: record.power,
    });
  }
  const routeDistanceM = points[points.length - 1].distance;
  if (routeDistanceM < 10) throw new Error('GPS 轨迹过短，无法生成动态视频');

  const startTime = session.startTime ?? points[0].t;
  const endTime = points[points.length - 1].t;
  const timeAvailable = parsed.hasTimestamps && startTime > 0;
  const recordDuration = Math.max(0, (endTime - startTime) / 1000);
  const durationAvailable = timeAvailable
    && ((session.elapsedTime ?? 0) > 0 || (session.timerTime ?? 0) > 0 || recordDuration > 0);
  // 显示时长优先用计时时间（timerTime，不含停留），与运动 App/Strava 口径一致；
  // timerTime 缺失或为 0 时退回 elapsedTime / 点跨度。
  const actualDuration = session.timerTime && session.timerTime > 0
    ? session.timerTime
    : session.elapsedTime ?? recordDuration;
  const durationSec = durationAvailable ? Math.max(1, actualDuration) : Math.max(20, routeDistanceM / 3.6);
  const movingSec = durationAvailable
    ? Math.max(1, session.timerTime ?? actualDuration)
    : durationSec;
  const distanceM = session.distance && session.distance > 0 ? session.distance : routeDistanceM;
  const scale = distanceM / routeDistanceM;
  for (const point of points) point.distance *= scale;

  const recordedSpeeds = points.map((point) => point.speed).filter(isNumber);
  const hasRecordedSpeeds = recordedSpeeds.length > 0;
  const speedValues = smoothSpeeds(points, movingSec, distanceM);
  for (let i = 0; i < points.length; i += 1) {
    if (speedValues[i] != null) points[i].speed = speedValues[i];
  }

  const validHeartRates = points.map((point) => point.heartRate).filter(isNumber);
  const recordMaxHr = validHeartRates.length ? Math.max(...validHeartRates) : undefined;
  const maxHeartRate = session.maxHeartRate && session.maxHeartRate > 0
    ? session.maxHeartRate
    : recordMaxHr;
  const heartRateAvailable = maxHeartRate != null;
  const avgHeartRate = session.avgHeartRate && session.avgHeartRate > 0
    ? session.avgHeartRate
    : validHeartRates.length
      ? Math.round(validHeartRates.reduce((sum, value) => sum + value, 0) / validHeartRates.length)
      : undefined;

  const maxSpeedAvailable = (session.maxSpeed ?? 0) > 0 || hasRecordedSpeeds || timeAvailable;
  const computedMaxSpeed = hasRecordedSpeeds
    ? Math.max(...recordedSpeeds)
    : percentile(points.map((point) => point.speed).filter(isNumber), 0.995);
  const maxSpeed = maxSpeedAvailable
    ? (session.maxSpeed && session.maxSpeed > 0 ? session.maxSpeed : computedMaxSpeed)
    : 0;
  const avgSpeedAvailable = (session.avgSpeed ?? 0) > 0 || durationAvailable || hasRecordedSpeeds;
  const avgSpeed = avgSpeedAvailable
    ? (session.avgSpeed && session.avgSpeed > 0
      ? session.avgSpeed
      : durationAvailable
        ? distanceM / movingSec
        : recordedSpeeds.reduce((sum, value) => sum + value, 0) / recordedSpeeds.length)
    : 0;

  const sportInfo = SPORTS[session.sport ?? -1] ?? { name: '运动', key: 'other' as const };
  // The peak markers drive the story bubbles in the film. A session summary can
  // report a max that no single record reaches (the watch smooths, or the value
  // lives only in the session message), and the old strict lookup then silently
  // dropped the bubble — 11.fit showed 10.41 km/h max speed but never popped
  // the "fastest" card. Always fall back to the actual peak record, then to the
  // midpoint of the ride, so a moment exists whenever the metric does.
  const midpoint = points[Math.max(0, Math.floor(points.length / 2))];
  const peakHeart = points.reduce<RoutePoint | undefined>((best, point) => {
    if (point.heartRate == null) return best;
    if (!best || (best.heartRate ?? -Infinity) < point.heartRate) return point;
    return best;
  }, undefined);
  const maxHrPoint = points.find((point) => point.heartRate != null && point.heartRate >= (recordMaxHr ?? Infinity))
    ?? peakHeart
    ?? (heartRateAvailable ? midpoint : undefined);

  const peakSpeed = points.reduce<RoutePoint | undefined>((best, point) => {
    if (point.speed == null) return best;
    if (!best || (best.speed ?? -Infinity) < point.speed) return point;
    return best;
  }, undefined);
  const maxSpeedPoint = maxSpeedAvailable
    ? (points.find((point) => point.speed != null && point.speed >= computedMaxSpeed * 0.96)
      ?? peakSpeed
      ?? midpoint)
    : undefined;
  const altitudeValues = points.map((point) => point.altitude).filter(isNumber);
  const maxAltitude = altitudeValues.length
    ? Math.max(...altitudeValues)
    : (session.maxAltitude ?? undefined);
  const altitudeAvailable = maxAltitude != null;
  const peakAltitude = points.reduce<RoutePoint | undefined>((best, point) => {
    if (point.altitude == null) return best;
    if (!best || (best.altitude ?? -Infinity) < point.altitude) return point;
    return best;
  }, undefined);
  const maxAltitudePoint = maxAltitude != null
    ? (points.find((point) => point.altitude != null && point.altitude >= maxAltitude - 0.01)
      ?? peakAltitude
      ?? midpoint)
    : undefined;

  const bounds = points.reduce(
    (box, point) => ({
      minLat: Math.min(box.minLat, point.lat),
      maxLat: Math.max(box.maxLat, point.lat),
      minLon: Math.min(box.minLon, point.lon),
      maxLon: Math.max(box.maxLon, point.lon),
    }),
    { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 },
  );
  const center = {
    lat: (bounds.minLat + bounds.maxLat) / 2,
    lon: (bounds.minLon + bounds.maxLon) / 2,
  };
  const city = nearestCity(center.lat, center.lon);
  const place = city ?? `${formatCoord(center.lat, 'N', 'S')} · ${formatCoord(center.lon, 'E', 'W')}`;
  const ascent = session.ascent ?? elevationGain(points);
  const descent = session.descent ?? elevationLoss(points);
  const calories = session.calories && session.calories > 0
    ? session.calories
    : estimateCalories(distanceM, durationSec, avgSpeed, avgHeartRate, sportInfo.key, durationAvailable);

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
    city: city ?? undefined,
    sessionCount: parsed.sessions.length,
    laps: parsed.laps,
    maxHrPoint,
    maxSpeedPoint,
    maxAltitudePoint,
  };
}

export function progressAtTime(activity: Activity, elapsedSec: number): number {
  const target = activity.startTime + elapsedSec * 1000;
  const points = activity.points;
  if (target <= points[0].t) return 0;
  if (target >= points[points.length - 1].t) return 1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= target) lo = mid;
    else hi = mid;
  }
  const span = points[hi].t - points[lo].t;
  const local = span > 0 ? (target - points[lo].t) / span : 0;
  return (points[lo].distance + (points[hi].distance - points[lo].distance) * local) / activity.distanceM;
}

export function interpolatePoint(activity: Activity, progress: number): {
  point: RoutePoint;
  distance: number;
  elapsed: number;
  speed: number;
  heartRate?: number;
} {
  const target = clamp(progress, 0, 1) * activity.distanceM;
  const points = activity.points;
  if (target <= 0) {
    return {
      point: points[0],
      distance: 0,
      elapsed: 0,
      speed: points[0].speed ?? 0,
      heartRate: points[0].heartRate,
    };
  }
  if (target >= activity.distanceM) {
    const point = points[points.length - 1];
    return {
      point,
      distance: activity.distanceM,
      elapsed: activity.durationSec,
      speed: 0,
      heartRate: point.heartRate,
    };
  }
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].distance <= target) lo = mid;
    else hi = mid;
  }
  const span = points[hi].distance - points[lo].distance;
  const local = span > 0 ? (target - points[lo].distance) / span : 0;
  const a = points[lo];
  const b = points[hi];
  const point: RoutePoint = {
    lat: a.lat + (b.lat - a.lat) * local,
    lon: a.lon + (b.lon - a.lon) * local,
    t: a.t + (b.t - a.t) * local,
    distance: target,
    altitude: lerpMaybe(a.altitude, b.altitude, local),
    heartRate: lerpMaybe(a.heartRate, b.heartRate, local),
    speed: lerpMaybe(a.speed, b.speed, local),
    cadence: lerpMaybe(a.cadence, b.cadence, local),
    power: lerpMaybe(a.power, b.power, local),
  };
  return {
    point,
    distance: target,
    elapsed: (point.t - activity.startTime) / 1000,
    speed: point.speed ?? activity.avgSpeed,
    heartRate: point.heartRate,
  };
}

export function formatDuration(seconds: number, forceHours = false): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0 || forceHours) return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  return `${pad(minutes)}:${pad(secs)}`;
}

export function formatPace(secondsPerKm: number): string {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return '--';
  const total = Math.round(secondsPerKm);
  return `${Math.floor(total / 60)}'${pad(total % 60)}"`;
}

export function formatSpeedKmh(metersPerSecond: number): string {
  return (metersPerSecond * 3.6).toFixed(1);
}

export function formatDateParts(timestamp: number): { date: string; time: string; weekday: string } {
  const date = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date);
  return {
    date: `${get('year') || date.getFullYear()}.${get('month')}.${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday,
  };
}

function buildSplits(points: RoutePoint[], startTime: number, totalDistance: number): Split[] {
  const splits: Split[] = [];
  const count = Math.ceil(totalDistance / 1000);
  let previousTime = startTime;
  let previousIndex = 0;
  for (let i = 0; i < count; i += 1) {
    const target = Math.min(totalDistance, (i + 1) * 1000);
    let index = findDistanceIndex(points, target);
    if (index <= previousIndex) index = Math.min(points.length - 1, previousIndex + 1);
    const point = points[index];
    const time = interpolateTimeAtDistance(points, target);
    const seconds = Math.max(0, (time - previousTime) / 1000);
    const distanceM = Math.max(0, target - i * 1000);
    const slice = points.slice(previousIndex, index + 1);
    const heartRates = slice.map((item) => item.heartRate).filter(isNumber);
    splits.push({
      index: i + 1,
      distanceM,
      seconds,
      speed: distanceM / Math.max(1, seconds),
      heartRate: heartRates.length
        ? Math.round(heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length)
        : undefined,
      ascent: elevationGain(slice),
    });
    previousTime = time;
    previousIndex = index;
  }
  return splits;
}

function interpolateTimeAtDistance(points: RoutePoint[], distance: number): number {
  const index = findDistanceIndex(points, distance);
  if (index <= 0) return points[0].t;
  const a = points[index - 1];
  const b = points[index];
  const span = b.distance - a.distance;
  const local = span > 0 ? (distance - a.distance) / span : 0;
  return a.t + (b.t - a.t) * local;
}

function findDistanceIndex(points: RoutePoint[], distance: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].distance < distance) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function smoothSpeeds(points: RoutePoint[], movingSec: number, distanceM: number): Array<number | undefined> {
  const raw: Array<number | undefined> = points.map((point) => point.speed);
  for (let i = 0; i < points.length; i += 1) {
    if (raw[i] != null) continue;
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dt = (b.t - a.t) / 1000;
    if (dt > 0) raw[i] = Math.max(0, (b.distance - a.distance) / dt);
  }
  const fallback = distanceM / Math.max(1, movingSec);
  const filled = raw.map((value) => (value != null && Number.isFinite(value) ? value : fallback));
  const radius = points.length > 1500 ? 2 : 3;
  const smoothed: number[] = [];
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

function elevationGain(points: RoutePoint[]): number | undefined {
  const altitudes = points.map((point) => point.altitude).filter(isNumber);
  if (altitudes.length < 2) return undefined;
  let gain = 0;
  for (let i = 1; i < altitudes.length; i += 1) {
    const delta = altitudes[i] - altitudes[i - 1];
    if (delta > 0.4) gain += delta;
  }
  return Math.round(gain);
}

function elevationLoss(points: RoutePoint[]): number | undefined {
  const altitudes = points.map((point) => point.altitude).filter(isNumber);
  if (altitudes.length < 2) return undefined;
  let loss = 0;
  for (let i = 1; i < altitudes.length; i += 1) {
    const delta = altitudes[i - 1] - altitudes[i];
    if (delta > 0.4) loss += delta;
  }
  return Math.round(loss);
}

function activityTitle(key: Activity['sportKey']): string {
  if (key === 'run') return '我的跑步';
  if (key === 'hike') return '我的徒步';
  if (key === 'ride') return '我的骑行';
  return '我的运动';
}

function estimateCalories(
  distanceM: number,
  durationSec: number,
  avgSpeed: number,
  avgHeartRate: number | undefined,
  sportKey: Activity['sportKey'],
  durationAvailable: boolean,
): number | undefined {
  if (!durationAvailable || distanceM <= 0 || durationSec <= 0) return undefined;
  const speedKmh = avgSpeed > 0 ? avgSpeed * 3.6 : (distanceM / 1000) / (durationSec / 3600);
  let met: number;
  if (sportKey === 'ride') {
    met = speedKmh < 16 ? 4.0 : speedKmh < 20 ? 6.8 : speedKmh < 25 ? 8.2 : speedKmh < 30 ? 10.0 : 12.0;
  } else if (sportKey === 'run') {
    met = Math.max(4, Math.min(20, 1.5 + speedKmh * 0.9));
  } else if (sportKey === 'hike') {
    met = speedKmh < 4 ? 3.5 : speedKmh < 6 ? 5.0 : 6.5;
  } else {
    met = Math.max(2.5, Math.min(12, 2 + speedKmh * 0.35));
  }
  if (avgHeartRate && avgHeartRate > 60) {
    const hrMet = Math.max(2, Math.min(16, 1.2 + (avgHeartRate - 60) * 0.12));
    met = met * 0.65 + hrMet * 0.35;
  }
  return Math.round(met * 65 * (durationSec / 3600));
}

function nearestCity(lat: number, lon: number): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const [name, cityLat, cityLon] of CITIES) {
    const distance = haversine(lat, lon, cityLat, cityLon);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best && best.distance < 55_000 ? best.name : undefined;
}

function isUsableRecord(record: FitRecord): boolean {
  return record.lat != null && record.lon != null
    && Number.isFinite(record.lat) && Number.isFinite(record.lon)
    && Math.abs(record.lat) <= 90 && Math.abs(record.lon) <= 180
    && !(Math.abs(record.lat) < 0.0001 && Math.abs(record.lon) < 0.0001)
    && record.timestamp != null;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)));
  return sorted[index];
}

function formatCoord(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`;
}

function lerpMaybe(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return a + (b - a) * t;
}

function isNumber(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
