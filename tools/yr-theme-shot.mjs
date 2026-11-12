import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const theme = process.argv[2] || 'tech';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:5178/?theme=${theme}`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => document.querySelector('#record-list .rec, #records-empty'), { timeout: 60000 });

// 导入测试数据（与主探针同一套：环六环 + 京郑三天 + 三条同形小环线）
const ringB64 = readFileSync('testdata/beijing-ring6-outside.fit').toString('base64');
const bjzzB64 = readFileSync('testdata/beijing-zhengzhou-3day.fit').toString('base64');
await page.evaluate(async (files) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await importFiles([
    new File([decode(files.ring)], 'beijing-ring6-outside.fit'),
    new File([decode(files.bjzz)], 'beijing-zhengzhou-3day.fit'),
  ]);
  for (let i = 0; i < 3; i += 1) {
    const start = Date.UTC(2026, 7, 10 + i, 1, 30);
    const pts = [];
    for (let k = 0; k < 420; k += 1) {
      const a = (k / 420) * Math.PI * 2;
      const lat = 40.00 + 0.045 * Math.sin(a) + 0.004 * Math.sin(a * 3);
      const lon = 116.39 + 0.055 * Math.cos(a) + 0.004 * Math.cos(a * 3);
      pts.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>48</ele><time>${new Date(start + k * 12000).toISOString()}</time></trkpt>`);
    }
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="probe" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>奥森公园环线</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
    await importFiles([new File([gpx], `aosen-loop-${i + 1}.gpx`)]);
  }
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
}, { ring: ringB64, bjzz: bjzzB64 });

await page.waitForFunction(() => {
  const banner = document.getElementById('yr-banner');
  return banner && !banner.hidden;
}, { timeout: 60000 });
await page.screenshot({ path: `tools/downloads/yr-banner-${theme}.png` });
await page.click('#yr-banner');
await page.waitForFunction(() => document.querySelectorAll('#yr-deck .yr-card').length > 0, { timeout: 120000 });
const shot = (name) => new Promise((resolve) => setTimeout(() => {
  page.screenshot({ path: `tools/downloads/yr-${name}-${theme}.png` }).then(resolve);
}, 450));
await shot('cover');
const next = () => page.keyboard.press('ArrowRight');
for (let i = 0; i < 4; i += 1) await next();
await shot('calendar');
for (let i = 0; i < 7; i += 1) await next();
await shot('end');
console.log(`${theme} shots done`);
await browser.close();
