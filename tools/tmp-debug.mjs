import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args: ['--no-sandbox','--disable-gpu','--hide-scrollbars'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('pageerror', e => console.log('EXC', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 700));
await page.evaluate(async () => {
  const sample = await import('/src/data/sample.ts');
  const bin = atob(sample.SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], sample.SAMPLE_NAME);
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 2500));
await page.evaluate(() => document.getElementById('import-close').click());
await new Promise(r => setTimeout(r, 400));
await page.evaluate(() => document.querySelector('.rec').click());
await new Promise(r => setTimeout(r, 4000));
const info = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, opacity: cs.opacity, bg: cs.backgroundColor, z: cs.zIndex, pos: cs.position };
  };
  const canvas = document.getElementById('stage-canvas');
  const data = canvas ? canvas.toDataURL('image/png') : '';
  return {
    boxes: ['.pane-create', '.stage-frame', '#stage-canvas', '#stage-loading', '.metric-grid', '.transport', '.stage-badge', '.big-play'].map(box),
    canvasData: data.slice(0, 40) + '...len=' + data.length,
    data,
    view: document.getElementById('app').dataset.view,
    theme: document.documentElement.dataset.theme,
  };
});
fs.writeFileSync('screenshots/app/debug-canvas.png', Buffer.from(info.data.split(',')[1], 'base64'));
delete info.data;
console.log(JSON.stringify(info, null, 2));
await browser.close();
