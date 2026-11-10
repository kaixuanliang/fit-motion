/**
 * 曲库的离线合成器。
 *
 * 一首曲子 = 若干小节的循环反复，直到铺满视频时长；结尾 0.5 秒淡出。
 * 合成走 OfflineAudioContext：比实时快一个量级（38 秒的曲子约 0.3~1 秒
 * 渲染完），且不依赖任何音频文件。
 *
 * 预览试听和导出共用同一个渲染函数，保证「听到的就是导出的」。
 */

import { musicById } from './library';

const SAMPLE_RATE = 44100;
/** 导出时音轨整体的峰值目标，留出 headroom 给 AAC 编码器。 */
const MASTER_GAIN = 0.8;

export const MUSIC_FADE_SEC = 0.5;

/** midi 音符号 → 频率 */
function n2f(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

interface AudioNodeGraph {
  ctx: OfflineAudioContext;
  dest: AudioNode;
}

function kick(g: AudioNodeGraph, t: number, gain: number, pitch = 120): void {
  const osc = g.ctx.createOscillator();
  const amp = g.ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(pitch, t);
  osc.frequency.exponentialRampToValueAtTime(42, t + 0.1);
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  osc.connect(amp).connect(g.dest);
  osc.start(t);
  osc.stop(t + 0.26);
}

function hat(g: AudioNodeGraph, t: number, gain: number, dur = 0.045): void {
  const len = Math.max(64, Math.floor(SAMPLE_RATE * dur));
  const noise = g.ctx.createBuffer(1, len, SAMPLE_RATE);
  const data = noise.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  const src = g.ctx.createBufferSource();
  src.buffer = noise;
  const hp = g.ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7200;
  const amp = g.ctx.createGain();
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(hp).connect(amp).connect(g.dest);
  src.start(t);
}

function bassNote(
  g: AudioNodeGraph,
  t: number,
  freq: number,
  dur: number,
  gain: number,
  type: OscillatorType = 'sawtooth',
  cutoff = 320,
): void {
  const osc = g.ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const lp = g.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  const amp = g.ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.linearRampToValueAtTime(gain, t + 0.012);
  amp.gain.setTargetAtTime(0.0001, t + dur * 0.72, 0.035);
  osc.connect(lp).connect(amp).connect(g.dest);
  osc.start(t);
  osc.stop(t + dur + 0.12);
}

function padChord(g: AudioNodeGraph, t: number, midis: number[], dur: number, gain: number, wide = true): void {
  for (const midi of midis) {
    const detunes = wide ? [-7, 7] : [0];
    for (const detune of detunes) {
      const osc = g.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = n2f(midi);
      osc.detune.value = detune;
      const lp = g.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(480, t);
      lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.45);
      lp.frequency.linearRampToValueAtTime(620, t + dur);
      const amp = g.ctx.createGain();
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.linearRampToValueAtTime(gain, t + dur * 0.28);
      amp.gain.setTargetAtTime(0.0001, t + dur * 0.82, 0.09);
      osc.connect(lp).connect(amp).connect(g.dest);
      osc.start(t);
      osc.stop(t + dur + 0.2);
    }
  }
}

