/**
 * 原生 OpenGL 预览桥接全链路测试（模拟原生层）：
 * 在页面启动前注入假的 window.FitMotionAndroid 桥，覆盖四个场景：
 *   A. 正常就绪：nativePreviewStart 收到合法 payload → nativePreviewReady(true, N)
 *      → gl-preview 挖洞类生效、stage-canvas 隐藏、自动开播、帧号持续推送、rect 比例正确
 *   B. 暂停/恢复：暂停后帧号停止推进，恢复后继续
 *   C. 退出创作页：nativePreviewStop 恰好调用一次，挖洞类移除
 *   D. 降级：原生回调 ok=false 与 nativePreviewStart 抛异常两种失败都退回网页渲染
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures.push(name);
};

// ① 页面启动前注入假桥
await page.evaluateOnNewDocument(() => {
  const calls = { start: [], frames: [], rects: [], stops: 0, mode: 'ok' };
  window.__gl = { calls };
  window.FitMotionAndroid = {
    nativePreviewStart: (json) => {
      calls.start.push(json);
      if (calls.mode === 'throw') throw new Error('mock bridge failure');
      const payload = JSON.parse(json);
      const totalFrames = Math.max(1, Math.ceil((payload.durationSec ?? 30) * 30));
      setTimeout(() => {
        const ok = calls.mode !== 'error';
        window.FitMotionJS?.nativePreviewReady?.(ok, ok ? totalFrames : 0);
      }, 250);
    },
    nativePreviewFrame: (f) => { calls.frames.push(f); },
    nativePreviewRect: (x, y, w, h) => { calls.rects.push([x, y, w, h]); },
    nativePreviewStop: () => { calls.stops += 1; },
  };
});

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2', timeout: 60000 });
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ② 造一条 GPX 记录并进创作页
await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const pts = [];
  const start = Date.UTC(2026, 0, 15, 7, 0, 0);
  for (let i = 0; i < 1000; i += 1) {
    const lat = 39.9 + i * 0.0004;
    const lon = 116.4 + Math.sin(i / 120) * 0.02;
    pts.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${(50 + (i % 60)).toFixed(1)}</ele>`
      + `<time>${new Date(start + i * 15000).toISOString()}</time></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="probe" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>GL桥测试样本</name><type>户外骑行</type><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await importFiles([new File([gpx], 'gl-bridge.gpx')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
});
await wait(1200);
await page.evaluate(() => { document.querySelector('#records-pane .rec')?.click(); });
await wait(2500);

// —— 场景 A：正常就绪 ——
const a = await page.evaluate(() => {
  const calls = window.__gl.calls;
  const payload = calls.start.length ? JSON.parse(calls.start[0]) : null;
  const canvas = document.getElementById('stage-canvas');
  return {
    startCount: calls.start.length,
    payloadKeys: payload ? Object.keys(payload).sort() : [],
    points: payload?.points?.length ?? 0,
    fps: payload?.fps ?? 0,
    durationSec: payload?.durationSec ?? 0,
    theme: payload?.theme ?? '',
    glClass: document.documentElement.classList.contains('gl-preview'),
    canvasHidden: canvas ? getComputedStyle(canvas).visibility === 'hidden' : false,
    rectCount: calls.rects.length,
    lastRect: calls.rects[calls.rects.length - 1] ?? null,
    loadingHidden: (() => {
      const el = document.getElementById('stage-loading');
      return !el || el.hidden === true;
    })(),
  };
});
check('A1 nativePreviewStart 恰好调用一次', a.startCount === 1, `count=${a.startCount}`);
check('A2 payload 含轨迹点/时长/fps=30/主题', a.points > 0 && a.fps === 30 && a.durationSec > 0 && !!a.theme,
  `points=${a.points} fps=${a.fps} dur=${a.durationSec} theme=${a.theme}`);
check('A3 gl-preview 挖洞类已挂', a.glClass);
check('A4 stage-canvas 已隐藏（原生画面透出）', a.canvasHidden);
const rect = a.lastRect;
const ratioOk = rect && rect[2] > 0 && Math.abs(rect[2] / rect[3] - 9 / 16) < 0.02;
check('A5 核心区 rect 为 9:16 且为正数', !!ratioOk, JSON.stringify(rect));

// 等自动开播 + 帧号推送
let framesSample = [];
let played = false;
for (let i = 0; i < 40; i += 1) {
  const ph = await page.evaluate(() => window.__fitPlayhead ?? -1);
  if (ph > 1.5) { played = true; break; }
  await wait(250);
}
check('A6 就绪后自动开播', played);
await wait(2000);
framesSample = await page.evaluate(() => window.__gl.calls.frames.slice());
const framesOk = framesSample.length >= 20
  && framesSample.every((f, i) => i === 0 || f >= framesSample[i - 1])
  && framesSample[framesSample.length - 1] > 5;
check('A7 帧号持续单调推送', framesOk, `n=${framesSample.length} last=${framesSample[framesSample.length - 1] ?? -1}`);

// —— 场景 B：暂停/恢复 ——
await page.evaluate(() => {
  const btn = document.querySelector('#play-btn');
  if (btn) btn.click();
});
await wait(300);
const frozenAt = await page.evaluate(() => window.__gl.calls.frames.length);
await wait(1600);
const afterPause = await page.evaluate(() => window.__gl.calls.frames.length);
check('B1 暂停后帧号停止推送', afterPause - frozenAt <= 2, `Δ=${afterPause - frozenAt}`);
await page.evaluate(() => {
  const btn = document.querySelector('#play-btn');
  if (btn) btn.click();
});
await wait(1200);
const resumed = await page.evaluate(() => window.__gl.calls.frames.length);
check('B2 恢复后帧号继续推进', resumed - afterPause >= 15, `Δ=${resumed - afterPause}`);

// —— 场景 C：退出创作页 ——
await page.evaluate(() => { document.getElementById('change-file')?.click(); });
await wait(1200);
const c = await page.evaluate(() => ({
  stops: window.__gl.calls.stops,
  glClass: document.documentElement.classList.contains('gl-preview'),
}));
check('C1 nativePreviewStop 恰好一次', c.stops === 1, `stops=${c.stops}`);
check('C2 退出后挖洞类移除', !c.glClass);

// —— 场景 D1：原生报错（ok=false）退回网页渲染 ——
await page.evaluate(() => { window.__gl.calls.mode = 'error'; });
await page.evaluate(() => { document.querySelector('#records-pane .rec')?.click(); });
await wait(3000);
const d1 = await page.evaluate(() => {
  const canvas = document.getElementById('stage-canvas');
  return {
    starts: window.__gl.calls.start.length,
    glClass: document.documentElement.classList.contains('gl-preview'),
    canvasVisible: canvas ? getComputedStyle(canvas).visibility !== 'hidden' : false,
  };
});
check('D1 ok=false 后退回网页渲染（类移除、画布恢复）', d1.glClass === false && d1.canvasVisible,
  `starts=${d1.starts} glClass=${d1.glClass}`);
await page.evaluate(() => { document.getElementById('change-file')?.click(); });
await wait(800);

// —— 场景 D2：桥接抛异常退回网页渲染 ——
await page.evaluate(() => { window.__gl.calls.mode = 'throw'; });
await page.evaluate(() => { document.querySelector('#records-pane .rec')?.click(); });
await wait(2500);
const d2 = await page.evaluate(() => {
  const canvas = document.getElementById('stage-canvas');
  return {
    glClass: document.documentElement.classList.contains('gl-preview'),
    canvasVisible: canvas ? getComputedStyle(canvas).visibility !== 'hidden' : false,
  };
});
check('D2 start 抛异常后仍走网页渲染', d2.glClass === false && d2.canvasVisible);

await browser.close();
console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
