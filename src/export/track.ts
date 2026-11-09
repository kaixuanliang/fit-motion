import { buildActivity, type Activity } from '../fit/activity';
import type { FitRecord, ParsedFit } from '../fit/types';

export type TrackFormat = 'gpx' | 'tcx';

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

export function activityToGpx(activity: Activity): string {
  const points = activity.points.map((point) => {
    const ele = point.altitude != null ? `<ele>${point.altitude.toFixed(2)}</ele>` : '';
    const time = activity.timeAvailable && point.t > 0 ? `<time>${new Date(point.t).toISOString()}</time>` : '';
    return `        <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lon.toFixed(7)}">${ele}${time}</trkpt>`;
  }).join('\n');
  // 官方统计写进 extensions（与华为导出同构）：重新导入时解析器优先用
  // 这组值，时长/距离不会漂移，运动指纹也能对上（不会产生重复记录）。
  const climb = activity.ascent != null && activity.ascent > 0 ? `<cumulativeClimb>${Math.round(activity.ascent)}</cumulativeClimb>` : '';
  const drop = activity.descent != null && activity.descent > 0 ? `<cumulativeDecrease>${Math.round(activity.descent)}</cumulativeDecrease>` : '';
  const extensions = activity.durationSec > 0 || activity.distanceM > 0
    ? `\n      <extensions>${activity.durationSec > 0 ? `<totalTime>${Math.round(activity.durationSec)}</totalTime>` : ''}${activity.distanceM > 0 ? `<totalDistance>${Math.round(activity.distanceM)}</totalDistance>` : ''}${climb}${drop}</extensions>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FIT MOTION" xmlns="http://www.topografix.com/GPX/1/1">
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
    const hr = point.heartRate != null ? `<HeartRateBpm><Value>${Math.round(point.heartRate)}</Value></HeartRateBpm>` : '';
    const cadence = point.cadence != null ? `<Cadence>${Math.round(point.cadence)}</Cadence>` : '';
    const speed = point.speed != null ? `<Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Speed>${point.speed.toFixed(3)}</Speed></TPX></Extensions>` : '';
    return `        <Trackpoint><Time>${time}</Time><Position><LatitudeDegrees>${point.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${point.lon.toFixed(7)}</LongitudeDegrees></Position>${altitude}${distance}${hr}${cadence}${speed}</Trackpoint>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities><Activity Sport="${escapeXml(activity.sportName)}"><Id>${startIso}</Id>
      <Lap StartTime="${startIso}"><TotalTimeSeconds>${activity.durationSec}</TotalTimeSeconds><DistanceMeters>${activity.distanceM.toFixed(2)}</DistanceMeters><Calories>${activity.calories ?? 0}</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
        <Track>
${points}
        </Track>
      </Lap>
    </Activity></Activities>
</TrainingCenterDatabase>`;
}

export function downloadTrack(activity: Activity, format: TrackFormat): void {
  const content = format === 'gpx' ? activityToGpx(activity) : activityToTcx(activity);
  const blob = new Blob([content], { type: format === 'gpx' ? 'application/gpx+xml' : 'application/vnd.garmin.tcx+xml' });
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
