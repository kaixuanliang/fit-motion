/**
 * 最近删除（回收站）。
 *
 * 删除是墓碑：记录立刻从列表消失，但轨迹还在库里，所以能撤销。
 * 这里的「清空」只回收轨迹与原始文件，墓碑(几百字节)保留 ——
 * 云端对账要靠它，抹掉的话下次同步会把记录当新数据拉回来。
 */

import { listDeleted, purgeAllTrash, restoreActivity, trashBytes, TRASH_KEEP_DAYS } from '../store/repo';
import type { ActivityMeta } from '../store/types';
import { showConfirm } from './dialog';
import { showToast } from './toast';

export interface TrashApi {
  open(): Promise<void>;
  close(): void;
}

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function fmtKm(meters: number): string {
  const km = meters / 1000;
  return (km >= 100 ? km.toFixed(0) : km.toFixed(1)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function rowHtml(meta: ActivityMeta): string {
  const start = new Date(meta.start);
  const removed = new Date(meta.deleted);
  const days = Math.max(0, Math.floor((Date.now() - meta.deleted) / 86_400_000));
  const left = Math.max(0, TRASH_KEEP_DAYS - days);
  return `<div class="trash-row" data-id="${meta.id}">
    <span class="dt">${pad(start.getMonth() + 1)}-${pad(start.getDate())}</span>
    <span class="nm">${meta.name}</span>
    <span class="num">${fmtKm(meta.distance)} km</span>
    <button class="trash-restore" type="button" data-restore="${meta.id}">恢复</button>
    <span class="age">删除于 ${removed.getMonth() + 1}/${removed.getDate()} · 还可恢复 ${left} 天</span>
  </div>`;
}

export function initTrash(onChanged: () => Promise<void> | void): TrashApi {
  const overlay = $<HTMLDivElement>('trash-overlay');
  const list = $<HTMLDivElement>('trash-list');
  const hint = $<HTMLParagraphElement>('trash-hint');
  const sub = $<HTMLParagraphElement>('trash-sub');
  const clear = $<HTMLButtonElement>('trash-clear');
  const done = $<HTMLButtonElement>('trash-done');

  let rows: ActivityMeta[] = [];
  let busy = false;

  const render = (): void => {
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<p class="merge-hint">回收站是空的。删除的记录会在这里保留 30 天。</p>';
    } else {
      list.innerHTML = rows.map(rowHtml).join('');
    }
    if (hint) {
      const bytes = rows.reduce((sum, row) => sum + trashBytes(row), 0);
      hint.textContent = rows.length
        ? `共 ${rows.length} 条 · 占用约 ${fmtBytes(bytes)}，清空后回收这些空间`
        : '删除记录后可在这里恢复';
    }
    if (clear) clear.disabled = busy || !rows.length;
    if (sub) {
      sub.textContent = rows.length
        ? `最近 ${TRASH_KEEP_DAYS} 天内删除的记录，恢复后会回到原来的位置。`
        : `删除的记录会在这里保留 ${TRASH_KEEP_DAYS} 天，期间可以恢复。`;
    }
  };

  const reload = async (): Promise<void> => {
    rows = await listDeleted();
    render();
  };

  const close = (): void => {
    if (overlay) overlay.hidden = true;
  };

  list?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-restore]');
    if (!button || busy) return;
    const id = button.dataset.restore ?? '';
    void (async () => {
      busy = true;
      try {
        await restoreActivity(id);
        rows = rows.filter((row) => row.id !== id);
        render();
        await onChanged();
        showToast('已恢复');
      } finally {
        busy = false;
      }
    })();
  });

  clear?.addEventListener('click', () => {
    if (busy || !rows.length) return;
    void (async () => {
      const ok = await showConfirm({
        title: '清空最近删除？',
        message: `将永久清除 ${rows.length} 条记录的本地轨迹与原始文件。记录不会再出现在列表里，也无法恢复。`,
        confirmText: '清空',
        tone: 'danger',
      });
      if (!ok) return;
      busy = true;
      if (clear) clear.disabled = true;
      try {
        const count = await purgeAllTrash();
        rows = [];
        render();
        await onChanged();
        showToast(`已清空 ${count} 条，空间已回收`);
      } finally {
        busy = false;
      }
    })();
  });

  done?.addEventListener('click', close);
  overlay?.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  return {
    close,
    open: async () => {
      if (!overlay) return;
      overlay.hidden = false;
      if (list) list.innerHTML = '<p class="merge-hint">正在读取…</p>';
      try {
        await reload();
      } catch (error) {
        if (list) list.innerHTML = `<p class="merge-hint">读取失败：${error instanceof Error ? error.message : '未知错误'}</p>`;
      }
    },
  };
}
