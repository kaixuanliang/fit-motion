import type { Activity, RoutePoint } from '../fit/activity';
import { formatDuration, formatSpeedKmh, interpolatePoint } from '../fit/activity';
import { clamp, easeInOutCubic, easeOutCubic, metersPerPixel } from '../geo';
import { TrackMap, type MapCamera, type MapRoutePoint } from './map';
import type { VectorFollowLayer, OverviewVectorLayer } from './vector-map';
import type { VideoTheme } from './theme';

export type StagePhase = 'intro' | 'running' | 'result';

export interface StageFrame {
  phase: StagePhase;
  progress: number;
  elapsed: number;
  distance: number;
  speed: number;
  heartRate?: number;
  resultVisible: boolean;
  resultReveal: number;
  paused: boolean;
  momentLabel?: string;
}

type IconKind = 'route' | 'clock' | 'speed' | 'speedometer' | 'heart' | 'mountain' | 'gauge' | 'flame';

interface Moment {
  kind: 'maxHr' | 'maxSpeed' | 'maxAltitude';
  label: string;
  value: string;
  unit: string;
  color: string;
  icon: IconKind;
  progress: number;
}

interface ScheduledMoment {
  moment: Moment;
  start: number;
  end: number;
}

interface TimelineState {
  progress: number;
  moment?: Moment;
  pauseT: number;
}

const WIDTH = 1080;
const HEIGHT = 1920;
const RUN_MIN = 6;
const RUN_MAX = 40;

/**
 * 走线段时长（秒）：预览与导出共用的唯一权威，时间线其余各段都从这里伸长。
 *
 * 每公里约 0.36 秒走线 + 7 秒起步，线性直给 —— 刻意不用开方曲线：骑行
 * 高频区间在 30~100km，恰好是 √ 曲线最平的一段，30km 和 100km 只差 8 秒，
 * 观感上「都差不多长」。线性让常见区间真正拉开（30km≈28s → 100km≈50s），
 * 超长距离靠上限封顶（RUN_MAX），不会失控。
 * 均速做修正：以 22km/h 为基准，快的压缩到 0.72x，慢的放宽到 1.35x ——
 * 同样的里程，骑得快画面利落，骑得慢沿途多看两眼。
 */
export function runDurationFor(distanceM: number, avgSpeed: number): number {
  const km = Math.max(0.2, distanceM / 1000);
  const paceFactor = avgSpeed > 0
    ? clamp(22 / (avgSpeed * 3.6), 0.72, 1.35)
    : 1;
  return clamp((7 + 0.36 * km) * paceFactor, RUN_MIN, RUN_MAX);
}
const PAUSE_SECONDS = 1.9;
const INTRO_SECONDS = 1.0;
// 片尾：拉回全景 + 成绩卡浮现约 1.1 秒，之后停在海报帧。留 2 秒静止尾巴即可，
// 再长就变成「视频卡住了」。
const OUTRO_SECONDS = 3.2;
const RESULT_REVEAL_DELAY = 0.25;
const RESULT_REVEAL_SECONDS = 0.85;
const RUN_ANCHOR_Y = 900;
const RESULT_ANCHOR_Y = 700;
const COVER_SECONDS = 1.1;

