/**
 * 年度回顾视频：一条 40 秒左右的短片，不是逐月平铺的十二段循环。
 *
 * 叙事结构（2026-11 重做）：
 *   1. 片头数据卡（4.4s）：年份 + 总里程数字滚动 + 天数/次数 + 称号
 *   2. 高光路线（最多 5 幕 × 5.6s）：全年最长 / 爬升最多 / 黄金月代表 /
 *      最快一次 / 最后一骑 —— 每条都有"为什么剪它"的说法，而不是按月份
 *      机械点名；全局视角渐进点亮，幕标就是这条路的说法
 *   3. 片尾卡（8s）：12 个月柱状图逐月长出来 + 累计里程滚动 + 称号落版
 *
 * 卡片幕走 Java 的 NativeCardScene（Canvas 直绘 + 纹理上传），路线幕复用
 * 原来的 NativeRouteScene。一个编码器会话贯穿全片，PTS 全局连续。
 */

import { computeYearReview, yearHighlights } from '../stats/year-review';
import { loadActivity } from '../store/repo';
import { formatDateParts, formatDuration, formatSpeedKmh } from '../fit/activity';
import { THEMES } from '../render/theme';
import { renderMusicPcm } from '../audio/synth';
import { currentMusicId } from './music';
import { showToast } from './toast';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 路线幕：封面 1s + 入场 0.8s + 巡游（Java 侧 COVER/INTRO 常量对齐）。 */
const ROUTE_CHAPTER_SEC = 5.6;
/** 片头数据卡：数字滚动 + 称号淡入，收得干净利落。 */
const OPEN_CARD_SEC = 4.4;
/** 片尾：12 根月度柱 + 累计里程 + 称号，留一点余韵。 */
const CLOSE_CARD_SEC = 8.0;
/** 每幕轨迹抽稀上限：全局视角只有总览层在画，4000 点远超所需。 */
const CHAPTER_POINTS = 4000;

let busy = false;
let abortController: AbortController | null = null;

export function yearVideoBusy(): boolean {
  return busy;
}

export function cancelYearVideo(): void {
  abortController?.abort();
  void fetch(`${exportBase()}/abort`, { method: 'POST', mode: 'cors' }).catch(() => { });
}

function exportBase(): string {
  try {
    const bridge = (window as unknown as {
      FitMotionAndroid?: { nativeExportUrl?: () => string };
    }).FitMotionAndroid;
    return bridge?.nativeExportUrl?.() ?? '';
  } catch {
    return '';
  }
}

interface RouteChapterPayload {
  durationSec: number;
  title: string;
  subtitle: string;
  place: string;
  startText: string;
  distance: string;
  distanceMeters: number;
  displayMeters: number;
  maxSpeed: string;
  avgSpeed: string;
  maxHeart: string;
  maxAltitude: string;
  duration: string;
  activityDurationSec: number;
  movingDurationSec: number;
  elapsedDurationSec: number;
  elapsedAvailable: boolean;
  theme: string;
  themeRoute: string[];
  globalView: boolean;
  moments: unknown[];
  speedSeries: number[];
  heartSeries: number[];
  chapterBadge: string;
  chapterBadgeSub: string;
  points: Array<[number, number]>;
}

interface CardChapterPayload {
  kind: 'card';
  /** opening：片头；closing：片尾月度节奏 + 称号 */
  cardKind: 'opening' | 'closing';
  durationSec: number;
  year: number;
  totalMeters: number;
  rideDays: number;
  rides: number;
  climbM: number;
  titleName: string;
  titleDesc: string;
  months: number[];
}

type ChapterPayload = RouteChapterPayload | CardChapterPayload;

async function buildChapters(year: number): Promise<ChapterPayload[]> {
  const review = await computeYearReview(year);
  if (!review) return [];
  const theme = THEMES.tech;
  const out: ChapterPayload[] = [];

  // 1 片头数据卡
  out.push({
    kind: 'card',
    cardKind: 'opening',
    durationSec: OPEN_CARD_SEC,
    year: review.year,
    totalMeters: review.totalMeters,
    rideDays: review.rideDays,
    rides: review.rides,
    climbM: review.climbM,
    titleName: review.title.name,
    titleDesc: review.title.desc.replace(/<br\s*\/?>/g, ' · '),
    months: review.months,
  });

  // 2 高光路线
  const highlights = await yearHighlights(year);
  let order = 0;
  for (const highlight of highlights) {
    const meta = highlight.meta;
    let points: Array<[number, number]> = [];
    try {
      const activity = await loadActivity(meta.id);
      const stride = Math.max(1, Math.ceil(activity.points.length / CHAPTER_POINTS));
      for (let i = 0; i < activity.points.length; i += stride) {
        const point = activity.points[i];
        points.push([point.lat, point.lon]);
      }
    } catch {
      // 轨迹已被清理：跳过这一幕（数据卡照样成片）
      continue;
    }
    if (points.length < 2) continue;
    order += 1;
    const date = formatDateParts(meta.start);
    out.push({
      durationSec: ROUTE_CHAPTER_SEC,
      title: meta.name || highlight.label,
      subtitle: date.date,
      place: meta.name || highlight.label,
      startText: `开始 ${date.date.slice(5)}  ${date.time}`,
      distance: (meta.distance / 1000).toFixed(2),
      distanceMeters: meta.distance,
      displayMeters: meta.distance,
      maxSpeed: formatSpeedKmh(meta.maxSpeed),
      avgSpeed: meta.avgSpeed > 0 ? formatSpeedKmh(meta.avgSpeed) : '',
      maxHeart: meta.maxHr != null ? String(Math.round(meta.maxHr)) : '—',
      maxAltitude: meta.maxAlt != null ? String(Math.round(meta.maxAlt)) : '—',
      duration: formatDuration(meta.duration),
      activityDurationSec: meta.duration,
      movingDurationSec: meta.duration,
      elapsedDurationSec: meta.duration,
      elapsedAvailable: false,
      theme: theme.id,
      themeRoute: [...theme.route],
      globalView: true,
      moments: [],
      speedSeries: [],
      heartSeries: [],
      chapterBadge: highlight.label,
      chapterBadgeSub: highlight.note,
      points,
    });
  }

  // 3 片尾数据卡（12 个月柱状图 + 称号）
  out.push({
    kind: 'card',
    cardKind: 'closing',
    durationSec: CLOSE_CARD_SEC,
    year: review.year,
    totalMeters: review.totalMeters,
    rideDays: review.rideDays,
    rides: review.rides,
    climbM: review.climbM,
    titleName: review.title.name,
    titleDesc: review.title.desc.replace(/<br\s*\/?>/g, ' · '),
    months: review.months,
  });

  return out;
}

