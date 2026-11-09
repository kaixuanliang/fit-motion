/**
 * 预览试听播放器：跟随创作页的播放头走。
 *
 * 播放 → 从当前播放头起播；暂停/拖进度 → 同步停或跳；倍速 → 连音调一起变
 * （跟视频一起加速，和磁带快进是一个效果）。缓冲由 synth 模块缓存，
 * 同一条记录反复播放不会重新渲染。
 */

import { renderMusicBuffer } from './synth';

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private key = '';

  /** 预渲染（幂等）。曲目为 none 或渲染失败时静默无操作。 */
  async prepare(trackId: string, duration: number): Promise<void> {
    if (trackId === 'none') {
      this.clearBuffer();
      return;
    }
    const key = `${trackId}:${duration.toFixed(2)}`;
    if (key === this.key && this.buffer) return;
    this.stop();
    try {
      const buffer = await renderMusicBuffer(trackId, duration);
      if (!buffer) return;
      this.buffer = buffer;
      this.key = key;
    } catch (error) {
      console.warn('[fit-motion] 音乐渲染失败', error);
      this.buffer = null;
      this.key = '';
    }
  }

  ready(): boolean {
    return this.buffer != null;
  }

  clearBuffer(): void {
    this.stop();
    this.buffer = null;
    this.key = '';
  }

  /** 从 offset 秒开始播放（幂等：会先停掉上一个 source）。 */
  async play(offset: number, rate = 1): Promise<void> {
    this.stop();
    if (!this.buffer) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const source = this.ctx.createBufferSource();
      source.buffer = this.buffer;
      source.playbackRate.value = Math.max(0.25, Math.min(5, rate));
      source.connect(this.ctx.destination);
      const at = Math.max(0, Math.min(this.buffer.duration - 0.05, offset));
      source.start(0, at);
      this.source = source;
    } catch (error) {
      console.warn('[fit-motion] 音乐播放失败', error);
    }
  }

  stop(): void {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.source.disconnect();
    } catch {
      /* already disconnected */
    }
    this.source = null;
  }

  /** 正在响吗（供 EQ 动画用）。 */
  playing(): boolean {
    return this.source != null;
  }

  async close(): Promise<void> {
    this.stop();
    this.clearBuffer();
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
  }
}

/**
 * 选曲弹层里的独立试听：渲染 12 秒片段并循环。
 * 与 MusicPlayer 分开，避免打开弹层就打断预览播放。
 */
export class AuditionPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private trackId = '';

  async toggle(trackId: string): Promise<boolean> {
    if (this.trackId === trackId && this.source) {
      this.stop();
      return false;
    }
    this.stop();
    try {
      const buffer = await renderMusicBuffer(trackId, 12);
      if (!buffer) return false;
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this.ctx.destination);
      source.start();
      this.source = source;
      this.trackId = trackId;
      return true;
    } catch (error) {
      console.warn('[fit-motion] 试听失败', error);
      return false;
    }
  }

  stop(): void {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      /* ignore */
    }
    try {
      this.source.disconnect();
    } catch {
      /* ignore */
    }
    this.source = null;
    this.trackId = '';
  }
}
