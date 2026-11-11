import './base.css';
import './app.css';
import { buildActivity, formatDateParts, formatDuration, formatPace, formatSpeedKmh, type Activity } from './fit/activity';
import { parseFit } from './fit/parser';
import { parseGpx } from './gpx/parser';
import { parseTcx } from './tcx/parser';
import { activityToGpx, activityToTcx, mergeActivities, type TrackFormat } from './export/track';
import { activityToFit } from './export/fit';
import { saveBlob } from './export/save';
import { SAMPLE_FIT_BASE64, SAMPLE_NAME } from './data/sample';
import { TrackMap } from './render/map';
import { OverviewVectorLayer, VectorFollowLayer, clearVectorTileCache } from './render/vector-map';
import { clearBaseTileCache } from './render/tile-cache';
import { clearMapSnapshots } from './render/snapshot-cache';
import { MotionStage } from './render/stage';
import { THEMES, isThemeId, type ThemeId } from './render/theme';
import { bindTabbar, currentPane, showPane } from './ui/router';
import { initRecords, type RecordsApi } from './ui/records';
import { initImport, type ImportApi } from './ui/import-page';
import { initMerge, type MergeApi } from './ui/merge-page';
import { initTrash, type TrashApi } from './ui/trash-page';
import { showToast } from './ui/toast';
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
import { getSetting, setSetting } from './store/db';

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
      /** 检查 MediaStore 里的视频是否还存在（用户可能已在相册删除） */
      canShare?: (uri: string) => boolean;
      /** 定向分享：wechat=微信 douyin=抖音 空串=系统分享面板；目标未安装返回 false */
      shareUriTo?: (uri: string, mime: string, target: string) => boolean;
      /** 原生 OpenGL 预览：开始渲染（payload 与导出同一份） */
      nativePreviewStart?: (payloadJson: string) => void;
      /** 推进播放头（帧号） */
      nativePreviewFrame?: (frame: number) => void;
      /** 视频核心区域位置（CSS px） */
      nativePreviewRect?: (x: number, y: number, w: number, h: number) => void;
      /** 停止并释放原生预览 */
      nativePreviewStop?: () => void;
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
/** 当前创作页记录的 id（示例轨迹没有 id）；导出记录与分享按钮用它做键 */
let currentActivityId: string | null = null;
let currentMap: TrackMap | null = null;
let currentFollow: VectorFollowLayer | null = null;
let currentOverview: OverviewVectorLayer | null = null;
/** 成片视角：第一视角（跟随镜头）或全局视角（整条路线渐进描绘）。 */
type ViewMode = 'follow' | 'global';
let viewMode: ViewMode = 'follow';
/** 距离超过 300km 后锁定全局视角（第一视角瓦片走廊成本不可行）。 */
let viewLocked = false;
let cacheReady = false;

/**
 * 创作页会话缓存：记录列表 ⇄ 创作页来回切换时，同一条记录 + 同一主题
 * 直接复用上一轮已就绪的图层实例。图层实例里的 parsed/active/bitmaps/
 * labelCandidates 全是热缓存，重进等于零成本；不缓存的话 closeStudio 的
 * clear() 会把它们全丢掉，重进要重跑抓取→解码→预热→标签整条管线，
 * 表现为「同一条数据第二次进入还是卡一下、又看一遍缓存进度」。
 * 换记录 / 换主题 / 视角切换 / 清除缓存 / 重新导入都会使缓存失效。
 */
interface StudioSession {
  activityId: string;
  themeId: string;
  viewMode: ViewMode;
  /** 上一轮 prepareStudio 完整跑完（缓存门全过）才允许走复用捷径 */
  ready: boolean;
  map: TrackMap;
  follow: VectorFollowLayer | null;
  overview: OverviewVectorLayer;
}
let studioSession: StudioSession | null = null;

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

/* ── 原生 OpenGL 预览（Android App 专属）────────────────────────
 * 预览画面改由原生 NativeRouteScene 绘制——与导出成片是同一个渲染器，
 * WebView 创作页 stage 区域挖空，原生 SurfaceView 垫在下层透出画面。
 * 播放头仍由 JS 主导（背景音乐走 WebAudio），每帧把帧号推给原生。
 * 网页渲染管线保留作兜底：海报模式、老版本 App、原生失败时照旧走网页。 */
let glPreviewActive = false;
let glPreviewReady = false;
let glPreviewTotalFrames = 0;

/**
 * 预览渲染方式（设置页可切）：
 *  - auto：原生 OpenGL，SurfaceView 载体；个别机型挖洞黑屏时 App 会自动退到
 *    TextureView；
 *  - texture：强制用 TextureView 载体（兼容模式，给自动检测也失效的机型用）；
 *  - web：完全走网页 Canvas 渲染（老路径，最稳但帧率受瓦片加载影响）。
 */
type PreviewRenderer = 'auto' | 'texture' | 'web';
const PREVIEW_RENDERER_LABEL: Record<PreviewRenderer, string> = {
  auto: '原生 OpenGL',
  texture: '兼容模式 · TextureView',
  web: '网页 Canvas',
};
const PREVIEW_RENDERER_NEXT: Record<PreviewRenderer, PreviewRenderer> = {
  auto: 'texture',
  texture: 'web',
  web: 'auto',
};
let previewRenderer: PreviewRenderer = 'auto';

function loadPreviewRenderer(): void {
  void getSetting<PreviewRenderer>('preview.renderer', 'auto').then((value) => {
    if (value === 'texture' || value === 'web' || value === 'auto') {
      previewRenderer = value;
    }
    syncPreviewRendererUi();
  });
}

