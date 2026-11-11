import { buildActivity, type Activity, type RoutePoint } from '../fit/activity';
import { linkDistance, linkLimitFor, sameRoute } from '../import/route-match';
import { activityToFit } from './fit';
import type { FitRecord, FitSession, ParsedFit, TripInfo, TripLeg } from '../fit/types';

export type TrackFormat = 'gpx' | 'tcx' | 'fit';

/** 本地自然日键：判断是不是多日行程（按用户所在时区，不按 UTC）。 */
function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 把多段轨迹拼成一条合并行程。规则：
 * - 只能合并同一种运动，按开始时间先后排列；
 * - **同一条路线只保留一次几何**（往返、同路线多刷）：轨迹点不重复拼接，
 *   但这段的里程/时长仍计入合计，极值汇总进 TripInfo.best；
 * - 不是同一条路线的段必须首尾相接（阈值随段长放宽，2~8km），否则直接报错，
 *   避免地图上出现横穿地图的直线、第一视角瞬移；
 * - 运动时长 = 实际绘制的那一遍（供视频/进度使用），真实总计另存 TripInfo；
 * - 距离/爬升/卡路里累加，平均心率按时长加权，最高速取各段最大。
 */
export function mergeToParsed(activities: Activity[]): ParsedFit {
  if (activities.length < 2) throw new Error('至少需要两条轨迹才能合并');
  const parts = [...activities].sort((a, b) => a.startTime - b.startTime);
  const sportKey = parts[0].sportKey;
  if (parts.some((part) => part.sportKey !== sportKey)) throw new Error('只能合并同一种运动的记录');

  const useTime = parts.every((part) => part.timeAvailable
    && part.points.length > 1
    && part.points[part.points.length - 1].t > 0);

  interface Classified {
    activity: Activity;
    /** 与前面第几段是同一条路线（几何不重复拼接） */
    repeatOf?: number;
    /** 与上一段的衔接距离 */
    linkM: number;
    /** 这一段采用的衔接上限 */
    limitM: number;
  }

  const classified: Classified[] = [];
  const kept: Array<{ activity: Activity; index: number }> = [];
  let previous: Activity | null = null;
  let linkLimitM = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    let repeatOf: number | undefined;
    if (part.points.length > 1) {
      for (const route of kept) {
        if (sameRoute(route.activity.points, part.points)) {
          repeatOf = route.index;
          break;
        }
      }
    }
    let linkM = 0;
    let limitM = 0;
    if (repeatOf == null && previous) {
      linkM = linkDistance(previous.points, part.points);
      limitM = linkLimitFor(previous.distanceM, part.distanceM);
      linkLimitM = Math.max(linkLimitM, limitM);
      if (linkM > limitM) {
        throw new Error(
          `第 ${i + 1} 段（${shortDate(part.startTime)} · ${(part.distanceM / 1000).toFixed(1)} km）`
          + `起点距离上一段终点 ${(linkM / 1000).toFixed(1)} km，超出可衔接范围（${(limitM / 1000).toFixed(0)} km）。`
          + '多日行程要求相邻两段首尾相接；如果是两次独立出行，请分开生成视频。',
        );
      }
    }
    classified.push({ activity: part, repeatOf, linkM, limitM });
    if (repeatOf == null) kept.push({ activity: part, index: i + 1 });
    previous = part;
  }

  const records: FitRecord[] = [];
  let synthetic = 0;
  let previousTime = 0;
  for (const item of classified) {
    if (item.repeatOf != null) continue;
    const part = item.activity;
    const step = useTime ? 0 : Math.max(1, part.durationSec / Math.max(1, part.points.length - 1));
    for (const point of part.points) {
      if (useTime) {
        if (point.t <= previousTime) continue;
        previousTime = point.t;
      } else {
        synthetic += step;
      }
      records.push({
        timestamp: useTime ? point.t : Math.round(synthetic * 1000),
        lat: point.lat,
        lon: point.lon,
        altitude: point.altitude,
        speed: point.speed,
        heartRate: point.heartRate,
        cadence: point.cadence,
        power: point.power,
      });
    }
  }
  if (records.length < 2) throw new Error('合并后的轨迹点不足');

  const keptActivities = classified
    .filter((item) => item.repeatOf == null)
    .map((item) => item.activity);
  const numbers = (values: Array<number | undefined>): number[] =>
    values.filter((value): value is number => value != null && Number.isFinite(value));
  const sum = (values: Array<number | undefined>): number =>
    values.reduce<number>((acc, value) => acc + (value ?? 0), 0);

  const startTime = useTime ? records[0].timestamp : parts[0].startTime;
  // 真实跨度：首段开始到「最后一段」结束。注意不能用 records 的末点 ——
  // 重复路线的点不会拼进 records，末段是重复段时会算成第一次的结束时间，
  // 跨天行程的「总时长」就缩回一天以内了。
  const lastPart = parts[parts.length - 1];
  const lastPoint = lastPart.points[lastPart.points.length - 1];
  const endTime = useTime ? lastPoint?.t : undefined;
  // 裁点窗口必须覆盖全部点，含停留与跨天间隔
  const spanSec = useTime && startTime != null && endTime != null && endTime > startTime
    ? Math.max(1, (endTime - startTime) / 1000)
    : sum(parts.map((part) => Math.max(1, part.movingSec)));

  const routeMeters = keptActivities.reduce((acc, part) => acc + part.distanceM, 0);
  const totalMeters = parts.reduce((acc, part) => acc + part.distanceM, 0);
  /** 视频/进度口径：实际只画一遍，时长也只算保留段 */
  const playMovingSec = keptActivities.reduce((acc, part) => acc + Math.max(1, part.movingSec), 0);
  const totalMovingSec = parts.reduce((acc, part) => acc + Math.max(1, part.movingSec), 0);

  const weightedHr = keptActivities.reduce((acc, part) => {
    if (part.avgHeartRate == null) return acc;
    const weight = Math.max(1, part.movingSec);
    acc.total += part.avgHeartRate * weight;
    acc.weight += weight;
    return acc;
  }, { total: 0, weight: 0 });

  const keptMaxSpeed = numbers(keptActivities.map((part) => part.maxSpeed));
  const keptMaxHr = numbers(keptActivities.map((part) => part.maxHeartRate));
  const allMaxSpeed = numbers(parts.map((part) => part.maxSpeed));
  const allMaxHr = numbers(parts.map((part) => part.maxHeartRate));
  const allMaxAlt = numbers(parts.map((part) => part.maxAltitude));
  const allAscent = numbers(parts.map((part) => part.ascent));

  const repeated = classified.filter((item) => item.repeatOf != null).length;
  const multiDay = new Set(parts.map((part) => dayKey(part.startTime))).size > 1;

  const legs: TripLeg[] = classified.map((item, index) => {
    const part = item.activity;
    return {
      index: index + 1,
      start: part.startTime,
      distanceM: part.distanceM,
      movingSec: part.movingSec,
      elapsedSec: part.elapsedSec,
      ascent: part.ascent,
      maxSpeed: part.maxSpeedAvailable ? part.maxSpeed : undefined,
      maxHeartRate: part.maxHeartRate,
      maxAltitude: part.maxAltitude,
      repeat: item.repeatOf != null,
      repeatOf: item.repeatOf,
      linkM: item.repeatOf != null ? 0 : item.linkM,
    };
  });

  const trip: TripInfo = {
    legs,
    multiDay,
    routeMeters,
    totalMeters,
    totalMovingSec,
    totalElapsedSec: Math.round(spanSec),
    repeated,
    best: {
      maxSpeed: allMaxSpeed.length ? Math.max(...allMaxSpeed) : undefined,
      maxHeartRate: allMaxHr.length ? Math.max(...allMaxHr) : undefined,
      maxAltitude: allMaxAlt.length ? Math.max(...allMaxAlt) : undefined,
      ascent: allAscent.length ? Math.round(allAscent.reduce((acc, value) => acc + value, 0)) : undefined,
    },
    linkLimitM,
  };

  const session: FitSession = {
    startTime,
    elapsedTime: spanSec,
    timerTime: playMovingSec,
    distance: routeMeters,
    calories: parts.reduce((acc, part) => acc + (part.calories ?? 0), 0) || undefined,
    sport: parts[0].sport,
    subSport: parts[0].subSport,
    avgHeartRate: weightedHr.weight > 0 ? Math.round(weightedHr.total / weightedHr.weight) : undefined,
    maxHeartRate: keptMaxHr.length ? Math.max(...keptMaxHr) : undefined,
    maxSpeed: keptMaxSpeed.length ? Math.max(...keptMaxSpeed) : undefined,
    ascent: allAscent.length
      ? Math.round(keptActivities.reduce((acc, part) => acc + (part.ascent ?? 0), 0))
      : undefined,
    descent: classified.length
      ? Math.round(keptActivities.reduce((acc, part) => acc + (part.descent ?? 0), 0)) || undefined
      : undefined,
  };

  return {
    sourceType: parts[0].sourceType,
    hasTimestamps: useTime,
    name: '合并轨迹',
    sportHint: parts[0].sport,
    records,
    sessions: [session],
    laps: [],
    trip,
  };
}

