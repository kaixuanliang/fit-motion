/**
 * 年度回顾视频：12 个月代表骑行串联成一条全局视角 MP4。
 *
 * 数据来自 stats/year-review 的 monthChapters（每月取里程最大的一次骑行
 * 作代表，徽标展示当月次数与总里程）。渲染走原生 /render 的分章出口：
 * 顶层 payload 携带 chapters[]，Java 侧一个编码器会话逐章建场景 → 预光栅
 * → 编码 → 释放，PTS 全局连续，成片约 60~90 秒。
 *
 * 这里只负责组织 payload 与进度 UI（复用导出浮层），渲染与混流全在原生层。
 */

import { monthChapters } from '../stats/year-review';
import { loadActivity } from '../store/repo';
import { formatDateParts, formatDuration, formatSpeedKmh } from '../fit/activity';
import { THEMES } from '../render/theme';
import { renderMusicPcm } from '../audio/synth';
import { currentMusicId } from './music';
import { showToast } from './toast';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 非末章时长：封面 1s + 入场 0.8s + 巡游 5s（Java 侧 COVER/INTRO 常量对齐）。 */
const CHAPTER_SEC = 6.8;
/** 末章在巡游之外多留 5s 给成绩卡收尾（Java OUTRO 4s + 余量）。 */
const LAST_CHAPTER_SEC = 11.8;
/** 每章轨迹抽稀上限：全局视角只有总览层在画，4000 点远超所需。 */
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

interface ChapterPayload {
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

async function buildChapters(year: number): Promise<ChapterPayload[]> {
  const chapters = await monthChapters(year);
  const out: ChapterPayload[] = [];
  const theme = THEMES.tech;
  for (const chapter of chapters) {
    const meta = chapter.meta;
    let points: Array<[number, number]> = [];
    try {
      const activity = await loadActivity(meta.id);
      const stride = Math.max(1, Math.ceil(activity.points.length / CHAPTER_POINTS));
      for (let i = 0; i < activity.points.length; i += stride) {
        const point = activity.points[i];
        points.push([point.lat, point.lon]);
      }
    } catch {
      // 轨迹已被清理：跳过这个月，徽标数据仍然有效
      continue;
    }
    if (points.length < 2) continue;
    const date = formatDateParts(meta.start);
    const km = (chapter.meters / 1000).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    out.push({
      durationSec: 0, // 末章在下面补
      title: meta.name || `${chapter.month + 1}月骑行`,
      subtitle: date.date,
      place: meta.name || `${chapter.month + 1}月骑行`,
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
      chapterBadge: `${chapter.month + 1} 月`,
      chapterBadgeSub: `${chapter.rides} 次出行 · ${km} 公里`,
      points,
    });
  }
  out.forEach((chapter, i) => {
    chapter.durationSec = i === out.length - 1 ? LAST_CHAPTER_SEC : CHAPTER_SEC;
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
  status.textContent = '正在统计 12 个月的代表骑行…';
  status.style.display = '';
  fill.style.width = '0%';
  if (report) report.hidden = true;
  $('export-progress-box').style.display = '';

  try {
    const chapters = await buildChapters(year);
    if (chapters.length === 0) {
      showToast('没有带轨迹的月度骑行，无法生成视频。', true);
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
          status.textContent = `逐章渲染 + 硬件编码中… ${pct}% · ${seconds.toFixed(0)}s`;
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