function syncPreviewRendererUi(): void {
  const label = document.getElementById('set-renderer');
  if (label) label.textContent = PREVIEW_RENDERER_LABEL[previewRenderer];
  const button = document.getElementById('set-renderer-btn');
  if (button) {
    button.textContent = previewRenderer === 'auto' ? '切换到兼容渲染' : '切换到下一个';
  }
}

/** 切换渲染方式：写设置 → 重建当前创作页预览（三种方式互斥）。 */
function cyclePreviewRenderer(): void {
  previewRenderer = PREVIEW_RENDERER_NEXT[previewRenderer];
  void setSetting('preview.renderer', previewRenderer);
  syncPreviewRendererUi();
  if (!currentStage) return;
  hideStageLoading();
  glPreviewReady = false;
  disengageGlPreview();
  if (previewRenderer === 'web') {
    // 回到网页渲染：把画布补画出来（原生接管期间 canvas 是隐藏的）
    currentStage.renderAt(playhead);
    drawAmbient();
    setStudioBusy(false);
    return;
  }
  engageGlPreview();
}

const glBridge = (): Window['FitMotionAndroid'] | null => {
  const bridge = window.FitMotionAndroid;
  return bridge && typeof bridge.nativePreviewStart === 'function' ? bridge : null;
};

/** 视频核心（9:16）在 stage-frame 内的实际位置；全屏与普通布局通用。 */
function stageCoreRect(): { x: number; y: number; width: number; height: number } {
  const frame = stageFrame.getBoundingClientRect();
  let width = frame.height * (9 / 16);
  let height = frame.height;
  if (width > frame.width) {
    width = frame.width;
    height = width * (16 / 9);
  }
  return { x: frame.left + (frame.width - width) / 2, y: frame.top, width, height };
}

function syncGlPreviewRect(): void {
  if (!glPreviewActive || !glBridge()) return;
  const rect = stageCoreRect();
  try {
    window.FitMotionAndroid?.nativePreviewRect?.(rect.x, rect.y, rect.width, rect.height);
  } catch { /* 老版本没有这个方法 */ }
}

function pushGlFrame(time: number): void {
  if (!glPreviewReady || !currentStage || glPreviewTotalFrames <= 0) return;
  const frame = Math.min(
    glPreviewTotalFrames - 1,
    Math.max(0, Math.round((time / currentStage.duration) * glPreviewTotalFrames)),
  );
  try {
    window.FitMotionAndroid?.nativePreviewFrame?.(frame);
  } catch { /* 老版本没有这个方法 */ }
}

/** 播放/拖动守卫：原生预览就绪后不必等网页瓦片缓存。 */
function canPlayback(): boolean {
  return cacheReady || (glPreviewActive && glPreviewReady);
}

function engageGlPreview(): void {
  if (previewRenderer === 'web') return;
  const bridge = glBridge();
  if (!bridge || !currentStage || !currentActivity || exporting) return;
  const date = currentActivity.timeAvailable ? formatDateParts(currentActivity.startTime) : null;
  const payload = nativeScenePayload(activeTheme(), date, currentStage.duration);
  payload.fps = 30;
  // auto 走 SurfaceView（失败由原生侧自动退 TextureView）；texture 直接指定兼容载体
  (payload as { renderer?: string }).renderer = previewRenderer === 'texture' ? 'texture' : 'surface';
  glPreviewActive = true;
  glPreviewReady = false;
  document.documentElement.classList.add('gl-preview');
  try {
    bridge.nativePreviewStart?.(JSON.stringify(payload));
  } catch {
    // 桥接异常：退回网页渲染
    glPreviewActive = false;
    document.documentElement.classList.remove('gl-preview');
    return;
  }
  syncGlPreviewRect();
}

function disengageGlPreview(): void {
  const wasActive = glPreviewActive;
  glPreviewActive = false;
  glPreviewReady = false;
  glPreviewTotalFrames = 0;
  document.documentElement.classList.remove('gl-preview');
  if (wasActive) {
    try { window.FitMotionAndroid?.nativePreviewStop?.(); } catch { /* ignore */ }
  }
}

