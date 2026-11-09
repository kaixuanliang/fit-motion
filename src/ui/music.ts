/**
 * 选曲弹层与全局音乐状态。
 *
 * 当前曲目存 IndexedDB settings（key = 'music'），默认「晨风 · 轻电子」。
 * 本地音乐（mp3/flac）的文件本体存 'music-local-file'，歌名存 'music-local-name'。
 * 页面上所有 [data-song-name] 元素在换曲时统一刷新。
 */

import { MUSIC_TRACKS, DEFAULT_MUSIC, musicById } from '../audio/library';

export { musicById };
import { AuditionPlayer } from '../audio/player';
import { getSetting, setSetting } from '../store/db';

let currentTrackId = DEFAULT_MUSIC;
let localMusicName = '';
let loaded = false;
const audition = new AuditionPlayer();

/** 本地音乐大小上限：太大解码又慢又占内存。 */
const LOCAL_MUSIC_MAX_BYTES = 100 * 1024 * 1024;

export function currentMusicId(): string {
  return currentTrackId;
}

export function currentMusicName(): string {
  if (currentTrackId === 'local') return localMusicName || '本地音乐';
  return musicById(currentTrackId).name;
}

export async function loadMusicSetting(): Promise<string> {
  if (!loaded) {
    try {
      currentTrackId = await getSetting('music', DEFAULT_MUSIC);
      localMusicName = await getSetting('music-local-name', '');
    } catch {
      currentTrackId = DEFAULT_MUSIC;
    }
    loaded = true;
  }
  return currentTrackId;
}

function syncLabels(): void {
  const name = currentMusicName();
  document.querySelectorAll<HTMLElement>('[data-song-name]').forEach((el) => {
    el.textContent = name;
  });
  const settings = document.getElementById('set-music');
  if (settings) settings.textContent = currentTrackId === 'none' ? '无音乐' : name;
}

function closeSheet(): void {
  audition.stop();
  document.querySelectorAll<HTMLButtonElement>('[data-audition]').forEach((btn) => {
    btn.textContent = '试听';
    btn.classList.remove('on');
  });
  const sheet = document.getElementById('music-sheet');
  if (sheet) sheet.classList.remove('open');
}

export function openMusicSheet(): void {
  const sheet = document.getElementById('music-sheet');
  if (!sheet) return;
  buildList();
  sheet.classList.add('open');
}

function rowFor(track: (typeof MUSIC_TRACKS)[number]): HTMLButtonElement {
  const name = track.id === 'local' && localMusicName ? localMusicName : track.name;
  const note = track.id === 'local' && localMusicName ? '已选择 · 点击文件可更换' : track.note;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `song${track.id === currentTrackId ? ' on' : ''}`;
  row.innerHTML = `<span class="song-name">${name}</span>`
    + `<span class="song-note">${note}</span>`
    + (track.kind === 'none' ? '' : '<button class="audition" type="button" data-audition>试听</button>')
    + '<span class="song-check">✓</span>';
  row.dataset.track = track.id;
  return row;
}

function buildList(): void {
  const list = document.getElementById('music-list');
  if (!list) return;
  list.textContent = '';
  for (const track of MUSIC_TRACKS) {
    const row = rowFor(track);
    row.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-audition]')) {
        event.stopPropagation();
        const btn = target.closest<HTMLButtonElement>('[data-audition]');
        if (!btn) return;
        void (async () => {
          const on = await audition.toggle(track.id);
          document.querySelectorAll<HTMLButtonElement>('[data-audition]').forEach((item) => {
            const mine = (item.closest('.song') as HTMLElement | null)?.dataset.track === track.id;
            item.textContent = mine && on ? '停止' : '试听';
            item.classList.toggle('on', Boolean(mine && on));
          });
        })();
        return;
      }
      if (track.id === 'local' && !localMusicName) {
        pickLocalMusic();
        return;
      }
      void selectMusic(track.id);
      closeSheet();
    });
    list.appendChild(row);
  }

  // 本地音乐行下挂一个选文件的入口：没选过时点行就弹文件选择器
  if (!document.getElementById('music-local-file')) {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'music-local-file';
    input.accept = '.mp3,.flac,audio/mpeg,audio/flac,audio/*';
    input.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) void importLocalMusic(file);
    });
    list.appendChild(input);
  }
}

function pickLocalMusic(): void {
  document.getElementById('music-local-file')?.click();
}

async function importLocalMusic(file: File): Promise<void> {
  if (file.size > LOCAL_MUSIC_MAX_BYTES) {
    audition.stop();
    const { showToast } = await import('./toast');
    showToast('文件太大（上限 100 MB），换个小一点的吧', true);
    return;
  }
  const name = file.name.replace(/\.(mp3|flac|m4a|aac|wav)$/i, '') || '本地音乐';
  try {
    await setSetting('music-local-file', { name: file.name, blob: file });
    await setSetting('music-local-name', name);
    localMusicName = name;
    currentTrackId = 'local';
    syncLabels();
    window.dispatchEvent(new CustomEvent('fitmotion:music-changed', { detail: { trackId: 'local' } }));
    await setSetting('music', 'local');
    closeSheet();
  } catch {
    const { showToast } = await import('./toast');
    showToast('本地音乐保存失败，重试一次', true);
  }
}

async function selectMusic(trackId: string): Promise<void> {
  if (trackId === currentTrackId) return;
  currentTrackId = trackId;
  // 先刷新界面再落盘：IndexedDB 写入要几十毫秒，用户点完应该立刻看到新名字
  syncLabels();
  window.dispatchEvent(new CustomEvent('fitmotion:music-changed', { detail: { trackId } }));
  try {
    await setSetting('music', trackId);
  } catch {
    /* 存不进去也不拦着换曲，本次会话仍然生效 */
  }
}

export function initMusic(): void {
  void (async () => {
    await loadMusicSetting();
    syncLabels();
  })();
  document.getElementById('swap-music')?.addEventListener('click', openMusicSheet);
  document.getElementById('fs-swap')?.addEventListener('click', openMusicSheet);
  document.getElementById('set-music-btn')?.addEventListener('click', openMusicSheet);
  document.getElementById('music-sheet-mask')?.addEventListener('click', closeSheet);
}