export function mergeActivities(activities: Activity[]): Activity {
  return buildActivity(mergeToParsed(activities), `合并轨迹-${activities.length}段.tcx`);
}

function isNumber(value: number | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * 心率过滤：FIT / TCX 的心率字段都是 uint8，0xFF(255) 在 FIT 里表示无效，
 * 所以只放行 30~254；低于 30 基本是传感器未佩戴时的噪声。
 */
function heartRateValue(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const raw = Math.round(value);
  if (raw < 30 || raw > 254) return null;
  return raw;
}

/**
 * GPX 1.1 标准本身没有心率字段，行业通用做法是 Garmin 的 TrackPointExtension，
 * Garmin Connect / Strava / 华为运动健康 / 高驰都能识别 gpxtpx:hr。
 */
function gpxPointExtension(point: RoutePoint): string {
  const parts: string[] = [];
  const hr = heartRateValue(point.heartRate);
  if (hr != null) parts.push(`<gpxtpx:hr>${hr}</gpxtpx:hr>`);
  const cadence = point.cadence != null && Number.isFinite(point.cadence) ? Math.round(point.cadence) : null;
  if (cadence != null && cadence > 0 && cadence < 255) parts.push(`<gpxtpx:cad>${cadence}</gpxtpx:cad>`);
  if (!parts.length) return '';
  return `<extensions><gpxtpx:TrackPointExtension>${parts.join('')}</gpxtpx:TrackPointExtension></extensions>`;
}

export function activityToGpx(activity: Activity): string {
  const points = activity.points.map((point) => {
    const ele = point.altitude != null ? `<ele>${point.altitude.toFixed(2)}</ele>` : '';
    const time = activity.timeAvailable && point.t > 0 ? `<time>${new Date(point.t).toISOString()}</time>` : '';
    const ext = gpxPointExtension(point);
    return `        <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lon.toFixed(7)}">${ele}${time}${ext}</trkpt>`;
  }).join('\n');
  // 官方统计写进 extensions（与华为导出同构）：重新导入时解析器优先用
  // 这组值，时长/距离不会漂移，运动指纹也能对上（不会产生重复记录）。
  const climb = activity.ascent != null && activity.ascent > 0 ? `<cumulativeClimb>${Math.round(activity.ascent)}</cumulativeClimb>` : '';
  const drop = activity.descent != null && activity.descent > 0 ? `<cumulativeDecrease>${Math.round(activity.descent)}</cumulativeDecrease>` : '';
  const extensions = activity.durationSec > 0 || activity.distanceM > 0
    ? `\n      <extensions>${activity.durationSec > 0 ? `<totalTime>${Math.round(activity.durationSec)}</totalTime>` : ''}${activity.distanceM > 0 ? `<totalDistance>${Math.round(activity.distanceM)}</totalDistance>` : ''}${climb}${drop}</extensions>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FIT MOTION" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">
  <metadata><name>${escapeXml(activity.title)}</name></metadata>
  <trk><name>${escapeXml(activity.title)}</name><type>${escapeXml(activity.sportName)}</type>${extensions}
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
}

export function activityToTcx(activity: Activity): string {
  const startIso = new Date(activity.timeAvailable ? activity.startTime : Date.now()).toISOString();
  const points = activity.points.map((point, index) => {
    const time = new Date(activity.timeAvailable ? point.t : Date.now() + index * 1000).toISOString();
    const altitude = point.altitude != null ? `<AltitudeMeters>${point.altitude.toFixed(2)}</AltitudeMeters>` : '';
    const distance = `<DistanceMeters>${point.distance.toFixed(2)}</DistanceMeters>`;
    const hrRaw = heartRateValue(point.heartRate);
    const hr = hrRaw != null ? `<HeartRateBpm><Value>${hrRaw}</Value></HeartRateBpm>` : '';
    const cadence = point.cadence != null ? `<Cadence>${Math.round(point.cadence)}</Cadence>` : '';
    const speed = point.speed != null ? `<Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Speed>${point.speed.toFixed(3)}</Speed></TPX></Extensions>` : '';
    return `        <Trackpoint><Time>${time}</Time><Position><LatitudeDegrees>${point.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${point.lon.toFixed(7)}</LongitudeDegrees></Position>${altitude}${distance}${hr}${cadence}${speed}</Trackpoint>`;
  }).join('\n');
  // Lap 层的心率汇总：Garmin Connect / 华为运动健康打开 TCX 时直接读这两个值，
  // 没有它们只会在曲线上画心率，摘要区的心率是空的。
  const avgHr = heartRateValue(activity.avgHeartRate);
  const maxHr = heartRateValue(activity.maxHeartRate);
  const lapAvg = avgHr != null ? `<AverageHeartRateBpm><Value>${avgHr}</Value></AverageHeartRateBpm>` : '';
  const lapMax = maxHr != null ? `<MaximumHeartRateBpm><Value>${maxHr}</Value></MaximumHeartRateBpm>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Activities><Activity Sport="${tcxSport(activity.sportKey)}"><Id>${startIso}</Id>
      <Lap StartTime="${startIso}"><TotalTimeSeconds>${activity.durationSec}</TotalTimeSeconds><DistanceMeters>${activity.distanceM.toFixed(2)}</DistanceMeters><Calories>${activity.calories ?? 0}</Calories>${lapAvg}${lapMax}<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
        <Track>
${points}
        </Track>
      </Lap>
    </Activity></Activities>
</TrainingCenterDatabase>`;
}

/** TCX 的 Sport 是枚举（Running / Biking / Other），写中文会被 Garmin 拒收。 */
function tcxSport(key: Activity['sportKey']): string {
  if (key === 'run') return 'Running';
  if (key === 'ride') return 'Biking';
  return 'Other';
}

export function downloadTrack(activity: Activity, format: TrackFormat): void {
  const content = format === 'gpx' ? activityToGpx(activity)
    : format === 'tcx' ? activityToTcx(activity)
      : activityToFit(activity);
  const blob = new Blob([content as BlobPart], {
    type: format === 'gpx' ? 'application/gpx+xml'
      : format === 'tcx' ? 'application/vnd.garmin.tcx+xml' : 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${activity.title}-${format}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[character] ?? character));
}
