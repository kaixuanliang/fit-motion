import type { FitRecord, FitSession, ParsedFit } from '../fit/types';
import { haversine } from '../geo';
import { inferSport } from '../gpx/parser';

/**
 * TCX reader for Garmin / Coros / Wahoo / 华为 style Training Center XML.
 *
 * 华为导出的 TCX 和 GPX 一样存在「点跨度 ≠ 计时时间」的问题：全程记录里
 * 中途停留也写进了 Trackpoint 时间轴，所以时长取 Lap 的 TotalTimeSeconds，
 * 距离取 Lap 的 DistanceMeters（多圈求和），两者都比逐点累加更贴近 App 显示。
 */
export function parseTcx(text: string, fileName: string): ParsedFit {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement) {
    throw new Error('TCX 文件格式不正确，无法解析 XML');
  }

  const nodes = Array.from(doc.getElementsByTagNameNS('*', 'Trackpoint'));
  if (nodes.length < 2) throw new Error('TCX 文件中没有足够的轨迹点');

  const raw = nodes.map((node) => readPoint(node)).filter((point): point is RawPoint => point !== null);
  if (raw.length < 2) throw new Error('TCX 文件中的有效轨迹点不足');

  const times = raw.map((point) => point.time).filter((value): value is number => value != null && Number.isFinite(value));
  const hasTimestamps = times.length >= Math.max(2, Math.ceil(raw.length * 0.8))
    && Math.max(...times) > Math.min(...times);
  if (hasTimestamps) fillMissingTimes(raw);

  let cumulative = 0;
  let syntheticSeconds = 0;
  const records: FitRecord[] = raw.map((point, index) => {
    if (index > 0) {
      cumulative += haversine(raw[index - 1].lat, raw[index - 1].lon, point.lat, point.lon);
      if (!hasTimestamps) syntheticSeconds = cumulative / 3.6;
    }
    return {
      timestamp: hasTimestamps ? point.time : Math.round(syntheticSeconds * 1000),
      lat: point.lat,
      lon: point.lon,
      altitude: point.ele,
      speed: point.speed,
      heartRate: point.hr,
      cadence: point.cadence,
      power: point.power,
    };
  });

  const firstTime = hasTimestamps ? raw[0].time : undefined;
  const lastTime = hasTimestamps ? raw[raw.length - 1].time : undefined;
  const span = firstTime != null && lastTime != null ? Math.max(0, (lastTime - firstTime) / 1000) : undefined;

  // Lap 是厂商写下的「这一圈跑了多少」：多圈求和，再对点跨度做上限防御。
  // （自动暂停的 TCX 里 TotalTimeSeconds 会小于点跨度，这是正确的。）
  const laps = Array.from(doc.getElementsByTagNameNS('*', 'Lap'));
  const lapTimerSec = laps.reduce((sum, lap) => sum + (readNumber(lap, ['TotalTimeSeconds']) ?? 0), 0);
  const lapDistance = laps.reduce((sum, lap) => sum + (readNumber(lap, ['DistanceMeters']) ?? 0), 0);
  const lapCalories = laps.reduce((sum, lap) => sum + (readNumber(lap, ['Calories']) ?? 0), 0);
  // 华为把累计爬升/下降写在 Lap 上（CumulativeClimb / CumulativeDecrease），
  // 和 App 显示的数字一致；逐点算会因 GPS 高程噪声偏差几百米。
  const lapClimb = laps.reduce((sum, lap) => sum + (readNumber(lap, ['CumulativeClimb']) ?? 0), 0);
  const lapDecrease = laps.reduce((sum, lap) => sum + (readNumber(lap, ['CumulativeDecrease']) ?? 0), 0);

  // Lap 的 TotalTimeSeconds 是码表计时（不含停留），可信；没有 Lap 就留空，
  // 让 activity.ts 停留检测估算，别拿点跨度硬填成运动时长。
  const timerTime = lapTimerSec > 0
    ? (span != null ? Math.min(lapTimerSec, span) : lapTimerSec)
    : undefined;

  const altitudes = raw.map((point) => point.ele).filter((value): value is number => value != null);
  const heartRates = raw.map((point) => point.hr).filter((value): value is number => value != null);
  const speeds = raw.map((point) => point.speed).filter((value): value is number => value != null);
  const activity = doc.getElementsByTagNameNS('*', 'Activity')[0] ?? null;
  const sport = inferSport(`${activity?.getAttribute('Sport') ?? ''} ${readFirstText(doc, 'Sport')} ${fileName}`);
  const distance = pickDistance(lapDistance, lastRecordDistance(raw), cumulative);

  const session: FitSession = {
    startTime: firstTime,
    elapsedTime: span,
    timerTime,
    distance,
    calories: lapCalories > 0 ? lapCalories : undefined,
    sport,
    subSport: 0,
    maxHeartRate: heartRates.length ? Math.max(...heartRates) : undefined,
    avgHeartRate: heartRates.length
      ? Math.round(heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length)
      : undefined,
    maxSpeed: speeds.length ? Math.max(...speeds) : undefined,
    avgSpeed: timerTime && timerTime > 0
      ? distance / timerTime
      : span && span > 0
        ? distance / span
        : undefined,
    maxAltitude: altitudes.length ? Math.max(...altitudes) : undefined,
    avgAltitude: altitudes.length
      ? altitudes.reduce((sum, value) => sum + value, 0) / altitudes.length
      : undefined,
    ascent: lapClimb > 0 ? Math.round(lapClimb) : undefined,
    descent: lapDecrease > 0 ? Math.round(lapDecrease) : undefined,
  };

  return {
    sourceType: 'tcx',
    hasTimestamps,
    sportHint: sport,
    name: readFirstText(activity ?? doc, 'Id') || fileName.replace(/\.tcx$/i, ''),
    records,
    sessions: [session],
    laps: [],
  };
}

