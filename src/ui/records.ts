/**
 * 记录列表：游标分页 + 年份/来源筛选 + 空状态。
 *
 * 每次只从 IndexedDB 取一页（20 条），滚到底自动续；筛选条件会带进游标，
 * 否则「切到 2024 年再加载更多」会漏数据。
 */

import {
  listPage, listIds, libraryStats,
  removeActivity, removeActivities,
  restoreActivity, restoreActivities,
  loadFileBlob,
} from '../store/repo';
import { PAGE_SIZE } from '../store/repo';
import { SOURCE_LABEL, type ActivityMeta, type ListQuery, type SourceKind } from '../store/types';
import { showActionSheet, showConfirm } from './dialog';
import { showToastAction } from './toast';

export type ExportFormat = 'gpx' | 'tcx';

export interface RecordsHooks {
  /** 卡片菜单里导出的落地动作，由 main 提供（需要 loadActivity + saveBlob）。 */
  onExport?: (meta: ActivityMeta, format: ExportFormat) => Promise<void> | void;
  /** 删除 / 撤销之后通知外层刷新设置页统计。 */
  onChanged?: () => Promise<void> | void;
}

export interface RecordsApi {
  /** 重新从库里读第一页 */
  reload(): Promise<void>;
  /** 当前筛选下的总数 */
  total(): number;
  /** 最近一次渲染出来的记录 */
  items(): ActivityMeta[];
  /** 处于批量选择模式时退出并返回 true（Android 返回键用它取消多选） */
  exitSelectingIfActive(): boolean;
}

type OpenHandler = (meta: ActivityMeta) => void;

interface State {
  year: number | 'all';
  src: SourceKind | 'all';
  order: 'asc' | 'desc';
  items: ActivityMeta[];
  next: number | null;
  total: number;
  loading: boolean;
  /** 批量选择模式 */
  selecting: boolean;
  selected: Set<string>;
}

const state: State = { year: 'all', src: 'all', order: 'desc', items: [], next: null, total: 0, loading: false, selecting: false, selected: new Set() };

/** 年份条横向滚动位置，重绘后恢复。 */
let yearsScrollLeft = 0;

let openHandler: OpenHandler = () => {};

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function fmtKm(meters: number): string {
  const km = meters / 1000;
  const text = km >= 100 ? km.toFixed(0) : km.toFixed(1);
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m`;
}

function fmtSpeed(metersPerSecond: number): string {
  return (metersPerSecond * 3.6).toFixed(1);
}

function cardHtml(meta: ActivityMeta): string {
  const date = new Date(meta.start);
  const title = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${meta.name}`;
  const tagClass = meta.src === 'huawei' ? 'hw' : meta.src === 'gpx' ? 'gpx' : meta.src === 'merged' ? 'merged' : '';
  const tagText = meta.src === 'merged'
    ? `合并${meta.mergedFrom?.length ? ` ${meta.mergedFrom.length} 段` : ''}`
    : SOURCE_LABEL[meta.src];
  const badge = meta.backup === 2 ? ['both', '双端'] : meta.backup === 1 ? ['one', '已备份'] : ['wait', '待备份'];
  const selected = state.selecting && state.selected.has(meta.id);
  return `<div class="rec${selected ? ' sel' : ''}" data-id="${meta.id}" role="button" tabindex="0">
    <span class="thumb"><svg viewBox="0 0 44 44"><path d="${meta.thumb}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/></svg></span>
    <span class="body">
      <span class="top"><b>${title}</b><i class="tag ${tagClass}">${tagText}</i></span>
      <span class="meta">${fmtKm(meta.distance)} km · ${fmtDuration(meta.duration)} · ${fmtSpeed(meta.avgSpeed)} km/h</span>
      <span class="state ${badge[0]}"><i></i>${badge[1]}</span>
    </span>
    <button class="mini" data-create="${meta.id}" type="button"><svg viewBox="0 0 24 24"><use href="#i-pen"/></svg>创作</button>
    <button class="rec-more" data-more="${meta.id}" type="button" aria-label="更多操作">
      <svg viewBox="0 0 24 24"><use href="#i-more"/></svg>
    </button>
  </div>`;
}

