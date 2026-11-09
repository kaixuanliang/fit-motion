/**
 * 捕获真实导出 payload：伪装 window.FitMotionAndroid + 本地 /render 服务端，
 * 走真实点击「导出」按钮的代码路径，拿到手机上完全一致的 JSON。
 * 然后用 Java buildTimeline 的精确复刻检查时间线是否异常。
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';

// 1) 本地假 /render 服务
let captured = null;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/render') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = body;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, uri: '', seconds: 1, frames: 10, audioMs: 1 }));
    });
  } else if (req.method === 'POST' && req.url === '/preview') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, image: 'data:image/png;base64,iVBORw0KGgo=' }));
  } else if (req.method === 'GET' && req.url === '/progress') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ phase: 'render', done: 1, total: 10 }));
  } else {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('{}');
  }
});
await new Promise((r) => server.listen(5199, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
// 伪装 Android 桥
await page.evaluateOnNewDocument(() => {
  window.FitMotionAndroid = {
    nativeExportUrl: () => 'http://127.0.0.1:5199',
    saveToGallery: () => true,
  };
});

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

// 点真实的导出按钮
await page.evaluate(() => document.getElementById('export-btn')?.click());
for (let i = 0; i < 120; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  if (captured) break;
}
await browser.close();
server.close();

if (!captured) { console.log('NO PAYLOAD CAPTURED'); process.exit(1); }
const payload = JSON.parse(captured);
console.log('=== 真实 payload 关键字段 ===');
console.log('durationSec:', payload.durationSec, ' fps:', payload.fps, ' points:', payload.points.length);
console.log('moments:', JSON.stringify(payload.moments, null, 1));

// Java buildTimeline 精确复刻
const fps = payload.fps;
const COVER = 1.0, INTRO = 0.8, OUTRO = 4.0, PAUSE = 1.4;
const moments = payload.moments.map((m) => ({ progress: Math.max(0.02, Math.min(0.97, m.progress)) }))
  .sort((a, b) => a.progress - b.progress);
const totalFrames = Math.max(1, Math.ceil(payload.durationSec * fps));
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
const introEnd = coverFrames + introFrames;
const outroStart = totalFrames - outroFrames;
const posterHoldStart = Math.min(totalFrames, outroStart + Math.max(4, Math.round(1.2 * fps)));
const runStart = introEnd;
const runEnd = Math.max(runStart + 30, outroStart);
const travelFrames = Math.max(30, runEnd - runStart - pauseFrames * moments.length);
console.log('\n=== Java 时间线 ===');
console.log(`total=${(totalFrames / fps).toFixed(1)}s travel=${(travelFrames / fps).toFixed(1)}s outroStart=${(outroStart / fps).toFixed(1)}s posterHold=${(posterHoldStart / fps).toFixed(1)}s 静止尾段=${((totalFrames - posterHoldStart) / fps).toFixed(1)}s`);
