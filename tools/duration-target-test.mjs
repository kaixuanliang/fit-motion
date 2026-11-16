// 目标时长档位验证：demo 轨迹加载后切 20/40/60/auto 档，
// 断言舞台重建后的 duration 精确命中目标（含片头片尾）。
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 1000 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/?demo=1', { waitUntil: 'domcontentloaded', timeout: 60000 });

const durationOf = () => page.evaluate(() => window.__fitStage ? +window.__fitStage.duration.toFixed(2) : null);
const waitReady = () => page.waitForFunction(
  () => document.getElementById('stage-loading').classList.contains('is-hidden') && window.__fitStage,
  { timeout: 120_000 },
);
await waitReady();
console.log('自动档 duration:', await durationOf());

for (const dur of ['20', '40', '60', 'auto']) {
  await page.evaluate((d) => document.querySelector(`#es-seg button[data-dur="${d}"]`).click(), dur);
  await waitReady();
  await new Promise((r) => setTimeout(r, 500));
  const value = await durationOf();
  const active = await page.$eval('#es-seg button.active', (b) => b.dataset.dur);
  const target = dur === 'auto' ? null : Number(dur);
  const hit = target == null ? value > 0 : Math.abs(value - target) < 0.3;
  console.log(`档位 ${dur}: duration=${value} 选中=${active} ${hit ? '命中' : '未命中'}`);
  if (!hit) process.exitCode = 1;
}
await browser.close();
console.log(process.exitCode ? 'FAIL' : 'DONE');
