/**
 * 记录列表：游标分页 + 年份/来源筛选 + 空状态。
 *
 * 每次只从 IndexedDB 取一页（20 条），滚到底自动续；筛选条件会带进游标，
 * 否则「切到 2024 年再加载更多」会漏数据。
 */

import { listPage, libraryStats, removeActivity, restoreActivity, loadFileBlob } from '../store/repo';
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
}

type OpenHandler = (meta: ActivityMeta) => void;

interface State {
  year: number | 'all';
  src: SourceKind | 'all';
  items: ActivityMeta[];
  next: number | null;
  total: number;
  loading: boolean;
}

const state: State = { year: 'all', src: 'all', items: [], next: null, total: 0, loading: false };

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
  return `<div class="rec" data-id="${meta.id}" role="button" tabindex="0">
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

function renderChips(stats: { byYear: Record<string, number>; bySrc: Record<string, number>; byBoth: Record<string, number> }): void {
  const chips = $<HTMLDivElement>('chips');
  if (!chips) return;
  const entries: Array<[string, string]> = [];
  const all = stats.byBoth['all|all'] ?? 0;
  entries.push(['all|all', `全部 ${all}`]);
  const years = Object.keys(stats.byYear).sort().reverse();
  for (const year of years) entries.push([`${year}|all`, year]);
  for (const src of ['huawei', 'fit', 'gpx', 'tcx', 'merged'] as SourceKind[]) {
    const count = stats.bySrc[src] ?? 0;
    if (count > 0) entries.push([`all|${src}`, SOURCE_LABEL[src]]);
  }
  chips.innerHTML = entries.map(([key, label]) => {
    const [year, src] = key.split('|');
    const active = String(state.year) === year && String(state.src) === src;
    return `<button class="chip${active ? ' on' : ''}" type="button" data-year="${year}" data-src="${src}">${label}</button>`;
  }).join('');
}

function renderList(reset: boolean): void {
  const list = $<HTMLDivElement>('record-list');
  const empty = $<HTMLDivElement>('records-empty');
  const foot = $<HTMLDivElement>('list-foot');
  const more = $<HTMLButtonElement>('load-more');
  const tip = $<HTMLSpanElement>('list-tip');
  if (!list) return;

  if (reset) list.innerHTML = state.items.map(cardHtml).join('');
  else list.insertAdjacentHTML('beforeend', state.items.slice(-PAGE_SIZE).map(cardHtml).join(''));

  const isEmpty = state.items.length === 0;
  if (empty) empty.hidden = !isEmpty;
  if (foot) foot.hidden = isEmpty;
  if (more) {
    more.disabled = state.next == null;
    more.textContent = state.next == null
      ? `已全部加载 · 共 ${state.total} 条`
      : `加载更多 · 已显示 ${state.items.length} / ${state.total}`;
  }
  if (tip) tip.textContent = isEmpty ? '' : '下拉自动加载，或按年份快速定位';
}

export async function loadFirstPage(): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  try {
    const query: ListQuery = { year: state.year, src: state.src, before: null, limit: PAGE_SIZE };
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
    const query: ListQuery = { year: state.year, src: state.src, before: state.next, limit: PAGE_SIZE };
    const page = await listPage(query);
    state.items = state.items.concat(page.items);
    state.next = page.next;
    state.total = page.total;
    renderList(false);
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

  // 长按（移动端）：480ms，手指移动超过 10px 视为滚动，取消长按。
  let pressTimer = 0;
  let pressX = 0;
  let pressY = 0;
  let longPressed = false;
  const cancelPress = (): void => {
    window.clearTimeout(pressTimer);
    pressTimer = 0;
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
      void openMenu(card.dataset.id ?? '');
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

  const chips = $<HTMLDivElement>('chips');
  chips?.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>('.chip');
    if (!chip) return;
    const year = chip.dataset.year ?? 'all';
    const src = chip.dataset.src ?? 'all';
    state.year = year === 'all' ? 'all' : Number(year);
    state.src = src as SourceKind | 'all';
    void refreshSummary();
    void loadFirstPage();
    const pane = $<HTMLElement>('records-pane');
    if (pane) pane.scrollTop = 0;
  });

  $<HTMLButtonElement>('load-more')?.addEventListener('click', () => void loadNextPage());

  $<HTMLElement>('records-pane')?.addEventListener('scroll', (event) => {
    const pane = event.currentTarget as HTMLElement;
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
