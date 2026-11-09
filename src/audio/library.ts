/**
 * 内置曲库。
 *
 * 音乐不在安装包里放任何音频文件 —— 三首曲子全部由 WebAudio 离线合成，
 * 导出时再实时渲染成与视频等长的 PCM。好处：
 * - APK 体积不变（0 字节曲库）；
 * - 音乐长度永远精确等于视频长度，不需要循环拼贴处理；
 * - 不存在版权问题。
 */

export interface MusicTrack {
  id: string;
  name: string;
  /** 列表右侧的小字 */
  note: string;
  bpm: number;
  kind: 'electronic' | 'drive' | 'ambient' | 'local' | 'none';
}

export const MUSIC_TRACKS: MusicTrack[] = [
  { id: 'pulse', name: '晨风 · 轻电子', note: '92 BPM · 循环 · 结尾 0.5s 淡出', bpm: 92, kind: 'electronic' },
  { id: 'drive', name: '疾驰 · 公路律动', note: '126 BPM · 循环 · 结尾 0.5s 淡出', bpm: 126, kind: 'drive' },
  { id: 'dusk', name: '落日 · 氛围', note: '72 BPM · 循环 · 结尾 0.5s 淡出', bpm: 72, kind: 'ambient' },
  { id: 'local', name: '本地音乐', note: '选手机里的 mp3 / flac', bpm: 0, kind: 'local' },
  { id: 'none', name: '无音乐', note: '静音导出', bpm: 0, kind: 'none' },
];

export const DEFAULT_MUSIC = 'pulse';

export function musicById(id: string): MusicTrack {
  return MUSIC_TRACKS.find((track) => track.id === id) ?? MUSIC_TRACKS[MUSIC_TRACKS.length - 1];
}

export function musicName(id: string): string {
  return musicById(id).name;
}
