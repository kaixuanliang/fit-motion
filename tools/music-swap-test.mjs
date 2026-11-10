/**
 * 本地音乐换曲回归：
 * 1. 连续选择两个不同的本地音频，第二次必须重新渲染（缓存键要带文件指纹）；
 * 2. MusicPlayer 的预备键同样要变，否则预览仍放旧歌；
 * 3. 渲染结果结尾 0.5s 必须淡出（末尾 RMS 显著低于中段）。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const out = await page.evaluate(async () => {
  const { setSetting, getSetting } = await import('/src/store/db.ts');
  const { renderMusicBuffer, musicCacheKey } = await import('/src/audio/synth.ts');
  const { MusicPlayer } = await import('/src/audio/player.ts');

  /** 生成单声道 16bit WAV，freq 决定音高，用于区分两首歌 */
  const wavBytes = (freq, seconds = 3) => {
    const rate = 44100;
    const frames = rate * seconds;
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const write = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + frames * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i += 1) {
      view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), true);
    }
    return new Uint8Array(buffer);
  };

  const zeroCrossings = (buffer, fromSec, toSec) => {
    const data = buffer.getChannelData(0);
    const a = Math.floor(fromSec * buffer.sampleRate);
    const b = Math.min(data.length, Math.floor(toSec * buffer.sampleRate));
    let count = 0;
    for (let i = a + 1; i < b; i += 1) {
      if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) count += 1;
    }
    return count;
  };

  const rms = (buffer, fromSec, toSec) => {
    const data = buffer.getChannelData(0);
    const a = Math.max(0, Math.floor(fromSec * buffer.sampleRate));
    const b = Math.min(data.length, Math.floor(toSec * buffer.sampleRate));
    let sum = 0;
    for (let i = a; i < b; i += 1) sum += data[i] * data[i];
    return b > a ? Math.sqrt(sum / (b - a)) : 0;
  };

  const report = {};
  const player = new MusicPlayer();

  const pick = async (name, freq, stamp) => {
    const blob = new File([wavBytes(freq)], name, { type: 'audio/wav', lastModified: stamp });
    await setSetting('music-local-file', { name, blob, stamp });
    await setSetting('music-local-name', name.replace(/\.wav$/, ''));
    await setSetting('music', 'local');
  };

  // 第一次：440Hz
  await pick('a.wav', 440, 1000);
  const keyA = await musicCacheKey('local', 6);
  await player.prepare('local', 6);
  const playerKeyA = player.key;
  const bufA = await renderMusicBuffer('local', 6);

  // 第二次：880Hz（同名不同内容之外，直接换名字+指纹）
  await pick('b.wav', 880, 2000);
  const keyB = await musicCacheKey('local', 6);
  await player.prepare('local', 6);
  const playerKeyB = player.key;
  const bufB = await renderMusicBuffer('local', 6);

  report.cacheKeyChanged = keyA !== keyB;
  report.playerKeyChanged = playerKeyA !== playerKeyB;
  report.renderedDifferent = bufA !== bufB;
  report.bufferLengthMatch = bufA.length === bufB.length;
  report.zeroCrossA = zeroCrossings(bufA, 1, 2);
  report.zeroCrossB = zeroCrossings(bufB, 1, 2);
  report.toneChanged = report.zeroCrossB > report.zeroCrossA * 1.5;

  // 淡出：末尾 0.5s 的 RMS 应显著低于中段
  const midRms = rms(bufB, 2.5, 3.5);
  const tailRms = rms(bufB, 5.75, 6);
  const lastSample = Math.abs(bufB.getChannelData(0)[bufB.length - 1]);
  report.fade = {
    midRms: Number(midRms.toFixed(4)),
    tailRms: Number(tailRms.toFixed(4)),
    ratio: Number((tailRms / (midRms || 1)).toFixed(3)),
    lastSample: Number(lastSample.toFixed(4)),
    fading: tailRms < midRms * 0.45 && lastSample < 0.02,
  };

  // 同名同大小但换了内容（lastModified 变化）也要能区分
  await setSetting('music-local-file', { name: 'b.wav', blob: new File([wavBytes(660)], 'b.wav', { type: 'audio/wav', lastModified: 3000 }), stamp: 3000 });
  report.thirdKeyDiffers = (await musicCacheKey('local', 6)) !== keyB;

  const stored = await getSetting('music-local-file', null);
  report.storedName = stored?.name ?? null;
  player.close?.();
  return report;
});

await browser.close();
console.log(JSON.stringify({ ...out, errors }, null, 2));