export async function exportYearReviewVideo(year: number): Promise<void> {
  if (busy) return;
  const base = exportBase();
  if (!base) {
    showToast('原生渲染仅支持 Android App。', true);
    return;
  }
  busy = true;
  const overlay = $('export-overlay');
  const title = $('export-title');
  const status = $('export-status');
  const fill = $('export-progress-fill');
  const report = $('export-report');
  const ring = $('export-ring');
  const eyebrow = $('export-eyebrow');
  overlay.hidden = false;
  if (ring) ring.style.display = '';
  if (eyebrow) eyebrow.style.display = '';
  if (title) title.textContent = `正在生成 ${year} 年度回顾视频`;
  status.textContent = '正在挑选年度高光…';
  status.style.display = '';
  fill.style.width = '0%';
  if (report) report.hidden = true;
  $('export-progress-box').style.display = '';

  try {
    const chapters = await buildChapters(year);
    if (chapters.length === 0) {
      // 一张卡都没有 = 这一年没有记录
      showToast('还没有可用的年度数据，无法生成视频。', true);
      overlay.hidden = true;
      return;
    }
    const durationSec = chapters.reduce((total, chapter) => total + chapter.durationSec, 0);

    // 背景音乐沿用创作页的当前选择，整轨渲染成长度匹配的 PCM。
    let audio: Awaited<ReturnType<typeof renderMusicPcm>> = null;
    try {
      status.textContent = '正在合成背景音乐…';
      audio = await renderMusicPcm(currentMusicId(), durationSec);
    } catch (error) {
      console.warn('[fit-motion] 年度回顾音乐合成失败，改为静音导出', error);
    }

    const payload: Record<string, unknown> = {
      width: 1080,
      height: 1920,
      fps: 30,
      bitrate: 4_000_000,
      chapters,
    };
    if (audio) payload.audio = audio;

    abortController = new AbortController();
    const started = performance.now();
    const timer = window.setInterval(async () => {
      const seconds = (performance.now() - started) / 1000;
      try {
        const res = await fetch(`${base}/progress`, { mode: 'cors' });
        const p = (await res.json()) as { phase?: string; done?: number; total?: number };
        const done = p.done ?? 0;
        const total = p.total ?? 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        if (p.phase === 'prefetch') {
          status.textContent = `下载/读取地图瓦片… ${seconds.toFixed(0)}s`;
        } else if (p.phase === 'raster') {
          status.textContent = `预渲染高清地图瓦片 ${done}/${total}（${pct}%）· ${seconds.toFixed(0)}s`;
        } else if (p.phase === 'render') {
          status.textContent = `逐幕渲染 + 硬件编码中… ${pct}% · ${seconds.toFixed(0)}s`;
          fill.style.width = `${pct}%`;
        } else if (p.phase === 'audio') {
          status.textContent = `正在混入背景音乐（AAC）… ${seconds.toFixed(0)}s`;
        }
      } catch {
        status.textContent = `渲染中… ${seconds.toFixed(0)}s`;
      }
    }, 600);

    const response = await fetch(`${base}/render`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });
    window.clearInterval(timer);
    if (!response.ok) throw new Error(`原生渲染失败（HTTP ${response.status}）`);
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      audioNote?: string;
      seconds?: number;
      chapters?: number;
      uri?: string;
    };
    if (!result.ok) throw new Error(result.error ?? '原生渲染失败');
    overlay.hidden = true;
    const note = result.audioNote ? `（音乐混流失败已回退静音：${result.audioNote}）` : '';
    showToast(`年度回顾视频已保存到 Download/FIT Motion${note}`);
    console.info('[fit-motion] year review video', result);
  } catch (error) {
    overlay.hidden = true;
    const message = (error as Error)?.name === 'AbortError' ? '年度回顾视频导出已取消。'
      : `年度回顾视频生成失败：${(error as Error)?.message ?? error}`;
    showToast(message, (error as Error)?.name !== 'AbortError');
  } finally {
    abortController = null;
    busy = false;
  }
}