/**
 * 分类栏：左边固定的格式分类（全部/FIT/TCX/GPX/合并，无数据自动隐藏），
 * 右边是可横向滑动的年份条（新→旧，向左滑动露出的旧年份会从格式块下方划过）。
 */
function renderChips(stats: { byYear: Record<string, number>; bySrc: Record<string, number> }): void {
  const formats = $<HTMLDivElement>('cat-formats');
  const years = $<HTMLDivElement>('cat-years');
  if (!formats || !years) return;

  // 格式分类：空分类隐藏；GPX 组含华为
  const countOf = (src: SourceKind): number => {
    if (src === 'gpx') return (stats.bySrc['gpx'] ?? 0) + (stats.bySrc['huawei'] ?? 0);
    return stats.bySrc[src] ?? 0;
  };
  const groups: Array<[SourceKind, string]> = [
    ['fit', 'FIT'],
    ['tcx', 'TCX'],
    ['gpx', 'GPX'],
    ['merged', '合并'],
  ];
  const fmtHtml = groups.map(([src, label]) => {
    const count = countOf(src);
    if (count === 0) return '';
    const active = state.src === src;
    return `<button class="chip${active ? ' on' : ''}" type="button" data-cat-src="${src}">${label} ${count}</button>`;
  }).join('');
  const allActive = state.src === 'all';
  formats.innerHTML = `<button class="chip${allActive ? ' on' : ''}" type="button" data-cat-src="all">全部</button>${fmtHtml}`
    + `<button class="cat-sort" id="sort-btn" type="button" aria-label="切换排序">${state.order === 'desc' ? '↓' : '↑'}</button>`;

  // 年份条：新→旧，向左滑动看更早的年份
  const yearKeys = Object.keys(stats.byYear).sort().reverse();
  years.innerHTML = yearKeys.map((year) => {
    const active = String(state.year) === year;
    const count = stats.byYear[year];
    return `<button class="chip${active ? ' on' : ''}" type="button" data-cat-year="${year}">${year} ${count}</button>`;
  }).join('');

  // 恢复年份条位置：innerHTML 重绘会重置横向滚动
  years.scrollLeft = yearsScrollLeft;
  updateYearFade();
}

/** 还有年份被挡在右边时，给分类栏加渐隐提示（滑到底自动消失）。 */
function updateYearFade(): void {
  const years = $<HTMLDivElement>('cat-years');
  const bar = $<HTMLDivElement>('cat-bar');
  if (!years || !bar) return;
  const hidden = years.scrollWidth - years.clientWidth - years.scrollLeft;
  bar.classList.toggle('has-more', hidden > 2);
}

function renderList(reset: boolean, appendCount = PAGE_SIZE): void {
  const list = $<HTMLDivElement>('record-list');
  const empty = $<HTMLDivElement>('records-empty');
  const foot = $<HTMLDivElement>('list-foot');
  const more = $<HTMLButtonElement>('load-more');
  const tip = $<HTMLSpanElement>('list-tip');
  if (!list) return;

  list.classList.toggle('selecting', state.selecting);
  if (reset) list.innerHTML = state.items.map(cardHtml).join('');
  // 只追加真正新加载的那几条 —— 最后一页常常不足一页，按固定 20 条追加会把
  // 上一页的卡片原样再画一遍（重复卡片 + 顺序乱跳）
  else if (appendCount > 0) list.insertAdjacentHTML('beforeend', state.items.slice(-appendCount).map(cardHtml).join(''));

  const isEmpty = state.items.length === 0;
  if (empty) empty.hidden = !isEmpty || state.selecting;
  if (foot) foot.hidden = isEmpty || state.selecting;
  if (more) {
    more.disabled = state.next == null;
    more.textContent = state.next == null
      ? `已全部加载 · 共 ${state.total} 条`
      : `加载更多 · 已显示 ${state.items.length} / ${state.total}`;
  }
  if (tip) tip.textContent = isEmpty ? '' : state.selecting ? '点击卡片选择，长按卡片退出批量模式' : '下拉自动加载，或按年份快速定位';
  syncBatchBar();
}

