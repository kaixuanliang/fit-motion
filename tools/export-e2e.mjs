// End-to-end: load the built app with the demo activity, run the parallel
// export path, capture the produced MP4 and verify it decodes (duration,
// resolution, and a mid-video frame that is not black).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const outDir = path.join(root, '.workbuddy', 'tmp');
fs.mkdirSync(outDir, { recursive: true });

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(path.join(root, 'dist', 'index.html')));
});
await new Promise((resolve) => server.listen(5195, '127.0.0.1', resolve));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  defaultViewport: { width: 1280, height: 1000 },
});
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'info' || message.type() === 'error') logs.push(`${message.type()}: ${message.text()}`);
});

await page.goto('http://127.0.0.1:5195/?demo=1', { waitUntil: 'domcontentloaded', timeout: 60000 });

// Capture the exported blob before it reaches the manual-save flow.
await page.evaluate(() => {
  const original = URL.createObjectURL.bind(URL);
  window.__captured = null;
  URL.createObjectURL = (blob) => {
    window.__captured = blob;
    return original(blob);
  };
});

await page.waitForFunction(
  () => !document.getElementById('export-btn').disabled && document.getElementById('stage-loading').classList.contains('is-hidden'),
  { timeout: 420_000 },
);

const started = Date.now();
await page.click('#export-btn');
await page.waitForFunction(() => {
  const report = document.getElementById('export-report');
  return report !== null && !report.hidden;
}, { timeout: 420_000 });

const report = await page.$eval('#export-report', (element) => element.textContent);
const blobSize = await page.evaluate(async () => {
  const blob = window.__captured;
  if (!blob) return null;
  const buffer = await blob.arrayBuffer();
  window.__bytes = new Uint8Array(buffer);
  return { size: blob.size, type: blob.type };
});
if (!blobSize) throw new Error('no exported blob captured');
const bytes = await page.evaluate(() => Array.from(window.__bytes));
const mp4Path = path.join(outDir, 'parallel-export.mp4');
fs.writeFileSync(mp4Path, Buffer.from(bytes));
console.log(`exported ${(blobSize.size / 1048576).toFixed(2)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${mp4Path}`);

// Decode check in a fresh page.
const checkPage = await browser.newPage();
await checkPage.goto('http://127.0.0.1:5195/', { waitUntil: 'domcontentloaded' });
const check = await checkPage.evaluate(async (url) => {
  const video = document.createElement('video');
  video.muted = true;
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('metadata load failed'));
  });
  const meta = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  video.currentTime = Math.min(10, video.duration / 2);
  await new Promise((resolve) => { video.onseeked = resolve; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 320, 180);
  const data = ctx.getImageData(0, 0, 320, 180).data;
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    min = Math.min(min, luma);
    max = Math.max(max, luma);
    sum += luma;
  }
  return { ...meta, lumaMin: Math.round(min), lumaMax: Math.round(max), lumaMean: Math.round(sum / (data.length / 4)) };
}, `file:///${mp4Path.replace(/\\/g, '/')}`);

console.log('report:', JSON.stringify(report, null, 0));
console.log('decode:', JSON.stringify(check));
console.log('logs:', logs.slice(-12).join('\n'));

const valid = check.width === 1080 && check.height === 1920 && check.duration > 5 && check.lumaMax - check.lumaMin > 30;
console.log(valid ? 'PASS: parallel export decodes correctly' : 'FAIL: decoded output looks wrong');
await browser.close();
server.close();
process.exit(valid ? 0 : 1);
