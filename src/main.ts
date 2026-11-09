import './base.css';
import './app.css';
import { buildActivity, formatDateParts, formatDuration, formatPace, formatSpeedKmh, type Activity } from './fit/activity';
import { parseFit } from './fit/parser';
import { parseGpx } from './gpx/parser';
import { parseTcx } from './tcx/parser';
import { activityToGpx, activityToTcx, mergeActivities, type TrackFormat } from './export/track';
import { saveBlob } from './export/save';
import { SAMPLE_FIT_BASE64, SAMPLE_NAME } from './data/sample';
import { TrackMap } from './render/map';
import { OverviewVectorLayer, VectorFollowLayer, clearVectorTileCache } from './render/vector-map';
import { clearBaseTileCache } from './render/tile-cache';
import { MotionStage } from './render/stage';
import { THEMES, isThemeId, type ThemeId } from './render/theme';
import { bindTabbar, currentPane, showPane } from './ui/router';
import { initRecords, type RecordsApi } from './ui/records';
import { initImport, type ImportApi } from './ui/import-page';
import { initMerge, type MergeApi } from './ui/merge-page';
import { initTrash, type TrashApi } from './ui/trash-page';
import { showToast, showToastAction } from './ui/toast';
import { initPanels, refreshRemoteUsage, renderBackup, renderSettings } from './ui/panels';
import { loadActivity, purgeExpiredTrash, setRemoteTrackResolver } from './store/repo';
import { initMusic, currentMusicId, musicById } from './ui/music';
import { initThemeSheet, syncFsThemeTag } from './ui/theme-sheet';
import { MusicPlayer } from './audio/player';
import { renderMusicPcm } from './audio/synth';
import type { ActivityMeta } from './store/types';
import { downloadTrack, probeAll } from './backup/sync';
import { trimCache } from './store/cache';
import { initKeyboard } from './ui/keyboard';

declare global {
  interface Window {
    FitMotionAndroid?: {
      beginSave: (name: string, mime: string) => boolean;
      appendSave: (base64Chunk: string) => boolean;
      finishSave: () => string;
      cancelSave: () => void;
      nativeExportUrl?: () => string;
      shareUri?: (uri: string, mime: string) => boolean;
      shareExport?: (name: string, mime: string) => boolean;
      beginExport?: (title: string) => void;
      updateExportProgress?: (percent: number, text: string) => void;
      endExport?: () => void;
      isExportCancelled?: () => boolean;
      /** 用系统浏览器打开外部页面（百度网盘授权页） */
      openUrl?: (url: string) => void;
      /** 输入框聚焦状态，原生用它决定长按是否放行（粘贴菜单） */
      setEditing?: (editing: boolean) => void;
    };
  }
}

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

const studio = byId<HTMLElement>('studio');
const fileInput = byId<HTMLInputElement>('file-input');
const stageCanvas = byId<HTMLCanvasElement>('stage-canvas');
const stageFrame = byId<HTMLDivElement>('stage-frame');
const playBtn = byId<HTMLButtonElement>('play-btn');
const bigPlay = byId<HTMLButtonElement>('big-play');
const replayBtn = byId<HTMLButtonElement>('replay-btn');
const timeline = byId<HTMLDivElement>('timeline');
const timelineFill = byId<HTMLDivElement>('timeline-fill');
const timelineThumb = byId<HTMLDivElement>('timeline-thumb');
const timecode = byId<HTMLSpanElement>('timecode');
const stageLoading = byId<HTMLDivElement>('stage-loading');
const exportOverlay = byId<HTMLDivElement>('export-overlay');
const exportStatus = byId<HTMLParagraphElement>('export-status');
const exportProgress = byId<HTMLDivElement>('export-progress-fill');
const ambientCanvas = byId<HTMLCanvasElement>('stage-ambient');
const esSeg = byId<HTMLDivElement>('es-seg');
const esEst = byId<HTMLSpanElement>('es-est');

let currentStage: MotionStage | null = null;
let currentActivity: Activity | null = null;
let currentMap: TrackMap | null = null;
let currentFollow: VectorFollowLayer | null = null;
let currentOverview: OverviewVectorLayer | null = null;
let posterMode = false;
let cacheReady = false;

/**
 * 缓存就绪标志。除了内部守卫，还挂到 window 上给端到端脚本用 ——
 * 靠 is-busy 类名猜状态会有竞态（点开记录到 mount 之间有一小段窗口）。
 */
function setCacheReady(value: boolean): void {
  cacheReady = value;
  (window as unknown as { __fitReady?: boolean }).__fitReady = value;
}
let studioToken = 0;
let studioWasPlaying = false;
let playing = false;
let playhead = 0;
/** 预览背景音乐：与播放头同步，导出时由原生层混成 AAC 音轨。 */
const musicPlayer = new MusicPlayer();
/** 创作页全屏播放态（CSS 覆盖层，不是系统 fullscreen）。 */
let fsActive = false;
/**
 * 导出倍速：只作用于成片画面（预览恒为 1× 原速）。
 * 倍速压缩的是画面时间线，背景音乐按原速渲染混音、随成片淡出。
 */
let exportSpeed = 1;
let raf = 0;
let basePlayhead = 0;
let baseWall = 0;
let exportCancelled = false;
let exporting = false;
let draggingTimeline = false;
/** Live handle on the native /render request so 取消 can actually stop it. */
let exportAbort: AbortController | null = null;
let exportBase = '';
let records: RecordsApi | null = null;
let importer: ImportApi | null = null;
let merger: MergeApi | null = null;
let trash: TrashApi | null = null;

// 导出倍速记忆：默认 1×，换过就记住上次的选择。
try {
  const savedSpeed = Number(localStorage.getItem('fitmotion-export-speed'));
  if (savedSpeed >= 1 && savedSpeed <= 5) exportSpeed = Math.round(savedSpeed);
} catch {
  // file:// WebView 可能禁存储，保持默认 1×
}

/**
 * Stops an in-flight native export: abort the HTTP request and tell the native
 * render loop to bail out at the next frame boundary.
 */
function requestExportCancel(): void {
  if (!exporting) return;
  exportCancelled = true;
  exportStatus.textContent = '正在取消…';
  if (exportBase) {
    void fetch(`${exportBase}/abort`, { method: 'POST', mode: 'cors' }).catch(() => {});
  }
  exportAbort?.abort();
}

const params = new URLSearchParams(window.location.search);
const isDemo = params.has('demo');
const isStill = params.has('still');
const MAX_VIDEO_METERS = 300_000;
let storedTheme: string | null = null;
try {
  storedTheme = localStorage.getItem('fitmotion-theme');
} catch {
  storedTheme = null;
}
let selectedTheme: ThemeId = isThemeId(params.get('theme'))
  ? params.get('theme') as ThemeId
  : isThemeId(storedTheme)
    ? storedTheme
    : 'bright';
const activeTheme = () => THEMES[selectedTheme];

void boot();

