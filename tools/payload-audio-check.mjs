/**
 * 对比「有音乐 / 无音乐」两次真实导出的 payload：
 *  - durationSec 是否一致
 *  - audio 的 PCM 时长是否与 durationSec 匹配
 * 目的是定位「带音乐的导出时长异常」到底出在 JS 还是原生层。
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';

const captured = [];
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/render') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, uri: '', seconds: 1, frames: 10, audioMs: 1 }));
    });
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
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
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

const stageInfo = await page.evaluate(async () => {
  const mod = await import('/src/ui/music.ts');
  return { music: mod.currentMusicId() };
});
console.log('当前曲目:', stageInfo.music);

async function run(label) {
  captured.length = 0;
  await page.evaluate(() => document.getElementById('export-btn')?.click());
  for (let i = 0; i < 240; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (captured.length) break;
  }
  if (!captured.length) { console.log(label, '未捕获'); return null; }
  const p = JSON.parse(captured[0]);
  const audio = p.audio;
  const pcmBytes = audio ? Math.round((audio.pcm.length * 3) / 4) : 0;
  const audioSec = audio ? pcmBytes / (2 * audio.channels) / audio.sampleRate : 0;
  const out = {
    label,
    durationSec: p.durationSec,
    fps: p.fps,
    frames: Math.ceil(p.durationSec * p.fps),
    audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels, bytes: audio.bytes, sec: +audioSec.toFixed(2) } : null,
    payloadMB: +(captured[0].length / 1048576).toFixed(2),
  };
  console.log(JSON.stringify(out));
  return out;
}

const withMusic = stageInfo.music !== 'none' ? await run('有音乐') : null;
if (!withMusic) {
  await page.evaluate(async () => {
    const { selectMusic } = await import('/src/ui/music.ts');
    await selectMusic('drive');
  });
  await new Promise((r) => setTimeout(r, 500));
}
const a = withMusic ?? await run('有音乐');
await page.evaluate(async () => {
  const { selectMusic } = await import('/src/ui/music.ts');
  await selectMusic('none');
});
await new Promise((r) => setTimeout(r, 400));
const b = await run('无音乐');

await browser.close();
server.close();

if (a && b) {
  console.log('\n=== 差异 ===');
  console.log('durationSec:', a.durationSec, 'vs', b.durationSec);
  console.log('frames:', a.frames, 'vs', b.frames);
  console.log('PCM 时长:', a.audio?.sec, 's / 视频', a.durationSec, 's → 差',
    a.audio ? (a.audio.sec - a.durationSec).toFixed(2) : 'n/a', 's');
}
