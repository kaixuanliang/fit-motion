/** 两张同尺寸 PNG 的像素差异统计。 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const pairs = [
  ['before-cover.png', 'after-cover.png'],
  ['before-follow.png', 'after-follow.png'],
];
const dir = path.join(process.cwd(), 'tools', 'downloads');

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const results = [];
for (const [a, b] of pairs) {
  const a64 = fs.readFileSync(path.join(dir, a)).toString('base64');
  const b64 = fs.readFileSync(path.join(dir, b)).toString('base64');
  results.push(await page.evaluate(async (aData, bData, name) => {
    const load = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
    const one = await load(`data:image/png;base64,${aData}`);
    const two = await load(`data:image/png;base64,${bData}`);
    if (one.width !== two.width || one.height !== two.height) {
      return { name, sizeMismatch: true, sizeA: [one.width, one.height], sizeB: [two.width, two.height] };
    }
    const canvas = document.createElement('canvas');
    canvas.width = one.width;
    canvas.height = one.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(one, 0, 0);
    const first = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(two, 0, 0);
    const second = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    let diff = 0;
    let maxDelta = 0;
    let sumDelta = 0;
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    const w = canvas.width;
    for (let i = 0; i < first.length; i += 4) {
      const d = Math.max(
        Math.abs(first[i] - second[i]),
        Math.abs(first[i + 1] - second[i + 1]),
        Math.abs(first[i + 2] - second[i + 2]),
      );
      if (d > 8) {
        diff += 1;
        sumDelta += d;
        if (d > maxDelta) maxDelta = d;
        const pixel = i / 4;
        const x = pixel % w;
        const y = Math.floor(pixel / w);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const total = first.length / 4;
    return {
      name,
      size: [one.width, one.height],
      diffPixels: diff,
      diffPct: Number(((diff / total) * 100).toFixed(3)),
      maxDelta,
      avgDelta: diff ? Number((sumDelta / diff).toFixed(1)) : 0,
      bbox: diff ? [minX, minY, maxX, maxY] : null,
    };
  }, a64, b64, `${a} vs ${b}`));
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