/** 原生回调（经 FitMotionJS.nativePreviewReady）：ok=false 时退回网页渲染。 */
function glPreviewReadyCallback(ok: boolean, arg: number | string): void {
  if (!glPreviewActive) return;
  if (!ok) {
    glPreviewActive = false;
    glPreviewReady = false;
    document.documentElement.classList.remove('gl-preview');
    return;
  }
  const firstReady = !glPreviewReady;
  glPreviewReady = true;
  glPreviewTotalFrames = typeof arg === 'number' && arg > 0 ? arg : 0;
  hideStageLoading();
  setStudioBusy(false);
  syncGlPreviewRect();
  // 只有首次就绪才自动开播：App 切后台回来会重建 surface 并再次就绪，
  // 那时应保持暂停（与网页缓存版行为一致），只把画面恢复出来
  if (firstReady && !playing && !isStill && currentStage) startPlayback();
}

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
  loadPreviewRenderer();
  document.getElementById('set-renderer-btn')?.addEventListener('click', () => cyclePreviewRenderer());
  importer = initImport(async () => {
    await records?.reload();
    await refreshPanels();
  });
  merger = initMerge(async (outcome) => {
    await records?.reload();
    await refreshPanels();
    showToast(outcome.status === 'added'
      ? `已合并为「${outcome.name}」：${(outcome.distanceM / 1000).toFixed(1)} km · ${formatDuration(outcome.durationSec)}${outcome.repeated > 0 ? `（${outcome.repeated} 段同路线已去重）` : ''}`
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
    // 重新导入可能改写同一条记录的内容，会话缓存的图层实例必须作废
    studioSession = null;
    void records?.reload();
  });
  initMusic();
  initKeyboard();
  // 原生预览回调：keyboard 模块先建了 FitMotionJS 对象，这里往里补方法
  const fitJs = ((window as unknown as { FitMotionJS?: Record<string, unknown> }).FitMotionJS
    ??= {}) as Record<string, unknown>;
  fitJs.nativePreviewReady = (ok: boolean, arg?: number | string) => glPreviewReadyCallback(ok, arg ?? 0);
  // stage 位置跟着滚动/尺寸变，原生 SurfaceView 的摆位要同步跟上
  document.addEventListener('scroll', () => syncGlPreviewRect(), true);
  window.addEventListener('resize', () => syncGlPreviewRect());
  window.addEventListener('fitmotion:music-changed', () => {
    // 曲目变了：预渲染新缓冲；正在播放就从当前进度无缝切过去
    if (!currentStage) return;
    void (async () => {
      const token = studioToken;
      await musicPlayer.prepare(currentMusicId(), currentStage.duration);
      // 倍速播放时换曲也要按当前倍速接上，否则音乐会慢半拍
      if (playing && token === studioToken) await musicPlayer.play(playhead, Math.max(1, exportSpeed));
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
    // 记录页批量选择模式：返回键先退出多选，不退出页面
    if (records?.exitSelectingIfActive()) return true;
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
  byId<HTMLButtonElement>('export-track-fit').addEventListener('click', () => void exportTrack('fit'));
  byId<HTMLButtonElement>('export-track-gpx').addEventListener('click', () => void exportTrack('gpx'));
  byId<HTMLButtonElement>('export-track-tcx').addEventListener('click', () => void exportTrack('tcx'));
  // 保存路线图 PNG（原 >300km 海报模式保留为副选项，任意视角可用）
  byId<HTMLButtonElement>('export-poster-btn').addEventListener('click', () => {
    void exportPoster();
  });
  // 视角切换：>300km 锁定全局（按钮隐藏），其余两种视角自由切换
  byId<HTMLButtonElement>('view-toggle').addEventListener('click', toggleViewMode);
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
      if (!exporting && currentStage && canPlayback()) {
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
  // 常驻分享按钮：直接唤起系统分享面板
  byId<HTMLButtonElement>('share-video-btn').addEventListener('click', () => {
    shareExportedVideo();
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
  // 同一条记录 + 同一主题 + 同一模式 → 复用上一轮图层实例（即使上一轮没
  // 跑完也复用：抓了一半的进度作废重来更亏）。键不匹配才整套重建。
  const sessionId = currentActivityId;
  const sessionHit = !!(studioSession && sessionId !== null
    && studioSession.activityId === sessionId
    && studioSession.themeId === theme.id
    && studioSession.viewMode === viewMode);
  if (sessionHit && studioSession) {
    currentMap = studioSession.map;
    currentFollow = studioSession.follow;
    currentOverview = studioSession.overview;
  } else {
    currentMap = new TrackMap(activity, theme, () => {
      if (currentStage) currentStage.renderAt(playhead);
    });
    // 全局视角不需要第一视角瓦片走廊（那是 >300km 不可行的成本大头），
    // 只有第一视角模式才建跟随层并抓 z15/16 瓦片。
    currentFollow = viewMode === 'follow' ? new VectorFollowLayer(activity, theme, currentMap) : null;
    currentOverview = new OverviewVectorLayer(theme, currentMap);
    studioSession = {
      activityId: sessionId ?? '',
      themeId: theme.id,
      viewMode,
      ready: false,
      map: currentMap,
      follow: currentFollow,
      overview: currentOverview,
    };
  }
  currentStage = new MotionStage(stageCanvas, activity, currentMap, theme, currentFollow ?? undefined, viewMode === 'global');
  currentStage.setOverview(currentOverview);
  cacheMark(sessionHit ? 'session-hit' : 'session-miss');
  (window as unknown as { __fmSession?: StudioSession | null }).__fmSession = studioSession;
  (window as unknown as { __fitStage?: MotionStage }).__fitStage = currentStage;
  setCacheReady(false);
  setStudioBusy(true);
  applyStudioModeUi();
  currentStage.renderAt(at);
  drawAmbient();
  updateTransport();
  syncExportSpeedUi();
  // 音乐缓冲在地图缓存的网络空档里悄悄渲染好，点播放立刻有声（全局视角
  // 也是视频，同样配乐）
  void musicPlayer.prepare(currentMusicId(), currentStage.duration);
  // 原生预览跟着每次挂载重建（换记录/换主题 payload 都变了）
  engageGlPreview();
  void prepareStudio(activity, theme, token, at, resume, sessionHit);
}

function applyStudioModeUi(): void {
  const device = byId<HTMLElement>('stage-device');
  const exportButton = byId<HTMLButtonElement>('export-btn');
  const help = byId<HTMLElement>('export-help');
  const toggle = byId<HTMLButtonElement>('view-toggle');
  toggle.hidden = viewLocked;
  toggle.classList.toggle('on', viewMode === 'global');
  toggle.title = viewMode === 'global'
    ? '当前：全局视角 · 点击切换第一视角'
    : '当前：第一视角 · 点击切换全局视角';
  toggle.setAttribute('aria-label', toggle.title);
  if (viewMode === 'global') {
    device.textContent = '全局视角 · 1080P MP4';
    exportButton.innerHTML = '<svg><use href="#i-download"/></svg> 导出 1080P MP4';
    help.innerHTML = '1080 × 1920 · 30FPS · MP4 · 全局视角回放完整路线'
      + (viewLocked ? '（超过 300 公里仅支持全局视角）' : '');
  } else {
    device.textContent = `${activeTheme().label} · 1080P MP4`;
    exportButton.innerHTML = '<svg><use href="#i-download"/></svg> 导出 1080P MP4';
    help.innerHTML = '1080 × 1920 · 30FPS · MP4 · 导出时请保持此页面在前台';
  }
}

/** 切换视角：重建创作页（缓存会话按视角区分），播放头与播放状态尽量保留。 */
function toggleViewMode(): void {
  if (viewLocked || exporting) return;
  viewMode = viewMode === 'global' ? 'follow' : 'global';
  showToast(viewMode === 'global' ? '已切换到全局视角。' : '已切换到第一视角。');
  if (currentActivity) rebuildStudioTheme();
  else applyStudioModeUi();
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
  // 原生预览已就绪后，网页缓存进度不再把加载层盖回画面上
  if (glPreviewReady) return;
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

/**
 * 创作页准备阶段的性能打点。performance.mark 本身几乎零成本，
 * 留着方便用 performance.getEntriesByType('mark') 定位「哪一步慢」。
 */
function cacheMark(step: string, detail?: Record<string, unknown>): void {
  try {
    performance.mark(`fm:cache:${step}`, detail ? { detail } : undefined);
  } catch {
    /* 老 WebView 没有 performance.mark，忽略 */
  }
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
  reused = false,
): Promise<void> {
  const map = currentMap;
  const stage = currentStage;
  const follow = currentFollow;
  const overview = currentOverview;
  if (!map || !stage) return;
  try {
    cacheMark('start');
    // 会话复用捷径：同一条记录的图层实例还热着（瓦片已抓齐、位图已预热、
    // 标签缓存已建好），整条抓取→解码→预热管线直接跳过，几百毫秒内出画面。
    const sessionReady = reused && studioSession?.ready && map.usingTiles
      && (!follow || follow.ready) && (overview ? overview.ready : false);
    cacheMark('reuse-check', {
      detail: {
        reused: reused ? 1 : 0,
        ready: studioSession?.ready ? 1 : 0,
        usingTiles: map.usingTiles ? 1 : 0,
        followReady: follow ? (follow.ready ? 1 : 0) : -1,
        overviewReady: overview ? (overview.ready ? 1 : 0) : -1,
        overviewStats: overview?.prefetchStats ?? null,
      },
    });
    cacheMark(sessionReady ? 'reuse-hit' : 'reuse-miss');
    if (!sessionReady) {
      showCacheProgress('正在缓存地图瓦片', 0);
      // 三个抓取任务相互独立（栅格底图 / 矢量总览 / 第一视角瓦片），全部并行。
      // 旧的串行写法把每段的耗时加在一起，并行后总耗时 ≈ 最慢的一段。
      // 全局视角不抓第一视角瓦片，也不抓栅格底图：它全程只画总览层
      // （栅格只作总览失败时的兜底，用的是构造时画好的艺术底图），
      // 少一路下载还能把带宽让给总览瓦片。
      const ratios = { raster: 0, overview: 0, follow: 0 };
      const reportFetch = (label: string): void => {
        const combined = viewMode === 'follow'
          ? ratios.follow * 0.5 + ratios.overview * 0.3 + ratios.raster * 0.2
          : viewMode === 'global'
            ? ratios.overview
            : ratios.overview * 0.6 + ratios.raster * 0.4;
        showCacheProgress(label, combined * 0.85);
      };
      const rasterTask = viewMode === 'global'
        ? Promise.resolve().then(() => cacheMark('raster-skipped'))
        : map.loadTiles((progress) => {
          if (token !== studioToken) return;
          ratios.raster = progress;
          reportFetch('正在缓存地图瓦片');
        }).then(() => cacheMark('raster-done'));
      // The vector overview is what the cover/result frames actually paint.
      const overviewTask = (overview
        ? overview.prefetch((done, total) => {
          if (token !== studioToken) return;
          ratios.overview = total ? done / total : 1;
          reportFetch('正在缓存地图瓦片');
        })
        : Promise.resolve()).then(() => cacheMark('overview-fetched'));
      // 第一视角瓦片是纯网络抓取（解码在 primeAll 里），不必等前两个任务。
      const followFetchTask = (viewMode === 'follow' && follow
        ? follow.prefetch((done, total) => {
          if (token !== studioToken) return;
          ratios.follow = total ? done / total : 1;
          reportFetch('正在缓存地图瓦片');
        })
        : Promise.resolve()).then(() => cacheMark('follow-fetched'));
      await Promise.all([rasterTask, overviewTask, followFetchTask]);
      cacheMark('tiles-fetched');
      if (token !== studioToken) return;
      if (!map.usingTiles && !overview?.ready) throw new Error('总览地图缓存不完整');

      if (viewMode === 'follow' && follow) {
        showCacheProgress('正在解码第一视角地图', 0.85);
        await follow.primeAll((done, total) => {
          if (token !== studioToken) return;
          showCacheProgress('正在解码第一视角地图', 0.85 + (total ? done / total : 1) * 0.08);
        });
        stage.setFollow(follow);
      }
      cacheMark('follow-primed');

      // 逐张预热瓦片位图（每张让出主线程）。不预热的话，缓存完成后的第一帧要
      // 现烤十几张瓦片（页面冻住一两秒、点播放没反应）；末帧整帧还会被
      // posterCache 截走，截到缺块的画面就再也补不回来了。
      const warmBase = viewMode === 'follow' ? 0.93 : 0.85;
      const warmSpan = viewMode === 'follow' ? 0.07 : 0.15;
      if (overview) {
        showCacheProgress('正在生成地图画面', warmBase);
        let overviewTiles = 0;
        await overview.warmBitmaps(stage.resultCameraScale, (done, total) => {
          overviewTiles = total;
          if (token !== studioToken) return;
          showCacheProgress('正在生成地图画面', warmBase + (total ? done / total : 1) * warmSpan * 0.2);
        });
        cacheMark('overview-warm', { tiles: overviewTiles, px: overview.lastRasterSize });
        // 地名/国道标签候选也要在缓存阶段解码好，否则封面和成绩卡每帧都要
        // 对全城瓦片跑 loadGeometry()，一帧几百毫秒（页面冻结、时间显示冻住）
        let labelTiles = 0;
        await overview.buildLabelCache((done, total) => {
          labelTiles = total;
          if (token !== studioToken) return;
          showCacheProgress('正在生成地图画面', warmBase + warmSpan * (0.2 + (total ? done / total : 1) * 0.1));
        });
        cacheMark('labels-built', { tiles: labelTiles });
      }
      if (viewMode === 'follow' && follow) {
        let followTiles = 0;
        await follow.warmBitmaps(stage.followCameraScale, (done, total) => {
          followTiles = total;
          if (token !== studioToken) return;
          showCacheProgress('正在生成地图画面', warmBase + warmSpan * 0.3 + (total ? done / total : 1) * warmSpan * 0.7);
        });
        cacheMark('follow-warm', { tiles: followTiles });
      }
    }

    if (token !== studioToken) return;
    if (studioSession && studioSession.map === map) studioSession.ready = true;
    setCacheReady(true);
    setStudioBusy(false);
    // 首帧（含总览标签碰撞、海报缓存等一次性成本）必须在加载层还没揭掉时
    // 画完，否则用户看到的是「缓存 100% 后页面冻一下才开始播」。
    playhead = at;
    stage.renderAt(playhead);
    cacheMark('first-frame');
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
    if (!isStill) {
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
    await Promise.all([clearBaseTileCache(), clearVectorTileCache(), clearMapSnapshots()]);
    // 瓦片全没了，会话缓存里热着的图层实例自然也要作废
    studioSession = null;
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
    openStudio(activity, meta.id);
  } catch (error) {
    console.error(error);
    showToast(errorMessage(error), true);
  }
}

async function saveTrack(activity: Activity, format: TrackFormat): Promise<void> {
  if (!activity.points.length) {
    throw new Error('这条记录没有轨迹点，无法导出（可能轨迹还没同步到本机，联网后重试）');
  }
  const content = format === 'gpx' ? activityToGpx(activity)
    : format === 'tcx' ? activityToTcx(activity)
      : activityToFit(activity);
  const mime = format === 'gpx' ? 'application/gpx+xml'
    : format === 'tcx' ? 'application/vnd.garmin.tcx+xml' : 'application/octet-stream';
  const filename = `${activity.title}-${format}.${format}`;
  await saveBlob(new Blob([content as BlobPart], { type: mime }), filename, mime);
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

function openStudio(activity: Activity, id: string | null = null): void {
  pausePlayback();
  currentActivity = activity;
  currentActivityId = id;
  // >300km 锁定全局视角：第一视角成片的瓦片走廊成本随里程暴涨，不可行
  viewLocked = activity.distanceM > MAX_VIDEO_METERS;
  viewMode = viewLocked ? 'global' : 'follow';
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
  studio.classList.remove('is-busy', 'fs');
  disengageGlPreview();
  // 注意：不再 clear() 图层实例。实例由 studioSession 持有，同一条记录
  // 二次进入直接复用热缓存；换记录/换主题时实例被整体替换，GC 回收。
  // 旧写法在这里 clear() 等于把会话缓存当场清空，重进必然重跑整条管线。
  currentFollow = null;
  currentOverview = null;
  currentStage = null;
  currentMap = null;
  currentActivity = null;
  currentActivityId = null;
  setCacheReady(false);
  playhead = 0;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 跨天时长用「N 天 H 小时」；天以内沿用 HH:MM:SS。 */
function formatTripSpan(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 86400) return formatDuration(total, true);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

function tripKmText(meters: number): string {
  const km = meters / 1000;
  return km >= 100 ? `${km.toFixed(0)}` : km.toFixed(1);
}

/**
 * 合并行程卡片：多日行程的每天、同一条路线骑了几次。
 * 重复路线在地图上只画一条，这里把「第几次」与当次极值摊开给用户看。
 */
function renderTripCard(activity: Activity): void {
  const card = document.getElementById('trip-card');
  if (!card) return;
  const trip = activity.trip;
  if (!trip || trip.legs.length < 2) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const days = new Set(trip.legs.map((leg) => new Date(leg.start).toDateString())).size;
  const allRepeat = trip.repeated === trip.legs.length - 1;
  const kind = allRepeat ? '同一路线多次骑行' : trip.multiDay ? '多日行程' : '合并行程';

  const title = document.getElementById('trip-title');
  const sub = document.getElementById('trip-sub');
  const badge = document.getElementById('trip-badge');
  const list = document.getElementById('trip-legs');
  const note = document.getElementById('trip-note');
  if (title) title.textContent = kind;
  if (sub) {
    sub.textContent = `${days > 1 ? `${days} 天 · ` : ''}${trip.legs.length} 段 · 合计 ${tripKmText(trip.totalMeters)} km · ${formatTripSpan(trip.totalMovingSec)}`;
  }
  if (badge) badge.textContent = trip.repeated > 0 ? `${trip.repeated} 段同路线` : '逐段接续';

  if (list) {
    list.innerHTML = trip.legs.map((leg) => {
      const date = new Date(leg.start);
      const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
      const tag = leg.repeat
        ? (leg.repeatOf ? `同 D${leg.repeatOf}` : '同路线')
        : leg.index === 1 ? '起' : '接续';
      return `<li class="trip-leg${leg.repeat ? ' is-repeat' : ''}">
        <span class="tl-day">D${leg.index}</span>
        <span class="tl-date">${mmdd}</span>
        <span class="tl-km">${tripKmText(leg.distanceM)} km · ${formatTripSpan(leg.movingSec)}</span>
        <span class="tl-tag">${tag}</span>
      </li>`;
    }).join('');
  }

  if (note) {
    const lines: string[] = [];
    if (trip.repeated > 0) {
      lines.push(`重复路线在地图上只绘制一次，播放也只走一遍；${trip.legs.length} 段骑行的最快速度、最高心率、最高海拔已取最优值展示。`);
    }
    if (trip.multiDay) {
      const chained = trip.legs.some((leg) => !leg.repeat && leg.index > 1);
      if (chained) {
        const limit = trip.linkLimitM > 0 ? ` ≤ ${(trip.linkLimitM / 1000).toFixed(0)} km` : '';
        lines.push(`共 ${days} 天，相邻两段首尾相接（衔接距离${limit}），轨迹按天连续拼接。`);
      } else {
        lines.push(`共 ${days} 天，同一条路线分 ${trip.legs.length} 次骑完。`);
      }
    }
    note.textContent = lines.join(' ');
  }
}

function populateSide(activity: Activity): void {
  const date = activity.timeAvailable ? formatDateParts(activity.startTime) : null;
  const trip = activity.trip;
  // 合并行程：界面上的「总距离/总时长/极值」按真实总量走，播放进度仍按实际
  // 绘制的那一遍（activity.distanceM）推进。
  const totalMeters = trip?.totalMeters ?? activity.distanceM;
  const totalMoving = trip?.totalMovingSec ?? activity.movingSec;
  const totalElapsed = trip?.totalElapsedSec ?? activity.elapsedSec;
  const maxSpeed = trip?.best.maxSpeed ?? activity.maxSpeed;
  const maxHr = trip?.best.maxHeartRate ?? activity.maxHeartRate;
  const maxAlt = trip?.best.maxAltitude ?? activity.maxAltitude;
  const avgSpeed = trip && trip.totalMovingSec > 0 ? trip.totalMeters / trip.totalMovingSec : activity.avgSpeed;

  byId<HTMLElement>('activity-title').textContent = activity.title;
  byId<HTMLElement>('activity-sub').textContent = date
    ? `${activity.place}  ·  ${date.date} ${date.time}${trip && trip.multiDay ? `  ·  ${new Set(trip.legs.map((leg) => new Date(leg.start).toDateString())).size} 天` : ''}`
    : activity.place;
  byId<HTMLElement>('max-hr').textContent = activity.heartRateAvailable && maxHr
    ? String(Math.round(maxHr))
    : '--';
  byId<HTMLElement>('max-speed').textContent = activity.maxSpeedAvailable
    ? formatSpeedKmh(maxSpeed)
    : '--';
  byId<HTMLElement>('total-distance').textContent = (totalMeters / 1000).toFixed(2);
  byId<HTMLElement>('total-duration').textContent = activity.durationAvailable
    ? formatTripSpan(totalMoving)
    : '--';
  byId<HTMLElement>('total-elapsed').textContent = activity.elapsedAvailable
    ? formatTripSpan(totalElapsed)
    : '--';
  setMetric('avg-hr', 'avg-hr-unit', activity.avgHeartRate ? String(Math.round(activity.avgHeartRate)) : '--', '次/分');
  setMetric('avg-speed', 'avg-speed-unit', activity.avgSpeedAvailable ? formatSpeedKmh(avgSpeed) : '--', 'km/h');
  setMetric('max-altitude', 'max-altitude-unit',
    activity.altitudeAvailable && maxAlt != null ? String(Math.round(maxAlt)) : '--', '米');
  setMetric('calories', 'calories-unit', activity.calories != null ? String(Math.round(activity.calories)) : '--', '千卡');
  byId<HTMLElement>('stage-device').textContent = `${activeTheme().label} · 1080P MP4`;
  renderTripCard(activity);
}

/* ── 导出记录与常驻分享按钮 ─────────────────────────────────────── */

interface VideoExportRecord {
  uri: string;
  mime: string;
  at: number;
}

const EXPORTS_KEY = 'fitmotion.video-exports.v1';

function readVideoExports(): Record<string, VideoExportRecord> {
  try {
    return JSON.parse(localStorage.getItem(EXPORTS_KEY) ?? '{}') as Record<string, VideoExportRecord>;
  } catch {
    return {};
  }
}

function recordVideoExport(id: string, uri: string): void {
  const all = readVideoExports();
  all[id] = { uri, mime: 'video/mp4', at: Date.now() };
  try {
    localStorage.setItem(EXPORTS_KEY, JSON.stringify(all));
  } catch {
    // 存不下就算了，分享按钮这次不亮
  }
}

/**
 * 分享按钮常驻：直接唤起系统分享面板（不再让用户选微信/抖音）。
 * 视频被删掉或压根没导出过时，提示先导出，而不是静默失败。
 */
function shareExportedVideo(): void {
  const bridge = window.FitMotionAndroid;
  const record = currentActivityId ? readVideoExports()[currentActivityId] : undefined;
  if (!record || !bridge?.shareUriTo || !bridge.canShare?.(record.uri)) {
    showToast('请先导出视频再分享', true);
    return;
  }
  if (!bridge.shareUriTo(record.uri, record.mime, '')) {
    showToast('分享面板拉起失败，可在相册里分享。', true);
  }
}

/** 数据面板：主值填 <b>，单位填旁边的 <em>；值缺失时单位一起隐藏。 */
function setMetric(valueId: string, unitId: string, value: string, unit: string): void {
  byId<HTMLElement>(valueId).textContent = value;
  const unitEl = document.getElementById(unitId);
  if (unitEl) {
    unitEl.textContent = value === '--' ? '' : unit;
    unitEl.hidden = value === '--';
  }
}

/** 进入全屏播放：舞台铺满屏幕，自动从当前进度续播。 */
function enterFullScreen(): void {
  if (!currentStage || !canPlayback()) return;
  fsActive = true;
  studio.classList.add('fs');
  const title = document.getElementById('fs-title');
  if (title) title.textContent = currentActivity?.title ?? '';
  syncFsThemeTag(activeTheme().label);
  updateTransport();
  syncGlPreviewRect();
  if (!playing) startPlayback();
}

/** 退出全屏：回到创作页布局，播放暂停。 */
function exitFullScreen(): void {
  if (!fsActive) return;
  fsActive = false;
  studio.classList.remove('fs');
  pausePlayback();
  syncGlPreviewRect();
}

function togglePlay(): void {
  if (!currentStage || !canPlayback()) return;
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
  if (!currentStage || playing || !canPlayback()) return;
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
  // 测试钩子：预览播放头（供 e2e 工具采样，无运行时成本）
  (window as unknown as { __fitPlayhead?: number }).__fitPlayhead = playhead;
  // 预览倍速与导出倍速共用 exportSpeed（同一选中态）：预览按倍速推进播放头，
  // 导出成片同样按倍速压缩时间线，两边看到的节奏一致。
  // 播放头逐帧推进并限幅（单帧最多走 1.5s×倍速）：限幅只拦截「主线程被
  // 冻住几秒」的墙钟跳变（表现为进度条突然跳到中间）。上限不能压到 0.25s：
  // 长轨迹在手机上单帧渲染经常超过 250ms，限幅会把画面时间线拉长 20%+，
  // 而音乐缓冲走真实墙钟不受限幅——结果就是「音乐提前放完、画面还剩好几秒」。
  const rate = Math.max(1, exportSpeed);
  const wallDelta = (now - baseWall) / 1000;
  const clamped = wallDelta * rate > 1.5 * rate;
  const next = basePlayhead + Math.min(1.5 * rate, wallDelta * rate);
  if (next >= currentStage.duration) {
    playhead = currentStage.duration;
    if (glPreviewActive && glPreviewReady) pushGlFrame(playhead);
    else currentStage.renderAt(playhead);
    playing = false;
    musicPlayer.stop();
    updatePlayButton();
    updateTransport();
    return;
  }
  playhead = next;
  basePlayhead = playhead;
  baseWall = now;
  if (glPreviewActive && glPreviewReady) {
    // 画面由原生渲染：本帧只推帧号，省掉整幅 Canvas 重绘
    pushGlFrame(playhead);
  } else {
    currentStage.renderAt(playhead);
    drawAmbient();
  }
  // 真发生了限幅（冻结/极端卡顿）：画面时间线与音乐墙钟脱节，把音乐拉回播放头
  if (clamped && musicPlayer.playing()) {
    void syncMusicToPlayhead();
  }
  updateTransport();
  raf = requestAnimationFrame(tick);
}

function renderCurrent(time: number): void {
  if (!currentStage) return;
  if (glPreviewActive && glPreviewReady) {
    pushGlFrame(time);
  } else {
    currentStage.renderAt(time);
    drawAmbient();
  }
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
  if (fsActive || !currentStage || !currentFollow) return;
  const ctx = ambientCanvas.getContext('2d');
  if (!ctx) return;
  const frameRect = stageFrame.getBoundingClientRect();
  // 原生预览模式下网页核心画布被隐藏（getBoundingClientRect 会是 0），
  // 核心矩形改用 9:16 数学推算，与原生 SurfaceView 的摆位完全一致
  const coreRect = glPreviewActive
    ? stageCoreRect()
    : stageCanvas.getBoundingClientRect();
  const coreLeftCss = glPreviewActive
    ? coreRect.x - frameRect.left
    : (frameRect.width - coreRect.width) / 2;
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
  }
  // 只压暗核心两侧的条带，不盖住核心区域，避免中缝出现明暗分界。
  // 之前 0.68 太重，明亮主题下两侧几乎成黑边，观感是「视频两边大片空白」；
  // 0.42 保留主次关系（两侧仍明显比核心暗）但能看清是地图延续。
  const coreLeft = Math.round(coreLeftCss * dpr);
  const coreWidth = Math.round(coreRect.width * dpr);
  ctx.fillStyle = 'rgba(4, 7, 10, 0.42)';
  if (coreLeft > 0) ctx.fillRect(0, 0, coreLeft, height);
  const rightStart = coreLeft + coreWidth;
  if (rightStart < width) ctx.fillRect(rightStart, 0, width - rightStart, height);
  if (glPreviewActive) {
    // 核心区域必须完全透明：原生 SurfaceView 在 WebView 下层透出画面，
    // 延展地图画布哪怕画了一个像素都会盖在原生画面上
    ctx.clearRect(coreLeft, 0, coreWidth, height);
  }
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
  // 合并行程：轨迹只画一遍（distanceMeters 供进度/公里刻度），成绩卡与 HUD
  // 用 displayMeters / 真实时长 / 聚合极值，和创作页的数据卡保持一致。
  const trip = activity.trip;
  const displayMeters = trip?.totalMeters ?? activity.distanceM;
  const movingSec = trip?.totalMovingSec ?? activity.movingSec;
  const elapsedSec = trip?.totalElapsedSec ?? activity.elapsedSec;
  const maxSpeed = trip?.best.maxSpeed ?? activity.maxSpeed;
  const maxHeart = trip?.best.maxHeartRate ?? activity.maxHeartRate;
  const maxAltitude = trip?.best.maxAltitude ?? activity.maxAltitude;
  const avgSpeed = trip && trip.totalMovingSec > 0
    ? trip.totalMeters / trip.totalMovingSec
    : activity.avgSpeed;
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    bitrate: 4_000_000,
    durationSec: durationSec,
    activityDurationSec: activity.durationSec,
    // 尾页数据口径：运动时长用 movingSec（不含停留），总时长用 elapsedSec
    movingDurationSec: movingSec,
    elapsedDurationSec: elapsedSec,
    elapsedAvailable: activity.elapsedAvailable,
    title: activity.title,
    subtitle: date ? `${activity.place} · ${date.date}` : activity.place,
    place: activity.place,
    startText: date ? `开始 ${date.date.slice(5)}  ${date.time}` : '',
    distance: (displayMeters / 1000).toFixed(2),
    distanceMeters: activity.distanceM,
    displayMeters,
    maxSpeed: formatSpeedKmh(maxSpeed),
    avgSpeed: activity.avgSpeedAvailable ? formatSpeedKmh(avgSpeed) : '',
    maxHeart: maxHeart ? String(Math.round(maxHeart)) : '—',
    maxAltitude: maxAltitude != null ? String(Math.round(maxAltitude)) : '—',
    calories: activity.calories != null ? String(Math.round(activity.calories)) : '',
    duration: activity.durationAvailable ? formatDuration(activity.durationSec) : '—',
    theme: theme.id,
    themeRoute: theme.route,
    // 成片视角：原生侧据此钉住全景相机并跳过 z14 走廊预光栅
    globalView: viewMode === 'global',
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
  // 导出要自建一份原生地图实例（约百兆级），预览先让路，结束后再恢复
  disengageGlPreview();
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
    if (result.uri && currentActivityId) {
      // 记录导出结果：分享按钮据此找到最近一次导出的视频
      recordVideoExport(currentActivityId, result.uri);
      showToast('视频已保存到手机相册，可用「分享视频给好友」发送。');
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
      if (glPreviewActive && glPreviewReady) pushGlFrame(playhead);
      else currentStage.renderAt(playhead);
      updateTransport();
    }
    engageGlPreview();
  }
}

async function exportCurrent(): Promise<void> {
  // 全局视角 / 第一视角都出 MP4 视频；路线图 PNG 走「保存路线图」副按钮。
  await exportVideo();
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

    // 详细数据：与创作页数据卡完全同序、同口径（每行两列）。
    // 缺失的指标保留占位（--），让卡片数量与顺序在任何记录上都一致。
    const details: Array<[string, string, string]> = [
      ['总距离', (activity.distanceM / 1000).toFixed(2), '公里'],
      ['总时长', activity.elapsedAvailable ? formatDuration(activity.elapsedSec, true) : '--', '时:分:秒'],
      ['运动时长', activity.durationAvailable ? formatDuration(activity.movingSec, true) : '--', '时:分:秒'],
      ['最快速度', activity.maxSpeedAvailable ? formatSpeedKmh(activity.maxSpeed) : '--', 'km/h'],
      ['平均速度', activity.avgSpeedAvailable ? formatSpeedKmh(activity.avgSpeed) : '--', 'km/h'],
      ['最高心率', activity.heartRateAvailable && activity.maxHeartRate ? String(activity.maxHeartRate) : '--', '次/分'],
      ['平均心率', activity.heartRateAvailable && activity.avgHeartRate != null
        ? String(Math.round(activity.avgHeartRate)) : '--', '次/分'],
      ['消耗热量', activity.calories != null ? String(Math.round(activity.calories)) : '--', '千卡'],
      ['最高海拔', activity.altitudeAvailable && activity.maxAltitude != null
        ? String(Math.round(activity.maxAltitude)) : '--', '米'],
    ];

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
      // 奇数项时最后一张拉通整行，与创作页数据卡一致
      const full = details.length % 2 === 1 && i === details.length - 1;
      const cardW = full ? W - pad * 2 : colW;
      const x = pad + (full ? 0 : col * (colW + 24));
      const top = y + row * 116;
      ctx.fillStyle = hexToRgba(theme.text, 0.045);
      roundRect(x, top, cardW, 104, 20);
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
      if (details[i][1] === '--') continue;
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