export class MotionStage {
  readonly canvas: HTMLCanvasElement;
  readonly map: TrackMap;
  readonly activity: Activity;
  readonly c: VideoTheme;
  readonly introDuration = INTRO_SECONDS;
  readonly runDuration: number;
  readonly outroDuration = OUTRO_SECONDS;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly fitScale: number;
  private readonly followScale: number;
  private readonly resultScale: number;
  private readonly fitCenter: MapRoutePoint;
  private readonly moments: Moment[];
  private readonly schedule: ScheduledMoment[];
  private readonly runEnd: number;
  private readonly totalDuration: number;
  private grainPattern?: CanvasPattern;
  private lastFrame: StageFrame;
  private follow: VectorFollowLayer | null = null;
  private overview: OverviewVectorLayer | null = null;
  private drawerBlurCanvas: HTMLCanvasElement | null = null;
  private drawerGlassCanvas: HTMLCanvasElement | null = null;
  /** 片尾静止段的整帧快照：末段每帧只需 blit，不再重画地图/轨迹/成绩卡。 */
  private posterCache: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement, activity: Activity, map: TrackMap, theme: VideoTheme, follow?: VectorFollowLayer) {
    this.canvas = canvas;
    this.activity = activity;
    this.map = map;
    this.c = theme;
    this.follow = follow ?? null;
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    this.runDuration = runDurationFor(activity.distanceM, activity.avgSpeed);
    const bounds = map.routeBounds;
    const routeW = Math.max(1, bounds.maxX - bounds.minX);
    const routeH = Math.max(1, bounds.maxY - bounds.minY);
    this.fitScale = Math.min(940 / routeW, 1050 / routeH, 9);
    const centerLat = (activity.bounds.minLat + activity.bounds.maxLat) / 2;
    const baseMpp = metersPerPixel(map.zoom, centerLat);
    // Target a 4.5 km first-person window when a high-resolution follow layer is
    // available. The landing-page preview keeps the wider overview camera.
    this.followScale = follow
      ? Math.min(34, Math.max(2.2, (1080 * baseMpp) / 4500))
      : Math.min(6, Math.max(1.2, this.fitScale * 2.7));
    this.resultScale = Math.min(980 / routeW, 560 / routeH, this.fitScale * 1.1);
    this.fitCenter = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };

    this.moments = this.buildMoments();
    this.schedule = this.buildSchedule();
    this.runEnd = this.schedule.length
      ? this.schedule[this.schedule.length - 1].end + (1 - this.schedule[this.schedule.length - 1].moment.progress) * this.runDuration
      : INTRO_SECONDS + this.runDuration;
    this.totalDuration = COVER_SECONDS + this.runEnd + this.outroDuration;
    this.createGrain();
    this.lastFrame = {
      phase: 'intro',
      progress: 0,
      elapsed: 0,
      distance: 0,
      speed: 0,
      heartRate: activity.points[0]?.heartRate,
      resultVisible: false,
      resultReveal: 0,
      paused: false,
    };
  }

  get duration(): number {
    return this.totalDuration;
  }

  /** 海报静止帧的起始时间：此后的画面完全不变，可以整帧复用。 */
  get posterStart(): number {
    return COVER_SECONDS + this.runEnd + RESULT_REVEAL_DELAY + RESULT_REVEAL_SECONDS;
  }

  /**
   * 导出端（Android 原生渲染）直接使用的时间线，与预览逐帧一致。
   *
   * 之前原生侧用自己的一套常量（封面 1.0s / 片尾 4.0s / 停留 1.4s）重新推导，
   * 与预览永远对不齐；现在把预览的权威分段原样交给导出端，两边共用一条时间线。
   */
  get timelinePlan(): {
    totalSeconds: number;
    coverEnd: number;
    introEnd: number;
    runEnd: number;
    outroStart: number;
    posterStart: number;
    segments: Array<{ start: number; end: number; p0: number; p1: number }>;
  } {
    const segments: Array<{ start: number; end: number; p0: number; p1: number }> = [
      { start: 0, end: COVER_SECONDS, p0: 0, p1: 0 },
    ];
    let cursor = this.introDuration;
    let previous = 0;
    for (const event of this.schedule) {
      const travel = (event.moment.progress - previous) * this.runDuration;
      segments.push({
        start: COVER_SECONDS + cursor,
        end: COVER_SECONDS + cursor + travel,
        p0: previous,
        p1: event.moment.progress,
      });
      segments.push({
        start: COVER_SECONDS + cursor + travel,
        end: COVER_SECONDS + event.end,
        p0: event.moment.progress,
        p1: event.moment.progress,
      });
      cursor = event.end;
      previous = event.moment.progress;
    }
    segments.push({
      start: COVER_SECONDS + cursor,
      end: COVER_SECONDS + this.runEnd,
      p0: previous,
      p1: 1,
    });
    segments.push({
      start: COVER_SECONDS + this.runEnd,
      end: this.totalDuration,
      p0: 1,
      p1: 1,
    });
    return {
      totalSeconds: this.totalDuration,
      coverEnd: COVER_SECONDS,
      introEnd: COVER_SECONDS + this.introDuration,
      runEnd: COVER_SECONDS + this.runEnd,
      outroStart: COVER_SECONDS + this.runEnd,
      posterStart: this.posterStart,
      segments,
    };
  }

  get previewTime(): number {
    return 0.3;
  }

  get frame(): StageFrame {
    return this.lastFrame;
  }

  setFollow(follow: VectorFollowLayer | null): void {
    this.follow = follow;
  }

  /** 第一视角相机的固定缩放（缓存完成后预热瓦片位图用）。 */
  get followCameraScale(): number {
    return this.followScale;
  }

  /** 封面/成绩卡相机的缩放（总览层位图预热用）。 */
  get resultCameraScale(): number {
    return this.resultScale;
  }

  /** 指定播放头时刻的相机（预览延展地图按同一视角向两侧延伸）。 */
  cameraAtTime(time: number): MapCamera {
    const t = clamp(time, 0, this.totalDuration);
    if (t < COVER_SECONDS) {
      const current = interpolatePoint(this.activity, 1);
      return this.cameraAt(1, 1, current.point);
    }
    const localTime = t - COVER_SECONDS;
    const timeline = this.timelineAt(localTime);
    const resultReveal = clamp((localTime - this.runEnd - 0.3) / 0.85, 0, 1);
    const current = interpolatePoint(this.activity, timeline.progress);
    return this.cameraAt(timeline.progress, resultReveal, current.point);
  }

  /**
   * 指定播放头时刻核心画面用的是总览相机还是第一视角相机（与 renderAt 的
   * 选层一致）：封面段和成绩卡揭示段画总览层，其余画第一视角层。延展地图
   * 必须与核心同层，否则两侧内容和中央对不上。
   */
  overviewPhaseAt(time: number): boolean {
    const t = clamp(time, 0, this.totalDuration);
    if (t < COVER_SECONDS) return true;
    return t - COVER_SECONDS > this.runEnd + 0.3;
  }

  setOverview(overview: OverviewVectorLayer | null): void {
    this.overview = overview;
  }

  renderAt(time: number): StageFrame {
    const t = clamp(time, 0, this.totalDuration);
    const ctx = this.ctx;

    // 片尾静止段：整帧复用缓存的像素。以前这里每帧都重画地图 + 轨迹 + 成绩卡
    // + 颗粒叠加，手机上末段会明显掉帧（看着像卡住）；缓存后是纯 blit。
    if (t >= this.posterStart && this.posterCache) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.posterCache, 0, 0);
      ctx.restore();
      this.lastFrame = {
        phase: 'result',
        progress: 1,
        elapsed: this.activity.durationSec,
        distance: this.activity.distanceM,
        speed: 0,
        heartRate: this.activity.maxHeartRate,
        resultVisible: true,
        resultReveal: 1,
        paused: false,
      };
      return this.lastFrame;
    }

    // The first encoded frame is also the cover: the final summary frame.
    if (t < COVER_SECONDS) {
      const current = interpolatePoint(this.activity, 1);
      const camera = this.cameraAt(1, 1, current.point);
      ctx.save();
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = this.c.stageBg;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      if (!this.overview?.draw(ctx, camera, WIDTH, HEIGHT)) this.map.draw(ctx, camera, WIDTH, HEIGHT);
      this.overview?.drawLabels(ctx, camera, WIDTH, HEIGHT);
      this.drawAtmosphere(ctx, 1);
      this.drawRoute(ctx, camera, 1, true);
      this.drawTopPlace(ctx, current, 1);
      this.drawTopRight(ctx, current.point, 1);
      this.drawSpeedEcg(ctx, current, 1, true);
      this.drawResult(ctx, 1);
      this.drawGrain(ctx);
      ctx.restore();
      this.lastFrame = {
        phase: 'result',
        progress: 1,
        elapsed: this.activity.durationSec,
        distance: this.activity.distanceM,
        speed: 0,
        heartRate: this.activity.maxHeartRate,
        resultVisible: true,
        resultReveal: 1,
        paused: false,
      };
      return this.lastFrame;
    }

    const localTime = t - COVER_SECONDS;
    const timeline = this.timelineAt(localTime);
    const resultReveal = clamp((localTime - this.runEnd - 0.3) / 0.85, 0, 1);
    const resultVisible = resultReveal > 0;
    const current = interpolatePoint(this.activity, timeline.progress);
    const camera = this.cameraAt(timeline.progress, resultReveal, current.point);

    ctx.save();
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = this.c.stageBg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (!resultVisible && this.follow) {
      const vectorDrawn = this.follow.draw(ctx, camera, WIDTH, HEIGHT);
      if (!vectorDrawn) this.map.draw(ctx, camera, WIDTH, HEIGHT);
      this.follow.ensureForProgress(timeline.progress);
    } else if (!this.overview?.draw(ctx, camera, WIDTH, HEIGHT)) {
      this.map.draw(ctx, camera, WIDTH, HEIGHT);
    }
    this.drawAtmosphere(ctx, resultReveal);
    this.drawRoute(ctx, camera, timeline.progress, resultVisible);
    this.drawMarkers(ctx, camera, timeline.progress, t, resultVisible);
    if (!resultVisible) this.follow?.drawLabels(ctx, camera, WIDTH, HEIGHT);
    if (resultVisible) this.overview?.drawLabels(ctx, camera, WIDTH, HEIGHT);

    if (resultVisible) {
      this.drawTopPlace(ctx, current, 1);
      this.drawTopRight(ctx, current.point, 1);
      this.drawSpeedEcg(ctx, current, 1, true);
      this.drawResult(ctx, resultReveal);
    } else {
      this.drawTopPlace(ctx, current, clamp(localTime / 0.55, 0, 1));
      this.drawTopRight(ctx, current.point, clamp(localTime / 0.55, 0, 1));
      if (localTime > this.introDuration * 0.72) {
        this.drawSpeedEcg(ctx, current, timeline.progress);
        this.drawLiveHud(ctx, timeline.progress, current);
        this.drawMomentDrawer(ctx, localTime, resultReveal);
      }
      if (timeline.moment) {
        this.drawEventBubble(ctx, camera, timeline.moment, timeline.pauseT);
      }
    }

    if (localTime < this.introDuration) {
      ctx.save();
      ctx.globalAlpha = 1 - easeOutCubic(clamp(localTime / this.introDuration, 0, 1));
      ctx.fillStyle = this.c.stageBg;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.restore();
    }

    this.drawGrain(ctx);
    ctx.restore();

    // 海报稳定后把整帧存下来，供尾段复用（颗粒噪点是随机的，不缓存会每帧重画）。
    if (resultVisible && resultReveal >= 1 && t >= this.posterStart && !this.posterCache) {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      canvas.getContext('2d')?.drawImage(this.ctx.canvas, 0, 0);
      this.posterCache = canvas;
    }

    this.lastFrame = {
      phase: resultVisible ? 'result' : localTime < this.introDuration ? 'intro' : 'running',
      progress: timeline.progress,
      elapsed: timeline.progress >= 1 ? this.activity.durationSec : current.elapsed,
      distance: timeline.progress * this.activity.distanceM,
      speed: timeline.progress >= 1 ? 0 : current.speed,
      heartRate: current.heartRate,
      resultVisible,
      resultReveal,
      paused: Boolean(timeline.moment),
      momentLabel: timeline.moment?.label,
    };
    return this.lastFrame;
  }

  private timelineAt(time: number): TimelineState {
    if (time <= this.introDuration) return { progress: 0, pauseT: 0 };
    let previousProgress = 0;
    let cursor = this.introDuration;
    for (const event of this.schedule) {
      const travel = (event.moment.progress - previousProgress) * this.runDuration;
      const arrive = cursor + travel;
      if (time < arrive) {
        return {
          progress: previousProgress + (time - cursor) / this.runDuration,
          pauseT: 0,
        };
      }
      if (time < event.end) {
        return {
          progress: event.moment.progress,
          moment: event.moment,
          pauseT: (time - arrive) / PAUSE_SECONDS,
        };
      }
      cursor = event.end;
      previousProgress = event.moment.progress;
    }
    const remaining = (1 - previousProgress) * this.runDuration;
    return {
      progress: clamp(previousProgress + (time - cursor) / Math.max(0.001, remaining) * (1 - previousProgress), 0, 1),
      pauseT: 0,
    };
  }

  private buildSchedule(): ScheduledMoment[] {
    const events: ScheduledMoment[] = [];
    let cursor = this.introDuration;
    let previousProgress = 0;
    for (const moment of this.moments) {
      const travel = (moment.progress - previousProgress) * this.runDuration;
      const start = cursor + travel;
      const end = start + PAUSE_SECONDS;
      events.push({ moment, start, end });
      cursor = end;
      previousProgress = moment.progress;
    }
    return events;
  }

  private buildMoments(): Moment[] {
    const moments: Moment[] = [];
    const add = (
      kind: Moment['kind'],
      condition: boolean,
      point: RoutePoint | undefined,
      label: string,
      value: string,
      unit: string,
      color: string,
      icon: IconKind,
    ): void => {
      if (!condition || !point) return;
      moments.push({
        kind,
        label,
        value,
        unit,
        color,
        icon,
        progress: clamp(point.distance / this.activity.distanceM, 0.025, 0.94),
      });
    };

    add(
      'maxAltitude', this.activity.altitudeAvailable, this.activity.maxAltitudePoint,
      '最高海拔', String(Math.round(this.activity.maxAltitude ?? 0)), '米', '#3fd0d8', 'mountain',
    );
    add(
      'maxHr', this.activity.heartRateAvailable, this.activity.maxHrPoint,
      '最高心率', String(Math.round(this.activity.maxHeartRate ?? 0)), '次/分钟', '#ff6b8a', 'heart',
    );
    add(
      'maxSpeed', this.activity.maxSpeedAvailable, this.activity.maxSpeedPoint,
      '最快速度', formatSpeedKmh(this.activity.maxSpeed), '公里/小时', '#ffb347', 'speedometer',
    );
    return moments.sort((a, b) => a.progress - b.progress);
  }

  private cameraAt(progress: number, resultReveal: number, current: RoutePoint): MapCamera {
    const currentPoint = this.mapPointAtDistance(progress * this.activity.distanceM);
    const aheadPoint = this.mapPointAtDistance(Math.min(1, progress + 0.006) * this.activity.distanceM);
    const runCenter = {
      x: currentPoint.x * 0.7 + aheadPoint.x * 0.3,
      y: currentPoint.y * 0.7 + aheadPoint.y * 0.3,
    };

    let centerX = runCenter.x;
    let centerY = runCenter.y;
    let scale = this.followScale;

    const runCameraY = centerY + (HEIGHT / 2 - RUN_ANCHOR_Y) / scale;
    const runCameraX = this.clampCamera(centerX, this.map.width, WIDTH / 2 / scale);
    const clampedRunY = this.clampCamera(runCameraY, this.map.height, HEIGHT / 2 / scale);

    if (resultReveal > 0) {
      const e = easeInOutCubic(resultReveal);
      const resultY = this.fitCenter.y + (HEIGHT / 2 - RESULT_ANCHOR_Y) / this.resultScale;
      return {
        x: runCameraX + (this.fitCenter.x - runCameraX) * e,
        y: clampedRunY + (resultY - clampedRunY) * e,
        scale: scale + (this.resultScale - scale) * e,
      };
    }

    return { x: runCameraX, y: clampedRunY, scale };
  }

  private clampCamera(value: number, size: number, half: number): number {
    if (half * 2 >= size) return size / 2;
    return clamp(value, half, size - half);
  }

  private drawAtmosphere(ctx: CanvasRenderingContext2D, resultReveal: number): void {
    const top = ctx.createLinearGradient(0, 0, 0, 300);
    top.addColorStop(0, hexAlpha(this.c.stageBg, 0.92));
    top.addColorStop(1, hexAlpha(this.c.stageBg, 0));
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, WIDTH, 300);

    const bottom = ctx.createLinearGradient(0, 1500, 0, HEIGHT);
    bottom.addColorStop(0, hexAlpha(this.c.stageBg, 0));
    bottom.addColorStop(0.52, hexAlpha(this.c.stageBg, 0.48));
    bottom.addColorStop(1, hexAlpha(this.c.stageBg, 0.8));
    ctx.fillStyle = bottom;
    ctx.fillRect(0, 1450, WIDTH, HEIGHT - 1450);

    if (resultReveal > 0) {
      const scrim = ctx.createLinearGradient(0, 720, 0, HEIGHT);
      scrim.addColorStop(0, hexAlpha(this.c.stageBg, 0));
      scrim.addColorStop(0.28, hexAlpha(this.c.stageBg, 0.72));
      scrim.addColorStop(1, hexAlpha(this.c.stageBg, 0.9));
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 720, WIDTH, HEIGHT - 720);
    }
  }

  private drawTopPlace(
    ctx: CanvasRenderingContext2D,
    current: ReturnType<typeof interpolatePoint>,
    alpha: number,
  ): void {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'left';

    const start = this.activity.timeAvailable ? `开始 ${formatDate(this.activity.startTime, true)}` : '';
    const elapsed = this.activity.durationAvailable
      ? `用时 ${formatDuration(current.elapsed, this.activity.durationSec >= 3600)}`
      : '';
    this.setFont(ctx, 34, 600, 'zh');
    const placeWidth = ctx.measureText(this.activity.place).width;
    this.setFont(ctx, 22, 500, 'zh');
    const startWidth = start ? ctx.measureText(start).width : 0;
    const elapsedWidth = elapsed ? ctx.measureText(elapsed).width : 0;
    const x = 54;
    const y = 52;
    const h = 64;
    const w = 24 + 16 + 12 + placeWidth
      + (start ? 20 + startWidth : 0)
      + (elapsed ? 20 + elapsedWidth : 0)
      + 24;

    ctx.shadowColor = this.c.shadow;
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 8;
    roundRect(ctx, x, y, w, h, 20);
    ctx.fillStyle = this.c.glass;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = this.c.border;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.strokeStyle = this.c.accent;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(x + 26, y + 27, 5.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 26, y + 33);
    ctx.lineTo(x + 26, y + 46);
    ctx.stroke();

    this.setFont(ctx, 34, 600, 'zh');
    ctx.fillStyle = this.c.text;
    ctx.fillText(this.activity.place, x + 44, y + 42);

    let cursor = x + 44 + placeWidth;
    const drawSegment = (text: string, font: number) => {
      const dividerX = cursor + 10;
      ctx.strokeStyle = hexAlpha(this.c.text, 0.18);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dividerX, y + 18);
      ctx.lineTo(dividerX, y + 46);
      ctx.stroke();
      this.setFont(ctx, font, 500, 'zh');
      ctx.fillStyle = this.c.muted;
      ctx.fillText(text, dividerX + 10, y + 41);
      cursor = dividerX + 10 + ctx.measureText(text).width;
    };
    if (start) drawSegment(start, 22);
    if (elapsed) drawSegment(elapsed, 22);
    ctx.restore();
  }

  private drawTopRight(ctx: CanvasRenderingContext2D, point: RoutePoint, alpha: number): void {
    if (alpha <= 0.01) return;
    const lat = `${Math.abs(point.lat).toFixed(5)}°${point.lat >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(point.lon).toFixed(5)}°${point.lon >= 0 ? 'E' : 'W'}`;
    const text = `${lat}  ${lon}`;
    this.setFont(ctx, 22, 500, 'latin');
    const textWidth = ctx.measureText(text).width;
    const w = textWidth + 48;
    const h = 58;
    const x = WIDTH - 54 - w;
    const y = 55;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'left';
    ctx.shadowColor = this.c.shadow;
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 7;
    roundRect(ctx, x, y, w, h, 18);
    ctx.fillStyle = this.c.glass;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = this.c.border;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = this.c.text;
    ctx.fillText(text, x + 24, y + 36);
    ctx.restore();
  }

  private drawSpeedEcg(
    ctx: CanvasRenderingContext2D,
    current: ReturnType<typeof interpolatePoint>,
    progress: number,
    full = false,
  ): void {
    if (!this.activity.maxSpeedAvailable) return;
    const x = 54;
    const y = 132;
    const w = WIDTH - 108;
    const h = 168;
    const lineColor = this.c.ecg;

    // Transparent theme gradient behind the graph; deliberately no map blur.
    ctx.save();
    roundRect(ctx, x, y, w, h, 16);
    const panel = ctx.createLinearGradient(0, y, 0, y + h);
    if (this.c.id === 'night') {
      panel.addColorStop(0, 'rgba(3, 14, 26, 0.58)');
      panel.addColorStop(1, 'rgba(3, 14, 26, 0.08)');
    } else if (this.c.id === 'tech') {
      panel.addColorStop(0, 'rgba(2, 22, 28, 0.58)');
      panel.addColorStop(1, 'rgba(2, 22, 28, 0.08)');
    } else {
      panel.addColorStop(0, 'rgba(248, 250, 244, 0.58)');
      panel.addColorStop(1, 'rgba(248, 250, 244, 0.08)');
    }
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.strokeStyle = hexAlpha(this.c.text, 0.12);
    ctx.lineWidth = 1;
    ctx.stroke();

    this.setFont(ctx, 15, 500, 'zh');
    ctx.fillStyle = this.c.muted;
    ctx.fillText('速度', x + 18, y + 26);
    this.setFont(ctx, 23, 600, 'latin');
    ctx.fillStyle = this.c.text;
    const speedText = full ? formatSpeedKmh(this.activity.maxSpeed) : formatSpeedKmh(progress >= 1 ? 0 : current.speed);
    const labelWidth = full ? 92 : 52;
    const speedLabelWidth = ctx.measureText(speedText).width;
    ctx.fillText(speedText, x + labelWidth, y + 27);
    this.setFont(ctx, 12, 600, 'latin');
    ctx.fillStyle = this.c.muted;
    ctx.fillText('公里/小时', x + labelWidth + 8 + speedLabelWidth, y + 26);

    const left = x + 18;
    const right = x + w - 18;
    const top = y + 34;
    const bottom = y + h - 30;
    const center = (top + bottom) / 2;
    const graphW = right - left;
    const graphH = bottom - top;
    ctx.strokeStyle = hexAlpha(this.c.text, 0.1);
    ctx.lineWidth = 1;
    for (let gx = left; gx <= right; gx += 42) {
      ctx.beginPath();
      ctx.moveTo(gx, top);
      ctx.lineTo(gx, bottom);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(left, center);
    ctx.lineTo(right, center);
    ctx.stroke();

    const endIndex = this.activity.points.length - 1;
    const startIndex = 1;
    const maxSpeed = Math.max(0.1, this.activity.maxSpeed);
    let localMin = maxSpeed;
    let localMax = 0;
    for (let i = startIndex; i <= endIndex; i += 1) {
      const speed = this.activity.points[i]?.speed ?? 0;
      localMin = Math.min(localMin, speed);
      localMax = Math.max(localMax, speed);
    }
    const variation = clamp((localMax - localMin) / maxSpeed, 0, 1);
    const amplitude = 0.85 + variation * 1.9;
    const step = Math.max(1, Math.floor((endIndex - startIndex) / 320));

    const samples: Array<{ x: number; y: number }> = [];
    for (let i = startIndex; i <= endIndex; i += step) {
      const point = this.activity.points[i];
      if (!point) continue;
      const speed = point.speed ?? 0;
      const previous = this.activity.points[Math.max(1, i - step)]?.speed ?? speed;
      const delta = (speed - previous) / maxSpeed;
      const norm = clamp(speed / maxSpeed, 0, 1.2);
      const phase = (i % 16) / 16;
      let beat = 0;
      if (phase < 0.08) beat = Math.sin((phase / 0.08) * Math.PI) * 0.18;
      else if (phase < 0.16) beat = -Math.sin(((phase - 0.08) / 0.08) * Math.PI) * 0.16;
      else if (phase < 0.23) beat = Math.sin(((phase - 0.16) / 0.07) * Math.PI) * 1.0;
      else if (phase < 0.31) beat = -Math.sin(((phase - 0.23) / 0.08) * Math.PI) * 0.32;
      else if (phase < 0.5) beat = Math.sin(((phase - 0.31) / 0.19) * Math.PI) * 0.2;
      const px = left + ((i - startIndex) / Math.max(1, endIndex - startIndex)) * graphW;
      const deltaSpike = clamp(delta * 2.6, -0.8, 0.8);
      const py = clamp(
        center
          - (norm - 0.45) * graphH * 1.02
          - beat * graphH * (0.17 + amplitude * 0.52)
          - deltaSpike * graphH * 0.46,
        top + 2,
        bottom - 2,
      );
      samples.push({ x: px, y: py });
    }
    if (samples.length < 2) {
      ctx.restore();
      return;
    }

    // Draw the whole curve immediately, with the travelled section highlighted.
    const fullPath = new Path2D();
    fullPath.moveTo(samples[0].x, samples[0].y);
    for (let i = 1; i < samples.length; i += 1) fullPath.lineTo(samples[i].x, samples[i].y);
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke(fullPath);
    ctx.restore();

    const travelled = clamp(progress, 0, 1) * (samples.length - 1);
    const last = Math.max(0, Math.min(samples.length - 2, Math.floor(travelled)));
    const frac = clamp(travelled - last, 0, 1);
    const dot = {
      x: samples[last].x + (samples[last + 1].x - samples[last].x) * frac,
      y: samples[last].y + (samples[last + 1].y - samples[last].y) * frac,
    };

    const area = new Path2D();
    area.moveTo(samples[0].x, bottom);
    area.lineTo(samples[0].x, samples[0].y);
    for (let i = 1; i <= last; i += 1) area.lineTo(samples[i].x, samples[i].y);
    area.lineTo(dot.x, dot.y);
    area.lineTo(dot.x, bottom);
    area.closePath();
    const fill = ctx.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, hexAlpha(lineColor, 0.38));
    fill.addColorStop(0.6, hexAlpha(lineColor, 0.12));
    fill.addColorStop(1, hexAlpha(lineColor, 0));
    ctx.fillStyle = fill;
    ctx.fill(area);

    const activePath = new Path2D();
    activePath.moveTo(samples[0].x, samples[0].y);
    for (let i = 1; i <= last; i += 1) activePath.lineTo(samples[i].x, samples[i].y);
    activePath.lineTo(dot.x, dot.y);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.7;
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = 10;
    ctx.stroke(activePath);
    ctx.shadowBlur = 0;

    const glow = ctx.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, 46);
    glow.addColorStop(0, hexAlpha(lineColor, 0.24));
    glow.addColorStop(1, hexAlpha(lineColor, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 46, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    this.setFont(ctx, 12, 500, 'zh');
    ctx.fillStyle = this.c.muted;
    ctx.fillText('速度曲线', x + 18, y + h - 9);
    ctx.restore();
  }

  private drawLiveHud(ctx: CanvasRenderingContext2D, progress: number, current: ReturnType<typeof interpolatePoint>): void {
    const items: Array<{ icon: IconKind; label: string; value: string; unit: string }> = [
      {
        icon: 'route',
        label: '距离',
        value: ((progress * this.activity.distanceM) / 1000).toFixed(2),
        unit: '公里',
      },
    ];
    if (this.activity.durationAvailable) {
      items.push({
        icon: 'clock',
        label: '时间',
        value: formatDuration(current.elapsed, this.activity.durationSec >= 3600),
        unit: '',
      });
    }
    if (this.activity.heartRateAvailable && current.heartRate != null) {
      items.push({ icon: 'heart', label: '心率', value: String(Math.round(current.heartRate)), unit: '次/分钟' });
    }
    if (this.activity.maxSpeedAvailable) {
      items.push({
        icon: 'speed',
        label: '速度',
        value: formatSpeedKmh(progress >= 1 ? 0 : current.speed),
        unit: '公里/小时',
      });
    }

    const x = 54;
    const y = 1644;
    const w = 972;
    const h = 190;
    ctx.save();
    ctx.shadowColor = this.c.shadow;
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 8;
    roundRect(ctx, x, y, w, h, 27);
    ctx.fillStyle = this.c.glass;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = this.c.border;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    const sheen = ctx.createLinearGradient(x, y, x, y + h);
    sheen.addColorStop(0, hexAlpha(this.c.text, 0.15));
    sheen.addColorStop(1, hexAlpha(this.c.text, 0.01));
    ctx.fillStyle = sheen;
    ctx.fill();

    const column = w / items.length;
    const iconColors = [this.c.accent, this.c.blue, this.c.red, this.c.orange];
    const unitSize = 14;
    // One shared size for every column: the widest cell ("163.38 公里") used to
    // spill its unit into the neighbouring column at 45 px.
    let valueSize = 45;
    for (const item of items) {
      if (!item.unit) continue;
      this.setFont(ctx, unitSize, 600, 'latin');
      const unitWidth = ctx.measureText(item.unit).width;
      while (valueSize > 26) {
        this.setFont(ctx, valueSize, 600, 'latin');
        if (ctx.measureText(item.value).width + 8 + unitWidth <= column - 70) break;
        valueSize -= 1;
      }
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const cx = x + column * i;
      if (i > 0) {
        ctx.strokeStyle = hexAlpha(this.c.text, 0.12);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, y + 35);
        ctx.lineTo(cx, y + h - 35);
        ctx.stroke();
      }
      this.drawMetricIcon(ctx, item.icon, cx + 34, y + 70, 16, iconColors[i % iconColors.length]);
      this.setFont(ctx, 18, 500, 'zh');
      ctx.fillStyle = this.c.muted;
      ctx.fillText(item.label, cx + 66, y + 53);
      this.setFont(ctx, valueSize, 600, 'latin');
      ctx.fillStyle = this.c.text;
      ctx.fillText(item.value, cx + 58, y + 122);
      const valueWidth = ctx.measureText(item.value).width;
      if (item.unit) {
        this.setFont(ctx, unitSize, 600, 'latin');
        ctx.fillStyle = this.c.muted;
        ctx.fillText(item.unit, cx + 58 + valueWidth + 8, y + 119);
      }
    }
    ctx.restore();
  }

  private drawEventBubble(
    ctx: CanvasRenderingContext2D,
    camera: MapCamera,
    moment: Moment,
    pauseT: number,
  ): void {
    const reveal = Math.min(1, pauseT / 0.14, (1 - pauseT) / 0.18);
    if (reveal <= 0) return;
    const e = easeOutCubic(reveal);
    const point = this.mapPointAtDistance(moment.progress * this.activity.distanceM);
    const screen = this.map.screenPoint(point, camera, WIDTH, HEIGHT);
    const cy = screen.y - 78;
    const radius = 44;
    const pulse = (pauseT * 2.2) % 1;

    ctx.save();
    ctx.globalAlpha = e;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 20 + pulse * 34, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(moment.color, 0.45 * (1 - pulse));
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.shadowColor = this.c.shadow;
    ctx.shadowBlur = 28;
    ctx.beginPath();
    ctx.arc(screen.x, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = this.c.glassStrong;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = hexAlpha(moment.color, 0.8);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(screen.x - 10, cy + radius - 3);
    ctx.lineTo(screen.x, screen.y - 8);
    ctx.lineTo(screen.x + 10, cy + radius - 3);
    ctx.closePath();
    ctx.fillStyle = this.c.glassStrong;
    ctx.fill();
    ctx.strokeStyle = hexAlpha(moment.color, 0.65);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(screen.x, cy, radius - 12, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(moment.color, 0.14);
    ctx.fill();
    this.drawMetricIcon(ctx, moment.icon, screen.x, cy, 34, moment.color);
    ctx.restore();
  }

  private drawMomentDrawer(ctx: CanvasRenderingContext2D, localTime: number, resultReveal: number): void {
    const items = this.schedule
      .filter((event) => localTime >= event.start)
      .map((event) => ({ moment: event.moment, age: localTime - event.start }));
    if (items.length === 0 || resultReveal >= 0.98) return;

    const right = WIDTH - 12;
    const bottomY = 1580;
    const itemH = 96;
    const itemGap = 14;
    const topW = 178;
    const bottomW = 246;
    const visible = items
      .map((item, index) => ({ ...item, index, reveal: clamp(item.age / 0.32, 0, 1) * (1 - resultReveal) }))
      .filter((item) => item.reveal > 0.01);
    if (!visible.length) return;

    // The drawer is painted into the video canvas, so a CSS backdrop-filter is
    // not available. Snapshot a small copy of the scene, blur it, and draw it
    // clipped to the trapezoid; this gives a real frosted-glass backdrop while
    // staying cheap enough for 1080p export.
    if (!this.drawerBlurCanvas) {
      this.drawerBlurCanvas = document.createElement('canvas');
      this.drawerBlurCanvas.width = 270;
      this.drawerBlurCanvas.height = 480;
    }
    if (!this.drawerGlassCanvas) {
      this.drawerGlassCanvas = document.createElement('canvas');
      this.drawerGlassCanvas.width = 270;
      this.drawerGlassCanvas.height = 480;
    }
    const blurCtx = this.drawerBlurCanvas.getContext('2d');
    const glassCtx = this.drawerGlassCanvas.getContext('2d');
    if (blurCtx) {
      blurCtx.clearRect(0, 0, this.drawerBlurCanvas.width, this.drawerBlurCanvas.height);
      blurCtx.imageSmoothingEnabled = true;
      blurCtx.imageSmoothingQuality = 'high';
      blurCtx.drawImage(ctx.canvas, 0, 0, WIDTH, HEIGHT, 0, 0, this.drawerBlurCanvas.width, this.drawerBlurCanvas.height);
    }
    if (glassCtx) {
      // Blur inside the 270x480 buffer (1.3px reads as 5px at 1080 wide) instead
      // of on the full-size canvas. ctx.filter runs a software gaussian over the
      // painted region, so blurring 129k pixels beats blurring 2.07M.
      glassCtx.clearRect(0, 0, this.drawerGlassCanvas.width, this.drawerGlassCanvas.height);
      glassCtx.filter = 'blur(1.3px)';
      glassCtx.drawImage(this.drawerBlurCanvas, 0, 0);
      glassCtx.filter = 'none';
    }

    visible.forEach(({ moment, index, reveal }) => {
      const bottom = bottomY - index * (itemH + itemGap);
      const top = bottom - itemH;
      const slide = (1 - reveal) * 26;
      const r = right + slide;
      const lTop = r - topW;
      const lBottom = r - bottomW;
      const cy = (top + bottom) / 2;
      const radius = 22;
      const leftDx = lTop - lBottom;
      const leftDy = top - bottom;
      const leftLen = Math.max(1, Math.hypot(leftDx, leftDy));
      const ux = leftDx / leftLen;
      const uy = leftDy / leftLen;

      const trace = (): void => {
        ctx.beginPath();
        ctx.moveTo(lTop + radius, top);
        ctx.lineTo(r, top);
        ctx.lineTo(r, bottom);
        ctx.lineTo(lBottom + radius, bottom);
        ctx.quadraticCurveTo(lBottom, bottom, lBottom + ux * radius, bottom + uy * radius);
        ctx.lineTo(lTop - ux * radius, top - uy * radius);
        ctx.quadraticCurveTo(lTop, top, lTop + radius, top);
        ctx.closePath();
      };

      ctx.save();
      ctx.globalAlpha = reveal;
      trace();
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = reveal;
      if (this.drawerGlassCanvas) ctx.drawImage(this.drawerGlassCanvas, 0, 0, WIDTH, HEIGHT);
      const glass = ctx.createLinearGradient(0, top, 0, bottom);
      glass.addColorStop(0, this.c.glassStrong);
      glass.addColorStop(1, this.c.glass);
      ctx.fillStyle = glass;
      ctx.fill();
      ctx.restore();

      trace();
      ctx.shadowColor = this.c.shadow;
      ctx.shadowBlur = 20;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = this.c.glass;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.strokeStyle = this.c.border;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.strokeStyle = hexAlpha(moment.color, 0.48);
      ctx.lineWidth = 1;
      ctx.stroke();

      // The slanted left edge eats into the icon if it is measured from the
      // bottom corner, so place it from the edge at mid-height plus a gap.
      const midX = lBottom + (lTop - lBottom) / 2;
      const iconX = midX + 42;
      ctx.beginPath();
      ctx.arc(iconX, cy, 17, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(moment.color, 0.3);
      ctx.fill();
      ctx.strokeStyle = hexAlpha(moment.color, 0.72);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      this.drawMetricIcon(ctx, moment.icon, iconX, cy, 20, moment.color);
      // Value and unit are stacked: on this trapezoid "35.0 公里/小时" is wider
      // than the space right of the icon, and the old one-line layout pushed
      // the number straight through the icon plate.
      const contentRight = r - 20;
      const iconRight = iconX + 17 + 10;
      const available = Math.max(64, contentRight - iconRight);
      let valueSize = 32;
      this.setFont(ctx, valueSize, 600, 'latin');
      let valueWidth = ctx.measureText(moment.value).width;
      while (valueSize > 18 && valueWidth > available) {
        valueSize -= 2;
        this.setFont(ctx, valueSize, 600, 'latin');
        valueWidth = ctx.measureText(moment.value).width;
      }
      const valueX = Math.max(iconRight, contentRight - valueWidth);
      ctx.fillStyle = this.c.text;
      ctx.fillText(moment.value, valueX, cy - 2);
      if (moment.unit) {
        let unitSize = 12;
        this.setFont(ctx, unitSize, 600, 'zh');
        let unitWidth = ctx.measureText(moment.unit).width;
        while (unitSize > 9 && unitWidth > available) {
          unitSize -= 1;
          this.setFont(ctx, unitSize, 600, 'zh');
          unitWidth = ctx.measureText(moment.unit).width;
        }
        ctx.fillStyle = this.c.muted;
        ctx.fillText(moment.unit, Math.max(iconRight, contentRight - unitWidth), cy + 20);
      }
      ctx.restore();
    });
  }

  private drawRoute(ctx: CanvasRenderingContext2D, camera: MapCamera, progress: number, result: boolean): void {
    // 封面/成绩卡要画整条轨迹：30k+ GPS 点每帧投影 + 4 次全路径描边在手机上
    // 是秒级开销（开头冻结、结尾成绩卡段时间冻住的主源）。按固定步长抽稀到
    // ~1500 点并缓存，13px 描边宽度下视觉无差。巡航段本来只画 720 点局部。
    const route = result ? this.overviewRoute() : this.map.route;
    if (route.length < 2) return;
    const target = clamp(progress, 0, 1) * this.activity.distanceM;
    let index = findIndex(this.activity.points, target);
    index = Math.min(index, route.length - 1);

    // During the follow shot only a local trail is visible. Mapping all 30k+
    // GPS points every frame was the main cause of the low capture frame rate.
    const trailPoints = 720;
    const start = result ? 0 : Math.max(0, index - trailPoints);
    const end = result
      ? route.length - 1
      : Math.min(route.length - 1, index + Math.max(40, Math.floor(route.length * 0.012)));
    const screen = route.slice(start, end + 1).map((point) => this.map.screenPoint(point, camera, WIDTH, HEIGHT));
    const localIndex = index - start;

    if (localIndex < 1 && progress <= 0.001) {
      this.drawStartDot(ctx, screen[0]);
      return;
    }

    const glowPath = new Path2D();
    glowPath.moveTo(screen[0].x, screen[0].y);
    for (let i = 1; i <= localIndex; i += 1) {
      glowPath.lineTo(screen[i].x, screen[i].y);
    }

    // Small look-ahead helps the first-person view without revealing the whole route.
    if (!result && localIndex < screen.length - 1) {
      const lookAhead = Math.min(screen.length - 1, localIndex + Math.max(4, Math.floor(screen.length * 0.2)));
      ctx.save();
      ctx.setLineDash([3, 10]);
      ctx.strokeStyle = 'rgba(19, 47, 41, 0.32)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(screen[localIndex].x, screen[localIndex].y);
      for (let i = localIndex + 1; i <= lookAhead; i += 1) ctx.lineTo(screen[i].x, screen[i].y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Layered strokes stand in for shadowBlur: a 14px gaussian over the whole
    // route path costs far more than two extra strokes and reads the same.
    ctx.strokeStyle = 'rgba(24, 64, 55, 0.10)';
    ctx.lineWidth = 21;
    ctx.stroke(glowPath);
    ctx.strokeStyle = 'rgba(24, 64, 55, 0.12)';
    ctx.lineWidth = 17;
    ctx.stroke(glowPath);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.lineWidth = 13;
    ctx.stroke(glowPath);
    const startPoint = screen[0];
    const endPoint = screen[localIndex];
    const routeGradient = ctx.createLinearGradient(startPoint.x, startPoint.y, endPoint.x, endPoint.y);
    routeGradient.addColorStop(0, this.c.route[0]);
    routeGradient.addColorStop(0.38, this.c.route[1]);
    routeGradient.addColorStop(0.72, this.c.route[2]);
    routeGradient.addColorStop(1, this.c.route[3]);
    ctx.strokeStyle = routeGradient;
    ctx.lineWidth = 7;
    ctx.stroke(glowPath);
    ctx.restore();

    if (result || start === 0) this.drawStartDot(ctx, screen[0]);
    if (result) this.drawFinishDot(ctx, screen[screen.length - 1]);
    this.drawKilometres(ctx, camera, progress);
  }


  /** 封面/成绩卡用的整条轨迹（抽稀缓存，构建一次终身复用）。 */
  private overviewRouteCache: MapRoutePoint[] | null = null;

  private overviewRoute(): MapRoutePoint[] {
    const route = this.map.route;
    if (!this.overviewRouteCache) {
      const stride = Math.max(1, Math.ceil(route.length / 1500));
      const out: MapRoutePoint[] = [];
      for (let i = 0; i < route.length; i += stride) out.push(route[i]);
      const last = route[route.length - 1];
      if (out[out.length - 1] !== last) out.push(last);
      this.overviewRouteCache = out;
    }
    return this.overviewRouteCache;
  }

  private drawMarkers(
    ctx: CanvasRenderingContext2D,
    camera: MapCamera,
    progress: number,
    time: number,
    result: boolean,
  ): void {
    if (result) return;
    const current = this.mapPointAtDistance(progress * this.activity.distanceM);
    const screen = this.map.screenPoint(current, camera, WIDTH, HEIGHT);
    if (screen.x < -80 || screen.x > WIDTH + 80 || screen.y < -80 || screen.y > HEIGHT + 80) return;
    const ahead = this.mapPointAtDistance(Math.min(1, progress + 0.004) * this.activity.distanceM);
    const aheadScreen = this.map.screenPoint(ahead, camera, WIDTH, HEIGHT);
    const angle = Math.atan2(aheadScreen.y - screen.y, aheadScreen.x - screen.x);
    const pulse = 0.86 + Math.sin(time * 3.2) * 0.14;

    ctx.save();
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 24, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(this.c.glassStrong, 0.92);
    ctx.fill();
    ctx.strokeStyle = hexAlpha(this.c.accent, 0.9);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 15 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(this.c.accent, 0.34);
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 5.2, 0, Math.PI * 2);
    ctx.fillStyle = this.c.accent;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(25, 0);
    ctx.lineTo(17, -5.5);
    ctx.lineTo(17, 5.5);
    ctx.closePath();
    ctx.fillStyle = this.c.accent;
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  private drawStartDot(ctx: CanvasRenderingContext2D, point: MapRoutePoint): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = this.c.accent2;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  private drawFinishDot(ctx: CanvasRenderingContext2D, point: MapRoutePoint): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = this.c.route[3];
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  private drawKilometres(ctx: CanvasRenderingContext2D, camera: MapCamera, progress: number): void {
    if (progress < 0.02) return;
    const totalKm = Math.floor(this.activity.distanceM / 1000);
    // Same ladder as the native renderer: the label interval grows with the
    // distance so a 200 km ride does not turn into a wall of numbers.
    const every = totalKm <= 10 ? 1 : totalKm <= 30 ? 5 : totalKm <= 80 ? 10 : totalKm <= 150 ? 20 : 25;
    ctx.save();
    this.setFont(ctx, 20, 600, 'latin');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let km = every; km <= totalKm; km += every) {
      if ((km * 1000) / this.activity.distanceM > progress) break;
      const p = this.mapPointAtDistance(km * 1000);
      const screen = this.map.screenPoint(p, camera, WIDTH, HEIGHT);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(this.c.text, 0.42);
      ctx.fill();
      ctx.fillStyle = hexAlpha(this.c.text, 0.6);
      ctx.fillText(String(km), screen.x, screen.y - 16);
    }
    ctx.restore();
  }

  private drawResult(ctx: CanvasRenderingContext2D, reveal: number): void {
    const e = easeOutCubic(reveal);
    const metrics = [
      this.resultMetric('route', '总距离', true, (this.activity.distanceM / 1000).toFixed(2), '公里', this.c.accent),
      this.resultMetric('clock', '运动时长', this.activity.durationAvailable, this.activity.durationAvailable ? formatDuration(this.activity.durationSec) : '', '时:分:秒', this.c.blue),
      this.resultMetric('speedometer', '最快速度', this.activity.maxSpeedAvailable, formatSpeedKmh(this.activity.maxSpeed), '公里/小时', this.c.orange),
      this.resultMetric('heart', '最高心率', this.activity.heartRateAvailable, this.activity.maxHeartRate ? String(Math.round(this.activity.maxHeartRate)) : '', '次/分钟', this.c.red),
      this.resultMetric('mountain', '最高海拔', this.activity.altitudeAvailable, this.activity.maxAltitude != null ? String(Math.round(this.activity.maxAltitude)) : '', '米', this.c.accent2),
      this.resultMetric('gauge', '平均速度', this.activity.avgSpeedAvailable, formatSpeedKmh(this.activity.avgSpeed), '公里/小时', this.c.blue),
      this.resultMetric('flame', '消耗热量', this.activity.calories != null, this.activity.calories != null ? String(Math.round(this.activity.calories)) : '', '千卡', this.c.orange),
    ].filter((item): item is ResultMetric => item != null);

    const panelX = 54;
    const panelW = 972;
    const innerW = panelW - 76;
    const gap = 14;
    const cardW = (innerW - gap) / 2;
    const cardH = 128;
    const rowGap = 14;
    const rows = Math.max(1, Math.ceil(metrics.length / 2));
    const panelH = 132 + rows * cardH + (rows - 1) * rowGap + 34;
    const panelY = Math.max(1040, 1782 - panelH) + (1 - e) * 40;

    ctx.save();
    ctx.globalAlpha = e;
    ctx.shadowColor = this.c.shadow;
    ctx.shadowBlur = 46;
    ctx.shadowOffsetY = 16;
    roundRect(ctx, panelX, panelY, panelW, panelH, 34);
    ctx.fillStyle = this.c.glass;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.strokeStyle = this.c.border;
    ctx.lineWidth = 1.6;
    roundRect(ctx, panelX, panelY, panelW, panelH, 34);
    ctx.stroke();

    ctx.strokeStyle = this.c.accent;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(panelX + 40, panelY);
    ctx.lineTo(panelX + 198, panelY);
    ctx.stroke();

    this.setFont(ctx, 54, 600, 'zh');
    ctx.fillStyle = this.c.text;
    ctx.fillText(this.activity.title, panelX + 42, panelY + 76);
    this.setFont(ctx, 20, 500, 'zh');
    ctx.fillStyle = this.c.muted;
    const sub = this.activity.timeAvailable
      ? `${this.activity.place}  ·  ${formatDate(this.activity.startTime, true)}`
      : this.activity.place;
    ctx.fillText(sub, panelX + 44, panelY + 112);

    metrics.forEach((item, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const isLastOdd = metrics.length % 2 === 1 && index === metrics.length - 1;
      const x = panelX + 38 + (isLastOdd ? 0 : col * (cardW + gap));
      const y = panelY + 132 + row * (cardH + rowGap);
      this.drawGridMetricCard(ctx, item, x, y, isLastOdd ? innerW : cardW, cardH, isLastOdd);
    });

    this.setFont(ctx, 10, 500, 'latin');
    ctx.textAlign = 'right';
    drawSpacedRight(ctx, 'MAP © ESRI', panelX + panelW - 38, panelY + panelH - 22, 1, hexAlpha(this.c.text, 0.28));
    ctx.restore();
  }

  private drawGridMetricCard(
    ctx: CanvasRenderingContext2D,
    item: ResultMetric,
    x: number,
    y: number,
    w: number,
    h: number,
    wide: boolean,
  ): void {
    roundRect(ctx, x, y, w, h, 18);
    ctx.fillStyle = this.c.glass;
    ctx.fill();
    ctx.fillStyle = hexAlpha(item.color, 0.065);
    ctx.fill();
    ctx.strokeStyle = this.c.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Icon + label in the top band, value in its own band below — the old
    // 42 / 98 pairing let a 46 px number grow into the icon plate.
    this.drawIconBadge(ctx, item.icon, x + 32, y + 38, 21, item.color);
    this.setFont(ctx, 20, 500, 'zh');
    ctx.fillStyle = this.c.muted;
    ctx.fillText(item.label, x + 74, y + 44);

    this.setFont(ctx, 18, 600, 'latin');
    const unitWidth = ctx.measureText(item.unit).width;
    const unitGap = 14;
    // Shrink until value + unit fit the card; a long number with a long unit
    // could otherwise run past the card edge.
    const budget = wide ? 420 : w - 56;
    let valueSize = 46;
    this.setFont(ctx, valueSize, 600, 'latin');
    let valueWidth = ctx.measureText(item.value).width;
    while (valueSize > 30 && valueWidth + unitGap + unitWidth > budget) {
      valueSize -= 2;
      this.setFont(ctx, valueSize, 600, 'latin');
      valueWidth = ctx.measureText(item.value).width;
    }
    const right = x + w - 26;
    const valueX = wide ? right - valueWidth - unitGap - unitWidth : x + 28;

    this.setFont(ctx, valueSize, 600, 'latin');
    ctx.fillStyle = this.c.text;
    ctx.fillText(item.value, valueX, y + 108);
    this.setFont(ctx, 18, 600, 'latin');
    ctx.fillStyle = item.color;
    ctx.fillText(item.unit, valueX + valueWidth + unitGap, y + 106);
  }

  private drawSmallMetricCard(
    ctx: CanvasRenderingContext2D,
    item: ResultMetric,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    roundRect(ctx, x, y, w, h, 17);
    ctx.fillStyle = this.c.glass;
    ctx.fill();
    ctx.fillStyle = hexAlpha(item.color, 0.06);
    ctx.fill();
    ctx.strokeStyle = this.c.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    this.drawIconBadge(ctx, item.icon, x + 32, y + h / 2, 19, item.color);
    this.setFont(ctx, 20, 500, 'zh');
    ctx.fillStyle = this.c.muted;
    ctx.fillText(item.label, x + 64, y + 34);

    this.setFont(ctx, 40, 600, 'latin');
    const valueWidth = ctx.measureText(item.value).width;
    this.setFont(ctx, 20, 600, 'latin');
    const unitWidth = ctx.measureText(item.unit).width;
    const right = x + w - 24;
    const start = right - valueWidth - 7 - unitWidth;
    this.setFont(ctx, 40, 600, 'latin');
    ctx.fillStyle = this.c.text;
    ctx.fillText(item.value, start, y + 64);
    this.setFont(ctx, 20, 600, 'latin');
    ctx.fillStyle = item.color;
    ctx.fillText(item.unit, start + valueWidth + 12, y + 62);
  }

  private resultMetric(
    icon: IconKind,
    label: string,
    available: boolean,
    value: string,
    unit: string,
    color: string,
  ): ResultMetric | null {
    if (!available || !value) return null;
    return { icon, label, value, unit, color };
  }

  private drawIconBadge(
    ctx: CanvasRenderingContext2D,
    kind: IconKind,
    x: number,
    y: number,
    radius: number,
    color: string,
  ): void {
    // Tinted plate + ring: the glyph alone washes out on the glass cards, and
    // the same plate is painted by the native renderer.
    const r = radius * 1.09;
    const grad = ctx.createLinearGradient(0, y - r, 0, y + r);
    grad.addColorStop(0, hexAlpha(color, 0.26));
    grad.addColorStop(1, hexAlpha(color, 0.07));
    ctx.save();
    roundRect(ctx, x - r, y - r, r * 2, r * 2, r * 0.58);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = hexAlpha(color, 0.38);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
    this.drawMetricIcon(ctx, kind, x, y, radius * 1.24, color);
  }

  private drawMetricIcon(
    ctx: CanvasRenderingContext2D,
    kind: IconKind,
    x: number,
    y: number,
    size: number,
    color: string,
  ): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 20, size / 20);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;

    if (kind === 'heart') {
      ctx.beginPath();
      ctx.moveTo(0, 8);
      ctx.bezierCurveTo(-12, 0, -9, -12, 0, -5);
      ctx.bezierCurveTo(9, -12, 12, 0, 0, 8);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(-5, -5);
      ctx.quadraticCurveTo(-7, -1, -4, 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.beginPath();
      ctx.ellipse(-4, -4, 2.1, 1.2, -0.6, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'speedometer') {
      ctx.beginPath();
      // Top arc, matching the native glyph: a bottom smile reads as a frown.
      ctx.arc(0, 2, 9.5, Math.PI * 1.12, Math.PI * 1.88);
      ctx.lineWidth = 2.8;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      for (const angle of [-0.55, -0.28, 0, 0.28, 0.55]) {
        const a = -Math.PI / 2 + angle;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 6.7, 2 + Math.sin(a) * 6.7);
        ctx.lineTo(Math.cos(a) * 8.7, 2 + Math.sin(a) * 8.7);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, 3);
      ctx.lineTo(6.1, -4.2);
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 3, 1.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'speed') {
      ctx.beginPath();
      ctx.moveTo(-7, 8);
      ctx.lineTo(0, -9);
      ctx.lineTo(1, -1);
      ctx.lineTo(8, -3);
      ctx.lineTo(-1, 9);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-3, 4); ctx.lineTo(1, -3);
      ctx.stroke();
    } else if (kind === 'clock') {
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(color, 0.18);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(0, 1);
      ctx.lineTo(4, 4);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, 1.4, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'mountain') {
      const grad = ctx.createLinearGradient(0, -10, 0, 10);
      grad.addColorStop(0, hexAlpha(color, 0.95));
      grad.addColorStop(1, hexAlpha(color, 0.42));
      ctx.beginPath();
      ctx.moveTo(-11, 8);
      ctx.lineTo(-2, -9);
      ctx.lineTo(3, 1);
      ctx.lineTo(6, -5);
      ctx.lineTo(11, 8);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-6, 1); ctx.lineTo(-2, -3); ctx.lineTo(1, 0);
      ctx.moveTo(4, -2); ctx.lineTo(6, -4.5); ctx.lineTo(8, -2);
      ctx.stroke();
    } else if (kind === 'gauge') {
      ctx.beginPath();
      ctx.arc(0, 3, 9.5, Math.PI, Math.PI * 2);
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, 3);
      ctx.lineTo(5.4, -4.4);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 3, 1.4, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'flame') {
      const grad = ctx.createLinearGradient(0, -11, 0, 10);
      grad.addColorStop(0, '#ffe16a');
      grad.addColorStop(0.55, color);
      grad.addColorStop(1, hexAlpha(color, 0.55));
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.bezierCurveTo(-9, 4, -6, -3, -1, -10);
      ctx.bezierCurveTo(0, -5, 4, -5, 3, -1);
      ctx.bezierCurveTo(7, -2, 9, 6, 0, 9);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.beginPath();
      ctx.moveTo(0, 6);
      ctx.quadraticCurveTo(-3, 2, 0, -3);
      ctx.quadraticCurveTo(3, 2, 0, 6);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(-10, 6);
      ctx.bezierCurveTo(-7, -1, -2, 1, 0, -5);
      ctx.bezierCurveTo(3, 4, 7, 0, 10, 6);
      ctx.stroke();
      ctx.shadowBlur = 0;
      for (const [px, py] of [[-10, 6], [0, -5], [10, 6]] as Array<[number, number]>) {
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private mapPointAtDistance(distance: number): MapRoutePoint {
    const points = this.activity.points;
    const index = findIndex(points, distance);
    if (index <= 0) return this.map.route[0];
    if (index >= points.length) return this.map.route[this.map.route.length - 1];
    const a = points[index - 1];
    const b = points[index];
    const span = b.distance - a.distance;
    const local = span > 0 ? (distance - a.distance) / span : 0;
    const p1 = this.map.route[index - 1];
    const p2 = this.map.route[index];
    return { x: p1.x + (p2.x - p1.x) * local, y: p1.y + (p2.y - p1.y) * local };
  }

  private createGrain(): void {
    const grain = document.createElement('canvas');
    grain.width = 160;
    grain.height = 160;
    const g = grain.getContext('2d')!;
    const image = g.createImageData(160, 160);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = Math.random() * 255;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 42;
    }
    g.putImageData(image, 0, 0);
    this.grainPattern = this.ctx.createPattern(grain, 'repeat') ?? undefined;
  }

  private drawGrain(ctx: CanvasRenderingContext2D): void {
    if (!this.grainPattern) return;
    ctx.save();
    ctx.globalAlpha = 0.018;
    ctx.fillStyle = this.grainPattern;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.restore();
  }

  private setFont(ctx: CanvasRenderingContext2D, size: number, weight: number, kind: 'latin' | 'zh' | 'letter'): void {
    const family = kind === 'latin'
      ? '"Barlow Condensed", "Arial Narrow", sans-serif'
      : '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    ctx.font = `${weight} ${size}px ${family}`;
  }
}

interface ResultMetric {
  icon: IconKind;
  label: string;
  value: string;
  unit: string;
  color: string;
}

function findIndex(points: RoutePoint[], distance: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].distance < distance) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawSpacedRight(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  let total = 0;
  for (const char of text) total += ctx.measureText(char).width + spacing;
  let cursor = x - total + spacing;
  for (const char of text) {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + spacing;
  }
  ctx.restore();
}

function formatDate(timestamp: number, withTime: boolean): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  if (!withTime) return `${month}.${day}`;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${month}.${day}  ${hh}:${mm}`;
}

function hexAlpha(hex: string, alpha: number): string {
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

