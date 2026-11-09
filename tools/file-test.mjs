import puppeteer from 'puppeteer-core';
import path from 'node:path';

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fileUrl = `file:///${path.join(process.cwd(), 'dist', 'index.html').replace(/\\/g, '/')}?demo=1&t=13&still=1`;

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--disable-crash-reporter', '--disable-breakpad', '--allow-file-access-from-files'],
  defaultViewport: { width: 1280, height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') logs.push(`console.${message.type()}: ${message.text()}`);
});
page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => {
  if (!request.url().includes('autonavi')) logs.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`);
});

await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((resolve) => setTimeout(resolve, 12000));
const diagnostics = await page.evaluate(() => {
  const canvas = document.getElementById('stage-canvas');
  let taint = '';
  try {
    canvas.toDataURL();
  } catch (error) {
    taint = String(error);
  }
  return {
    taint,
    canvas: `${canvas.width}x${canvas.height}`,
    studioHidden: document.getElementById('studio').hidden,
    fonts: document.fonts.status,
    timecode: document.getElementById('timecode').textContent,
  };
});
await page.screenshot({ path: 'screenshots/file-studio.png' });
console.log(JSON.stringify({ diagnostics, logs }, null, 2));
await browser.close();
