// Decodes a produced MP4 in headless Chrome and reports duration / size /
// mid-video luma spread, to confirm the file is a playable, non-black video.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const mp4Path = process.argv[2] ?? path.join(process.cwd(), '.workbuddy', 'tmp', 'parallel-export.mp4');
const file = fs.readFileSync(mp4Path);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': file.length });
  res.end(file);
});
await new Promise((resolve) => server.listen(5194, '127.0.0.1', resolve));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5194/', { waitUntil: 'domcontentloaded' });

const check = await page.evaluate(async () => {
  const video = document.createElement('video');
  video.muted = true;
  video.src = 'http://127.0.0.1:5194/export.mp4';
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('metadata load failed'));
  });
  const meta = {
    duration: Number(video.duration.toFixed(2)),
    width: video.videoWidth,
    height: video.videoHeight,
  };
  const spots = [0.2, 0.5, 0.8];
  const spreads = [];
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (const spot of spots) {
    video.currentTime = video.duration * spot;
    await new Promise((resolve) => { video.onseeked = resolve; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    ctx.drawImage(video, 0, 0, 320, 180);
    const data = ctx.getImageData(0, 0, 320, 180).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      min = Math.min(min, luma);
      max = Math.max(max, luma);
    }
    spreads.push(Math.round(max - min));
  }
  return { ...meta, lumaSpreads: spreads };
});

console.log('decode:', JSON.stringify(check));
const valid = check.width === 1080 && check.height === 1920 && check.duration > 5 && check.lumaSpreads.every((s) => s > 30);
console.log(valid ? `PASS: ${path.basename(mp4Path)} decodes correctly` : 'FAIL: decoded output looks wrong');
await browser.close();
server.close();
process.exit(valid ? 0 : 1);