function pluck(
  g: AudioNodeGraph,
  t: number,
  midi: number,
  gain: number,
  dur = 0.3,
  type: OscillatorType = 'triangle',
): void {
  const osc = g.ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = n2f(midi);
  const amp = g.ctx.createGain();
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(amp).connect(g.dest);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/** 晨风 · 轻电子：Am–F–C–G，温和的四拍底鼓 + 八分音符琶音。 */
function electronic(g: AudioNodeGraph, seconds: number): void {
  const beat = 60 / 92;
  const bar = beat * 4;
  // 和弦（midi）：Am F C G，低声部给 pad，高声部给琶音
  const chords: Array<[number[], number[]]> = [
    [[45, 57, 60, 64], [69, 72, 76, 81]],
    [[41, 53, 57, 60], [65, 69, 72, 77]],
    [[48, 60, 64, 67], [72, 76, 79, 84]],
    [[43, 55, 59, 62], [67, 71, 74, 79]],
  ];
  let barIndex = 0;
  for (let t = 0; t < seconds; t += bar, barIndex += 1) {
    const [low, high] = chords[barIndex % chords.length];
    padChord(g, t, low, Math.min(bar * 1.05, seconds - t), 0.055);
    for (let b = 0; b < 4 && t + b * beat < seconds; b += 1) {
      const tb = t + b * beat;
      kick(g, tb, b % 2 === 0 ? 0.5 : 0.34, 110);
      bassNote(g, tb, n2f(low[0]), beat * 0.9, 0.16, 'triangle', 260);
      for (let h = 0; h < 2; h += 1) {
        const th = tb + (h * beat) / 2;
        if (th < seconds) hat(g, th, 0.035);
      }
    }
    for (let e = 0; e < 8; e += 1) {
      const te = t + (e * bar) / 8;
      if (te >= seconds) break;
      pluck(g, te, high[e % high.length], 0.085, 0.26);
    }
  }
}

/** 疾驰 · 公路律动：Em–C–G–D，126 BPM 四踩 + 反拍开镲 + 十六分贝斯。 */
function drive(g: AudioNodeGraph, seconds: number): void {
  const beat = 60 / 126;
  const bar = beat * 4;
  const chords: Array<[number[], number[]]> = [
    [[40, 52, 55, 59], [64, 67, 71, 76]],
    [[36, 48, 52, 55], [60, 64, 67, 72]],
    [[43, 55, 59, 62], [67, 71, 74, 79]],
    [[38, 50, 54, 57], [62, 66, 69, 74]],
  ];
  let barIndex = 0;
  for (let t = 0; t < seconds; t += bar, barIndex += 1) {
    const [low, high] = chords[barIndex % chords.length];
    padChord(g, t, low, Math.min(bar * 1.05, seconds - t), 0.045);
    for (let b = 0; b < 4; b += 1) {
      const tb = t + b * beat;
      if (tb >= seconds) break;
      kick(g, tb, 0.62, 128);
      const open = tb + beat / 2;
      if (open < seconds) hat(g, open, 0.05, 0.09);
      hat(g, tb, 0.022);
      for (const [step, octave] of [[0, 0], [2, 0], [4, 12], [6, 0]] as Array<[number, number]>) {
        const ts = tb + (step * beat) / 4;
        if (ts < seconds) bassNote(g, ts, n2f(low[0] + octave), beat * 0.22, 0.19, 'sawtooth', 420);
      }
    }
    for (let e = 0; e < 16; e += 1) {
      const te = t + (e * bar) / 16;
      if (te >= seconds) break;
      if (e % 4 === 3) continue;
      const note = high[(e * 3) % high.length];
      pluck(g, te, note, 0.05, 0.12, 'square');
      // 手动回声：把旋律在 3/16 拍后用更低音量再放一遍
      const echo = te + (bar * 3) / 16;
      if (echo < seconds) pluck(g, echo, note, 0.022, 0.12, 'square');
    }
  }
}

/** 落日 · 氛围：没有鼓，只有宽 pad、正弦贝斯和稀疏的钟琴。 */
function ambient(g: AudioNodeGraph, seconds: number): void {
  const bar = (60 / 72) * 4;
  const chords: Array<[number[], number[]]> = [
    [[41, 53, 57, 60, 64], [77, 72, 69]],
    [[45, 57, 60, 64, 67], [76, 72, 64]],
    [[40, 52, 55, 59, 62], [71, 67, 64]],
    [[43, 55, 59, 62, 66], [74, 69, 62]],
  ];
  let barIndex = 0;
  for (let t = 0; t < seconds; t += bar * 2, barIndex += 1) {
    const [low, sparkle] = chords[barIndex % chords.length];
    padChord(g, t, low, Math.min(bar * 2.1, seconds - t), 0.05);
    const sub = g.ctx.createOscillator();
    const subAmp = g.ctx.createGain();
    sub.type = 'sine';
    sub.frequency.value = n2f(low[0] - 12);
    subAmp.gain.setValueAtTime(0.0001, t);
    subAmp.gain.linearRampToValueAtTime(0.13, t + bar * 0.4);
    subAmp.gain.setTargetAtTime(0.0001, t + bar * 1.4, 0.4);
    sub.connect(subAmp).connect(g.dest);
    sub.start(t);
    sub.stop(Math.min(t + bar * 2.4, seconds));
    for (let s = 0; s < 4; s += 1) {
      const ts = t + s * (bar / 2) + 0.31;
      if (ts >= seconds) break;
      pluck(g, ts, sparkle[(s + barIndex) % sparkle.length], 0.06, 0.9, 'sine');
    }
  }
}

const GENERATORS: Record<string, (g: AudioNodeGraph, seconds: number) => void> = {
  electronic,
  drive,
  ambient,
};

/**
 * 曲目 → 循环小节数。和弦进行的最小完整周期：
 * electronic / drive 四个和弦各一小节；ambient 两个小节换一次和弦，
 * 四个和弦要八小节才走完一圈。
 */
const LOOP_BARS: Record<string, number> = { electronic: 4, drive: 4, ambient: 8 };

const loopCache = new Map<string, AudioBuffer>();
/** 拼好淡入淡出的成品缓存（曲目+时长）。 */
const bufferCache = new Map<string, AudioBuffer>();

function loopSeconds(trackId: string): number {
  const track = musicById(trackId);
  const bpm = track.bpm;
  const bars = LOOP_BARS[track.kind] ?? 4;
  return (60 / bpm) * 4 * bars;
}

/**
 * 渲染一个曲目的「循环体」。WebAudio 对大量短生命周期节点的处理是
 * 超线性的（38 秒整轨要十几秒），而循环体只有 4~8 小节，几百毫秒
 * 就能渲完；渲一次按曲目缓存，之后任意时长都是纯采样搬运。
 */
async function renderLoop(trackId: string): Promise<AudioBuffer | null> {
  const track = musicById(trackId);
  const generator = GENERATORS[track.kind];
  if (!generator) return null;
  const seconds = loopSeconds(trackId);
  const ctx = new OfflineAudioContext(2, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp);
  comp.connect(ctx.destination);
  generator({ ctx, dest: master }, seconds);
  return ctx.startRendering();
}

/** 循环体平铺到任意时长（采样级复制，毫秒级），再叠淡入淡出。 */
function tileLoop(loop: AudioBuffer, seconds: number): AudioBuffer {
  const frames = Math.max(1, Math.ceil(SAMPLE_RATE * seconds));
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const out = ctx.createBuffer(2, frames, SAMPLE_RATE);
  const fadeIn = Math.min(0.6, seconds * 0.2);
  // 结尾固定淡出 0.5s（视频太短时最多占一半），避免最后一个音被硬切出爆音
  const fadeOut = Math.min(MUSIC_FADE_SEC, seconds * 0.5);
  for (let c = 0; c < 2; c += 1) {
    const dst = out.getChannelData(c);
    const src = loop.getChannelData(Math.min(c, loop.numberOfChannels - 1));
    let offset = 0;
    while (offset < frames) {
      const chunk = Math.min(src.length, frames - offset);
      dst.set(src.subarray(0, chunk), offset);
      offset += chunk;
    }
    for (let i = 0; i < frames; i += 1) {
      const t = i / SAMPLE_RATE;
      let gain = 1;
      if (t < fadeIn) gain *= t / fadeIn;
      const fromEnd = seconds - t;
      if (fromEnd < fadeOut) gain *= Math.max(0, fromEnd / fadeOut);
      if (gain !== 1) dst[i] *= gain;
    }
  }
  return out;
}

interface StoredLocalMusic {
  name: string;
  size: number;
  stamp: number;
  blob: Blob;
}

/** 读本地音乐设置。文件指纹用 文件名+大小+修改时间，换了文件必须能区分开。 */
async function readLocalMusic(): Promise<StoredLocalMusic | null> {
  try {
    const { getSetting } = await import('../store/db');
    const stored = await getSetting<{ name: string; blob: Blob; stamp?: number } | null>('music-local-file', null);
    if (!stored?.blob) return null;
    const stamp = stored.stamp
      ?? (stored.blob as Blob & { lastModified?: number }).lastModified
      ?? 0;
    return { name: stored.name, size: stored.blob.size, stamp, blob: stored.blob };
  } catch {
    return null;
  }
}

/**
 * 缓存键：内置曲目只看「曲目+时长」；本地音乐还要带上文件指纹，
 * 否则换了另一首歌（曲目 id 仍是 local）会命中旧缓冲，听起来像没换成功。
 */
export async function musicCacheKey(trackId: string, seconds: number): Promise<string> {
  const base = seconds.toFixed(2);
  if (trackId !== 'local') return `${trackId}:${base}`;
  const stored = await readLocalMusic();
  return stored
    ? `local:${stored.name}:${stored.size}:${stored.stamp}:${base}`
    : `local:none:${base}`;
}

/** 本地文件换掉后，旧缓冲没有价值了，顺手清掉避免占内存。 */
function pruneLocalBuffers(): void {
  for (const key of Array.from(bufferCache.keys())) {
    if (key.startsWith('local:')) bufferCache.delete(key);
  }
}

/**
 * 渲染指定曲目的完整 AudioBuffer。同一 (曲目, 时长) 只渲染一次，
 * 预览与导出共享缓存。
 */
export async function renderMusicBuffer(trackId: string, seconds: number): Promise<AudioBuffer | null> {
  if (trackId === 'none' || seconds <= 0.2) return null;
  const key = await musicCacheKey(trackId, seconds);
  const cached = bufferCache.get(key);
  if (cached) return cached;

  if (trackId === 'local') {
    // 本地音乐：文件存 IndexedDB（Blob），用时解码一次，之后按视频时长平铺
    const decoded = await loadLocalMusicBuffer();
    if (!decoded) return null;
    pruneLocalBuffers();
    const buffer = tileLoop(decoded, seconds);
    bufferCache.set(key, buffer);
    return buffer;
  }

  let loop = loopCache.get(trackId) ?? null;
  if (!loop) {
    loop = await renderLoop(trackId);
    if (!loop) return null;
    loopCache.set(trackId, loop);
  }
  const buffer = tileLoop(loop, seconds);
  bufferCache.set(key, buffer);
  return buffer;
}

let localDecoded: AudioBuffer | null = null;
let localKey = '';

/** 解码本地音乐文件（mp3/flac 等），换歌后重新解码。结果缓存在内存里。 */
async function loadLocalMusicBuffer(): Promise<AudioBuffer | null> {
  try {
    const stored = await readLocalMusic();
    if (!stored) return null;
    const key = `${stored.name}:${stored.size}:${stored.stamp}`;
    if (localDecoded && localKey === key) return localDecoded;
    const ctx = new OfflineAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
    const bytes = await stored.blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes);
    localDecoded = decoded;
    localKey = key;
    return decoded;
  } catch (error) {
    console.warn('[fit-motion] 本地音乐解码失败', error);
    return null;
  }
}