async function boot(): Promise<void> {
  syncThemeUi();
  bindEvents();
  bindTabbar();
  records = initRecords((meta) => void openRecord(meta), {
    onExport: (meta, format) => exportRecord(meta, format),
    onChanged: () => refreshPanels(),
  });
  trash = initTrash(async () => {
    await records?.reload();
    await refreshPanels();
  });
  byId<HTMLButtonElement>('set-open-trash').addEventListener('click', () => void trash?.open());
  importer = initImport(async () => {
    await records?.reload();
    await refreshPanels();
  });
  merger = initMerge(async (outcome) => {
    await records?.reload();
    await refreshPanels();
    showToast(outcome.status === 'added'
      ? `已合并为「${outcome.name}」：${(outcome.distanceM / 1000).toFixed(1)} km · ${formatDuration(outcome.durationSec)}`
      : `这 ${outcome.count} 段已经合并过，没有重复生成。`, outcome.status !== 'added');
  });
  byId<HTMLButtonElement>('merge-open').addEventListener('click', () => void merger?.open());
  initPanels({ currentTheme: () => selectedTheme, applyTheme: (id) => {
    if (isThemeId(id)) applyTheme(id as ThemeId);
  } });
  // 轨迹不在本机时由备份层回源，repo 不需要知道 GitHub/Gitee 的存在
  setRemoteTrackResolver(downloadTrack);
  // 删除满 30 天的记录只留墓碑，轨迹与原始文件回收掉
  void purgeExpiredTrash().then((cleaned) => {
    if (cleaned > 0) {
      showToast(`已回收 ${cleaned} 条过期删除记录占用的空间`);
      void refreshPanels();
    }
  });
  window.addEventListener('fitmotion:records-changed', () => {
    void records?.reload();
  });
  initMusic();
  initKeyboard();
  window.addEventListener('fitmotion:music-changed', () => {
    // 曲目变了：预渲染新缓冲；正在播放就从当前进度无缝切过去
    if (!currentStage) return;
    void (async () => {
      const token = studioToken;
      await musicPlayer.prepare(currentMusicId(), currentStage.duration);
      if (playing && token === studioToken) await musicPlayer.play(playhead, 1);
    })();
  });
  try {
    await records.reload();
  } catch (error) {
    console.error(error);
    const empty = document.getElementById('records-empty');
    if (empty) {
      empty.hidden = false;
      const text = empty.querySelector('p');
      if (text) text.textContent = '这台设备的 WebView 无法使用本地数据库（IndexedDB），记录库暂不可用。可以先用「导入」直接处理单个文件。';
    }
  }
  await refreshPanels().catch(() => undefined);
  void afterBootMaintenance();
  await waitForFonts();

  if (!isDemo) {
    // 空库时先给个引导，非空就直接看记录
    const empty = document.getElementById('records-empty');
    if (empty) empty.hidden = (records?.total() ?? 0) > 0;
  } else {
    try {
      const sample = decodeBase64(SAMPLE_FIT_BASE64);
      const activity = buildActivity(parseFit(sample), SAMPLE_NAME);
      openStudio(activity);
      const tParam = params.get('t');
      const still = tParam != null ? Number(tParam) : Number.NaN;
      if (isStill || Number.isFinite(still)) {
        window.setTimeout(() => {
          if (!currentStage) return;
          pausePlayback();
          const target = Number.isFinite(still) && still > 0 ? still : currentStage.previewTime;
          playhead = Math.min(currentStage.duration, target);
          currentStage.renderAt(playhead);
          updateTransport();
        }, 450);
      }
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  }
}

async function waitForFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load('600 100px "Barlow Condensed"'),
      document.fonts.load('500 100px "Barlow Condensed"'),
      document.fonts.load('700 100px "Barlow Condensed"'),
    ]);
    await document.fonts.ready;
  } catch {
    // System fallbacks are fine.
  }
}

function fitMotionOpenExport(): boolean {
  if (!currentActivity) return false;
  if (currentPane() !== 'create') showPane('create');
  if (!exportOverlay.hidden) return true;
  const exportButton = document.getElementById('export-btn');
  exportButton?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  showToast('已返回导出页面。');
  return true;
}

(window as unknown as { fitMotionOpenExport?: () => boolean }).fitMotionOpenExport = fitMotionOpenExport;

function bindEvents(): void {
  (window as unknown as { fitMotionHandleBack?: () => boolean }).fitMotionHandleBack = () => {
    // Android back: cancel a running export first, then dismiss the sheet.
    if (exporting) {
      requestExportCancel();
      return true;
    }
    if (overlayIsOpen('merge-overlay')) {
      merger?.close();
      return true;
    }
    if (overlayIsOpen('trash-overlay')) {
      trash?.close();
      return true;
    }
    if (!exportOverlay.hidden) {
      resetExportOverlayUi();
      exportOverlay.hidden = true;
      return true;
    }
    if (fsActive) {
      exitFullScreen();
      return true;
    }
    if (currentPane() === 'create') {
      closeStudio();
      return true;
    }
    return false;
  };

  const openPicker = (): void => {
    fileInput.value = '';
    fileInput.click();
  };
  // 创作页右上角：回到记录列表挑另一条（不再走文件选择器）
  byId<HTMLButtonElement>('change-file').addEventListener('click', closeStudio);
  fileInput.addEventListener('change', () => {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    if (files.length) void handlePicked(files);
  });
  byId<HTMLButtonElement>('export-track-gpx').addEventListener('click', () => void exportTrack('gpx'));
  byId<HTMLButtonElement>('export-track-tcx').addEventListener('click', () => void exportTrack('tcx'));
  byId<HTMLButtonElement>('clear-cache').addEventListener('click', () => void clearMapCacheAndReload());
  stageLoading.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id === 'cache-retry') {
      if (!currentActivity) return;
      mountStudio(currentActivity, activeTheme(), playhead, false);
    }
  });

  const pane = document.getElementById('records-pane');
  if (pane) {
    for (const eventName of ['dragenter', 'dragover']) {
      pane.addEventListener(eventName, (event) => event.preventDefault());
    }
    pane.addEventListener('drop', (event) => {
      event.preventDefault();
      const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
      if (files.length) void handlePicked(files);
    });
  }

  byId<HTMLButtonElement>('back-btn').addEventListener('click', closeStudio);

  playBtn.addEventListener('click', togglePlay);
  bigPlay.addEventListener('click', togglePlay);
  replayBtn.addEventListener('click', () => {
    if (!currentStage) return;
    playhead = 0;
    renderCurrent(0);
    startPlayback();
  });

  timeline.addEventListener('pointerdown', (event) => {
    draggingTimeline = true;
    timeline.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  });
  timeline.addEventListener('pointermove', (event) => {
    if (draggingTimeline) seekFromPointer(event);
  });
  timeline.addEventListener('pointerup', () => {
    draggingTimeline = false;
  });
  timeline.addEventListener('pointercancel', () => {
    draggingTimeline = false;
  });

  // 容器尺寸变化（旋转/字体加载）后重画延展地图
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      requestAnimationFrame(() => drawAmbient());
    }).observe(stageFrame);
  }
  timeline.addEventListener('keydown', (event) => {
    if (!currentStage) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      pausePlayback();
      playhead = Math.max(0, Math.min(currentStage.duration, playhead + delta));
      renderCurrent(playhead);
    }
  });

  esSeg.querySelectorAll<HTMLButtonElement>('button[data-es]').forEach((button) => {
    button.addEventListener('click', () => {
      if (exporting) return;
      exportSpeed = Math.max(1, Math.min(5, Number(button.dataset.es ?? '1')));
      try {
        localStorage.setItem('fitmotion-export-speed', String(exportSpeed));
      } catch {
        // 存不了就本次会话内生效
      }
      syncExportSpeedUi();
      // 点击倍速 = 以该倍速从头预览播放，导出也是同一个倍速（单一选中态）。
      if (!exporting && currentStage && !posterMode && cacheReady) {
        pausePlayback();
        playhead = 0;
        startPlayback();
      }
    });
  });

  byId<HTMLButtonElement>('fullscreen-btn').addEventListener('click', enterFullScreen);
  byId<HTMLButtonElement>('fs-exit').addEventListener('click', exitFullScreen);
  // 全屏右下角主题标签 → 弹出主题选择（与选曲弹层同一套交互）
  initThemeSheet(
    () => selectedTheme,
    (id) => {
      applyTheme(id);
      syncFsThemeTag(activeTheme().label);
    },
  );

  // 全屏态：进度条支持点按/拖动，画面点一下播放/暂停
  const fsSeek = byId<HTMLElement>('fs-seek');
  let fsDragging = false;
  fsSeek.addEventListener('pointerdown', (event) => {
    fsDragging = true;
    fsSeek.setPointerCapture(event.pointerId);
    seekFromPointer(event, fsSeek);
  });
  fsSeek.addEventListener('pointermove', (event) => {
    if (fsDragging) seekFromPointer(event, fsSeek);
  });
  fsSeek.addEventListener('pointerup', () => { fsDragging = false; });
  fsSeek.addEventListener('pointercancel', () => { fsDragging = false; });
  stageFrame.addEventListener('click', (event) => {
    if (!fsActive) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.fs-top, .fs-bar')) return;
    togglePlay();
  });

  byId<HTMLButtonElement>('export-btn').addEventListener('click', () => {
    void exportCurrent();
  });
  byId<HTMLButtonElement>('stats-image-btn').addEventListener('click', () => {
    void exportStatsImage();
  });
  // PixelCopy 抓不到 WebView 的实时画面（窗口 buffer 是陈旧的），这条路已废弃。
  byId<HTMLButtonElement>('native-export-btn').hidden = true;
  byId<HTMLButtonElement>('cancel-export').addEventListener('click', () => {
    if (exportReportOpen) {
      resetExportOverlayUi();
      exportOverlay.hidden = true;
      return;
    }
    if (!exporting) {
      resetExportOverlayUi();
      exportOverlay.hidden = true;
      return;
    }
    requestExportCancel();
  });

  window.addEventListener('online', () => {
    if (!cacheReady && currentActivity && currentPane() === 'create') {
      showToast('网络已恢复，继续缓存地图…');
      mountStudio(currentActivity, activeTheme(), playhead, false);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && playing) {
      // Keep the playhead where it is; wall-clock based playback would jump.
      pausePlayback();
    }
  });
}

function syncThemeUi(): void {
  document.documentElement.dataset.theme = selectedTheme;
  document.querySelectorAll<HTMLButtonElement>('#theme-grid [data-set-theme]').forEach((button) => {
    button.classList.toggle('on', button.dataset.setTheme === selectedTheme);
  });
}

