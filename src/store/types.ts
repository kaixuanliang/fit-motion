/**
 * 记录库的持久化模型。
 *
 * 列表页只读 `ActivityMeta`（几百字节一条），轨迹与原始文件放在另外两个
 * store 里，翻页时不会被大数组拖慢。轨迹用 TypedArray 存，一条 7 小时的
 * 骑行大约 1.5 MB，比存原始 JSON 小一个数量级。
 */

export type SourceKind = 'fit' | 'gpx' | 'tcx' | 'huawei' | 'merged';

export const SOURCE_LABEL: Record<SourceKind, string> = {
  fit: 'FIT',
  gpx: 'GPX',
  tcx: 'TCX',
  huawei: '华为',
  merged: '合并',
};

/** 会员数据的运动指纹：开始时间（ms）、时长（s）、距离（m）。 */
export interface MotionFp {
  start: number;
  duration: number;
  distance: number;
}

/** 云端备份状态：0 待备份、1 单端已备份、2 双端已备份。 */
export type BackupState = 0 | 1 | 2;

export interface ActivityMeta {
  id: string;
  /** 展示名，例如「晨骑」「下班通勤」 */
  name: string;
  src: SourceKind;
  /** 原始文件名，用于列表副标题与导出时的默认名 */
  fileName: string;
  /** 开始时间，epoch ms */
  start: number;
  /** 运动时长，秒 */
  duration: number;
  /** 总距离，米 */
  distance: number;
  /** 平均速度 m/s */
  avgSpeed: number;
  /** 最大速度 m/s */
  maxSpeed: number;
  /** FIT 运动类型 id（合并路线时校验「同一种运动」） */
  sport?: number;
  avgHr: number | null;
  maxHr: number | null;
  climb: number;
  maxAlt: number | null;
  calories: number | null;
  /** 轨迹点数量，列表用来判断数据质量 */
  points: number;
  /** 44×44 缩略图路径（SVG path d） */
  thumb: string;
  /** 原始文件 SHA-256，用于「同一个文件重复导入」判定 */
  fileHash: string;
  /** 运动指纹，用于跨来源（华为 JSON 与码表 FIT）重复判定 */
  fp: MotionFp;
  backup: BackupState;
  added: number;
  updated: number;
  /** 原始文件字节数 */
  size: number;
  /** 墓碑时间：> 0 表示已删除，同步时需要把删除标记推到云端 */
  deleted: number;
  /**
   * 本地载荷已回收的时间。记录彻底从回收站消失后，只留墓碑给云端对账用。
   * 墓碑不会出现在回收站里，也不该再被计数。
   */
  purged?: number;
  /**
   * 各端已备份到的时间戳（值是推送时的 meta.updated）。
   * 有它才能算「还差哪一端没推」，也能让两端各自增量同步。
   */
  where?: Partial<Record<'github' | 'gitee', number>>;
  /**
   * 各端「当前版本住在哪个仓库」，值是 `owner/repo` 键（多仓库轮换后同一端
   * 的轨迹可能先后落在不同库里）。删除和按需下载按它定位；缺省按 0 号库。
   */
  home?: Partial<Record<'github' | 'gitee', string>>;
  /** 最近一次打开时间，本地缓存 LRU 淘汰用 */
  opened?: number;
  /** 合并轨迹的父记录 */
  mergedFrom?: string[];
}

export interface StoredSession {
  startTime?: number;
  elapsedTime?: number;
  timerTime?: number;
  distance?: number;
  calories?: number;
  ascent?: number;
  descent?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  maxAltitude?: number;
  sport?: number;
}

/**
 * 一条轨迹的紧凑表示。所有数组等长，t 缺失时用 0 填充并由 hasTimestamps
 * 标记（部分 GPX 只有坐标没有时间）。
 */
export interface StoredTrack {
  id: string;
  lat: Float32Array;
  lon: Float32Array;
  t: Float64Array;
  alt: Float32Array | null;
  hr: Int16Array | null;
  speed: Float32Array | null;
  dist: Float32Array | null;
  hasTimestamps: boolean;
  sportHint: number;
  session: StoredSession;
}

export interface StoredFile {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  added: number;
}

export type QueueKind = 'upload' | 'delete';

/** 备份队列的持久化条目：App 被杀掉也不会丢「待备份」。 */
export interface QueueItem {
  id: string;
  activityId: string;
  kind: QueueKind;
  provider: 'github' | 'gitee';
  attempts: number;
  nextAt: number;
  message: string;
}

export interface ImportResult {
  status: 'added' | 'duplicate-file' | 'duplicate-motion' | 'no-gps' | 'too-short' | 'error';
  name: string;
  id?: string;
  /** 命中的既有记录，用于「重复跳过」提示 */
  existing?: string;
  message?: string;
}

export interface ListQuery {
  year?: number | 'all';
  src?: SourceKind | 'all';
  /** 上一页最后一条的 start，null 表示第一页 */
  before?: number | null;
  limit?: number;
}

export interface ListPage {
  items: ActivityMeta[];
  /** 下一页游标，null 表示到底 */
  next: number | null;
  /** 当前筛选条件下的总数 */
  total: number;
}

export interface LibraryStats {
  count: number;
  distanceM: number;
  durationSec: number;
  first: number;
  last: number;
}
