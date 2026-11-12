/**
 * 年度骑行回顾：Wrapped 式全屏翻卡 + 年度成绩图导出。
 *
 * 入口在记录页顶栏（records.ts）。数据由 src/stats/year-review.ts 聚合，
 * 这里只负责呈现与导出。卡片数量按数据自适应（没有常骑路线/最长单骑时
 * 跳过对应卡），翻页支持左右滑动和方向键。
 *
 * 视觉跟随明暗主题（--page/--card/--accent 等变量），亮色主题下整页
 * 翻成亮色；成绩图导出同样在运行时读取主题变量取色。
 */

import { computeYearReview, distanceAnalogy, type RidePeak, type YearReview } from '../stats/year-review';
import { saveBlob } from '../export/save';
import { showToast } from './toast';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const fmtKm = (meters: number, digits = 0): string => {
  const km = meters / 1000;
  const text = digits > 0 ? km.toFixed(digits) : Math.round(km).toString();
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
const fmtHours = (seconds: number): number => Math.round(seconds / 3600);
const pad = (value: number): string => String(value).padStart(2, '0');
const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

let open = false;
let busy = false;
let index = 0;
let review: YearReview | null = null;

export async function openYearReview(preferredYear?: number): Promise<void> {
  if (open || busy) return;
  open = true;
  const overlay = $('year-review');
  const deck = $('yr-deck');
  overlay.hidden = false;
  deck.innerHTML = `<div class="yr-loading">
    <span class="spin"></span>
    <b>正在统计你的年度骑行</b>
    <i>汇总里程、天数与常骑路线…</i>
  </div>`;

  // 目标年份：优先显式指定，其次取有数据的最新一年
  let year = preferredYear ?? 0;
  if (!year) {
    const now = new Date();
    for (let y = now.getFullYear(); y >= now.getFullYear() - 6; y -= 1) {
      const data = await computeYearReview(y);
      if (data) {
        review = data;
        break;
      }
      if (y === now.getFullYear() - 6) {
        deck.innerHTML = `<div class="yr-loading empty">还没有可回顾的骑行记录。</div>`;
        return;
      }
    }
  } else {
    review = await computeYearReview(year);
  }
  if (!review) {
    deck.innerHTML = `<div class="yr-loading empty">还没有可回顾的骑行记录。</div>`;
    return;
  }
  renderDeck(review);
  go(0);
}

export function yearReviewOpen(): boolean {
  return open;
}

export function closeYearReview(): void {
  if (!open) return;
  open = false;
  $('year-review').hidden = true;
}

/* ── 卡片构建 ─────────────────────────────────────────────── */

const eyebrow = (text: string): string => `<div class="yr-eyebrow">${text}</div>`;
const srcNote = (text: string): string => `<div class="yr-src">${text}</div>`;

function statCard(eyebrowText: string, big: string, cap: string, stats: Array<[string, string]>, note: string): string {
  return `${eyebrow(eyebrowText)}
    <div class="yr-big">${big}</div>
    <div class="yr-cap">${cap}</div>
    <div class="yr-stat-row">${stats.map(([v, k]) => `<div class="yr-stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('')}</div>
    ${srcNote(note)}`;
}

function miniRouteSvg(sketch: Array<{ lat: number; lon: number }>): string {
  if (sketch.length < 2) return '';
  let minLat = 90; let maxLat = -90; let minLon = 180; let maxLon = -180;
  for (const p of sketch) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  const W = 340; const H = 190; const padX = 22; const padY = 20;
  const spanLat = Math.max(maxLat - minLat, 1e-6);
  const spanLon = Math.max(maxLon - minLon, 1e-6);
  const scale = Math.min((W - padX * 2) / spanLon, (H - padY * 2) / spanLat);
  const offX = (W - spanLon * scale) / 2;
  const offY = (H - spanLat * scale) / 2;
  const project = (p: { lat: number; lon: number }): [number, number] => [
    offX + (p.lon - minLon) * scale,
    H - (offY + (p.lat - minLat) * scale),
  ];
  const pts = sketch.map(project);
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [sx, sy] = pts[0];
  const [ex, ey] = pts[pts.length - 1];
  // 颜色由 CSS 类驱动（.yr-mini svg .route/.start/.end），跟随主题
  return `<svg viewBox="0 0 ${W} ${H}">
    <path class="route" d="${d}"/>
    <circle class="start" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5"/>
    <circle class="end" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="5"/>
  </svg>`;
}

/** 迷你条形组：max 高亮 + 顶上标数，周节奏与时段共用。 */
function barGroup(values: number[], labels: string[], topText: (value: number) => string): string {
  const max = Math.max(...values, 1);
  const top = values.indexOf(Math.max(...values));
  const bars = values.map((value, i) => {
    const height = value > 0 ? Math.max(4, (value / max) * 100) : 2;
    return `<div class="yr-bar${i === top ? ' top' : ''}"><div class="col" style="height:${height.toFixed(1)}%"><span class="val">${i === top ? topText(value) : ''}</span></div><div class="m">${labels[i]}</div></div>`;
  }).join('');
  return `<div class="yr-bars compact">${bars}</div>`;
}

/**
 * 骑行日历：53 周 × 7 天的里程热力格。一列一周，周一在最上，
 * 颜色越亮当天骑得越远 —— 一眼看出「哪几个月在骑」。
 * 格子颜色走 CSS 类（.yr-heat rect.h0~h3），跟随主题；
 * 类名同时解决 base.css 全局 svg 描边污染小格子的问题。
 */
function heatmapBlock(review: YearReview): string {
  const cell = 5.4;
  const gap = 1;
  const step = cell + gap;
  const offset = (new Date(review.year, 0, 1).getDay() + 6) % 7;
  const max = Math.max(...review.heat, 1);
  const rects: string[] = [];
  for (let day = 0; day < review.heat.length; day += 1) {
    const meters = review.heat[day] ?? 0;
    const slot = day + offset;
    const col = Math.floor(slot / 7);
    const row = slot % 7;
    if (col > 52) continue;
    const ratio = meters / max;
    const level = meters <= 0 ? 'h0' : ratio > 0.66 ? 'h3' : ratio > 0.33 ? 'h2' : 'h1';
    rects.push(`<rect class="${level}" x="${(col * step).toFixed(1)}" y="${(row * step).toFixed(1)}" width="${cell}" height="${cell}" rx="1.4"/>`);
  }
  const width = 53 * step - gap;
  const height = 7 * step - gap;
  return `<div class="yr-heat"><svg viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}">${rects.join('')}</svg></div>
    <div class="yr-heat-legend"><span>少</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><span>多</span></div>`;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const HOUR_BUCKETS: Array<[string, number, number]> = [
  ['深夜', 0, 5], ['清晨', 5, 8], ['上午', 8, 11], ['午后', 11, 15], ['傍晚', 15, 18], ['夜间', 18, 24],
];

function peakRow(kind: string, peak: RidePeak, unit: string, value: string): string {
  return `<div class="yr-peak">
    <div class="k">${kind}</div>
    <div class="v">${value}<i>${unit}</i></div>
    <div class="d">${fmtDate(peak.date)} · ${peak.name}</div>
  </div>`;
}

function buildCards(review: YearReview): string[] {
  const cards: string[] = [];
  const km = review.totalMeters / 1000;

  // 1 封面
  cards.push(`<section class="yr-card yr-cover">
    <div class="yr-eyebrow center">FIT MOTION · 年度回顾</div>
    <div class="yr-year">${review.year}</div>
    <div class="yr-title">我的骑行年度</div>
    <svg class="yr-deco" viewBox="0 0 240 80">
      <path class="line" d="M8 62 C 40 20, 70 70, 104 40 S 170 8, 200 34 S 228 58, 232 50"/>
      <circle class="start" cx="8" cy="62" r="4"/><circle class="end" cx="232" cy="50" r="4"/>
    </svg>
    <div class="yr-cover-stats">
      <div><b>${fmtKm(review.totalMeters)}</b><i>公里</i></div>
      <div><b>${review.rideDays}</b><i>天在车上</i></div>
      <div><b>${review.rides}</b><i>次出发</i></div>
    </div>
    <div class="yr-hint">滑动开始 ↕</div>
  </section>`);

  // 2 总里程
  cards.push(`<section class="yr-card">${statCard('TOTAL DISTANCE',
    `${fmtKm(review.totalMeters)}<small>公里</small>`,
    distanceAnalogy(km),
    [[`${review.rideDays}<i>天</i>`, '骑行天数'], [`${review.rides}<i>次</i>`, '出行次数'], [`${fmtKm(review.avgPerRideM, 1)}<i>km</i>`, '单次平均']],
    '数据口径：Σ meta.distance（真实总里程，多日行程按整程计）· 天数按自然日去重')}</section>`);

  // 3 时间与爬升
  const avgKmh = review.movingSec > 0 ? (review.totalMeters / review.movingSec) * 3.6 : 0;
  cards.push(`<section class="yr-card">${statCard('TIME & CLIMB',
    `${fmtHours(review.movingSec)}<small>小时</small>`,
    '踩动踏板的时间',
    [[`${Math.round(review.climbM)}<i>m</i>`, '总爬升'], [review.maxAltM != null ? `${Math.round(review.maxAltM)}<i>m</i>` : '--', '最高海拔'], [`${avgKmh.toFixed(1)}<i>km/h</i>`, '年均速']],
    '数据口径：Σ meta.duration（运动时长，不含休息）· Σ climb · max(maxAlt)')}</section>`);

  // 4 月度分布
  const maxMonth = Math.max(...review.months);
  const topMonth = review.months.indexOf(maxMonth);
  if (maxMonth > 0) {
    const bars = review.months.map((v, i) => {
      const height = v > 0 ? Math.max(4, (v / maxMonth) * 100) : 2;
      return `<div class="yr-bar${i === topMonth ? ' top' : ''}"><div class="col" style="height:${height.toFixed(1)}%"><span class="val">${i === topMonth ? fmtKm(v) : ''}</span></div><div class="m">${i + 1}月</div></div>`;
    }).join('');
    cards.push(`<section class="yr-card">
      ${eyebrow('BY MONTH')}
      <div class="yr-cap strong">${topMonth + 1} 月是你的黄金月 —— <b>${fmtKm(maxMonth)} 公里</b></div>
      <div class="yr-bars">${bars}</div>
      ${srcNote('数据口径：按记录开始时间的自然月聚合 Σ meta.distance')}
    </section>`);
  }

  // 5 骑行日历（热力图 + 最长连续）
  const activeDays = review.heat.filter((v) => v > 0).length;
  cards.push(`<section class="yr-card">
    ${eyebrow('RIDING CALENDAR')}
    <div class="yr-cap strong">${activeDays} 天踩上踏板 —— 一年里的 <b>${Math.round((activeDays / 365) * 100)}%</b></div>
    ${heatmapBlock(review)}
    <div class="yr-streak">
      <b>${review.streak.days}</b><span>天连续骑行</span>
      ${review.streak.days >= 2 ? `<i>${fmtDate(review.streak.from)} — ${fmtDate(review.streak.to)}</i>` : '<i>明年冲一次连骑</i>'}
    </div>
    ${srcNote('数据口径：每格一天（周一在上），亮度 = 当天里程 / 全年单日最高 · 连续段按自然日判定')}
  </section>`);

  // 6 骑行节奏（一周 / 一天）
  const weekdayTop = review.weekdayRides.indexOf(Math.max(...review.weekdayRides));
  const hourCounts = HOUR_BUCKETS.map(([, from, to]) =>
    review.hourRides.slice(from, to).reduce((total, v) => total + v, 0));
  const hourTop = hourCounts.indexOf(Math.max(...hourCounts));
  if (review.weekdayRides.some((v) => v > 0)) {
    cards.push(`<section class="yr-card">
      ${eyebrow('RHYTHM')}
      <div class="yr-cap strong">一周里，周${WEEKDAYS[weekdayTop]}骑得最多 —— ${review.weekdayRides[weekdayTop]} 次</div>
      ${barGroup(review.weekdayRides, WEEKDAYS.map((d) => `周${d}`), (v) => `${v} 次`)}
      <div class="yr-gap"></div>
      <div class="yr-cap strong">一天里，${HOUR_BUCKETS[hourTop][0]}出发最勤</div>
      ${barGroup(hourCounts, HOUR_BUCKETS.map(([label]) => label), (v) => `${v} 次`)}
      ${srcNote('数据口径：按记录开始时间统计次数（一次多日行程只算出发那天）')}
    </section>`);
  }

  // 7 最长单骑
  if (review.longest) {
    const l = review.longest;
    cards.push(`<section class="yr-card">
      ${eyebrow('LONGEST RIDE')}
      <div class="yr-big small">${fmtKm(l.meters)}<small>公里</small></div>
      <div class="yr-cap">${fmtDate(l.date)} · ${l.name}${l.days > 1 ? ` · 跨 ${l.days} 天` : ''}</div>
      ${l.sketch.length >= 2 ? `<div class="yr-mini">${miniRouteSvg(l.sketch)}</div>` : ''}
      <div class="yr-stat-row">
        <div class="yr-stat"><div class="v">${fmtHours(l.spanSec)}<i>小时</i></div><div class="k">全程跨度</div></div>
        <div class="yr-stat"><div class="v">${fmtHours(l.movingSec)}<i>小时</i></div><div class="k">运动时长</div></div>
        <div class="yr-stat"><div class="v">${l.days}<i>天</i></div><div class="k">行程天数</div></div>
      </div>
      ${srcNote('数据口径：max(meta.distance) 的那一次 · 多日行程显示 trip.legs 信息')}
    </section>`);
  }

  // 8 速度时刻（与其它卡统一深夜配色）
  cards.push(`<section class="yr-card">${statCard('SPEED MOMENTS',
    `${review.maxSpeedKmh.toFixed(1)}<small>km/h</small>`,
    `年度最高速度 · ${fmtDate(review.maxSpeedAt)}`,
    [[`${review.bestAvgKmh.toFixed(1)}<i>km/h</i>`, '最快单次均速'], [review.maxHr != null ? `${review.maxHr}<i>bpm</i>` : '--', '年度最高心率']],
    '数据口径：max(meta.maxSpeed) · max(meta.avgSpeed) · max(meta.maxHr)')}</section>`);

  // 9 年度之最：最陡 / 最久 / 最早与最晚
  if (review.bestClimb || review.bestDuration) {
    cards.push(`<section class="yr-card">
      ${eyebrow('PERSONAL BESTS')}
      <div class="yr-cap strong">这一年，你把极限推到了这里</div>
      <div class="yr-peak-list">
        ${review.bestClimb ? peakRow('单次爬升最多', review.bestClimb, 'm', `${Math.round(review.bestClimb.value)}`) : ''}
        ${review.bestDuration ? peakRow('单次骑得最久', review.bestDuration, '小时', `${(review.bestDuration.value / 3600).toFixed(1)}`) : ''}
        ${review.longest ? `<div class="yr-peak">
          <div class="k">单日最远</div>
          <div class="v">${fmtKm(review.longest.meters)}<i>km</i></div>
          <div class="d">${fmtDate(review.longest.date)} · ${review.longest.name}</div>
        </div>` : ''}
      </div>
      ${review.firstRide && review.lastRide ? `<div class="yr-window">${fmtDate(review.firstRide.date)} 第一次出发 · ${fmtDate(review.lastRide.date)} 收车</div>` : ''}
      ${srcNote('数据口径：max(meta.climb) · max(meta.duration) · max(meta.distance)')}
    </section>`);
  }

  // 10 常骑路线
  if (review.topRoutes.length > 0) {
    const items = review.topRoutes.map((route, i) => `<div class="yr-top-item">
      <div class="rank">${i + 1}</div>
      <div class="info"><div class="name">${route.name}</div><div class="meta">共 ${fmtKm(route.totalMeters)} km · 最快均速 ${(route.bestAvgSpeed * 3.6).toFixed(1)} km/h</div></div>
      <div class="times">×${route.count} 次</div>
    </div>`).join('');
    cards.push(`<section class="yr-card">
      ${eyebrow('MOST RIDDEN')}
      <div class="yr-cap strong">有 ${review.topRoutes.length} 条路线你反复刷了又刷</div>
      <div class="yr-top-list">${items}</div>
      ${srcNote('数据口径：同名 + sameRoute 几何聚合（双向覆盖率 ≥85%）· Σ 里程 / 最快均速')}
    </section>`);
  }

  // 11 与去年对比
  if (review.prev && review.prev.meters > 0) {
    const prev = review.prev;
    const delta = (review.totalMeters - prev.meters) / prev.meters;
    const up = delta >= 0;
    const pct = Math.abs(Math.round(delta * 100));
    const cmp = (now: number, before: number, unit: string): string => {
      const diff = now - before;
      return `<div class="yr-cmp-row">
        <span class="k">${unit}</span>
        <span class="now">${now}</span>
        <span class="was">去年 ${before}</span>
        <span class="delta ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '↑' : '↓'}${Math.abs(Math.round(before > 0 ? (diff / before) * 100 : 0))}%</span>
      </div>`;
    };
    cards.push(`<section class="yr-card">
      ${eyebrow('YEAR OVER YEAR')}
      <div class="yr-big small ${up ? 'up' : 'down'}">${up ? '+' : '−'}${pct}<small>%</small></div>
      <div class="yr-cap">${up ? '比去年多骑了' : '比去年少骑了'} ${fmtKm(Math.abs(review.totalMeters - prev.meters))} 公里</div>
      <div class="yr-cmp">
        ${cmp(review.rides, prev.rides, '出行次数')}
        ${cmp(review.rideDays, prev.rideDays, '骑行天数')}
      </div>
      ${srcNote(`数据口径：与 ${prev.year} 年度同口径聚合 · 里程 ${fmtKm(prev.meters)} 公里`)}
    </section>`);
  }

  // 12 称号
  cards.push(`<section class="yr-card yr-badge-card">
    <div class="yr-badge"><div class="inner">${review.title.emoji}</div></div>
    <div class="yr-title-name">${review.title.name}</div>
    <div class="yr-title-desc">${review.title.desc}</div>
    ${srcNote('称号规则：按总里程 + 最长单骑 + 爬升 + 速度分档授予')}
  </section>`);

  // 13 出口
  cards.push(`<section class="yr-card yr-end">
    ${eyebrow('KEEP IT')}
    <div class="yr-cap strong big-gap">把 ${review.year} 留下来</div>
    <div class="yr-ctas">
      <button class="yr-cta primary" id="yr-share-img" type="button">
        <span class="ic"><svg><use href="#i-download"/></svg></span>
        <span><b>生成年度成绩图</b><i>一张 1080×1920 分享图</i></span>
      </button>
    </div>
    ${srcNote('成绩图：Canvas 直绘年度数据 · 生成后可保存到相册或直接分享')}
  </section>`);

  return cards;
}

function renderDeck(review: YearReview): void {
  const deck = $('yr-deck');
  const cards = buildCards(review);
  deck.innerHTML = cards.join('');
  const dots = $('yr-dots');
  dots.innerHTML = cards.map(() => '<span class="yr-dot"></span>').join('');
  index = 0;

  $('yr-close').onclick = closeYearReview;
  deck.querySelector('#yr-share-img')?.addEventListener('click', () => void exportYearImage(review));
}

function go(next: number): void {
  const cards = [...$<HTMLElement>('yr-deck').children] as HTMLElement[];
  const dots = [...$<HTMLElement>('yr-dots').children] as HTMLElement[];
  if (next < 0 || next >= cards.length) return;
  cards.forEach((card, i) => {
    card.classList.toggle('active', i === next);
    card.classList.toggle('prev', i < next);
  });
  dots.forEach((dot, i) => dot.classList.toggle('on', i === next));
  index = next;
}

// 键盘翻页
document.addEventListener('keydown', (event) => {
  if (!open) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') go(index + 1);
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') go(index - 1);
  if (event.key === 'Escape') closeYearReview();
});

// 触摸滑动（横向优先，纵向也认 —— Wrapped 式上下滑更顺手）
let touchX = 0;
let touchY = 0;
$('yr-screen').addEventListener('touchstart', (event) => {
  touchX = event.touches[0].clientX;
  touchY = event.touches[0].clientY;
}, { passive: true });
$('yr-screen').addEventListener('touchend', (event) => {
  const dx = event.changedTouches[0].clientX - touchX;
  const dy = event.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) > 44 || Math.abs(dy) > 44) {
    if (dx < 0 || dy < 0) go(index + 1);
    else go(index - 1);
  }
}, { passive: true });

/* ── 年度成绩图（1080×1920 PNG）───────────────────────────── */

const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

interface PosterPalette {
  pageTop: string;
  pageMid: string;
  pageBottom: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  warn: string;
  panel: string;
  panelLine: string;
  accentSoft: string;
}

/** 运行时读取主题 CSS 变量取色：导出图与当前主题观感一致。 */
function posterPalette(): PosterPalette {
  const styles = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  const page = v('--page', '#04060a');
  const card = v('--card', '#11171b');
  return {
    pageTop: v('--card-2', card),
    pageMid: page,
    pageBottom: v('--bg-soft', page),
    ink: v('--text', '#f3f7ee'),
    muted: v('--muted', '#8d9c96'),
    faint: v('--dim', '#5c6a65'),
    accent: v('--accent', '#b4e64a'),
    warn: v('--warn', '#e0a458'),
    panel: card,
    panelLine: v('--line-strong', 'rgba(255,255,255,0.18)'),
    accentSoft: v('--accent-soft', 'rgba(180,230,74,0.12)'),
  };
}

async function exportYearImage(review: YearReview): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    showToast('正在生成年度成绩图…');
    const pal = posterPalette();
    const W = 1080;
    const H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, pal.pageTop);
    bg.addColorStop(0.55, pal.pageMid);
    bg.addColorStop(1, pal.pageBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const pad = 72;
    const accentLine = (x: number, y: number): void => {
      ctx.fillStyle = pal.accent;
      ctx.fillRect(x, y, 34, 4);
    };

    // 顶部品牌 + 年份
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = pal.accent;
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText('F I T   M O T I O N   ·   年 度 回 顾', pad, 118);
    const yearGrad = ctx.createLinearGradient(0, 140, 0, 340);
    yearGrad.addColorStop(0, pal.ink);
    yearGrad.addColorStop(1, pal.accent);
    ctx.fillStyle = yearGrad;
    ctx.font = `700 200px ${SANS}`;
    ctx.fillText(String(review.year), pad - 4, 316);
    ctx.fillStyle = pal.muted;
    ctx.font = `500 30px ${SANS}`;
    ctx.fillText('我的骑行年度', pad, 376);

    // 主数据：总里程
    let y = 500;
    accentLine(pad, y - 44);
    ctx.fillStyle = pal.muted;
    ctx.font = `500 24px ${SANS}`;
    ctx.fillText('年度总里程', pad, y - 58);
    ctx.fillStyle = pal.ink;
    ctx.font = `700 150px ${SANS}`;
    const kmText = fmtKm(review.totalMeters);
    ctx.fillText(kmText, pad, y + 82);
    const kmWidth = ctx.measureText(kmText).width;
    ctx.fillStyle = pal.accent;
    ctx.font = `500 40px ${SANS}`;
    ctx.fillText('公里', pad + kmWidth + 18, y + 82);
    ctx.fillStyle = pal.muted;
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText(distanceAnalogy(review.totalMeters / 1000), pad, y + 138);

    // 六宫格统计
    y += 200;
    const gridCols = 3;
    const gridW = (W - pad * 2 - 24 * (gridCols - 1)) / gridCols;
    const stats: Array<[string, string, string]> = [
      [`${review.rideDays}`, '天', '骑行天数'],
      [`${review.rides}`, '次', '出行次数'],
      [`${fmtHours(review.movingSec)}`, '小时', '运动时长'],
      [`${Math.round(review.climbM)}`, 'm', '总爬升'],
      [review.maxAltM != null ? `${Math.round(review.maxAltM)}` : '--', 'm', '最高海拔'],
      [review.maxHr != null ? `${review.maxHr}` : '--', 'bpm', '最高心率'],
    ];
    stats.forEach(([value, unit, label], i) => {
      const col = i % gridCols;
      const row = Math.floor(i / gridCols);
      const x = pad + col * (gridW + 24);
      const top = y + row * 150;
      ctx.fillStyle = pal.panel;
      ctx.strokeStyle = pal.panelLine;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.roundRect(x, top, gridW, 126, 20);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = pal.ink;
      ctx.font = `700 52px ${SANS}`;
      ctx.fillText(value, x + 24, top + 62);
      const vw = ctx.measureText(value).width;
      ctx.fillStyle = pal.warn;
      ctx.font = `500 24px ${SANS}`;
      ctx.fillText(unit, x + 30 + vw, top + 62);
      ctx.fillStyle = pal.muted;
      ctx.font = `400 22px ${SANS}`;
      ctx.fillText(label, x + 24, top + 100);
    });

    // 月度柱状图
    y += 380;
    accentLine(pad, y - 44);
    ctx.fillStyle = pal.muted;
    ctx.font = `500 24px ${SANS}`;
    ctx.fillText('月度分布', pad, y - 58);
    const maxMonth = Math.max(...review.months);
    if (maxMonth > 0) {
      const chartTop = y + 8;
      const chartH = 170;
      const barW = (W - pad * 2) / 12 - 10;
      const topMonth = review.months.indexOf(maxMonth);
      review.months.forEach((v, i) => {
        const x = pad + i * (barW + 10);
        const h = v > 0 ? Math.max(6, (v / maxMonth) * chartH) : 4;
        ctx.fillStyle = i === topMonth ? pal.accent : pal.accentSoft;
        ctx.beginPath();
        ctx.roundRect(x, chartTop + chartH - h, barW, h, 6);
        ctx.fill();
        ctx.fillStyle = i === topMonth ? pal.accent : pal.faint;
        ctx.font = `400 19px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.fillText(`${i + 1}`, x + barW / 2, chartTop + chartH + 30);
        ctx.textAlign = 'left';
      });
      const topX = pad + topMonth * (barW + 10) + barW / 2;
      ctx.fillStyle = pal.accent;
      ctx.font = `600 22px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${fmtKm(maxMonth)} km`, topX, chartTop + chartH - Math.max(6, (maxMonth / maxMonth) * chartH) - 12);
      ctx.textAlign = 'left';
    }
    y += 300;

    // 最长单骑迷你路线
    if (review.longest && review.longest.sketch.length >= 2) {
      accentLine(pad, y - 44);
      ctx.fillStyle = pal.muted;
      ctx.font = `500 24px ${SANS}`;
      ctx.fillText('最长单骑', pad, y - 58);
      const boxX = pad;
      const boxY = y + 4;
      const boxW = W - pad * 2;
      const boxH = 200;
      ctx.fillStyle = pal.panel;
      ctx.strokeStyle = pal.panelLine;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 24);
      ctx.fill();
      ctx.stroke();

      const sketch = review.longest.sketch;
      let minLat = 90; let maxLat = -90; let minLon = 180; let maxLon = -180;
      for (const p of sketch) {
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
      }
      const inner = 40;
      const spanLat = Math.max(maxLat - minLat, 1e-6);
      const spanLon = Math.max(maxLon - minLon, 1e-6);
      const scale = Math.min((boxW - inner * 2) / spanLon, (boxH - inner * 2) / spanLat);
      const offX = (boxW - spanLon * scale) / 2;
      const offY = (boxH - spanLat * scale) / 2;
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      sketch.forEach((p, i) => {
        const x = boxX + offX + (p.lon - minLon) * scale;
        const py = boxY + boxH - (offY + (p.lat - minLat) * scale);
        if (i === 0) ctx.moveTo(x, py);
        else ctx.lineTo(x, py);
      });
      ctx.stroke();
      const first = sketch[0];
      const last = sketch[sketch.length - 1];
      const dot = (p: { lat: number; lon: number }, color: string): void => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(boxX + offX + (p.lon - minLon) * scale, boxY + boxH - (offY + (p.lat - minLat) * scale), 10, 0, Math.PI * 2);
        ctx.fill();
      };
      dot(first, pal.ink);
      dot(last, pal.warn);

      const l = review.longest;
      ctx.fillStyle = pal.ink;
      ctx.font = `600 32px ${SANS}`;
      ctx.fillText(`${fmtKm(l.meters)} 公里`, boxX + 28, boxY + 52);
      ctx.fillStyle = pal.muted;
      ctx.font = `400 24px ${SANS}`;
      ctx.fillText(`${fmtDate(l.date)} · ${l.name}${l.days > 1 ? ` · 跨 ${l.days} 天` : ''}`, boxX + 28, boxY + 92);
      y += boxH + 44;
    }

    // 称号 + 底部
    ctx.textAlign = 'center';
    ctx.fillStyle = pal.warn;
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText('年度称号', W / 2, y + 46);
    ctx.fillStyle = pal.accent;
    ctx.font = `700 62px ${SANS}`;
    ctx.fillText(`${review.title.name}`, W / 2, y + 118);
    ctx.fillStyle = pal.muted;
    ctx.font = `400 24px ${SANS}`;
    ctx.fillText(review.title.desc.replace(/<br\s*\/?>/g, ' · '), W / 2, y + 168);
    ctx.textAlign = 'left';

    ctx.fillStyle = pal.faint;
    ctx.font = `400 22px ${SANS}`;
    ctx.fillText('FIT MOTION · YEAR IN MOTION', pad, H - 56);

    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((data) => (data ? resolve(data) : reject(new Error('编码失败'))), 'image/png');
    });
    const filename = `FitMotion-${review.year}年度回顾.png`;
    const result = await saveBlob(blob, filename, 'image/png');
    showToast(result === 'manual'
      ? '年度成绩图已生成，请点击“保存到手机”。'
      : result === 'picker'
        ? '请选择保存位置，成绩图会写入所选文件夹。'
        : `年度成绩图已保存：${filename}`);
  } catch (error) {
    console.error(error);
    showToast('年度成绩图生成失败，请重试。', true);
  } finally {
    busy = false;
  }
}
