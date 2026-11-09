/**
 * 导入页：文件选择、华为导出引导、批量进度与结果。
 *
 * 导入完成后刷新列表并跳到「记录」，让用户立刻看到新数据。
 */

import { importFiles, type ImportOutcome } from '../import/batch';
import { getMinDistanceKm, setMinDistanceKm } from '../import/settings';
import type { ImportResult } from '../store/types';
import { showText } from './dialog';
import { showPane } from './router';

const GUIDE_TEXT = [
  '你好，我申请导出的运动健康数据副本里只有最近 1 年的记录，我需要导出最近 5 年的全部运动数据（含轨迹），',
  '麻烦帮忙把我的历史数据准备到导出系统，谢谢。',
].join('');

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function mark(status: ImportResult['status']): string {
  if (status === 'added') return '<span class="st ok">新增</span>';
  if (status === 'replaced') return '<span class="st ok">已替换</span>';
  if (status === 'duplicate-file' || status === 'duplicate-motion') return '<span class="st dup">重复跳过</span>';
  if (status === 'too-short') return '<span class="st short">低于门槛</span>';
  return '<span class="st bad">跳过</span>';
}

function rowHtml(result: ImportResult): string {
  const note = result.status === 'duplicate-motion'
    ? `重复 · ${result.message ?? ''}`
    : result.status === 'duplicate-file'
      ? '同一文件之前已导入'
      : result.status === 'replaced'
        ? result.message ?? '已用更完整的数据替换'
        : result.status === 'no-gps'
          ? result.message ?? '没有可用的 GPS 点'
          : result.status === 'error'
            ? result.message ?? '导入失败'
            : result.status === 'too-short'
              ? result.message ?? '距离低于门槛'
              : '';
  return `<div class="recent-row">
    <span class="nm">${result.name}</span>
    ${note ? `<span class="st" style="color:var(--dim);font-size:9px;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${note}</span>` : ''}
    ${mark(result.status)}
  </div>`;
}

function reportText(outcome: ImportOutcome): string {
  const summary = [`新增 ${outcome.added} 条 · 重复 ${outcome.duplicated} 条`];
  const replaced = outcome.results.filter((r) => r.status === 'replaced').length;
  if (replaced > 0) summary.push(`替换 ${replaced} 条`);
  if (outcome.filtered > 0) summary.push(`低于距离 ${outcome.filtered} 条`);
  summary.push(`失败 ${outcome.failed} 条`);
  const lines = [summary.join(' · '), ''];
  for (const result of outcome.results.slice(0, 40)) {
    const prefix = result.status === 'added' || result.status === 'replaced' ? '✓' : result.status === 'error' ? '✕' : '·';
    const note = result.message ? `  — ${result.message}` : '';
    lines.push(`${prefix} ${result.name}${note}`);
  }
  if (outcome.results.length > 40) lines.push(`… 其余 ${outcome.results.length - 40} 条已省略`);
  return lines.join('\n');
}

export interface ImportApi {
  refresh(): Promise<void>;
  /** 外部（拖拽、记录页）触发的导入 */
  run(files: File[]): Promise<void>;
}

export function initImport(onDone: () => Promise<void>): ImportApi {
  const overlay = $<HTMLDivElement>('import-overlay');
  const title = $<HTMLElement>('import-title');
  const status = $<HTMLParagraphElement>('import-status');
  const fill = $<HTMLElement>('import-progress-fill');
  const report = $<HTMLPreElement>('import-report');
  const close = $<HTMLButtonElement>('import-close');
  const input = $<HTMLInputElement>('file-input');
  const recentCard = $<HTMLDivElement>('recent-card');
  const recentList = $<HTMLDivElement>('recent-list');

  let lastResults: ImportResult[] = [];
  let busy = false;
  let autoTimer: number | null = null;

  const cancelAutoClose = (): void => {
    if (autoTimer != null) {
      window.clearTimeout(autoTimer);
      autoTimer = null;
    }
    $<HTMLElement>('import-auto')?.setAttribute('hidden', '');
  };

  const hideOverlay = (): void => {
    cancelAutoClose();
    if (overlay) overlay.hidden = true;
  };

  const autoClose = (seconds: number): void => {
    const hint = $<HTMLElement>('import-auto');
    if (!hint) return;
    let left = seconds;
    hint.removeAttribute('hidden');
    const tick = (): void => {
      if (left <= 0) {
        hideOverlay();
        return;
      }
      hint.textContent = `${left} 秒后自动关闭 · 点弹窗任意处可留下查看`;
      left -= 1;
      autoTimer = window.setTimeout(tick, 1000);
    };
    tick();
  };

  const openPicker = (jsonOnly = false): void => {
    if (!input) return;
    input.accept = jsonOnly
      ? '.json,application/json'
      : '.fit,.gpx,.tcx,.json,application/octet-stream,application/gpx+xml,application/vnd.garmin.tcx+xml';
    input.value = '';
    input.click();
  };

  const showOverlay = (message: string): void => {
    if (!overlay) return;
    cancelAutoClose();
    overlay.hidden = false;
    if (title) title.textContent = '正在导入';
    if (status) status.textContent = message;
    if (fill) fill.style.width = '4%';
    if (report) {
      report.hidden = true;
      report.textContent = '';
    }
  };

  const runImport = async (files: File[]): Promise<void> => {
    if (busy || !files.length) return;
    busy = true;
    const minDistanceKm = getMinDistanceKm();
    showOverlay(`准备导入 ${files.length} 个文件…`);
    try {
      const outcome = await importFiles(files, (progress) => {
        if (!status || !fill) return;
        const ratio = progress.total ? progress.done / progress.total : 0;
        fill.style.width = `${Math.max(4, Math.round(ratio * 100))}%`;
        status.textContent = `正在处理 ${progress.label}`;
      }, { minDistanceM: minDistanceKm * 1000 });
      lastResults = outcome.results;

      if (title) title.textContent = outcome.added > 0 ? '导入完成' : '没有新增记录';
      if (status) {
        const parts = [`新增 ${outcome.added} 条`, `重复 ${outcome.duplicated} 条`];
        if (outcome.filtered > 0) parts.push(`低于距离 ${outcome.filtered} 条`);
        parts.push(`失败 ${outcome.failed} 条`);
        status.textContent = parts.join(' · ');
      }
      if (fill) fill.style.width = '100%';
      if (report) {
        report.hidden = false;
        report.textContent = reportText(outcome);
      }
      renderRecent();
      await onDone();
      // 全部成功时自动关掉弹窗，有失败时留给用户看原因
      if (outcome.failed === 0) autoClose(3);
    } catch (error) {
      if (title) title.textContent = '导入失败';
      if (status) status.textContent = error instanceof Error ? error.message : '导入失败';
    } finally {
      busy = false;
    }
  };

  const renderRecent = (): void => {
    if (!recentCard || !recentList) return;
    if (!lastResults.length) {
      recentCard.hidden = true;
      return;
    }
    recentCard.hidden = false;
    recentList.innerHTML = lastResults.slice(0, 12).map(rowHtml).join('');
  };

  $<HTMLButtonElement>('pick-files')?.addEventListener('click', () => openPicker(false));
  $<HTMLButtonElement>('hw-pick')?.addEventListener('click', () => openPicker(true));

  $<HTMLButtonElement>('hw-guide')?.addEventListener('click', () => {
    const done = (): void => {
      const button = $<HTMLButtonElement>('hw-guide');
      if (!button) return;
      const original = button.textContent;
      button.textContent = '已复制';
      window.setTimeout(() => { button.textContent = original; }, 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(GUIDE_TEXT).then(done).catch(() => {
        void showText({ title: '发给华为客服的话术', text: GUIDE_TEXT, confirmText: '关闭' });
      });
    } else {
      void showText({ title: '发给华为客服的话术', text: GUIDE_TEXT, confirmText: '关闭' });
    }
  });

  input?.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : [];
    if (files.length) void runImport(files);
  });

  // 最小导入距离：写在 localStorage，下次打开还在
  const minInput = $<HTMLInputElement>('min-distance');
  const minNote = $<HTMLParagraphElement>('min-distance-note');
  const syncMinHint = (): void => {
    const km = getMinDistanceKm();
    if (minInput && document.activeElement !== minInput) {
      minInput.value = km > 0 ? String(km) : '';
    }
    if (minNote) {
      minNote.textContent = km > 0
        ? `低于 ${km} km 的轨迹会被跳过，不写入记录库；填 0 表示不限。`
        : '低于这个距离的轨迹不导入，避免通勤、买菜记录占满列表。填 0 表示不限。';
    }
  };
  syncMinHint();
  const commitMin = (): void => {
    const raw = minInput?.value.trim() ?? '';
    const value = raw ? Number(raw) : 0;
    setMinDistanceKm(Number.isFinite(value) ? value : 0);
    syncMinHint();
  };
  minInput?.addEventListener('change', commitMin);
  minInput?.addEventListener('blur', commitMin);

  close?.addEventListener('click', () => {
    const hadAdded = lastResults.some((result) => result.status === 'added');
    hideOverlay();
    if (hadAdded) showPane('records');
  });

  // 自动关闭倒计时期间点弹窗任意处 → 取消倒计时，留在结果页
  $<HTMLDivElement>('import-overlay')?.addEventListener('pointerdown', (event) => {
    if (autoTimer == null) return;
    if ((event.target as HTMLElement)?.id === 'import-close') return;
    cancelAutoClose();
  });

  return {
    refresh: async () => {
      renderRecent();
    },
    run: runImport,
  };
}
