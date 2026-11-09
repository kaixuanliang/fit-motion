/**
 * 视频主题选择弹层（复用选曲弹层的样式）。
 *
 * 入口：全屏播放时点击右下角的主题标签（#fs-theme-tag），
 * 也可以从其它入口调用 openThemeSheet。选择后立即重建舞台。
 */

import { THEMES, type ThemeId } from '../render/theme';

/** 与设置页 theme-grid 的小注一致。 */
const THEME_NOTES: Record<ThemeId, string> = {
  tech: '青黑 · 荧光',
  night: '深蓝 · 霓虹',
  bright: '暖白 · 湖蓝',
};
const ORDER: ThemeId[] = ['tech', 'night', 'bright'];

function closeSheet(): void {
  document.getElementById('theme-sheet')?.classList.remove('open');
}

/** 全屏栏右下角的主题标签文字。 */
export function syncFsThemeTag(label: string): void {
  const tag = document.getElementById('fs-theme-tag');
  if (tag) tag.textContent = `${label}主题`;
}

export function openThemeSheet(current: ThemeId, apply: (id: ThemeId) => void): void {
  const sheet = document.getElementById('theme-sheet');
  const list = document.getElementById('theme-list');
  if (!sheet || !list) return;

  list.textContent = '';
  for (const id of ORDER) {
    const theme = THEMES[id];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `song${id === current ? ' on' : ''}`;
    row.dataset.pickTheme = id;
    row.innerHTML = `<span class="song-name">${theme.label}</span>`
      + `<span class="song-note">${THEME_NOTES[id]}</span>`
      + '<span class="song-check">✓</span>';
    row.addEventListener('click', () => {
      if (id !== current) apply(id);
      closeSheet();
    });
    list.appendChild(row);
  }

  sheet.classList.add('open');
}

export function initThemeSheet(getCurrent: () => ThemeId, apply: (id: ThemeId) => void): void {
  document.getElementById('fs-theme-tag')?.addEventListener('click', () => {
    openThemeSheet(getCurrent(), apply);
  });
  document.getElementById('theme-sheet-mask')?.addEventListener('click', closeSheet);
}
