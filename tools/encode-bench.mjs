// Measures the per-frame cost split inside a WebCodecs export loop:
//   A. building a VideoFrame from a 1080x1920 canvas (what `submit` times)
//   B. actually feeding an encoder and draining it (what `wait` times)
// Runs standalone in Chrome so the numbers are independent of the app.
import http from 'node:http';
import puppeteer from 'puppeteer-core';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>bench</title><body>bench</body>');
});
await new Promise((resolve) => server.listen(5197, '127.0.0.1', resolve));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--disable-crash-reporter'],
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('pageerror', error.message));
await page.goto('http://127.0.0.1:5197/', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const W = 1080;
  const H = 1920;
  const N = 60;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#101a20';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 400; i += 1) {
    ctx.fillStyle = `hsl(${(i * 37) % 360}, 55%, 52%)`;
    ctx.fillRect((i * 97) % W, (i * 211) % H, 90, 90);
  }

  const out = { ua: navigator.userAgent, videoEncoder: typeof VideoEncoder !== 'undefined', frame: null, codecs: [] };

  // A. VideoFrame construction only.
  let t = performance.now();
  for (let i = 0; i < N; i += 1) {
    const frame = new VideoFrame(canvas, { timestamp: i * 33333, duration: 33333 });
    frame.close();
  }
  out.frame = { perFrameMs: +((performance.now() - t) / N).toFixed(2) };

  // B. Full encode loop, mirroring main.ts: queue cap, no periodic flush.
  const candidates = ['avc1.640028', 'avc1.4D0028', 'avc1.42E028', 'avc1.420028', 'vp8'];
  for (const codec of candidates) {
    const isH264 = codec !== 'vp8';
    const config = {
      codec,
      width: W,
      height: H,
      bitrate: 4_000_000,
      framerate: 30,
      latencyMode: 'realtime',
      ...(isH264 ? { avc: { format: 'avc' } } : {}),
    };
    let supported = false;
    try {
      supported = (await VideoEncoder.isConfigSupported(config)).supported;
    } catch {
      supported = false;
    }
    if (!supported) {
      out.codecs.push({ codec, supported: false });
      continue;
    }
    let chunks = 0;
    let bytes = 0;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        chunks += 1;
        bytes += chunk.byteLength;
      },
      error: (error) => { out.codecs.push({ codec, error: String(error) }); },
    });
    encoder.configure(config);
    const started = performance.now();
    let maxQueue = 0;
    let waitMs = 0;
    for (let i = 0; i < N; i += 1) {
      const renderStart = performance.now();
      ctx.fillStyle = `hsl(${i * 6}, 50%, 40%)`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.fillRect((i * 13) % W, 400, 60, 60);
      const submitStart = performance.now();
      const frame = new VideoFrame(canvas, { timestamp: i * 33333, duration: 33333 });
      encoder.encode(frame, { keyFrame: i === 0 });
      frame.close();
      const waitStart = performance.now();
      if (encoder.encodeQueueSize > 8) {
        while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
      }
      waitMs += performance.now() - waitStart;
      maxQueue = Math.max(maxQueue, encoder.encodeQueueSize);
      if (submitStart - renderStart > 9999) break;
    }
    const flushStart = performance.now();
    await encoder.flush();
    const flushMs = performance.now() - flushStart;
    const totalMs = performance.now() - started;
    encoder.close();
    out.codecs.push({
      codec,
      supported: true,
      totalMs: Math.round(totalMs),
      perFrameMs: +(totalMs / N).toFixed(2),
      waitPerFrameMs: +(waitMs / N).toFixed(2),
      flushMs: Math.round(flushMs),
      maxQueue,
      chunks,
      kbps: Math.round((bytes * 8) / 1000 / (N / 30)),
    });
  }
  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
