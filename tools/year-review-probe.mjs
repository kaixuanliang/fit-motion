/**
 * 年度骑行回顾探针：
 * 1) 导入环六环 + 京郑 3 天 + 三条同形重复小环线（验证 Top 路线聚合）
 * 2) 打开年度回顾，逐卡截图
 * 3) 拦截 toBlob 抓到成绩图画布，贴到可见 canvas 截图
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

const executablePath = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).slice(0, 200)));

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => document.querySelector('#record-list .rec, #records-empty'), { timeout: 30_000 });

// 导入测试数据（时间戳错开，避免运动指纹判重）
const ringB64 = readFileSync('testdata/beijing-ring6-outside.fit').toString('base64');
const bjzzB64 = readFileSync('testdata/beijing-zhengzhou-3day.fit').toString('base64');
await page.evaluate(async (files) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await importFiles([
    new File([decode(files.ring)], 'beijing-ring6-outside.fit'),
    new File([decode(files.bjzz)], 'beijing-zhengzhou-3day.fit'),
  ]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
}, { ring: ringB64, bjzz: bjzzB64 });

// 三条同一条小环线的重复骑行（不同文件名/时间，验证 sameRoute 聚合）
for (let i = 0; i < 3; i += 1) {
  await page.evaluate(async (idx) => {
    const { importFiles } = await import('/src/import/batch.ts');
    const start = Date.UTC(2026, 7, 10 + idx, 1, 30) ;
    const pts = [];
    for (let k = 0; k < 420; k += 1) {
      const a = (k / 420) * Math.PI * 2;
      const lat = 40.00 + 0.045 * Math.sin(a) + 0.004 * Math.sin(a * 3);
      const lon = 116.39 + 0.055 * Math.cos(a) + 0.004 * Math.cos(a * 3);
      pts.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>48</ele><time>${new Date(start + k * 12000).toISOString()}</time></trkpt>`);
    }
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="probe" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>奥森公园环线</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
    await importFiles([new File([gpx], `aosen-loop-${idx + 1}.gpx`)]);
  }, i);
}
await page.evaluate(() => window.dispatchEvent(new CustomEvent('fitmotion:records-changed')));

await page.waitForFunction(() => !document.getElementById('yr-entry-btn')?.hidden, { timeout: 30_000 });
console.log('入口可见 ✓');

// 打开年度回顾
await page.click('#yr-entry-btn');
await page.waitForFunction(() => document.querySelectorAll('#yr-deck .yr-card').length > 0, { timeout: 120_000 });
const meta = await page.evaluate(() => ({
  cards: document.querySelectorAll('#yr-deck .yr-card').length,
}));
console.log(`卡片数: ${meta.cards}`);

const shot = (name) => new Promise((resolve) => setTimeout(() => {
  page.screenshot({ path: `tools/downloads/yr-${name}.png` }).then(resolve);
}, 450));

await shot('cover');
await page.click('#yr-next'); await shot('distance');
await page.click('#yr-next'); await shot('time');
await page.click('#yr-next'); await shot('months');
await page.click('#yr-next'); await shot('longest');
await page.click('#yr-next'); await shot('speed');
await page.click('#yr-next'); await shot('top');
await page.click('#yr-next'); await shot('badge');
await page.click('#yr-next'); await shot('end');

// 成绩图：拦 toBlob 抓画布
await page.evaluate(() => {
  window.__yrCanvas = null;
  const proto = HTMLCanvasElement.prototype;
  const orig = proto.toBlob;
  proto.toBlob = function (cb, type, quality) {
    window.__yrCanvas = this;
    return orig.call(this, cb, type, quality);
  };
});
await page.evaluate(() => document.getElementById('yr-share-img').click());
await page.waitForFunction(() => window.__yrCanvas, { timeout: 60_000 });
// saveBlob 的保存面板在 toBlob 之后才弹出，等它出现再一并隐藏
await new Promise((r) => { setTimeout(r, 1500); });
await page.evaluate(() => {
  const src = window.__yrCanvas;
  const view = document.createElement('canvas');
  view.id = 'yr-image-view';
  view.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99;background:#000;object-fit:contain';
  view.width = src.width;
  view.height = src.height;
  view.getContext('2d').drawImage(src, 0, 0);
  document.body.appendChild(view);
  const deck = document.getElementById('yr-deck');
  if (deck) deck.style.display = 'none';
  const exportOverlay = document.getElementById('export-overlay');
  if (exportOverlay) exportOverlay.style.display = 'none';
  const savePrompt = document.getElementById('browser-save-prompt');
  if (savePrompt) savePrompt.style.display = 'none';
  document.querySelectorAll('.toast, [class*="toast"]').forEach((el) => { el.style.display = 'none'; });
});
await new Promise((r) => { setTimeout(r, 400); });
await page.screenshot({ path: 'tools/downloads/yr-image.png' });
console.log('成绩图截图 ✓');

// 数据摘要（核对口径）
const summary = await page.evaluate(() => window.__yrSummary ?? null);
console.log('summary:', JSON.stringify(summary));

await browser.close();
console.log('DONE');