/** 批量选择条：显示选中数量，控制按钮可用性。 */
function syncBatchBar(): void {
  const bar = $<HTMLDivElement>('batch-bar');
  const count = $<HTMLSpanElement>('batch-count');
  const del = $<HTMLButtonElement>('batch-delete');
  const all = $<HTMLButtonElement>('batch-all');
  if (bar) bar.hidden = !state.selecting;
  const picked = state.selected.size;
  const allPicked = picked > 0 && picked >= state.total;
  if (count) count.textContent = allPicked ? `已选全部 ${picked} 条` : `已选 ${picked} 条`;
  if (del) del.disabled = picked === 0;
  if (all) all.textContent = allPicked ? '取消全选' : '全选';
}

function exitSelecting(): void {
  state.selecting = false;
  state.selected.clear();
  renderList(true);
}

/**
 * 切换筛选条件时退出多选：选中的 id 属于上一个筛选范围，
 * 留着会让「已选 N 条」和眼前的列表对不上。
 */
function dropSelection(): void {
  if (!state.selecting) return;
  exitSelecting();
}

export async function loadFirstPage(): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  try {
    const query: ListQuery = {
      year: state.year, src: state.src, limit: PAGE_SIZE, order: state.order,
      before: state.order === 'desc' ? null : undefined,
      after: state.order === 'asc' ? null : undefined,
    } as ListQuery;
    const page = await listPage(query);
    state.items = page.items;
    state.next = page.next;
    state.total = page.total;
    renderList(true);
  } finally {
    state.loading = false;
  }
}

export async function loadNextPage(): Promise<void> {
  if (state.loading || state.next == null) return;
  state.loading = true;
  try {
    const query: ListQuery = {
      year: state.year, src: state.src, limit: PAGE_SIZE, order: state.order,
      before: state.order === 'desc' ? state.next : undefined,
      after: state.order === 'asc' ? state.next : undefined,
    } as ListQuery;
    const page = await listPage(query);
    state.items = state.items.concat(page.items);
    state.next = page.next;
    state.total = page.total;
    renderList(false, page.items.length);
  } finally {
    state.loading = false;
  }
}

async function refreshSummary(): Promise<void> {
  const stats = await libraryStats();
  const sum = $<HTMLSpanElement>('records-sum');
  if (sum) sum.textContent = `${stats.count} 条 · ${fmtKm(stats.distanceM)} km`;
  const setTotal = $<HTMLElement>('set-total');
  if (setTotal) setTotal.textContent = `${stats.count} 条`;
  renderChips(stats);
}

