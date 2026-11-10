import { buildActivity, type Activity, type RoutePoint } from '../fit/activity';
import { activityToFit } from './fit';
import type { FitRecord, ParsedFit } from '../fit/types';

export type TrackFormat = 'gpx' | 'tcx' | 'fit';

/**
 * 把多段轨迹拼成一条（对齐华为运动健康的「合并运动记录」口径）：
 * - 只能合并同一种运动；
 * - 轨迹按开始时间先后拼接，段与段之间的空档不算运动时间；
 * - 距离 = 各段距离之和，运动时长 = 各段计时时间之和；
 * - 平均速度 = 总距离 / 运动时长，最高速度取各段最大；
 * - 爬升/下降/卡路里累加，平均心率按各段时长加权。
 */
export function mergeToParsed(activities: Activity[]): ParsedFit {
  if (activities.length < 2) throw new Error('至少需要两条轨迹才能合并');
  const parts = [...activities].sort((a, b) => a.startTime - b.startTime);
  const sportKey = parts[0].sportKey;
  if (parts.some((part) => part.sportKey !== sportKey)) throw new Error('只能合并同一种运动的记录');

  const useTime = parts.every((part) => part.timeAvailable
    && part.points.length > 1
    && part.points[part.points.length - 1].t > 0);

  const records: FitRecord[] = [];
  let synthetic = 0;
  let previousTime = 0;
  for (const part of parts) {
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

  const startTime = useTime ? records[0].timestamp : parts[0].startTime;
  const endTime = useTime ? records[records.length - 1].timestamp : undefined;
  const timerSec = parts.reduce((sum, part) => sum + Math.max(1, part.durationSec), 0);
  // 时间轴用首段开始到末段结束（含段间空档），运动时长仍按各段之和，
  // 这样 buildActivity 在按 session 窗口裁点时不会把后面的段裁掉。
  const spanSec = useTime && startTime != null && endTime != null
    ? Math.max(1, (endTime - startTime) / 1000)
    : timerSec;
  const totalDistance = parts.reduce((sum, part) => sum + part.distanceM, 0);

  const ascents = parts.map((part) => part.ascent).filter(isNumber);
  const descents = parts.map((part) => part.descent).filter(isNumber);
  const calories = parts.reduce((sum, part) => sum + (part.calories ?? 0), 0);
  const weightedHr = parts.reduce((acc, part) => {
    if (part.avgHeartRate == null) return acc;
    const weight = Math.max(1, part.durationSec);
    acc.total += part.avgHeartRate * weight;
    acc.weight += weight;
    return acc;
  }, { total: 0, weight: 0 });
  const maxHr = parts.map((part) => part.maxHeartRate).filter(isNumber);
  const maxSpeed = parts.map((part) => part.maxSpeed).filter(isNumber);

  return {
    sourceType: parts[0].sourceType,
    hasTimestamps: useTime,
    name: '合并轨迹',
    sportHint: parts[0].sport,
    records,
    sessions: [{
      startTime,
      elapsedTime: spanSec,
      timerTime: timerSec,
      distance: totalDistance,
      calories: calories > 0 ? calories : undefined,
      sport: parts[0].sport,
      subSport: parts[0].subSport,
      avgHeartRate: weightedHr.weight > 0 ? Math.round(weightedHr.total / weightedHr.weight) : undefined,
      maxHeartRate: maxHr.length ? Math.max(...maxHr) : undefined,
      maxSpeed: maxSpeed.length ? Math.max(...maxSpeed) : undefined,
      ascent: ascents.length ? Math.round(ascents.reduce((sum, value) => sum + value, 0)) : undefined,
      descent: descents.length ? Math.round(descents.reduce((sum, value) => sum + value, 0)) : undefined,
    }],
    laps: [],
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
