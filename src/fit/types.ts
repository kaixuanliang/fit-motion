export type FitValue = number | string | Array<number | string> | null;

export interface FitRecord {
  timestamp?: number;
  lat?: number;
  lon?: number;
  altitude?: number;
  speed?: number;
  distance?: number;
  heartRate?: number;
  cadence?: number;
  power?: number;
  temperature?: number;
}

export interface FitSession {
  timestamp?: number;
  startTime?: number;
  sport?: number;
  subSport?: number;
  elapsedTime?: number;
  timerTime?: number;
  distance?: number;
  calories?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgCadence?: number;
  maxCadence?: number;
  avgPower?: number;
  maxPower?: number;
  ascent?: number;
  descent?: number;
  avgAltitude?: number;
  maxAltitude?: number;
  trainingEffect?: number;
}

export interface FitLap {
  timestamp?: number;
  startTime?: number;
  elapsedTime?: number;
  timerTime?: number;
  distance?: number;
  calories?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgCadence?: number;
  maxCadence?: number;
  ascent?: number;
  descent?: number;
}

/**
 * 合并行程里的一次骑行。多日长途按天拆开，同一条路线骑了多次也各记一段。
 *
 * 重复路线的几何已经去重（只留第一次的轨迹点），这一段的数据仍然计入
 * 合计里程/时长，并由 TripInfo.best 汇总出「最快一次」的极值。
 */
export interface TripLeg {
  /** 第几段，从 1 开始 */
  index: number;
  /** 这段的开始时间，epoch ms */
  start: number;
  distanceM: number;
  movingSec: number;
  elapsedSec: number;
  ascent?: number;
  maxSpeed?: number;
  maxHeartRate?: number;
  maxAltitude?: number;
  /** 与前面某段是同一条路线（几何未重复绘制） */
  repeat: boolean;
  /** 重复的是第几段 */
  repeatOf?: number;
  /** 与上一段的衔接距离（米）；首段为 0，重复段不计 */
  linkM: number;
}

export interface TripInfo {
  legs: TripLeg[];
  /** 跨自然日（多日行程） */
  multiDay: boolean;
  /** 去重后实际绘制/播放的路线长度（米），与 Activity.distanceM 一致 */
  routeMeters: number;
  /** 真实骑行总里程（含重复路线），创作页「总距离」用它 */
  totalMeters: number;
  /** 真实总运动时长（秒，含重复路线） */
  totalMovingSec: number;
  /** 真实总耗时（秒，含停留与跨天间隔） */
  totalElapsedSec: number;
  /** 重复路线段数 */
  repeated: number;
  /** 多次骑行的聚合极值 */
  best: {
    maxSpeed?: number;
    maxHeartRate?: number;
    maxAltitude?: number;
    ascent?: number;
  };
  /** 合并时采用的衔接阈值（米） */
  linkLimitM: number;
}

export interface ParsedFit {
  sourceType: 'fit' | 'gpx' | 'tcx';
  hasTimestamps: boolean;
  sportHint?: number;
  name?: string;
  fileType?: string;
  manufacturer?: number;
  productName?: string;
  timeCreated?: number;
  records: FitRecord[];
  sessions: FitSession[];
  laps: FitLap[];
  /** 合并行程的分段信息（普通导入没有这个字段） */
  trip?: TripInfo;
}
