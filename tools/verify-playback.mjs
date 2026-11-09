/**
 * 修复验证：不打断自动播放，每 250ms 采样播放头 + rAF 帧间隔，
 * 输出播放头推进曲线与卡顿分布。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5178/';
const GPX = 'C:/Users/admin/xwechat_files/wxid_y1t5w0reko9722_969a/temp/RWTemp/2026-11/9e20f478899dc29eb19741386f9343c8/20250906户外骑行.gpx';
const executablePath = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath, headless: (process.env.HEADED ? false : true), args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await wait(2000);

await page.evaluate(() => {
  window.__probe = { gaps: [], last: 0 };
  const loop = (now) => {
    const gap = now - window.__probe.last;
    if (window.__probe.last && gap > 500) window.__probe.gaps.push(Math.round(gap));
    window.__probe.last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

await page.evaluate(async () => {
  const mod = await import('/src/store/repo.ts');
  for (const meta of await mod.allMeta()) await mod.removeActivity(meta.id);
});
await page.evaluate(() => document.querySelector('[data-tab="import"]')?.click());
await wait(300);
const b64 = fs.readFileSync(GPX).toString('base64');
await page.evaluate((b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], '20250906户外骑行.gpx'));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, b64);
await wait(9000);
await page.evaluate(() => document.getElementById('import-close')?.click());
await page.evaluate(() => document.querySelector('[data-tab="records"]')?.click());
await wait(500);
await page.evaluate(() => document.querySelector('#records-pane .rec')?.click());

const t0 = Date.now();
await page.waitForFunction(() => window.__fitReady === true, { timeout: 300000 });
const cacheSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`cache done in ${cacheSec}s (含 warm), 自动播放开始`);

// 60 秒内每 250ms 采样 thumb
const traj = [];
for (let i = 0; i < 240; i += 1) {
  await wait(250);
  const th = await page.evaluate(() => parseFloat(document.getElementById('timeline-thumb')?.style.left ?? '-1'));
  traj.push(th);
}
// 压缩输出：合并相同值
const segs = [];
let prev = null, count = 0, startIdx = 0;
for (let i = 0; i < traj.length; i += 1) {
  const v = Math.round(traj[i] * 1000) / 1000;
  if (v !== prev) {
    if (prev !== null) segs.push(`${(startIdx * 0.25).toFixed(1)}s: ${prev} ×${count}`);
    prev = v; count = 1; startIdx = i;
  } else count += 1;
}
segs.push(`${(startIdx * 0.25).toFixed(1)}s: ${prev} ×${count}`);
console.log('播放头轨迹(时间s: 比例 ×连续样本数):');
console.log(segs.join('\n'));
const gaps = await page.evaluate(() => window.__probe.gaps);
console.log('rAF 大间隙(>500ms):', JSON.stringify(gaps.slice(0, 20)));
await browser.close();
