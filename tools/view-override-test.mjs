// >300km 覆盖入口验证：按钮可见 → 点击弹确认 → 取消保持全局 → 确认切到第一视角
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => { setTimeout(r, 800); });

await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const start = Date.now() - 8 * 3600e3;
  const pts = [];
  for (let i = 0; i < 3600; i += 1) {
    pts.push(`<trkpt lat="${(39.6 + i * 0.00095).toFixed(7)}" lon="${(116.2 + Math.sin(i / 90) * 0.01).toFixed(7)}">`
      + `<ele>${(50 + (i % 60)).toFixed(1)}</ele><time>${new Date(start + i * 15000).toISOString()}</time></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="shot" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await importFiles([new File([gpx], 'override-long.gpx')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  await new Promise((r) => { setTimeout(r, 400); });
  document.querySelector('#records-pane .rec')?.click();
});
await page.waitForFunction(() => !document.getElementById('studio')?.hidden, { timeout: 120_000 });
await page.waitForFunction(() => document.getElementById('stage-loading')?.classList.contains('is-hidden') === true, { timeout: 300_000 });

const before = await page.evaluate(() => ({
  toggleHidden: document.getElementById('view-toggle')?.hidden ?? null,
  device: document.getElementById('stage-device')?.textContent ?? '',
  help: document.getElementById('export-help')?.textContent ?? '',
}));
console.log('初始（默认全局，按钮可见）:', JSON.stringify(before));

const click = async (id) => { const el = await page.$(`#${id}`); await page.evaluate((node) => node.click(), el); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

await click('view-toggle');
await sleep(300);
console.log('确认弹窗出现:', await page.evaluate(() => !document.getElementById('view-confirm-modal')?.hidden));

await click('view-confirm-cancel');
await sleep(300);
console.log('取消后仍是:', await page.evaluate(() => document.getElementById('stage-device')?.textContent));

await click('view-toggle');
await sleep(300);
await click('view-confirm-ok');
await sleep(500);
console.log('确认后:', JSON.stringify(await page.evaluate(() => ({
  device: document.getElementById('stage-device')?.textContent,
  toggleOn: document.getElementById('view-toggle')?.classList.contains('on'),
}))));

await page.waitForFunction(() => document.getElementById('stage-loading')?.classList.contains('is-hidden') === true, { timeout: 600_000 });
await sleep(1200);
await page.screenshot({ path: 'tools/downloads/override-follow.png' });
const finalMode = await page.evaluate(() => document.getElementById('stage-device')?.textContent);
console.log('重建完成视角:', finalMode);
await browser.close();
console.log(finalMode.includes('全局') ? 'FAIL: 未切到第一视角' : 'PASS: 覆盖入口工作正常');