/**
 * 距离优先级：Lap 汇总 > 最后一个 Trackpoint 的 DistanceMeters > 逐点 haversine。
 * 每一项都和历史轨迹比值做防御，偏差过大（GPS 漂移、单位写错）就继续降级。
 */
function pickDistance(lapDistance: number, lastPointDistance: number | undefined, cumulative: number): number {
  const candidates = [lapDistance, lastPointDistance ?? 0];
  for (const value of candidates) {
    if (value > 0 && cumulative > 0) {
      const ratio = value / cumulative;
      if (ratio > 0.3 && ratio < 1.5) return value;
    } else if (value > 0) {
      return value;
    }
  }
  return cumulative;
}

function lastRecordDistance(points: RawPoint[]): number | undefined {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i].distance != null && points[i].distance! > 0) return points[i].distance;
  }
  return undefined;
}

interface RawPoint {
  lat: number;
  lon: number;
  time?: number;
  ele?: number;
  hr?: number;
  cadence?: number;
  power?: number;
  speed?: number;
  distance?: number;
}

function readPoint(node: Element): RawPoint | null {
  const position = node.getElementsByTagNameNS('*', 'Position')[0];
  if (!position) return null;
  const lat = Number(readFirstText(position, 'LatitudeDegrees'));
  const lon = Number(readFirstText(position, 'LongitudeDegrees'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const hrNode = node.getElementsByTagNameNS('*', 'HeartRateBpm')[0];
  const speedNode = node.getElementsByTagNameNS('*', 'Speed')[0];
  return {
    lat,
    lon,
    time: parseTime(readFirstText(node, 'Time')),
    ele: readNumber(node, ['AltitudeMeters']),
    hr: hrNode ? Number(readFirstText(hrNode, 'Value')) : readNumber(node, ['HeartRateBpm']),
    cadence: readNumber(node, ['Cadence']),
    power: readNumber(node, ['Watts']),
    speed: speedNode?.textContent ? Number(speedNode.textContent) : readNumber(node, ['Speed']),
    distance: readNumber(node, ['DistanceMeters']),
  };
}

function fillMissingTimes(points: RawPoint[]): void {
  const known = points
    .map((point, index) => ({ index, time: point.time }))
    .filter((entry): entry is { index: number; time: number } => entry.time != null && Number.isFinite(entry.time));
  if (known.length < 2) return;
  for (let i = 0; i < points.length; i += 1) {
    if (points[i].time != null) continue;
    const before = [...known].reverse().find((entry) => entry.index < i);
    const after = known.find((entry) => entry.index > i);
    if (before && after) {
      const ratio = (i - before.index) / (after.index - before.index);
      points[i].time = before.time + (after.time - before.time) * ratio;
    } else if (before) {
      points[i].time = before.time + (i - before.index) * 1000;
    } else if (after) {
      points[i].time = after.time - (after.index - i) * 1000;
    }
  }
}

function readFirstText(parent: Element | Document, localName: string): string {
  const node = parent.getElementsByTagNameNS('*', localName)[0];
  return node?.textContent?.trim() ?? '';
}

function readNumber(parent: Element | Document, names: string[]): number | undefined {
  for (const name of names) {
    const node = parent.getElementsByTagNameNS('*', name)[0];
    if (!node?.textContent) continue;
    const value = Number(node.textContent.trim());
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function parseTime(text: string): number | undefined {
  if (!text) return undefined;
  const value = Date.parse(text);
  return Number.isFinite(value) ? value : undefined;
}
