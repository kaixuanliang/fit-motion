/**
 * 年度骑行回顾：Wrapped 式全屏翻卡 + 年度成绩图导出。
 *
 * 入口在记录页顶栏（records.ts）。数据由 src/stats/year-review.ts 聚合，
 * 这里只负责呈现与导出。卡片数量按数据自适应（没有常骑路线/最长单骑时
 * 跳过对应卡），翻页支持滑动、方向键和底部按钮。
 *
 * 视觉取「年度报告」质感：深夜底色 + 荧光绿主色，不跟随明暗主题 —— 这页
 * 是仪式感优先的内容页，固定配色反而稳定。
 */

import { computeYearReview, distanceAnalogy, type YearReview } from '../stats/year-review';
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

/** 记录页顶栏入口：只在所选年份有数据时亮出来。 */
export function syncYearEntry(yearWithData: boolean): void {
  const entry = document.getElementById('yr-entry-btn');
  if (entry) entry.hidden = !yearWithData;
}

export async function openYearReview(preferredYear?: number): Promise<void> {
  if (open || busy) return;
  open = true;
  const overlay = $('year-review');
  const deck = $('yr-deck');
  overlay.hidden = false;
  deck.innerHTML = `<div class="yr-loading"><span></span>正在统计你的年度骑行…</div>`;

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
        deck.innerHTML = `<div class="yr-loading">还没有可回顾的骑行记录。</div>`;
        return;
      }
    }
  } else {
    review = await computeYearReview(year);
  }
  if (!review) {
    deck.innerHTML = `<div class="yr-loading">还没有可回顾的骑行记录。</div>`;
    return;
  }
  renderDeck(review);
  go(0);
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
  const W = 340; const H = 150; const padX = 22; const padY = 16;
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
  return `<svg viewBox="0 0 ${W} ${H}">
    <path d="${d}" fill="none" stroke="#d8ff3e" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5" fill="#fff"/>
    <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="5" fill="#e8b84a"/>
  </svg>`;
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
      <path d="M8 62 C 40 20, 70 70, 104 40 S 170 8, 200 34 S 228 58, 232 50" fill="none" stroke="#d8ff3e" stroke-width="3" stroke-linecap="round"/>
      <circle cx="8" cy="62" r="4" fill="#fff"/><circle cx="232" cy="50" r="4" fill="#e8b84a"/>
    </svg>
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

  // 5 最长单骑
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

  // 6 速度时刻（亮色卡）
  cards.push(`<section class="yr-card light">${statCard('SPEED MOMENTS',
    `${review.maxSpeedKmh.toFixed(1)}<small>km/h</small>`,
    `年度最高速度 · ${fmtDate(review.maxSpeedAt)}`,
    [[`${review.bestAvgKmh.toFixed(1)}<i>km/h</i>`, '最快单次均速'], [review.maxHr != null ? `${review.maxHr}<i>bpm</i>` : '--', '年度最高心率']],
    '数据口径：max(meta.maxSpeed) · max(meta.avgSpeed) · max(meta.maxHr)')}</section>`);

  // 7 常骑路线
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

  // 8 称号
  cards.push(`<section class="yr-card yr-badge-card">
    <div class="yr-badge"><div class="inner">${review.title.emoji}</div></div>
    <div class="yr-title-name">${review.title.name}</div>
    <div class="yr-title-desc">${review.title.desc}</div>
    ${srcNote('称号规则：按总里程 + 最长单骑 + 爬升 + 速度分档授予')}
  </section>`);

  // 9 出口
  cards.push(`<section class="yr-card yr-end">
    ${eyebrow('KEEP IT')}
    <div class="yr-cap strong big-gap">把 ${review.year} 留下来</div>
    <div class="yr-ctas">
      <button class="yr-cta primary" id="yr-share-img" type="button">
        <span class="ic"><svg><use href="#i-download"/></svg></span>
        <span><b>生成年度成绩图</b><i>一张 1080×1920 分享图</i></span>
      </button>
      <button class="yr-cta" id="yr-share-video" type="button">
        <span class="ic"><svg><use href="#i-play"/></svg></span>
        <span><b>生成年度回顾视频</b><i>12 个月路线串联 · 即将上线</i></span>
      </button>
    </div>
    ${srcNote('成绩图：Canvas 直绘年度数据 · 视频：全局视角渲染线（后续版本）')}
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

  $('yr-prev').onclick = () => go(index - 1);
  $('yr-next').onclick = () => go(index + 1);
  $('yr-close').onclick = closeYearReview;
  deck.querySelector('#yr-share-img')?.addEventListener('click', () => void exportYearImage(review));
  deck.querySelector('#yr-share-video')?.addEventListener('click', () => {
    showToast('年度回顾视频将在后续版本上线，先保存一张成绩图吧。');
  });
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
  ($('yr-prev') as HTMLButtonElement).disabled = index === 0;
  ($('yr-next') as HTMLButtonElement).disabled = index === cards.length - 1;
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

const INK = '#f4f7ee';
const DEEP = '#0d1f2d';
const DEEP2 = '#12384a';
const LIME = '#d8ff3e';
const GOLD = '#e8b84a';
const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

async function exportYearImage(review: YearReview): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    showToast('正在生成年度成绩图…');
    const W = 1080;
    const H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, DEEP2);
    bg.addColorStop(0.55, DEEP);
    bg.addColorStop(1, '#08131c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const pad = 72;
    const accentLine = (x: number, y: number): void => {
      ctx.fillStyle = LIME;
      ctx.fillRect(x, y, 34, 4);
    };

    // 顶部品牌 + 年份
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(216,255,62,0.85)';
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText('F I T   M O T I O N   ·   年 度 回 顾', pad, 118);
    const yearGrad = ctx.createLinearGradient(0, 140, 0, 340);
    yearGrad.addColorStop(0, '#ffffff');
    yearGrad.addColorStop(1, LIME);
    ctx.fillStyle = yearGrad;
    ctx.font = `700 200px ${SANS}`;
    ctx.fillText(String(review.year), pad - 4, 316);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `500 30px ${SANS}`;
    ctx.fillText('我的骑行年度', pad, 376);

    // 主数据：总里程
    let y = 500;
    accentLine(pad, y - 44);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `500 24px ${SANS}`;
    ctx.fillText('年度总里程', pad, y - 58);
    ctx.fillStyle = INK;
    ctx.font = `700 150px ${SANS}`;
    const kmText = fmtKm(review.totalMeters);
    ctx.fillText(kmText, pad, y + 82);
    const kmWidth = ctx.measureText(kmText).width;
    ctx.fillStyle = LIME;
    ctx.font = `500 40px ${SANS}`;
    ctx.fillText('公里', pad + kmWidth + 18, y + 82);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
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
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.roundRect(x, top, gridW, 126, 20);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.font = `700 52px ${SANS}`;
      ctx.fillText(value, x + 24, top + 62);
      const vw = ctx.measureText(value).width;
      ctx.fillStyle = GOLD;
      ctx.font = `500 24px ${SANS}`;
      ctx.fillText(unit, x + 30 + vw, top + 62);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = `400 22px ${SANS}`;
      ctx.fillText(label, x + 24, top + 100);
    });

    // 月度柱状图
    y += 380;
    accentLine(pad, y - 44);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
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
        ctx.fillStyle = i === topMonth ? LIME : 'rgba(216,255,62,0.22)';
        ctx.beginPath();
        ctx.roundRect(x, chartTop + chartH - h, barW, h, 6);
        ctx.fill();
        ctx.fillStyle = i === topMonth ? LIME : 'rgba(255,255,255,0.4)';
        ctx.font = `400 19px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.fillText(`${i + 1}`, x + barW / 2, chartTop + chartH + 30);
        ctx.textAlign = 'left';
      });
      const topX = pad + topMonth * (barW + 10) + barW / 2;
      ctx.fillStyle = LIME;
      ctx.font = `600 22px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${fmtKm(maxMonth)} km`, topX, chartTop + chartH - Math.max(6, (maxMonth / maxMonth) * chartH) - 12);
      ctx.textAlign = 'left';
    }
    y += 300;

    // 最长单骑迷你路线
    if (review.longest && review.longest.sketch.length >= 2) {
      accentLine(pad, y - 44);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `500 24px ${SANS}`;
      ctx.fillText('最长单骑', pad, y - 58);
      const boxX = pad;
      const boxY = y + 4;
      const boxW = W - pad * 2;
      const boxH = 200;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
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
      ctx.strokeStyle = LIME;
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
      dot(first, '#ffffff');
      dot(last, GOLD);

      const l = review.longest;
      ctx.fillStyle = INK;
      ctx.font = `600 32px ${SANS}`;
      ctx.fillText(`${fmtKm(l.meters)} 公里`, boxX + 28, boxY + 52);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `400 24px ${SANS}`;
      ctx.fillText(`${fmtDate(l.date)} · ${l.name}${l.days > 1 ? ` · 跨 ${l.days} 天` : ''}`, boxX + 28, boxY + 92);
      y += boxH + 44;
    }

    // 称号 + 底部
    ctx.textAlign = 'center';
    ctx.fillStyle = GOLD;
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText('年度称号', W / 2, y + 46);
    ctx.fillStyle = LIME;
    ctx.font = `700 62px ${SANS}`;
    ctx.fillText(`${review.title.name}`, W / 2, y + 118);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `400 24px ${SANS}`;
    ctx.fillText(review.title.desc.replace(/<br\s*\/?>/g, ' · '), W / 2, y + 168);
    ctx.textAlign = 'left';

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
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
