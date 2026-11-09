import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = url.startsWith('/old/')
    ? path.join(root, 'web-dist', 'index.html')
    : path.join(root, 'dist', 'index.html');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(5198, '127.0.0.1', resolve));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-crash-reporter'],
  defaultViewport: { width: 1280, height: 1000 },
});

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

for (const variant of ['old', 'new']) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:5198/${variant}/?demo=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => document.getElementById('stage-loading').classList.contains('is-hidden'),
    { timeout: 240000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const gaps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        const tick = (now) => {
          samples.push(now - last);
          last = now;
          if (samples.length < 60) requestAnimationFrame(tick);
          else resolve(samples.slice(1));
        };
        requestAnimationFrame(tick);
      }),
  );
  const clean = gaps.filter((gap) => gap < 2000);
  console.log(
    JSON.stringify({
      variant,
      frames: clean.length,
      medianFrameMs: Number(median(clean).toFixed(1)),
      p90FrameMs: Number(clean.slice().sort((a, b) => a - b)[Math.floor(clean.length * 0.9)].toFixed(1)),
    }),
  );
  await page.close();
}

await browser.close();
server.close();
