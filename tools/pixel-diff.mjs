import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const tmp = path.join(process.cwd(), '.workbuddy', 'tmp');
const pairs = [
  { a: 'old-t6.png', b: 'new-t6.png', out: 'diff-t6.png' },
  { a: 'old-t18_8.png', b: 'new-t18_8.png', out: 'diff-t18_8.png' },
];

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.goto('about:blank');

for (const pair of pairs) {
  const read = (name) => fs.readFileSync(path.join(tmp, name)).toString('base64');
  const result = await page.evaluate(async (a64, b64) => {
    const load = (src) =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });
    const first = await load(`data:image/png;base64,${a64}`);
    const second = await load(`data:image/png;base64,${b64}`);
    const w = first.width;
    const h = first.height;
    const ca = document.createElement('canvas');
    ca.width = w;
    ca.height = h;
    ca.getContext('2d').drawImage(first, 0, 0);
    const cb = document.createElement('canvas');
    cb.width = w;
    cb.height = h;
    cb.getContext('2d').drawImage(second, 0, 0);
    const da = ca.getContext('2d').getImageData(0, 0, w, h).data;
    const db = cb.getContext('2d').getImageData(0, 0, w, h).data;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const oc = out.getContext('2d');
    const heat = oc.createImageData(w, h);
    let diffPixels = 0;
    let big = 0;
    let sum = 0;
    let max = 0;
    let rowsWithDiff = 0;
    let lastRow = -1;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      sum += d;
      if (d > max) max = d;
      if (d > 0) {
        diffPixels += 1;
        const row = Math.floor(i / 4 / w);
        if (row !== lastRow) {
          rowsWithDiff += 1;
          lastRow = row;
        }
      }
      if (d > 16) big += 1;
      heat.data[i] = Math.min(255, d * 8);
      heat.data[i + 1] = 0;
      heat.data[i + 2] = 0;
      heat.data[i + 3] = 255;
    }
    oc.putImageData(heat, 0, 0);
    return {
      w,
      h,
      diffPixels,
      big,
      rowsWithDiff,
      meanDiff: sum / (da.length / 4),
      max,
      png: out.toDataURL('image/png'),
    };
  }, read(pair.a), read(pair.b));

  fs.writeFileSync(path.join(tmp, pair.out), Buffer.from(result.png.split(',')[1], 'base64'));
  const total = result.w * result.h;
  console.log(
    JSON.stringify({
      compare: `${pair.a} vs ${pair.b}`,
      size: `${result.w}x${result.h}`,
      diffPixels: result.diffPixels,
      diffPercent: Number(((result.diffPixels / total) * 100).toFixed(2)),
      pixelsOver16: result.big,
      percentOver16: Number(((result.big / total) * 100).toFixed(3)),
      affectedRows: result.rowsWithDiff,
      meanChannelDiff: Number(result.meanDiff.toFixed(3)),
      maxChannelDiff: result.max,
      heatmap: path.join(tmp, pair.out),
    }),
  );
}

await browser.close();
