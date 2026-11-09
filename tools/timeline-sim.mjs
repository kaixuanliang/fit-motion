/**
 * 排查导出/预览时间线：
 * 1. 采样 JS 预览 stage.renderAt(t) 的 progress 曲线 —— 看片尾海报占了多久
 * 2. 用同一份数据复刻 Java NativeRouteScene.buildTimeline —— 看原生导出里
 *    路线何时走完、海报段从第几秒开始
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await page.evaluate(async () => {
  const { SAMPLE_FIT_BASE64, SAMPLE_NAME } = await import('/src/data/sample.ts');
  const bin = atob(SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], SAMPLE_NAME));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    const t = document.getElementById('import-title')?.textContent ?? '';
    if (/完成|没有新增|失败/.test(t)) break;
  }
  document.getElementById('import-close')?.click();
  document.querySelector('#records-pane .rec')?.click();
  for (let i = 0; i < 480; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (window.__fitReady === true) break;
  }
});

const data = await page.evaluate(() => {
  const stage = window.__fitStage;
  const a = stage.activity;
  const total = a.distanceM > 0 ? a.distanceM : 1;
  const mp = (p) => (p ? Math.max(0.03, Math.min(0.95, p.distance / total)) : null);
  return {
    duration: stage.duration,
    distanceKm: a.distanceM / 1000,
    moments: [
      { label: '最高海拔', p: mp(a.maxAltitudePoint) },
      { label: '最高心率', p: mp(a.maxHrPoint) },
      { label: '最快速度', p: mp(a.maxSpeedPoint) },
    ].filter((m) => m.p != null),
    // 采样预览曲线
    curve: (() => {
      const out = [];
      const step = 0.5;
      for (let t = 0; t <= stage.duration + 0.01; t += step) {
        const f = stage.renderAt(t);
        out.push({ t: +t.toFixed(1), phase: f.phase, progress: +f.progress.toFixed(3), reveal: f.resultReveal });
      }
      return out;
    })(),
  };
});
await browser.close();

console.log(`distance=${data.distanceKm.toFixed(1)}km  duration=${data.duration.toFixed(1)}s`);
console.log('moments:', data.moments.map((m) => `${m.label}@${(m.p * 100).toFixed(0)}%`).join('  '));

console.log('\n== JS 预览曲线（每 0.5s）==');
let lastPhase = '';
for (const c of data.curve) {
  const tag = c.phase !== lastPhase ? '  <== ' + c.phase : '';
  lastPhase = c.phase;
  console.log(`t=${String(c.t).padStart(5)}  progress=${(c.progress * 100).toFixed(0).padStart(3)}%  reveal=${c.reveal.toFixed(2)}${tag}`);
}

// ---- 复刻 Java buildTimeline ----
console.log('\n== Java 原生时间线复刻 ==');
const fps = 30;
const COVER = 1.0, INTRO = 0.8, OUTRO = 4.0, PAUSE = 1.4;
const totalFrames = Math.max(1, Math.ceil(data.duration * fps));
const moments = data.moments.map((m) => ({ progress: m.p }));
let coverFrames = Math.max(2, Math.round(COVER * fps));
let introFrames = Math.max(2, Math.round(INTRO * fps));
let outroFrames = Math.max(6, Math.round(OUTRO * fps));
let pauseFrames = Math.max(4, Math.round(PAUSE * fps));
const fixed = coverFrames + introFrames + outroFrames + pauseFrames * moments.length;
if (fixed > totalFrames * 0.85) {
  const shrink = (totalFrames * 0.85) / fixed;
  coverFrames = Math.max(2, Math.round(coverFrames * shrink));
  introFrames = Math.max(2, Math.round(introFrames * shrink));
  outroFrames = Math.max(6, Math.round(outroFrames * shrink));
  pauseFrames = Math.max(4, Math.round(pauseFrames * shrink));
}
const coverEnd = coverFrames;
const introEnd = coverFrames + introFrames;
const outroStart = totalFrames - outroFrames;
const posterHoldStart = Math.min(totalFrames, outroStart + Math.max(4, Math.round(1.2 * fps)));
const runStart = introEnd;
const runEnd = Math.max(runStart + 30, outroStart);
const travelFrames = Math.max(30, runEnd - runStart - pauseFrames * moments.length);

const segs = [];
let cursor = runStart, previous = 0, spent = 0;
for (const m of moments) {
  let frames = Math.max(3, Math.round(Math.max(0, m.progress - previous) * travelFrames));
  frames = Math.min(frames, Math.max(3, Math.round(travelFrames - spent)));
  segs.push({ s: cursor, e: cursor + frames, p0: previous, p1: m.progress, moment: true });
  cursor += frames; spent += frames;
  segs.push({ s: cursor, e: cursor + pauseFrames, p0: m.progress, p1: m.progress, pause: true });
  cursor += pauseFrames; previous = m.progress;
}
const tail = Math.max(3, runEnd - cursor);
segs.push({ s: cursor, e: cursor + tail, p0: previous, p1: 1 });
cursor += tail;
segs.push({ s: Math.max(cursor, outroStart), e: totalFrames, p0: 1, p1: 1 });

console.log(`totalFrames=${totalFrames} (${(totalFrames / fps).toFixed(1)}s)  introEnd=${introEnd} (${(introEnd / fps).toFixed(1)}s)  outroStart=${outroStart} (${(outroStart / fps).toFixed(1)}s)  posterHold=${posterHoldStart} (${(posterHoldStart / fps).toFixed(1)}s)`);
console.log(`travelFrames=${travelFrames} (${(travelFrames / fps).toFixed(1)}s)  fixed=${fixed}`);
for (const seg of segs) {
  console.log(`  seg [${seg.s}-${seg.e}] (${(seg.s / fps).toFixed(1)}s→${(seg.e / fps).toFixed(1)}s) progress ${seg.p0.toFixed(2)}→${seg.p1.toFixed(2)} ${seg.moment ? '(moment)' : seg.pause ? '(pause)' : ''}`);
}
// 逐秒 progress
const segAt = (f) => segs.find((sg) => f < sg.e) ?? segs[segs.length - 1];
console.log('\n原生逐秒 progress:');
for (let t = 0; t <= totalFrames / fps; t += 1) {
  const f = Math.min(totalFrames - 1, Math.round(t * fps));
  const seg = segAt(f);
  const span = Math.max(1, seg.e - seg.s);
  const k = Math.max(0, Math.min(1, (f - seg.s) / span));
  const p = seg.p0 + (seg.p1 - seg.p0) * k;
  console.log(`t=${String(t).padStart(3)}s  progress=${(Math.min(1, p) * 100).toFixed(0).padStart(3)}%`);
}