function applyTheme(id: ThemeId): void {
  if (id === selectedTheme) return;
  selectedTheme = id;
  try {
    localStorage.setItem('fitmotion-theme', id);
  } catch {
    // file:// WebView may disable storage; the current session still works.
  }
  syncThemeUi();
  if (currentPane() === 'create' && currentActivity) rebuildStudioTheme();
}

function rebuildStudioTheme(): void {
  if (!currentActivity) return;
  const at = playhead;
  const resume = playing;
  pausePlayback();
  mountStudio(currentActivity, activeTheme(), at, resume);
}

function mountStudio(activity: Activity, theme: ReturnType<typeof activeTheme>, at: number, resume: boolean): void {
  const token = ++studioToken;
  currentMap = new TrackMap(activity, theme, () => {
    if (currentStage) currentStage.renderAt(playhead);
  });
  currentFollow = posterMode ? null : new VectorFollowLayer(activity, theme, currentMap);
  currentOverview = new OverviewVectorLayer(theme, currentMap);
  currentStage = new MotionStage(stageCanvas, activity, currentMap, theme, currentFollow ?? undefined);
  currentStage.setOverview(currentOverview);
  (window as unknown as { __fitStage?: MotionStage }).__fitStage = currentStage;
  setCacheReady(false);
  setStudioBusy(true);
  applyStudioModeUi();
  currentStage.renderAt(at);
  drawAmbient();
  updateTransport();
  syncExportSpeedUi();
  // 音乐缓冲在地图缓存的网络空档里悄悄渲染好，点播放立刻有声
  if (!posterMode) void musicPlayer.prepare(currentMusicId(), currentStage.duration);
  void prepareStudio(activity, theme, token, at, resume);
}

function applyStudioModeUi(): void {
  studio.classList.toggle('poster-mode', posterMode);
  const device = byId<HTMLElement>('stage-device');
  const exportButton = byId<HTMLButtonElement>('export-btn');
  const help = byId<HTMLElement>('export-help');
  if (posterMode) {
    device.textContent = '路线图 · 1080×1920 PNG';
    exportButton.innerHTML = '<svg><use href="#i-download"/></svg> 保存 1080×1920 路线图';
    help.innerHTML = '1080 × 1920 · PNG<br />超过 300 公里仅生成一张完整路线图';
  } else {
    device.textContent = `${activeTheme().label} · 1080P MP4`;
    exportButton.innerHTML = '<svg><use href="#i-download"/></svg> 导出 1080P MP4';
    help.innerHTML = '1080 × 1920 · 30FPS · MP4<br />导出时请保持此页面在前台';
  }
}

function setStudioBusy(busy: boolean): void {
  studio.classList.toggle('is-busy', busy);
  byId<HTMLButtonElement>('export-btn').disabled = busy;
  const nativeButton = document.getElementById('native-export-btn') as HTMLButtonElement | null;
  if (nativeButton) nativeButton.disabled = busy;
  const statsButton = document.getElementById('stats-image-btn') as HTMLButtonElement | null;
  if (statsButton) statsButton.disabled = busy;
  byId<HTMLButtonElement>('play-btn').disabled = busy;
  byId<HTMLButtonElement>('big-play').disabled = busy;
  byId<HTMLButtonElement>('replay-btn').disabled = busy;
}

function showCacheProgress(label: string, ratio: number): void {
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  stageLoading.classList.add('cache-loading');
  stageLoading.classList.remove('is-hidden');
  if (!stageLoading.querySelector('.cache-meter')) {
    stageLoading.innerHTML = '<div class="cache-box">'
      + '<div class="cache-row"><span class="spinner"></span><span class="cache-label"></span><b class="cache-pct"></b></div>'
      + '<div class="cache-meter"><i></i></div></div>';
  }
  const text = stageLoading.querySelector('.cache-label');
  const pct = stageLoading.querySelector('.cache-pct');
  const fill = stageLoading.querySelector<HTMLElement>('.cache-meter i');
  if (text) text.textContent = label;
  if (pct) pct.textContent = `${percent}%`;
  if (fill) fill.style.width = `${percent}%`;
}

function hideStageLoading(): void {
  stageLoading.classList.add('is-hidden');
}

async function prepareStudio(
  activity: Activity,
  theme: ReturnType<typeof activeTheme>,
  token: number,
  at: number,
  resume: boolean,
): Promise<void> {
  const map = currentMap;
  const stage = currentStage;
  const follow = currentFollow;
  const overview = currentOverview;
  if (!map || !stage) return;
  try {
    showCacheProgress(posterMode ? '正在缓存路线图底图' : '正在缓存地图瓦片', 0);
    // 三个抓取任务相互独立（栅格底图 / 矢量总览 / 第一视角瓦片），全部并行。
    // 旧的串行写法把每段的耗时加在一起，并行后总耗时 ≈ 最慢的一段。
    const ratios = { raster: 0, overview: 0, follow: 0 };
    const reportFetch = (label: string): void => {
      const combined = posterMode
        ? ratios.overview * 0.6 + ratios.raster * 0.4
        : ratios.follow * 0.5 + ratios.overview * 0.3 + ratios.raster * 0.2;
      showCacheProgress(label, combined * 0.85);
    };
    const rasterTask = map.loadTiles((progress) => {
      if (token !== studioToken) return;
      ratios.raster = progress;
      reportFetch(posterMode ? '正在缓存路线图底图' : '正在缓存地图瓦片');
    });
    // The vector overview is what the cover/result frames actually paint.
    const overviewTask = overview
      ? overview.prefetch((done, total) => {
        if (token !== studioToken) return;
        ratios.overview = total ? done / total : 1;
        reportFetch('正在缓存地图瓦片');
      })
      : Promise.resolve();
    // 第一视角瓦片是纯网络抓取（解码在 primeAll 里），不必等前两个任务。
    const followFetchTask = !posterMode && follow
      ? follow.prefetch((done, total) => {
        if (token !== studioToken) return;
        ratios.follow = total ? done / total : 1;
        reportFetch('正在缓存地图瓦片');
      })
      : Promise.resolve();
    await Promise.all([rasterTask, overviewTask, followFetchTask]);
    if (token !== studioToken) return;
    if (!map.usingTiles && !overview?.ready) throw new Error('总览地图缓存不完整');

    if (!posterMode && follow) {
      showCacheProgress('正在解码第一视角地图', 0.85);
      await follow.primeAll((done, total) => {
        if (token !== studioToken) return;
        showCacheProgress('正在解码第一视角地图', 0.85 + (total ? done / total : 1) * 0.08);
      });
      stage.setFollow(follow);
    }

    // 逐张预热瓦片位图（每张让出主线程）。不预热的话，缓存完成后的第一帧要
    // 现烤十几张瓦片（页面冻住一两秒、点播放没反应）；末帧整帧还会被
    // posterCache 截走，截到缺块的画面就再也补不回来了。
    const warmBase = posterMode ? 0.85 : 0.93;
    const warmSpan = posterMode ? 0.15 : 0.07;
    if (overview) {
      showCacheProgress('正在生成地图画面', warmBase);
      await overview.warmBitmaps(stage.resultCameraScale, (done, total) => {
        if (token !== studioToken) return;
        showCacheProgress('正在生成地图画面', warmBase + (total ? done / total : 1) * warmSpan * 0.2);
      });
      // 地名/国道标签候选也要在缓存阶段解码好，否则封面和成绩卡每帧都要
      // 对全城瓦片跑 loadGeometry()，一帧几百毫秒（页面冻结、时间显示冻住）
      await overview.buildLabelCache((done, total) => {
        if (token !== studioToken) return;
        showCacheProgress('正在生成地图画面', warmBase + warmSpan * (0.2 + (total ? done / total : 1) * 0.1));
      });
    }
    if (!posterMode && follow) {
      await follow.warmBitmaps(stage.followCameraScale, (done, total) => {
        if (token !== studioToken) return;
        showCacheProgress('正在生成地图画面', warmBase + warmSpan * 0.3 + (total ? done / total : 1) * warmSpan * 0.7);
      });
    }

    if (token !== studioToken) return;
    setCacheReady(true);
    setStudioBusy(false);
    // 首帧（含总览标签碰撞、海报缓存等一次性成本）必须在加载层还没揭掉时
    // 画完，否则用户看到的是「缓存 100% 后页面冻一下才开始播」。
    playhead = posterMode ? 0 : at;
    stage.renderAt(playhead);
    drawAmbient();
    updateTransport();
    syncExportSpeedUi();
    // 留一拍让 100% 的进度条先上屏，再揭加载层/自动开播
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (token !== studioToken) return;
    hideStageLoading();
    if (follow?.failedTiles) {
      showToast(`地图缓存完成，但有 ${follow.failedTiles} 张高清瓦片下载失败，将使用总览底图补齐。`);
    }
    if (!posterMode && !isStill) {
      const wantsPlayback = resume || at < 0.05;
      if (wantsPlayback) {
        window.setTimeout(() => {
          if (!playing && currentStage === stage && !studio.hidden) startPlayback();
        }, 220);
      }
    }
  } catch (error) {
    if (token !== studioToken) return;
    console.error(error);
    setCacheReady(false);
    setStudioBusy(true);
    showCacheFailure(errorMessage(error));
  }
}

