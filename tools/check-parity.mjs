import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const base = 'http://127.0.0.1:5178/';
const outDir = 'screenshots/parity';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--disable-crash-reporter', '--disable-breakpad'],
  defaultViewport: { width: 1280, height: 1000, deviceScaleFactor: 1 },
});

async function open(params) {
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('PAGE ERROR:', message.text());
  });
  page.on('pageerror', (error) => console.log('PAGE EXCEPTION:', error.message));
  await page.goto(`${base}?${params}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForFunction(() => {
      const loading = document.getElementById('stage-loading');
      return loading && loading.classList.contains('is-hidden');
    }, { timeout: 240000 });
  } catch {
    console.log('stage never finished loading for', params);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return page;
}

async function saveCanvas(page, name) {
  const data = await page.evaluate(() => {
    const canvas = document.getElementById('stage-canvas');
    return canvas ? canvas.toDataURL('image/png') : null;
  });
  if (!data) {
    console.log('no canvas for', name);
    return;
  }
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
}

const poster = await open('demo=1&theme=tech&t=0&still=1');
await saveCanvas(poster, 'poster-tech');
await poster.close();

const drawer = await open('demo=1&theme=tech&t=27&still=1');
await saveCanvas(drawer, 'drawer-tech');
await drawer.close();

const result = await open('demo=1&theme=tech&t=44&still=1');
await saveCanvas(result, 'result-tech');

// Long image: grab the canvas the exporter is about to save.
await result.evaluate(() => {
  window.__statsCapture = null;
  const original = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function patched(callback, ...rest) {
    if (this.width === 1080 && this.height > 2000) {
      try {
        window.__statsCapture = this.toDataURL('image/png');
      } catch (error) {
        console.log('capture failed', error);
      }
    }
    return original.call(this, callback, ...rest);
  };
});
await result.click('#stats-image-btn');
await new Promise((resolve) => setTimeout(resolve, 6000));
const captured = await result.evaluate(() => window.__statsCapture);
if (captured) {
  fs.writeFileSync(`${outDir}/stats-long.png`, Buffer.from(captured.split(',')[1], 'base64'));
  console.log('stats long image captured');
} else {
  console.log('stats long image NOT captured');
}
await result.close();

await browser.close();
console.log('parity shots ready');