/** AudioBuffer → 交织的 16-bit PCM（给原生 AAC 编码器吃）。 */
export function bufferToPcm(buffer: AudioBuffer): { pcm: Int16Array; sampleRate: number; channels: number } {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const out = new Int16Array(frames * channels);
  const lanes: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) lanes.push(buffer.getChannelData(c));
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const v = Math.max(-1, Math.min(1, lanes[c][i]));
      out[i * channels + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  return { pcm: out, sampleRate: buffer.sampleRate, channels };
}

/** Uint8Array → base64，分块避免 String.fromCharCode 爆栈。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 导出用：渲染整轨并转成 payload 里给原生层的字段。
 * 返回 null 表示无音乐。
 *
 * seconds 传「成片时长」。倍速导出时画面整体加速，但背景音乐保持原速：
 * 渲染出的 PCM 长度恰好等于成片时长，原生层的音画时长校验（200ms）能过。
 */
export async function renderMusicPcm(
  trackId: string,
  seconds: number,
): Promise<{ pcm: string; sampleRate: number; channels: number; bytes: number } | null> {
  const buffer = await renderMusicBuffer(trackId, seconds);
  if (!buffer) return null;
  const { pcm, sampleRate, channels } = bufferToPcm(buffer);
  const view = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return { pcm: bytesToBase64(view), sampleRate, channels, bytes: view.byteLength };
}
