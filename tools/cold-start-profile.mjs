// 量化冷启动构成：dist 单文件在本地静态服务下，测 解析+执行 / IDB 首开 / 首帧 各占多少
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist');
const server = http.createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.slice(1);
  try {
    const data = fs.readFileSync(path.join(root, file));
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'application/javascript' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('no');
  }
});
await new Promise((r) => server.listen(5199, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
});

// 跑 3 次新 profile（关掉当前 profile 缓存影响很小——脚本本体是内联的）
const results = [];
for (let i = 0; i < 3; i += 1) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('!!document.querySelector("canvas") || !!document.body', { timeout: 30000 });
  const marks = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = performance.getEntriesByType('paint');
    return {
      // HTML 接收完成 → 脚本执行完（DOM ready）≈ 1.8MB 内联脚本的解析+执行成本
      htmlBytes: nav?.transferSize ?? 0,
      responseEnd: Math.round(nav?.responseEnd ?? 0),
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      loadEvent: Math.round(nav?.loadEventEnd ?? 0),
      firstPaint: Math.round(paints.find((p) => p.name === 'first-paint')?.startTime ?? -1),
    };
  });
  marks.wallMs = Date.now() - t0;
  results.push(marks);
  await ctx.close();
}
for (const r of results) {
  console.log(`parse+exec(≈domContentLoaded-responseEnd)=${r.domContentLoaded - r.responseEnd}ms  firstPaint=${r.firstPaint}ms  load=${r.loadEvent}ms  wall=${r.wallMs}ms`);
}
await browser.close();
server.close();