function showCacheFailure(message: string): void {
  stageLoading.classList.add('cache-loading');
  stageLoading.classList.remove('is-hidden');
  stageLoading.innerHTML = `<div class="cache-error-copy">${message}</div><button class="cache-retry" id="cache-retry" type="button">重新缓存</button>`;
}

function confirmClearCache(): Promise<boolean> {
  const modal = byId<HTMLElement>('clear-cache-modal');
  const cancel = byId<HTMLButtonElement>('clear-cache-cancel');
  const confirm = byId<HTMLButtonElement>('clear-cache-confirm');
  modal.hidden = false;
  confirm.focus();
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      modal.hidden = true;
      cancel.removeEventListener('click', onCancel);
      confirm.removeEventListener('click', onConfirm);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onCancel = (): void => finish(false);
    const onConfirm = (): void => finish(true);
    const onBackdrop = (event: MouseEvent): void => {
      if (event.target === modal) finish(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(false);
    };
    cancel.addEventListener('click', onCancel);
    confirm.addEventListener('click', onConfirm);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

async function clearMapCacheAndReload(): Promise<void> {
  if (exporting) return;
  if (!(await confirmClearCache())) return;
  try {
    await Promise.all([clearBaseTileCache(), clearVectorTileCache()]);
    showToast('地图缓存已清除，正在重新缓存…');
    if (currentActivity) {
      mountStudio(currentActivity, activeTheme(), 0, false);
    } else {
      setCacheReady(false);
    }
  } catch (error) {
    console.error(error);
    showToast('清除缓存失败，请重试。', true);
  }
}

async function refreshPanels(): Promise<void> {
  await renderBackup();
  await renderSettings();
}

/**
 * 启动后的后台活儿：链路慢、又不影响首屏，所以整段 fire-and-forget。
 * 探活成功才去拉容量，顺手把超出预算的轨迹缓存淘汰掉。
 */
async function afterBootMaintenance(): Promise<void> {
  try {
    const status = await probeAll();
    if (!status.some((row) => row.ok)) return;
    await refreshRemoteUsage();
    await trimCache();
    await renderBackup();
  } catch (error) {
    console.warn('后台维护失败', error);
  }
}

async function handlePicked(files: File[]): Promise<void> {
  if (!importer) return;
  await importer.run(files);
}

async function openRecord(meta: ActivityMeta): Promise<void> {
  showToast('正在载入这条记录…');
  try {
    const activity = await loadActivity(meta.id);
    openStudio(activity);
  } catch (error) {
    console.error(error);
    showToast(errorMessage(error), true);
  }
}

async function saveTrack(activity: Activity, format: TrackFormat): Promise<void> {
  if (!activity.points.length) {
    throw new Error('这条记录没有轨迹点，无法导出（可能轨迹还没同步到本机，联网后重试）');
  }
  const content = format === 'gpx' ? activityToGpx(activity) : activityToTcx(activity);
  const mime = format === 'gpx' ? 'application/gpx+xml' : 'application/vnd.garmin.tcx+xml';
  const filename = `${activity.title}-${format}.${format}`;
  await saveBlob(new Blob([content], { type: mime }), filename, mime);
  showToast(`已导出 ${format.toUpperCase()}：${filename}`);
}

async function exportTrack(format: TrackFormat): Promise<void> {
  if (!currentActivity) return;
  try {
    await saveTrack(currentActivity, format);
  } catch (error) {
    console.error(error);
    showToast(`导出 ${format.toUpperCase()} 失败，请重试。`, true);
  }
}

/** 记录卡片菜单里的导出：先按 id 把轨迹读回来再走同一套导出。 */
async function exportRecord(meta: ActivityMeta, format: TrackFormat): Promise<void> {
  try {
    const activity = await loadActivity(meta.id);
    await saveTrack(activity, format);
  } catch (error) {
    console.error(error);
    showToast(errorMessage(error), true);
  }
}

function openStudio(activity: Activity): void {
  pausePlayback();
  currentActivity = activity;
  posterMode = activity.distanceM > MAX_VIDEO_METERS;
  setCacheReady(false);
  playhead = 0;
  showPane('create');
  studio.scrollTop = 0;

  populateSide(activity);
  stageLoading.classList.remove('is-hidden');
  stageLoading.innerHTML = '<span class="spinner"></span> 正在准备地图缓存…';
  const tParam = params.get('t');
  const initialTime = isDemo && tParam != null && Number.isFinite(Number(tParam)) ? Math.max(0, Number(tParam)) : 0;
  mountStudio(activity, activeTheme(), initialTime, false);
}

function closeStudio(): void {
  studioToken += 1;
  exitFullScreen();
  pausePlayback();
  musicPlayer.stop();
  showPane('records');
  studio.classList.remove('poster-mode', 'is-busy', 'fs');
  currentFollow?.clear();
  currentFollow = null;
  currentOverview?.clear();
  currentOverview = null;
  currentStage = null;
  currentMap = null;
  currentActivity = null;
  setCacheReady(false);
  playhead = 0;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function populateSide(activity: Activity): void {
  const date = activity.timeAvailable ? formatDateParts(activity.startTime) : null;
  byId<HTMLElement>('file-badge').textContent = activity.sourceType.toUpperCase();
  byId<HTMLElement>('file-name').textContent = activity.fileName;
  byId<HTMLElement>('file-meta').textContent = `${formatInteger(activity.points.length)} 个轨迹点  ·  ${activity.sessionCount || 1} 个活动段${activity.heartRateAvailable ? '' : '  ·  文件未记录心率'}`;
  byId<HTMLElement>('activity-title').textContent = activity.title;
  byId<HTMLElement>('activity-sub').textContent = date
    ? `${activity.place}  ·  ${date.date} ${date.time}`
    : activity.place;
  byId<HTMLElement>('max-hr').textContent = activity.heartRateAvailable && activity.maxHeartRate
    ? String(activity.maxHeartRate)
    : '--';
  byId<HTMLElement>('max-speed').textContent = activity.maxSpeedAvailable
    ? formatSpeedKmh(activity.maxSpeed)
    : '--';
  byId<HTMLElement>('total-distance').textContent = (activity.distanceM / 1000).toFixed(2);
  byId<HTMLElement>('total-duration').textContent = activity.durationAvailable
    ? formatDuration(activity.durationSec, true)
    : '--';
  byId<HTMLElement>('total-elapsed').textContent = activity.elapsedAvailable
    ? formatDuration(activity.elapsedSec, true)
    : '--';
  byId<HTMLElement>('avg-hr').innerHTML = activity.avgHeartRate ? `${activity.avgHeartRate} <em>次/分钟</em>` : '--';
  byId<HTMLElement>('avg-speed').innerHTML = activity.avgSpeedAvailable
    ? `${formatSpeedKmh(activity.avgSpeed)} <em>公里/小时</em>`
    : '--';
  byId<HTMLElement>('max-altitude').innerHTML = activity.altitudeAvailable && activity.maxAltitude != null
    ? `${Math.round(activity.maxAltitude)} <em>米</em>`
    : '--';
  byId<HTMLElement>('calories').innerHTML = activity.calories != null
    ? `${Math.round(activity.calories)} <em>千卡</em>`
    : '--';
  byId<HTMLElement>('stage-device').textContent = `${activeTheme().label} · 1080P MP4`;
}

/** 进入全屏播放：舞台铺满屏幕，自动从当前进度续播。 */
function enterFullScreen(): void {
  if (!currentStage || posterMode || !cacheReady) return;
  fsActive = true;
  studio.classList.add('fs');
  const title = document.getElementById('fs-title');
  if (title) title.textContent = currentActivity?.title ?? '';
  syncFsThemeTag(activeTheme().label);
  updateTransport();
  if (!playing) startPlayback();
}

/** 退出全屏：回到创作页布局，播放暂停。 */
function exitFullScreen(): void {
  if (!fsActive) return;
  fsActive = false;
  studio.classList.remove('fs');
  pausePlayback();
}

function togglePlay(): void {
  if (!currentStage || posterMode || !cacheReady) return;
  if (playing) {
    pausePlayback();
  } else {
    if (playhead >= currentStage.duration - 0.03) {
      playhead = 0;
      currentStage.renderAt(0);
    }
    startPlayback();
  }
}

function startPlayback(): void {
  if (!currentStage || playing || posterMode || !cacheReady) return;
  if (playhead >= currentStage.duration - 0.03) playhead = 0;
  playing = true;
  basePlayhead = playhead;
  baseWall = performance.now();
  updatePlayButton();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
  void syncMusicToPlayhead();
}

function pausePlayback(): void {
  playing = false;
  cancelAnimationFrame(raf);
  musicPlayer.stop();
  updatePlayButton();
  updateTransport();
}

/**
 * 音乐跟随播放头。缓冲没渲染好时先渲染再接着播（渲染期间画面已经在
 * 走，音乐最多晚一秒跟上，不需要打断画面）。
 */
async function syncMusicToPlayhead(): Promise<void> {
  if (!playing || !currentStage) return;
  const trackId = currentMusicId();
  if (trackId === 'none') return;
  const token = studioToken;
  try {
    await musicPlayer.prepare(trackId, currentStage.duration);
  } catch {
    return;
  }
  if (playing && token === studioToken) await musicPlayer.play(playhead, Math.max(1, exportSpeed));
}

function tick(now: number): void {
  if (!currentStage || !playing) return;
  // 预览倍速与导出倍速共用 exportSpeed（同一选中态）：预览按倍速推进播放头，
  // 导出成片同样按倍速压缩时间线，两边看到的节奏一致。
  // 播放头逐帧推进并限幅（单帧最多走 0.25s×倍速）：主线程若被偶发长任务
  // 冻住，墙钟差会把播放头一下推到几十秒外（表现为「进度条突然跳到中间」）；
  // 限幅后冻结只是一次短暂停顿，恢复后从原位继续。
  const rate = Math.max(1, exportSpeed);
  const next = basePlayhead + Math.min(0.25 * rate, ((now - baseWall) / 1000) * rate);
  if (next >= currentStage.duration) {
    playhead = currentStage.duration;
    currentStage.renderAt(playhead);
    playing = false;
    musicPlayer.stop();
    updatePlayButton();
    updateTransport();
    return;
  }
  playhead = next;
  basePlayhead = playhead;
  baseWall = now;
  currentStage.renderAt(playhead);
  drawAmbient();
  updateTransport();
  raf = requestAnimationFrame(tick);
}

function renderCurrent(time: number): void {
  if (!currentStage) return;
  currentStage.renderAt(time);
  drawAmbient();
  updateTransport();
  updatePlayButton();
}

/* ── 延展地图（预览核心两侧的低清氛围地图） ───────────────────── */

/**
 * 用同一相机视角把地图向左右延展画满整个预览容器：中央 9:16 是视频核心，
 * 两侧是压暗的低清延续。位图缓存独立于核心（尺寸不同不能共用），每帧限量
 * 现烤、烤不完下拍补。绘制本身每帧都跑（位图命中时是纯 blit），保证两侧
 * 始终与核心同一帧的相机对齐。全屏与海报模式不需要（CSS 直接隐藏）。
 */
function drawAmbient(): void {
  if (fsActive || posterMode || !currentStage || !currentFollow) return;
  const ctx = ambientCanvas.getContext('2d');
  if (!ctx) return;
  const frameRect = stageFrame.getBoundingClientRect();
  const coreRect = stageCanvas.getBoundingClientRect();
  if (frameRect.width < 2 || coreRect.width < 2) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(frameRect.width * dpr);
  const height = Math.round(frameRect.height * dpr);
  if (ambientCanvas.width !== width || ambientCanvas.height !== height) {
    ambientCanvas.width = width;
    ambientCanvas.height = height;
  }
  const camera = currentStage.cameraAtTime(playhead);
  // 与核心画面连续：核心 1080 画布 px 显示为 coreRect.width css px，
  // 延展画布 1 css px = dpr 画布 px，所以延展层比例 = 相机比例 × (核心显示宽×dpr / 1080)
  const ambientScale = (camera.scale * coreRect.width * dpr) / 1080;
  // 与核心同层同相机：封面/成绩卡段用总览层，巡航段用第一视角层，
  // 这样两侧延伸和中央画面天然连续（总览位图按锁定比例拉伸，不重烤）
  const painted = currentStage.overviewPhaseAt(playhead)
    ? (currentOverview?.draw(ctx, { ...camera, scale: ambientScale }, width, height) ?? false)
    : currentFollow.drawAmbient(ctx, { ...camera, scale: ambientScale }, width, height);
  if (!painted) {
    // 视野内没有可用瓦片：铺背景色，避免残影
    ctx.fillStyle = '#0a1014';
    ctx.fillRect(0, 0, width, height);
    return;
  }
  // 只压暗核心两侧的条带，不盖住核心区域，避免中缝出现明暗分界
  const coreLeft = Math.round(((frameRect.width - coreRect.width) / 2) * dpr);
  const coreWidth = Math.round(coreRect.width * dpr);
  ctx.fillStyle = 'rgba(4, 7, 10, 0.68)';
  if (coreLeft > 0) ctx.fillRect(0, 0, coreLeft, height);
  const rightStart = coreLeft + coreWidth;
  if (rightStart < width) ctx.fillRect(rightStart, 0, width - rightStart, height);
}

/** 导出倍速卡：选中态 + 成片时长估算（原时长 ÷ 倍速，下限 6 秒）。 */
function syncExportSpeedUi(): void {
  esSeg.querySelectorAll<HTMLButtonElement>('button[data-es]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.es ?? '1') === exportSpeed);
  });
  esEst.textContent = currentStage
    ? `成片约 ${formatDuration(exportTimelineScale())}`
    : '成片约 --';
}

function seekFromPointer(event: PointerEvent, el: HTMLElement = timeline): void {
  if (!currentStage) return;
  const rect = el.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  pausePlayback();
  playhead = ratio * currentStage.duration;
  renderCurrent(playhead);
}

function updateTransport(): void {
  if (!currentStage) return;
  const ratio = Math.max(0, Math.min(1, playhead / currentStage.duration));
  timelineFill.style.width = `${ratio * 100}%`;
  timelineThumb.style.left = `${ratio * 100}%`;
  timecode.textContent = `${formatDuration(playhead)} / ${formatDuration(currentStage.duration)}`;
  const fsFill = document.getElementById('fs-seek-fill');
  if (fsFill) fsFill.style.width = `${ratio * 100}%`;
  const fsTime = document.getElementById('fs-time');
  if (fsTime) fsTime.textContent = `${formatDuration(playhead)} / ${formatDuration(currentStage.duration)}`;
  const eq = document.getElementById('music-eq');
  if (eq) eq.classList.toggle('on', playing && currentMusicId() !== 'none');
  const finished = currentStage.frame.resultVisible;
  bigPlay.classList.toggle('is-hidden', playing || finished);
}

function updatePlayButton(): void {
  if (!currentStage) return;
  playBtn.innerHTML = `<svg><use href="#${playing ? 'i-pause' : 'i-play'}"></use></svg>`;
  playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  updateTransport();
}

// The export overlay doubles as a results panel once encoding finishes: the
// numbers a slow export needs to be diagnosed (per-frame render / submit /
// encoder-wait) are useless in a toast that disappears after three seconds.
let exportReportOpen = false;

function resetExportOverlayUi(): void {
  exportReportOpen = false;
  const ring = document.getElementById('export-ring');
  const eyebrow = document.getElementById('export-eyebrow');
  const title = document.getElementById('export-title');
  const status = document.getElementById('export-status');
  const box = document.getElementById('export-progress-box');
  const report = document.getElementById('export-report');
  const hint = document.getElementById('export-hint');
  const button = document.getElementById('cancel-export');
  if (ring) ring.style.display = '';
  if (eyebrow) eyebrow.style.display = '';
  if (title) title.textContent = '正在生成你的轨迹短片';
  if (status) status.style.display = '';
  if (box) box.style.display = '';
  if (report) {
    report.hidden = true;
    report.textContent = '';
  }
  if (hint) hint.style.display = '';
  if (button) {
    button.textContent = '取消';
    button.classList.remove('is-done');
  }
}

function showExportReport(rows: Array<[string, string]>): void {
  exportReportOpen = true;
  const ring = document.getElementById('export-ring');
  const eyebrow = document.getElementById('export-eyebrow');
  const title = document.getElementById('export-title');
  const status = document.getElementById('export-status');
  const box = document.getElementById('export-progress-box');
  const report = document.getElementById('export-report');
  const hint = document.getElementById('export-hint');
  const button = document.getElementById('cancel-export');
  if (ring) ring.style.display = 'none';
  if (eyebrow) eyebrow.style.display = 'none';
  if (title) title.textContent = '导出完成';
  if (status) status.style.display = 'none';
  if (box) box.style.display = 'none';
  if (report) {
    report.hidden = false;
    report.textContent = rows.map(([key, value]) => (value ? `${key}  ${value}` : key)).join('\n');
  }
  if (hint) hint.style.display = 'none';
  if (button) {
    button.textContent = '完成';
    button.classList.add('is-done');
  }
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function overlayIsOpen(id: string): boolean {
  const node = document.getElementById(id);
  return node instanceof HTMLElement && !node.hidden;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '解析失败，请确认这是一个包含 GPS 轨迹的 FIT 或 GPX 活动文件。';
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

const awaitNextFrame = (): Promise<void> =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Native hardware-encode export (hybrid Phase 1): the WebView keeps rendering
 * frames 1:1, and for each frame the Java side PixelCopy-grabs the composited
 * window region straight into MediaCodec's hardware H.264 encoder. This skips
 * the canvas readback (57.2 ms/帧 on device) and the software encoder wall
 * of the WebCodecs path entirely.
 */
function buildHeartSeries(activity: Activity, samples = 96): number[] {
  if (!activity.heartRateAvailable) return [];
  const points = activity.points;
  if (points.length < 4) return [];
  const total = activity.distanceM > 0 ? activity.distanceM : points[points.length - 1].distance;
  if (!(total > 0)) return [];
  const sums = new Array<number>(samples).fill(0);
  const counts = new Array<number>(samples).fill(0);
  for (const point of points) {
    const bpm = point.heartRate;
    if (bpm == null || !(bpm > 0)) continue;
    const bucket = Math.min(samples - 1, Math.max(0, Math.round((point.distance / total) * (samples - 1))));
    sums[bucket] += bpm;
    counts[bucket] += 1;
  }
  const series: number[] = [];
  let last = 0;
  for (let i = 0; i < samples; i += 1) {
    if (counts[i] > 0) last = sums[i] / counts[i];
    series.push(Math.round(last));
  }
  return series;
}

function buildSpeedSeries(activity: Activity, samples = 96): number[] {
  const points = activity.points;
  if (points.length < 4) return [];
  const total = activity.distanceM > 0 ? activity.distanceM : points[points.length - 1].distance;
  if (!(total > 0)) return [];
  const sums = new Array<number>(samples).fill(0);
  const counts = new Array<number>(samples).fill(0);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const previous = points[index - 1];
    let speed = point.speed;
    if (speed == null || !(speed > 0)) {
      const dt = point.t - previous.t;
      const dd = point.distance - previous.distance;
      speed = dt > 0 && dd > 0 ? dd / dt : 0;
    }
    if (!(speed > 0) || !Number.isFinite(speed)) continue;
    const ratio = Math.max(0, Math.min(1, point.distance / total));
    const bucket = Math.min(samples - 1, Math.max(0, Math.round(ratio * (samples - 1))));
    sums[bucket] += speed * 3.6;
    counts[bucket] += 1;
  }
  const series: number[] = [];
  let last = 0;
  for (let i = 0; i < samples; i += 1) {
    if (counts[i] > 0) last = sums[i] / counts[i];
    series.push(last);
  }
  const firstReal = series.find((value) => value > 0) ?? 0;
  return series.map((value) => (value > 0 ? value : firstReal));
}

/**
 * Key moments the native timeline freezes on: max altitude, max heart rate and
 * max speed, each pushed to the point of the ride where it happened.
 */
function nativeMoments(activity: Activity): Array<{
  label: string;
  value: string;
  unit: string;
  icon: string;
  progress: number;
  color: string;
}> {
  const moments: Array<{
    label: string;
    value: string;
    unit: string;
    icon: string;
    progress: number;
    color: string;
  }> = [];
  const total = activity.distanceM > 0 ? activity.distanceM : 1;
  const add = (
    available: boolean,
    point: { distance: number } | undefined,
    label: string,
    value: string,
    unit: string,
    color: string,
    icon: string,
  ): void => {
    if (!available || !point) return;
    moments.push({
      label,
      value,
      unit,
      color,
      icon,
      progress: Math.max(0.03, Math.min(0.95, point.distance / total)),
    });
  };

  add(activity.altitudeAvailable, activity.maxAltitudePoint, '最高海拔',
    String(Math.round(activity.maxAltitude ?? 0)), '米', '#3FD0D8', 'mountain');
  add(activity.heartRateAvailable, activity.maxHrPoint, '最高心率',
    String(Math.round(activity.maxHeartRate ?? 0)), '次/分钟', '#FF6B8A', 'heart');
  add(activity.maxSpeedAvailable, activity.maxSpeedPoint, '最快速度',
    formatSpeedKmh(activity.maxSpeed), '公里/小时', '#FFB347', 'speed');

  return moments.sort((a, b) => a.progress - b.progress);
}

/**
 * 导出时间线：导出卡里选的倍速作用于成片画面 —— 原生渲染器按
 * durationSec 建排程，整体除以倍速即等比加速。封底 6 秒，防止
 * 5× 遇上超短视频时触到原生排程的最小段护栏，画面比例失真。
 * 背景音乐不跟随倍速：按成片时长原速渲染（见下方 audio 段）。
 */
function exportTimelineScale(): number {
  if (!currentStage) throw new Error('没有可导出的轨迹');
  const speed = Math.max(1, Math.min(5, exportSpeed));
  return Math.max(6, currentStage.duration / speed);
}

function nativeScenePayload(
  theme: ReturnType<typeof activeTheme>,
  date: ReturnType<typeof formatDateParts> | null,
  durationSec: number,
): Record<string, unknown> {
  if (!currentActivity || !currentStage) throw new Error('没有可导出的轨迹');
  const activity = currentActivity;
  const stride = Math.max(1, Math.ceil(activity.points.length / 6000));
  const points: Array<[number, number]> = [];
  for (let index = 0; index < activity.points.length; index += stride) {
    const point = activity.points[index];
    points.push([point.lat, point.lon]);
  }
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: 4_000_000,
    durationSec: durationSec,
    activityDurationSec: activity.durationSec,
    title: activity.title,
    subtitle: date ? `${activity.place} · ${date.date}` : activity.place,
    place: activity.place,
    startText: date ? `开始 ${date.date.slice(5)}  ${date.time}` : '',
    distance: (activity.distanceM / 1000).toFixed(2),
    distanceMeters: activity.distanceM,
    maxSpeed: formatSpeedKmh(activity.maxSpeed),
    avgSpeed: activity.avgSpeedAvailable ? formatSpeedKmh(activity.avgSpeed) : '',
    maxHeart: activity.maxHeartRate ? String(Math.round(activity.maxHeartRate)) : '—',
    maxAltitude: activity.maxAltitude != null ? String(Math.round(activity.maxAltitude)) : '—',
    calories: activity.calories != null ? String(Math.round(activity.calories)) : '',
    duration: activity.durationAvailable ? formatDuration(activity.durationSec) : '—',
    theme: theme.id,
    themeRoute: theme.route,
    speedSeries: buildSpeedSeries(activity),
    heartSeries: buildHeartSeries(activity),
    moments: nativeMoments(activity),
    points,
  };
}

/**
 * 倍速标注：1× 不展示，>1× 显示「2× 倍速」供导出过程提示用。
 */
function timelineLabel(): string {
  const speed = Math.max(1, Math.min(5, exportSpeed));
  return speed > 1 ? `${speed}× 倍速` : '1× 原速';
}

async function exportNativeScene(): Promise<void> {
  if (!currentStage || exporting || !currentActivity) return;
  const bridge = window.FitMotionAndroid;
  if (!bridge || typeof bridge.nativeExportUrl !== 'function') {
    showToast('原生渲染仅支持 Android App。', true);
    return;
  }
  let base = '';
  try {
    base = bridge.nativeExportUrl();
  } catch {
    base = '';
  }
  if (!base) {
    showToast('原生渲染服务启动失败。', true);
    return;
  }
  exportBase = base;

  exporting = true;
  exportCancelled = false;
  pausePlayback();
  currentMap?.lock();
  resetExportOverlayUi();
  exportOverlay.hidden = false;
  exportProgress.style.width = '0%';
  exportStatus.textContent = `原生渲染：预取地图瓦片…（${timelineLabel()}）`;

  const started = performance.now();
  const timer = window.setInterval(async () => {
    const seconds = (performance.now() - started) / 1000;
    try {
      const res = await fetch(`${base}/progress`, { mode: 'cors' });
      if (!res.ok) throw new Error('progress unavailable');
      const p = (await res.json()) as { phase?: string; done?: number; total?: number };
      if (p.phase === 'prefetch') {
        exportStatus.textContent = `原生渲染：下载/读取地图瓦片… ${seconds.toFixed(0)}s`;
      } else if (p.phase === 'raster') {
        const total = p.total ?? 0;
        const done = p.done ?? 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        exportStatus.textContent = `原生渲染：预渲染高清地图瓦片 ${done}/${total}（${pct}%）· ${seconds.toFixed(0)}s`;
      } else if (p.phase === 'render') {
        const total = p.total ?? 0;
        const done = p.done ?? 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        exportStatus.textContent = `原生 GPU 渲染 + 硬件编码中… ${pct}% · ${seconds.toFixed(0)}s · ${timelineLabel()}`;
        exportProgress.style.width = `${pct}%`;
      } else if (p.phase === 'audio') {
        exportStatus.textContent = `正在混入背景音乐（AAC）… ${seconds.toFixed(0)}s`;
      } else {
        exportStatus.textContent = `原生渲染中… ${seconds.toFixed(0)}s`;
      }
    } catch {
      exportStatus.textContent = `原生 GPU 渲染 + 硬件编码中… ${seconds.toFixed(0)}s`;
    }
  }, 600);

  const stride = Math.max(1, Math.ceil(currentActivity.points.length / 6000));
  const points: Array<[number, number]> = [];
  for (let index = 0; index < currentActivity.points.length; index += stride) {
    const point = currentActivity.points[index];
    points.push([point.lat, point.lon]);
  }
  const theme = activeTheme();
  const date = currentActivity.timeAvailable ? formatDateParts(currentActivity.startTime) : null;
  // 成片时长在导出开始时锁定一次（画面按倍速加速后的长度），音频与视频
  // 必须用同一个值，否则原生层的音画时长校验（200ms）会把整次导出打回。
  const durationSec = exportTimelineScale();
  const payload = nativeScenePayload(theme, date, durationSec);

  // 背景音乐：整轨渲染成 PCM（结尾 0.5s 已淡出），原生层编 AAC 混进 MP4。
  // 音乐不跟随倍速 —— 画面加速但音乐原速，渲染长度即成片时长（音乐只是
  // 在更短的片子里提前淡出）。
  let audio: Awaited<ReturnType<typeof renderMusicPcm>> = null;
  const musicId = currentMusicId();
  if (musicId !== 'none' && currentStage) {
    try {
      exportStatus.textContent = `正在合成背景音乐…（${timelineLabel()}）`;
      audio = await renderMusicPcm(musicId, durationSec);
      if (audio) payload.audio = audio;
    } catch (error) {
      console.warn('[fit-motion] 音乐合成失败，改为静音导出', error);
    }
  }

  try {
    const controller = new AbortController();
    exportAbort = controller;
    const response = await fetch(`${base}/render`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('原生渲染失败（HTTP ' + response.status + '）');
    const result = (await response.json()) as {
      ok?: boolean;
      seconds?: number;
      fps?: number;
      uri?: string;
      error?: string;
      frames?: number;
      mapTiles?: number;
      tileLoadMs?: number;
      tileRasterMs?: number;
      routeMsPerFrame?: number;
      hudMsPerFrame?: number;
      tileDrawMsPerFrame?: number;
      posterFrames?: number;
      swapMsPerFrame?: number;
      drainMsPerFrame?: number;
      coverFrames?: number;
      coverMsPerFrame?: number;
      cruiseFrames?: number;
      cruiseMsPerFrame?: number;
      outroFrames?: number;
      outroMsPerFrame?: number;
      outroHudMs?: number;
      audioMs?: number;
      audioTrackMs?: number;
      outMs?: number;
      audioNote?: string;
    };
    if (!result.ok) throw new Error(result.error ?? '原生渲染失败');
    const totalSeconds = result.seconds ?? (performance.now() - started) / 1000;
    const frames = result.frames ?? Math.ceil(currentStage.duration * 30);
    exportProgress.style.width = '100%';
    exportStatus.textContent = `原生渲染完成 · ${totalSeconds.toFixed(1)} 秒`;
    console.info('[fit-motion] native scene profile', result);
    const phase = (count?: number, ms?: number): string => (
      count ? `${count} 帧 · ${(ms ?? 0).toFixed(1)} ms/帧` : '—'
    );
    showExportReport([
      ['编码器', 'MediaCodec HW · 原生 GPU 渲染'],
      ['背景音乐', result.audioNote
        ? `混流失败，已回退静音（${result.audioNote}）`
        : audio
          ? `${musicById(musicId).name} · ${(audio.bytes / 1048576).toFixed(1)} MB PCM → AAC · 混流 ${((result.audioMs ?? 0) / 1000).toFixed(1)} 秒`
          : '无（静音）'],
      ['成片时长', result.outMs
        ? `${(result.outMs / 1000).toFixed(1)} 秒 · 音轨 ${((result.audioTrackMs ?? 0) / 1000).toFixed(1)} 秒`
        : `${currentStage.duration.toFixed(1)} 秒`],
      ['总帧数', `${frames} 帧 / ${currentStage.duration.toFixed(1)} 秒`],
      ['每帧均摊', `${((totalSeconds * 1000) / frames).toFixed(1)} ms`],
      ['────────────', ''],
      ['封面帧', phase(result.coverFrames, result.coverMsPerFrame)],
      ['巡航帧', phase(result.cruiseFrames, result.cruiseMsPerFrame)],
      ['尾段帧', result.outroFrames
        ? `${phase(result.outroFrames, result.outroMsPerFrame)} · HUD ${(result.outroHudMs ?? 0).toFixed(1)}`
        : '—'],
      ['交换/编码', `swap ${(result.swapMsPerFrame ?? 0).toFixed(1)} · drain ${(result.drainMsPerFrame ?? 0).toFixed(1)} ms/帧`],
      ['海报复用', result.posterFrames ? `${result.posterFrames} 帧直出缓存` : '未命中'],
      ['────────────', ''],
      ['瓦片预取', `${((result.tileLoadMs ?? 0) / 1000).toFixed(1)} 秒 · ${result.mapTiles ?? 0} 张`],
      ['瓦片绘制', `${(result.tileDrawMsPerFrame ?? 0).toFixed(1)} ms/帧`],
      ['路线+标记', `${(result.routeMsPerFrame ?? 0).toFixed(1)} ms/帧`],
      ['HUD', `${(result.hudMsPerFrame ?? 0).toFixed(1)} ms/帧`],
      ['合计耗时', `${totalSeconds.toFixed(1)} 秒`],
      ['保存结果', result.uri ? '已保存到手机相册' : '未保存'],
    ]);
    if (result.uri) {
      const uri = result.uri;
      showToastAction('视频已保存到手机相册', '分享', () => {
        const bridge = window.FitMotionAndroid;
        if (!bridge?.shareUri?.(uri, 'video/mp4')) {
          showToast('分享面板拉起失败，可在相册里分享。', true);
        }
      });
    }
    if (result.audioNote) showToast('音乐混流失败，已导出静音版本。', true);
  } catch (error) {
    const aborted = exportCancelled
      || (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError');
    if (aborted) {
      showToast('已取消导出。');
      exportOverlay.hidden = true;
    } else {
      console.error(error);
      showToast(error instanceof Error ? error.message : '原生渲染失败。', true);
      exportOverlay.hidden = true;
    }
  } finally {
    window.clearInterval(timer);
    exporting = false;
    exportAbort = null;
    exportBase = '';
    if (!exportReportOpen) exportOverlay.hidden = true;
    currentMap?.unlock();
    if (currentStage) {
      playhead = currentStage.duration;
      currentStage.renderAt(playhead);
      updateTransport();
    }
  }
}

async function exportCurrent(): Promise<void> {
  if (posterMode) {
    await exportPoster();
  } else {
    await exportVideo();
  }
}

async function exportPoster(): Promise<void> {
  if (!currentStage || exporting) return;
  if (!cacheReady) {
    showToast('地图缓存尚未完成，请稍候。', true);
    return;
  }
  exporting = true;
  exportOverlay.hidden = false;
  exportProgress.style.width = '0%';
  exportStatus.textContent = '正在渲染 1080×1920 路线图…';
  pausePlayback();
  currentStage.renderAt(0);
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const blob = await new Promise<Blob | null>((resolve) => stageCanvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('无法生成路线图');
    exportProgress.style.width = '100%';
    exportStatus.textContent = '正在保存路线图 PNG…';
    const filename = `${currentActivity?.title ?? '运动'}-路线图-${stamp()}.png`;
    const result = await saveBlob(blob, filename, 'image/png');
    showToast(result === 'manual' ? '路线图已生成，请点击“保存到手机”。' : result === 'picker' ? '请选择保存位置，路线图会写入所选文件夹。' : `路线图已保存：${filename}`);
  } catch (error) {
    console.error(error);
    showToast('路线图保存失败，请重试。', true);
  } finally {
    exporting = false;
    exportOverlay.hidden = true;
  }
}

async function exportVideo(): Promise<void> {
  if (!currentStage || exporting) return;
  if (!cacheReady) {
    showToast('地图缓存尚未完成，请等待缓存结束后再导出。', true);
    return;
  }
  // WebCodecs / MediaRecorder export paths were removed: the native GPU +
  // hardware encoder is faster by an order of magnitude and is the only path
  // the app ships now.
  await exportNativeScene();
}

/**
 * Long share image: the same ride numbers the studio shows, laid out as one
 * tall 1080-wide PNG (header, hero distance, metric grid, route sketch and a
 * per-kilometre speed chart) and saved through the same bridge as the video.
 */
async function exportStatsImage(): Promise<void> {
  if (!currentActivity || exporting) return;
  const activity = currentActivity;
  const theme = activeTheme();
  exporting = true;
  try {
    showToast('正在生成数据长图…');
    // The sheet opens with the very poster frame the video starts and ends on,
    // so the still image and the MP4 tell the same story.
    const posterW = 1080;
    const posterH = 1920;
    const poster = document.createElement('canvas');
    poster.width = posterW;
    poster.height = posterH;
    const posterCtx = poster.getContext('2d');
    if (currentStage && posterCtx) {
      const resumeAt = playhead;
      currentStage.renderAt(0);
      posterCtx.drawImage(currentStage.canvas, 0, 0, posterW, posterH);
      currentStage.renderAt(resumeAt);
    }

    const details: Array<[string, string, string]> = [];
    if (activity.heartRateAvailable && activity.avgHeartRate != null) {
      details.push(['平均心率', String(Math.round(activity.avgHeartRate)), '次/分钟']);
    }
    if (activity.altitudeAvailable && activity.maxAltitude != null) {
      details.push(['最高海拔', String(Math.round(activity.maxAltitude)), '米']);
    }
    if (activity.ascent != null) details.push(['累计爬升', String(Math.round(activity.ascent)), '米']);
    if (activity.calories != null) details.push(['消耗热量', String(Math.round(activity.calories)), '千卡']);
    if (activity.sportKey !== 'ride' && activity.avgSpeed > 0) {
      details.push(['平均配速', formatPace(1000 / activity.avgSpeed), '/公里']);
    } else if (activity.avgSpeedAvailable) {
      details.push(['平均速度', formatSpeedKmh(activity.avgSpeed), '公里/小时']);
    }

    const W = 1080;
    const pad = 54;
    // One row per kilometre is unreadable on a 200 km ride; group the splits so
    // the list stays a screenful, the same as the panel on the playback page.
    const splits = activity.splits;
    const group = Math.max(1, Math.ceil(splits.length / 24));
    const rows: Array<{ label: string; speed: number; heartRate?: number }> = [];
    for (let i = 0; i < splits.length; i += group) {
      const slice = splits.slice(i, i + group);
      const seconds = slice.reduce((total, split) => total + split.seconds, 0);
      const meters = slice.reduce((total, split) => total + split.distanceM, 0);
      const beats = slice
        .map((split) => split.heartRate)
        .filter((value): value is number => typeof value === 'number' && value > 0);
      rows.push({
        label: group === 1 ? String(slice[0].index) : `${slice[0].index}–${slice[slice.length - 1].index}`,
        speed: seconds > 0 ? meters / seconds : 0,
        heartRate: beats.length > 0 ? Math.round(beats.reduce((a, b) => a + b, 0) / beats.length) : undefined,
      });
    }

    const detailH = Math.ceil(details.length / 2) * 116;
    const splitBlock = rows.length > 0 ? 46 + rows.length * 64 + 26 : 0;
    const footerH = 132;
    const bodyH = 96 + 34 + detailH + 54 + splitBlock + footerH;
    const H = posterH + bodyH;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');

    const sans = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
    ctx.fillStyle = theme.stageBg;
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(poster, 0, 0);

    const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    const sectionHead = (top: number, label: string, caption: string): void => {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(pad, top - 16, 34, 4);
      ctx.font = `600 30px ${sans}`;
      ctx.fillStyle = theme.text;
      ctx.fillText(label, pad + 46, top);
      if (!caption) return;
      ctx.font = `400 20px ${sans}`;
      ctx.fillStyle = theme.faint;
      ctx.textAlign = 'right';
      ctx.fillText(caption, W - pad, top);
      ctx.textAlign = 'left';
    };

    let y = posterH + 96;
    sectionHead(y, '详细数据', '');
    y += 34;
    const colW = (W - pad * 2 - 24) / 2;
    for (let i = 0; i < details.length; i += 1) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = pad + col * (colW + 24);
      const top = y + row * 116;
      ctx.fillStyle = hexToRgba(theme.text, 0.045);
      roundRect(x, top, colW, 104, 20);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(theme.text, 0.09);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.font = `500 22px ${sans}`;
      ctx.fillStyle = theme.muted;
      ctx.fillText(details[i][0], x + 28, top + 32);
      // Extra vertical breathing room between the label band and the value.
      ctx.font = `700 42px ${sans}`;
      ctx.fillStyle = theme.text;
      ctx.fillText(details[i][1], x + 28, top + 86);
      const valueWidth = ctx.measureText(details[i][1]).width;
      ctx.font = `400 20px ${sans}`;
      ctx.fillStyle = theme.accent;
      ctx.fillText(details[i][2], x + 34 + valueWidth, top + 86);
    }
    y += detailH + 54;

    if (rows.length > 0) {
      const maxRowSpeed = Math.max(...rows.map((row) => row.speed), 0.001);
      sectionHead(y, '分段数据', `每 ${group} KM · ${activity.sportKey === 'ride' ? '平均速度' : '平均配速'}`);
      const listTop = y + 46;
      const barX = pad + 132;
      const barW = W - pad * 2 - 132 - 216;
      rows.forEach((row, index) => {
        const cy = listTop + index * 64 + 32;
        ctx.textAlign = 'left';
        ctx.font = `600 26px ${sans}`;
        ctx.fillStyle = theme.text;
        ctx.fillText(row.label, pad, cy + 9);
        if (group === 1) {
          ctx.font = `500 15px ${sans}`;
          ctx.fillStyle = theme.faint;
          ctx.fillText('KM', pad + 62, cy + 9);
        }

        ctx.fillStyle = hexToRgba(theme.text, 0.08);
        roundRect(barX, cy - 5, barW, 10, 5);
        ctx.fill();
        const ratio = Math.max(0.06, Math.min(1, row.speed / maxRowSpeed));
        const barGradient = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        barGradient.addColorStop(0, theme.accent);
        barGradient.addColorStop(1, theme.accent2);
        ctx.fillStyle = barGradient;
        roundRect(barX, cy - 5, barW * ratio, 10, 5);
        ctx.fill();

        ctx.textAlign = 'right';
        ctx.font = `600 26px ${sans}`;
        ctx.fillStyle = theme.text;
        ctx.fillText(
          activity.sportKey === 'ride' ? formatSpeedKmh(row.speed) : formatPace(1000 / row.speed),
          W - pad - 76,
          cy + 9,
        );
        ctx.font = `500 20px ${sans}`;
        ctx.fillStyle = row.heartRate ? theme.red : theme.faint;
        ctx.fillText(row.heartRate ? String(row.heartRate) : '--', W - pad, cy + 9);
        ctx.textAlign = 'left';
      });
      y += splitBlock;
    }

    // Footer.
    const footTop = H - footerH;
    ctx.strokeStyle = hexToRgba(theme.text, 0.1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, footTop);
    ctx.lineTo(W - pad, footTop);
    ctx.stroke();
    ctx.font = `600 20px ${sans}`;
    ctx.fillStyle = theme.accent;
    ctx.fillText('FIT MOTION', pad, footTop + 52);
    ctx.font = `400 20px ${sans}`;
    ctx.fillStyle = theme.faint;
    ctx.fillText(
      `${new Date().toLocaleDateString('zh-CN')} · ${activity.sportName}`,
      pad,
      footTop + 88,
    );
    ctx.textAlign = 'right';
    ctx.fillText('MAP © ESRI', W - pad, footTop + 88);
    ctx.textAlign = 'left';

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('无法生成数据长图');
    const filename = `${activity.title}-数据长图-${stamp()}.png`;
    const result = await saveBlob(blob, filename, 'image/png');
    showToast(result === 'manual'
      ? '数据长图已生成，请点击“保存到手机”。'
      : result === 'picker'
      ? '请选择保存位置，长图会写入所选文件夹。'
      : `数据长图已保存：${filename}`);
  } catch (error) {
    console.error(error);
    showToast(error instanceof Error ? error.message : '数据长图生成失败。', true);
  } finally {
    exporting = false;
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


function stamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
