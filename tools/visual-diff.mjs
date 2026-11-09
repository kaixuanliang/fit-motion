import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const outDir = path.join(root, '.workbuddy', 'tmp');
fs.mkdirSync(outDir, { recursive: true });

const html = (file) => {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  return fs.readFileSync(file);
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url.startsWith('/old/')) file = path.join(root, 'web-dist', 'index.html');
  else if (url.startsWith('/new/')) file = path.join(root, 'dist', 'index.html');
  else file = path.join(root, 'dist', 'index.html');
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html(file));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(5199, '127.0.0.1', resolve));

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--disable-crash-reporter'],
  defaultViewport: { width: 1280, height: 1000 },
});

const report = [];
for (const variant of ['old', 'new']) {
  for (const t of [6, 18.8]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    const started = Date.now();
    await page.goto(`http://127.0.0.1:5199/${variant}/?demo=1&t=${t}&still=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    let ok = true;
    try {
      await page.waitForFunction(
        () => document.getElementById('stage-loading').classList.contains('is-hidden'),
        { timeout: 240000 },
      );
    } catch {
      ok = false;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const elapsed = Date.now() - started;
    let wrote = '';
    try {
      const dataUrl = await page.evaluate(() => document.getElementById('stage-canvas').toDataURL('image/png'));
      wrote = path.join(outDir, `${variant}-t${String(t).replace('.', '_')}.png`);
      fs.writeFileSync(wrote, Buffer.from(dataUrl.split(',')[1], 'base64'));
    } catch (error) {
      errors.push(`toDataURL: ${error instanceof Error ? error.message : String(error)}`);
    }
    report.push({ variant, t, ok, cacheSeconds: Number((elapsed / 1000).toFixed(1)), file: wrote, errors });
    await page.close();
  }
}

console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
