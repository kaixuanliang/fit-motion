/**
 * 合并路线弹层：从记录库里勾选几段 → 合并成一条新记录。
 *
 * 只做选择和反馈，聚合规则在 import/merge.ts 里（对齐华为运动健康）。
 */

import { mergeCandidates, mergeRecords, mergeableSport, sportLabel, type MergeOutcome } from '../import/merge';
import type { ActivityMeta } from '../store/types';
import { showToast } from './toast';

export interface MergeApi {
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

function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return h > 0 ? `${h}h${pad(m)}m` : `${m}m`;
}

function rowHtml(meta: ActivityMeta): string {
  const date = new Date(meta.start);
  const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  // 旧记录没有 sport 字段：不拦着选，合并时会再做一次同类型校验
  const blocked = meta.sport != null && !mergeableSport(meta.sport);
  const label = meta.sport != null ? sportLabel(meta.sport) : '';
  return `<label class="merge-row${blocked ? ' off' : ''}" data-id="${meta.id}">
    <input type="checkbox" value="${meta.id}"${blocked ? ' disabled' : ''} />
    <span class="dt">${stamp}</span>
    <span class="nm">${meta.name}${label ? ` · ${label}` : ''}</span>
    <span class="num">${fmtKm(meta.distance)}km · ${fmtDuration(meta.duration)}</span>
  </label>`;
}

export function initMerge(onDone: (outcome: MergeOutcome) => Promise<void>): MergeApi {
  const overlay = $<HTMLDivElement>('merge-overlay');
  const list = $<HTMLDivElement>('merge-list');
  const hint = $<HTMLParagraphElement>('merge-hint');
  const confirm = $<HTMLButtonElement>('merge-confirm');
  const cancel = $<HTMLButtonElement>('merge-cancel');
  const sub = $<HTMLParagraphElement>('merge-sub');

  let metas: ActivityMeta[] = [];
  const picked = new Set<string>();
  let busy = false;
  /** 上一次合并失败的原因，必须留在界面上，不能被「已选 N 条」覆盖掉 */
  let errorText = '';

  const chosenMetas = (): ActivityMeta[] => metas.filter((meta) => picked.has(meta.id));

  /** 已选记录里出现了几种运动类型（缺失类型的不计） */
  const chosenSports = (): number[] => {
    const set = new Set<number>();
    for (const meta of chosenMetas()) {
      if (meta.sport != null && meta.sport > 0) set.add(meta.sport);
    }
    return Array.from(set);
  };

  const refreshHint = (): void => {
    if (!hint || !confirm) return;
    const chosen = chosenMetas();
    const sports = chosenSports();
    const mismatch = sports.length > 1;
    confirm.disabled = busy || chosen.length < 2 || mismatch;

    if (busy) return;
    if (errorText) {
      hint.textContent = errorText;
      hint.classList.add('bad');
      return;
    }
    hint.classList.remove('bad');
    if (!chosen.length) {
      hint.textContent = '勾选 2 条以上同一趟运动的记录（例如手表中断后分开的两段）';
      return;
    }
    if (mismatch) {
      hint.textContent = `已选 ${chosen.length} 条 · 运动类型不一致（${sports.map((value) => sportLabel(value)).join(' / ')}），只能合并同一种运动`;
      return;
    }
    const distance = chosen.reduce((sum, meta) => sum + meta.distance, 0);
    const duration = chosen.reduce((sum, meta) => sum + meta.duration, 0);
    const days = new Set(chosen.map((meta) => new Date(meta.start).toDateString())).size;
    hint.textContent = `已选 ${chosen.length} 条 · 合计 ${fmtKm(distance)} km · ${fmtDuration(duration)}${days > 1 ? ` · 跨 ${days} 天` : ''}`;
  };

  const render = (): void => {
    if (!list) return;
    if (!metas.length) {
      list.innerHTML = '<p class="merge-hint">记录库还是空的，先导入运动文件。</p>';
      refreshHint();
      return;
    }
    list.innerHTML = metas.map(rowHtml).join('');
    refreshHint();
  };

  const close = (): void => {
    if (!overlay) return;
    overlay.hidden = true;
    picked.clear();
  };

  list?.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input || input.type !== 'checkbox') return;
    const row = input.closest<HTMLElement>('.merge-row');
    if (!row) return;
    const id = row.dataset.id ?? '';
    if (input.checked) picked.add(id);
    else picked.delete(id);
    row.classList.toggle('on', input.checked);
    errorText = '';
    refreshHint();
  });

  cancel?.addEventListener('click', close);
  overlay?.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  confirm?.addEventListener('click', () => {
    if (busy) return;
    void (async () => {
      if (picked.size < 2) {
        errorText = '至少选两条记录才能合并';
        refreshHint();
        return;
      }
      errorText = '';
      busy = true;
      confirm.disabled = true;
      confirm.textContent = '合并中…';
      if (hint) {
        hint.classList.remove('bad');
        hint.textContent = `正在读取 ${picked.size} 段轨迹、重算时长与速度…`;
      }
      try {
        const outcome = await mergeRecords(Array.from(picked));
        close();
        await onDone(outcome);
      } catch (error) {
        errorText = error instanceof Error ? error.message : '合并失败，请重试';
        showToast(`合并失败：${errorText}`, true);
      } finally {
        busy = false;
        confirm.textContent = '开始合并';
        refreshHint();
      }
    })();
  });

  return {
    close,
    open: async () => {
      if (!overlay) return;
      overlay.hidden = false;
      picked.clear();
      errorText = '';
      if (sub) sub.textContent = '勾选 2 条以上同类型记录：同一条路线只画一条轨迹、数据取最优值；不同路线要求首尾相接。';
      if (list) list.innerHTML = '<p class="merge-hint">正在读取记录…</p>';
      if (confirm) {
        confirm.disabled = true;
        confirm.textContent = '开始合并';
      }
      try {
        metas = await mergeCandidates();
        render();
      } catch (error) {
        if (list) list.innerHTML = `<p class="merge-hint">读取失败：${error instanceof Error ? error.message : '未知错误'}</p>`;
      }
    },
  };
}
