/**
 * 音乐与全屏的界面截图，产出给使用报告配图。
 *
 * 18-music-sheet：选曲弹层（三首曲子 + 无音乐 + 试听按钮）
 * 19-fullscreen：全屏播放态（顶部退出 + 标题，底部歌名/主题/更换 + 进度）
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

await page.evaluate(async () => {
  const { SAMPLE_FIT_BASE64, SAMPLE_NAME } = await import('/src/data/sample.ts');
  const bin = atob(SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], SAMPLE_NAME));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (document.getElementById('import-overlay')?.hidden) break;
  }
  document.getElementById('import-close')?.click();
  document.querySelector('#records-pane .rec')?.click();
  for (let i = 0; i < 160; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (window.__fitReady === true) break;
  }
});

await page.screenshot({ path: 'screenshots/app/17b-create-music-row.png' });

await page.evaluate(() => document.getElementById('swap-music')?.click());
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: 'screenshots/app/18-music-sheet.png' });
await page.evaluate(() => document.getElementById('music-sheet-mask')?.click());
await new Promise((r) => setTimeout(r, 300));

await page.evaluate(() => document.getElementById('fullscreen-btn')?.click());
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'screenshots/app/19-fullscreen.png' });

const state = await page.evaluate(() => ({
  fs: document.getElementById('studio')?.classList.contains('fs'),
  song: document.getElementById('fs-bar')?.querySelector('[data-song-name]')?.textContent,
  time: document.getElementById('fs-time')?.textContent,
  seek: document.getElementById('fs-seek-fill')?.style.width,
}));
console.log(JSON.stringify(state));
await browser.close();
