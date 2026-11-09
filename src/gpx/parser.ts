import type { FitRecord, FitSession, ParsedFit } from '../fit/types';
import { haversine } from '../geo';

/**
 * GPX 1.0/1.1 reader for track points and common vendor extensions.
 *
 * 华为运动健康的导出（creator="Health"）有两处和通用 GPX 不一样：
 * 1. 官方统计写在 <trk><extensions> 里（totalTime / totalDistance /
 *    cumulativeClimb / cumulativeDecrease），是 App 上显示的那一组数，
 *    比「点跨度 + 裸算 haversine」更接近用户看到的成绩；
 * 2. 全程记录（含停留），点跨度通常大于计时时间，速度必须用 totalTime。
 * 这里优先用官方值，并用比值做防御，异常时才退回逐点计算。
 */
export function parseGpx(text: string, fileName: string): ParsedFit {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement) {
    throw new Error('GPX 文件格式不正确，无法解析 XML');
  }

  // 按 trkseg 分组：多段轨迹之间可能有停车/换地的空档，
  // 直接首尾相连算距离会把那段直线距离也算进里程。
  const segments = readSegments(doc);
  const raw = segments.flat();
  if (raw.length < 2) throw new Error('GPX 文件中没有 trkpt / rtept 轨迹点');

  const timeValues = raw.map((point) => point.time);
  const validTimes = timeValues.filter((value): value is number => value != null && Number.isFinite(value));
  const hasTimestamps = validTimes.length >= Math.max(2, Math.ceil(raw.length * 0.8))
    && Math.max(...validTimes) > Math.min(...validTimes);

  if (hasTimestamps) {
    segments.forEach(fillMissingTimes);
  }

  const records: FitRecord[] = [];
  let cumulative = 0;
  let syntheticSeconds = 0;
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i += 1) {
      const point = segment[i];
      if (i > 0) {
        cumulative += haversine(segment[i - 1].lat, segment[i - 1].lon, point.lat, point.lon);
        if (!hasTimestamps) syntheticSeconds = cumulative / 3.6; // fallback story pace only
      }
      records.push({
        timestamp: hasTimestamps ? point.time! : Math.round(syntheticSeconds * 1000),
        lat: point.lat,
        lon: point.lon,
        altitude: point.ele,
        speed: point.speed,
        heartRate: point.hr,
        cadence: point.cadence,
        power: point.power,
        temperature: point.temperature,
      });
    }
  }

  const trk = doc.getElementsByTagNameNS('*', 'trk')[0] ?? null;
  const sportHint = inferSport(`${readFirstText(trk ?? doc, 'type')} ${readFirstText(doc, 'name')} ${fileName}`);
  const firstTime = hasTimestamps ? raw[0].time! : metadataTime(doc);
  const lastTime = hasTimestamps ? raw[raw.length - 1].time! : undefined;
  const span = firstTime != null && lastTime != null ? Math.max(0, (lastTime - firstTime) / 1000) : undefined;
  const altitudes = raw.map((point) => point.ele).filter((value): value is number => value != null);
  const heartRates = raw.map((point) => point.hr).filter((value): value is number => value != null);
  const speeds = raw.map((point) => point.speed).filter((value): value is number => value != null);

  // 华为把官方统计挂在 trk 上，先看 trk，再退回整个文档（部分工具写在 gpx 根节点）。
  const extScope = trk ?? doc.documentElement;
  const gpxTotalTime = readNumber(extScope, ['totalTime']) ?? readNumber(doc.documentElement, ['totalTime']);
  const gpxTotalDistance = readNumber(extScope, ['totalDistance']) ?? readNumber(doc.documentElement, ['totalDistance']);
  const gpxClimb = readNumber(extScope, ['cumulativeClimb']);
  const gpxDecrease = readNumber(extScope, ['cumulativeDecrease']);

  // totalTime 是官方运动时长（不含停留）；没有就留空让停留检测估算，
  // 不能拿点跨度（= 总耗时）硬填，否则运动时长恒等于总时长。
  const timerTime = gpxTotalTime && gpxTotalTime > 0
    && (span == null || gpxTotalTime <= span * 1.05)
    ? gpxTotalTime
    : undefined;
  const officialRatio = gpxTotalDistance && cumulative > 0 ? gpxTotalDistance / cumulative : 0;
  const distance = gpxTotalDistance && gpxTotalDistance > 0
    && officialRatio > 0.3 && officialRatio < 1.5
    ? gpxTotalDistance
    : cumulative;

  const session: FitSession = {
    startTime: firstTime,
    elapsedTime: span,
    timerTime,
    distance,
    sport: sportHint,
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
    ascent: saneClimb(gpxClimb) ?? elevationGain(altitudes),
    descent: saneClimb(gpxDecrease) ?? elevationLoss(altitudes),
  };

  const name = readFirstText(trk ?? doc, 'name') || readFirstText(doc, 'name');
  return {
    sourceType: 'gpx',
    hasTimestamps,
    sportHint,
    name: name || fileName.replace(/\.gpx$/i, ''),
    records,
    sessions: [session],
    laps: [],
  };
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
  temperature?: number;
}