export function initRecords(onOpen: OpenHandler, hooks: RecordsHooks = {}): RecordsApi {
  openHandler = onOpen;

  const list = $<HTMLDivElement>('record-list');
  const findMeta = (id: string): ActivityMeta | undefined => state.items.find((item) => item.id === id);

  /** 删除：墓碑 + 清列表 + 撤销 Toast。 */
  const removeOne = async (meta: ActivityMeta): Promise<void> => {
    const ok = await showConfirm({
      title: '删除这条记录？',
      message: `${labelOf(meta)}\n删除后 30 天内可在「设置 → 最近删除」里恢复；若已开启云备份，下次同步会一并移除云端副本。`,
      confirmText: '删除',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!ok) return;
    await removeActivity(meta.id);
    state.items = state.items.filter((item) => item.id !== meta.id);
    state.total = Math.max(0, state.total - 1);
    renderList(true);
    await refreshSummary();
    await hooks.onChanged?.();
    showToastAction(`已删除「${meta.name}」`, '撤销', () => void undoOne(meta));
  };

  const undoOne = async (meta: ActivityMeta): Promise<void> => {
    await restoreActivity(meta.id);
    await refreshSummary();
    await loadFirstPage();
    await hooks.onChanged?.();
  };

  /** 卡片菜单：导出 / 删除。长按、右键、⋯ 按钮共用。 */
  const openMenu = async (id: string): Promise<void> => {
    const meta = findMeta(id);
    if (!meta) return;
    const choice = await showActionSheet({
      title: labelOf(meta),
      items: [
        { key: 'create', label: '开始创作', note: '用这条记录生成轨迹短片' },
        { key: 'gpx', label: '导出 GPX', note: '原始轨迹，通用格式' },
        { key: 'tcx', label: '导出 TCX', note: '含里程与时间，Garmin 通用' },
        { key: 'delete', label: '删除记录', note: '移入最近删除，30 天内可恢复', tone: 'danger' },
      ],
    });
    if (!choice) return;
    if (choice === 'create') {
      openHandler(meta);
      return;
    }
    if (choice === 'delete') {
      await removeOne(meta);
      return;
    }
    await hooks.onExport?.(meta, choice as ExportFormat);
  };

  // 长按（移动端）：480ms，手指移动超过 10px 视为滚动。长按进入批量选择模式。
  let pressTimer = 0;
  let pressX = 0;
  let pressY = 0;
  let longPressed = false;
  const cancelPress = (): void => {
    window.clearTimeout(pressTimer);
    pressTimer = 0;
  };

  const toggleSelect = (id: string): void => {
    if (!id) return;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    const card = list?.querySelector<HTMLElement>(`.rec[data-id="${id}"]`);
    if (card) card.classList.toggle('sel', state.selected.has(id));
    syncBatchBar();
  };

  const enterSelecting = (firstId: string): void => {
    state.selecting = true;
    state.selected.clear();
    if (firstId) state.selected.add(firstId);
    renderList(true);
  };

  list?.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('button')) return;
    const card = target.closest<HTMLElement>('.rec');
    if (!card) return;
    pressX = event.clientX;
    pressY = event.clientY;
    cancelPress();
    pressTimer = window.setTimeout(() => {
      longPressed = true;
      if (navigator.vibrate) navigator.vibrate(12);
      if (state.selecting) toggleSelect(card.dataset.id ?? '');
      else enterSelecting(card.dataset.id ?? '');
    }, 480);
  });

  list?.addEventListener('pointermove', (event) => {
    if (!pressTimer) return;
    if (Math.abs(event.clientX - pressX) > 10 || Math.abs(event.clientY - pressY) > 10) cancelPress();
  });
  list?.addEventListener('pointerup', cancelPress);
  list?.addEventListener('pointercancel', cancelPress);
  list?.addEventListener('pointerleave', cancelPress);

  // 桌面端右键
  list?.addEventListener('contextmenu', (event) => {
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('.rec');
    if (!card) return;
    event.preventDefault();
    void openMenu(card.dataset.id ?? '');
  });

  // 分类栏：格式（左，固定）与年份（右，横向滑动）是两个独立查询维度
  $<HTMLDivElement>('cat-formats')?.addEventListener('click', (event) => {
    const sortBtn = (event.target as HTMLElement | null)?.closest<HTMLElement>('.cat-sort');
    if (sortBtn) {
      state.order = state.order === 'desc' ? 'asc' : 'desc';
      dropSelection();
      void loadFirstPage();
      void refreshSummary();
      return;
    }
    const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-cat-src]');
    if (!chip) return;
    const src = chip.dataset.catSrc ?? 'all';
    state.src = src as SourceKind | 'all';
    dropSelection();
    void refreshSummary();
    void loadFirstPage();
    const pane = $<HTMLElement>('records-pane');
    if (pane) pane.scrollTop = 0;
  });

  $<HTMLDivElement>('cat-years')?.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-cat-year]');
    if (!chip) return;
    const year = chip.dataset.catYear ?? 'all';
    state.year = year === 'all' ? 'all' : Number(year);
    dropSelection();
    void refreshSummary();
    void loadFirstPage();
    const pane = $<HTMLElement>('records-pane');
    if (pane) pane.scrollTop = 0;
  });

  // 年份条横向滚动位置：重绘 chips 后恢复，避免筛选时跳回最左
  $<HTMLDivElement>('cat-years')?.addEventListener('scroll', (event) => {
    yearsScrollLeft = (event.currentTarget as HTMLElement).scrollLeft;
    updateYearFade();
  });
  // 旋转屏幕 / 改窗口宽度后「还能不能滑」会变，提示跟着重算
  window.addEventListener('resize', updateYearFade);

  // 批量选择条
  $<HTMLButtonElement>('batch-cancel')?.addEventListener('click', exitSelecting);
  // 全选 = 当前筛选下的全部记录（含还没加载的分页）；再点一次取消全选
  $<HTMLButtonElement>('batch-all')?.addEventListener('click', async () => {
    if (state.selected.size > 0 && state.selected.size >= state.total) {
      state.selected.clear();
      renderList(true);
      return;
    }
    const button = $<HTMLButtonElement>('batch-all');
    if (button) button.disabled = true;
    try {
      const ids = await listIds({ year: state.year, src: state.src });
      state.selected = new Set(ids);
      renderList(true);
    } finally {
      if (button) button.disabled = false;
    }
  });
  $<HTMLButtonElement>('batch-delete')?.addEventListener('click', async () => {
    if (state.selected.size === 0) return;
    const ids = [...state.selected];
    const hidden = ids.filter((id) => !state.items.some((item) => item.id === id)).length;
    const scope = state.year === 'all' && state.src === 'all'
      ? '全部记录'
      : `当前筛选（${state.year === 'all' ? '全部年份' : state.year}年${state.src === 'all' ? '' : ` · ${SOURCE_LABEL[state.src]}`}）`;
    const ok = await showConfirm({
      title: `删除 ${ids.length} 条记录？`,
      message: `${scope}下的 ${ids.length} 条会一起移入最近删除${hidden > 0 ? `（其中 ${hidden} 条还没加载到列表里）` : ''}。`
        + '\n删除后 30 天内可在「设置 → 最近删除」里恢复；若已开启云备份，下次同步会一并移除云端副本。',
      confirmText: '删除',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!ok) return;
    await removeActivities(ids);
    state.selected.clear();
    state.selecting = false;
    await refreshSummary();
    await loadFirstPage();
    await hooks.onChanged?.();
    showToastAction(`已删除 ${ids.length} 条记录`, '撤销', async () => {
      await restoreActivities(ids);
      await refreshSummary();
      await loadFirstPage();
      await hooks.onChanged?.();
    });
  });

  $<HTMLButtonElement>('load-more')?.addEventListener('click', () => void loadNextPage());

  $<HTMLElement>('records-pane')?.addEventListener('scroll', (event) => {
    const pane = event.currentTarget as HTMLElement;
    // 查询条件吸顶后加一层阴影，让「列表在下面滚」这件事看得出来
    const sticky = document.getElementById('records-sticky');
    if (sticky) sticky.classList.toggle('stuck', pane.scrollTop > 2);
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 160) void loadNextPage();
  });

  list?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const more = target?.closest<HTMLElement>('[data-more]');
    if (more) {
      event.stopPropagation();
      cancelPress();
      void openMenu(more.dataset.more ?? '');
      return;
    }
    // 长按抬起时浏览器还会补一次 click，别让它顺带打开创作页
    if (longPressed) {
      longPressed = false;
      return;
    }
    const card = target?.closest<HTMLElement>('.rec');
    if (!card) return;
    // 批量选择模式下，点击卡片是切换选中，不是打开创作页
    if (state.selecting) {
      toggleSelect(card.dataset.id ?? '');
      return;
    }
    const meta = findMeta(card.dataset.id ?? '');
    if (meta) openHandler(meta);
  });

  list?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('.rec');
    if (!card) return;
    event.preventDefault();
    const meta = findMeta(card.dataset.id ?? '');
    if (meta) openHandler(meta);
  });

  return {
    reload: async () => {
      await refreshSummary();
      await loadFirstPage();
    },
    total: () => state.total,
    items: () => state.items,
    exitSelectingIfActive: () => {
      if (!state.selecting) return false;
      exitSelecting();
      return true;
    },
  };
}

function labelOf(meta: ActivityMeta): string {
  const date = new Date(meta.start);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${meta.name} · ${fmtKm(meta.distance)} km`;
}

export async function deleteRecord(id: string): Promise<void> {
  await removeActivity(id);
}

export { loadFileBlob };
