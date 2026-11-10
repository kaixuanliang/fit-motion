/**
 * 音乐提前消失探针：
 * 钩住 AudioBufferSourceNode 记录每次 start/ended 的时间与参数，
 * 同时采样预览播放头，对比「音乐停止时刻」和「预览结束时刻」。
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
page.on('console', (m) => { if (m.text().startsWith('[probe]')) console.log(m.text()); });

// --throttle=N：模拟低端机 CPU（让单帧渲染变慢，验证音画同步）
const throttleArg = process.argv.find((a) => a.startsWith('--throttle='));
if (throttleArg) {
  const rate = Number(throttleArg.split('=')[1]) || 1;
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  console.log(`CPU throttle: ${rate}x`);
}

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2', timeout: 60000 });
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

await page.evaluate(() => {
  const log = [];
  window.__probe = { log };
  const proto = AudioBufferSourceNode.prototype;
  const origStart = proto.start;
  const origStop = proto.stop;
  proto.start = function (...args) {
    const buf = this.buffer;
    log.push({
      ev: 'start', at: performance.now() / 1000,
      offset: args[1] ?? 0,
      bufferDur: buf ? buf.duration : null,
      rate: this.playbackRate ? this.playbackRate.value : 1,
    });
    this.addEventListener('ended', () => {
      log.push({ ev: 'ended', at: performance.now() / 1000 });
    });
    return origStart.apply(this, args);
  };
  proto.stop = function (...args) {
    log.push({ ev: 'stop', at: performance.now() / 1000 });
    return origStop.apply(this, args);
  };
  window.__probe.getPlayhead = () => window.__fitPlayhead ?? -1;
  window.__probe.getDuration = () => {
    // duration 从进度条 max 拿，或从内部状态；先试 __fitPlayhead + transport
    const bar = document.querySelector('#transport input, .transport input, input[type=range]');
    return bar ? Number(bar.max) : null;
  };
});


// 造一条 GPX 记录（约 26 分钟骑行，预览时长 31 秒量级）
await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const pts = [];
  const start = Date.UTC(2026, 0, 15, 7, 0, 0);
  for (let i = 0; i < 1000; i += 1) {
    const lat = 39.9 + i * 0.0004;
    const lon = 116.4 + Math.sin(i / 120) * 0.02;
    const hr = 120 + (i % 45);
    pts.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${(50 + (i % 60)).toFixed(1)}</ele>`
      + `<time>${new Date(start + i * 15000).toISOString()}</time>`
      + `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="probe" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2"><trk><name>音乐探针样本</name><type>户外骑行</type><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await importFiles([new File([gpx], 'music-probe.gpx')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  return true;
});
await wait(1200);

// 进创作页，等缓存就绪
await page.evaluate(() => {
  window.__fitReady = false;
  document.querySelector('#records-pane .rec')?.click();
});
const readyDeadline = Date.now() + 180000;
let ready = false;
while (Date.now() < readyDeadline) {
  ready = await page.evaluate(() => window.__fitReady === true);
  if (ready) break;
  await wait(250);
}
if (!ready) throw new Error('创作页未就绪');
await wait(500);

// 选一首内置曲（打开选曲弹层，点第一首内置曲目行）
await page.$eval('#swap-music', (el) => el.click());
await wait(400);
await page.evaluate(() => {
  const row = document.querySelector('.song[data-track]:not([data-track="none"]):not([data-track="local"])');
  if (row) row.click();
});
await wait(800);


// 缓存就绪后创作页会自动开播（main.ts:716）。此时从弹层选歌，
// 走真实的「正在播放中换曲」路径：music-changed → prepare → play(playhead)。
// 之后不再点击任何按钮，直接采样到播放结束。
const autoPlayStarted = await (async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ph = await page.evaluate(() => window.__fitPlayhead ?? -1);
    if (ph > 1) return true;
    await wait(250);
  }
  return false;
})();
console.log('auto playback started:', autoPlayStarted);

const samples = [];

// 采样最多 70 秒：每 0.5s 记录 playhead 与最近一次音频事件；
// 播放头连续 4 次不动且音频已 ended 时提前收工
let stillCount = 0;
let prevPh = -1;
for (let i = 0; i < 140; i += 1) {
  const s = await page.evaluate(() => ({
    t: performance.now() / 1000,
    ph: window.__fitPlayhead ?? -1,
    lastAudio: window.__probe.log[window.__probe.log.length - 1] ?? null,
  }));
  samples.push(s);
  stillCount = s.ph === prevPh ? stillCount + 1 : 0;
  prevPh = s.ph;
  if (stillCount >= 4 && s.lastAudio && s.lastAudio.ev === 'ended') break;
  await wait(500);
}

const log = await page.evaluate(() => window.__probe.log);
const finalPh = await page.evaluate(() => window.__fitPlayhead);
const barDur = await page.evaluate(() => window.__probe.getDuration());
console.log('=== audio events ===');
for (const e of log) console.log(JSON.stringify(e));
console.log('=== samples (first/mid/last 8) ===');
const pick = [...samples.slice(0, 6), ...samples.slice(-10)];
for (const s of pick) console.log(JSON.stringify(s));
console.log('final playhead:', finalPh, 'bar max:', barDur);

// 归一化：把音频事件时间与采样时间对齐算出「音乐停在播放头第几秒」
const startEv = log.find((e) => e.ev === 'start');
const endedEv = [...log].reverse().find((e) => e.ev === 'ended');
if (startEv && endedEv) {
  console.log('music wall duration:', (endedEv.at - startEv.at).toFixed(2),
    'offset:', startEv.offset?.toFixed(2), 'rate:', startEv.rate,
    '=> 覆盖播放头', (startEv.offset + (endedEv.at - startEv.at) * startEv.rate).toFixed(2), '秒');
}
await browser.close();