function readSegments(doc: Document): RawPoint[][] {
  const segments: RawPoint[][] = [];
  for (const seg of Array.from(doc.getElementsByTagNameNS('*', 'trkseg'))) {
    const points = Array.from(seg.getElementsByTagNameNS('*', 'trkpt'))
      .map((node) => readPoint(node))
      .filter((point): point is RawPoint => point !== null);
    if (points.length) segments.push(points);
  }
  if (segments.length) return segments;

  // 部分工具（包括本应用旧版导出）把 trkpt 直接挂在 <trk> 下，没有 trkseg
  const loose: RawPoint[] = [];
  for (const trk of Array.from(doc.getElementsByTagNameNS('*', 'trk'))) {
    for (const node of Array.from(trk.getElementsByTagNameNS('*', 'trkpt'))) {
      const point = readPoint(node);
      if (point) loose.push(point);
    }
  }
  if (loose.length >= 2) return [loose];

  // 再不行就按 rtept 处理
  const route = Array.from(doc.getElementsByTagNameNS('*', 'rtept'))
    .map((node) => readPoint(node))
    .filter((point): point is RawPoint => point !== null);
  return route.length ? [route] : [];
}

function readPoint(node: Element): RawPoint | null {
  const lat = Number(node.getAttribute('lat'));
  const lon = Number(node.getAttribute('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    time: parseTime(readFirstText(node, 'time')),
    ele: readNumber(node, ['ele', 'elevation', 'altitude']),
    hr: readNumber(node, ['hr', 'heartrate', 'heart_rate']),
    cadence: readNumber(node, ['cad', 'cadence']),
    power: readNumber(node, ['power', 'watts']),
    speed: readNumber(node, ['speed']),
    temperature: readNumber(node, ['atemp', 'temp', 'temperature']),
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

/** 没有轨迹时间戳的 GPX：至少别让记录落到 1970 年。 */
function metadataTime(doc: Document): number | undefined {
  const metadata = doc.getElementsByTagNameNS('*', 'metadata')[0];
  const text = metadata ? readFirstText(metadata, 'time') : '';
  return parseTime(text);
}

function readFirstText(parent: Element | Document, localName: string): string {
  const node = parent.getElementsByTagNameNS('*', localName)[0];
  return node?.textContent?.trim() ?? '';
}

function readNumber(parent: Element, names: string[]): number | undefined {
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

/** 华为的中文运动类型直接映射到 FIT sport id。 */
export function inferSport(hint: string): number {
  const value = hint.toLowerCase();
  if (/e-?bike|ebike|电助力/.test(value)) return 21;
  if (/run|running|跑步|慢跑|越野跑|操场跑|跑步机/.test(value)) return 1;
  if (/hike|hiking|徒步|登山|爬山/.test(value)) return 17;
  if (/walk|walking|步行|散步/.test(value)) return 11;
  if (/swim|swimming|游泳/.test(value)) return 5;
  if (/ride|bike|cycling|bicycle|骑行|单车|自行车/.test(value)) return 2;
  return 2;
}

function saneClimb(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function elevationGain(altitudes: number[]): number | undefined {
  if (altitudes.length < 2) return undefined;
  let gain = 0;
  for (let i = 1; i < altitudes.length; i += 1) {
    const delta = altitudes[i] - altitudes[i - 1];
    if (delta > 0.4) gain += delta;
  }
  return Math.round(gain);
}

function elevationLoss(altitudes: number[]): number | undefined {
  if (altitudes.length < 2) return undefined;
  let loss = 0;
  for (let i = 1; i < altitudes.length; i += 1) {
    const delta = altitudes[i - 1] - altitudes[i];
    if (delta > 0.4) loss += delta;
  }
  return Math.round(loss);
}
