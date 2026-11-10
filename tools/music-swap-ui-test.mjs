/**
 * 选曲弹层真实交互回归：
 * 1. 首次点「本地音乐」→ 弹文件选择器 → 选 a.wav 后生效；
 * 2. 再次点同一行 → 必须再次弹出文件选择器（这是之前「换不了」的根因）；
 * 3. 选 b.wav 后界面与存储都更新成 b.wav。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const tmpDir = path.join(process.cwd(), 'tools', 'downloads');
fs.mkdirSync(tmpDir, { recursive: true });

const wav = (freq, seconds = 3) => {
  const rate = 44100;
  const frames = rate * seconds;
  const buffer = Buffer.alloc(44 + frames * 2);
  const write = (offset, text) => buffer.write(text, offset, 'ascii');
  write(0, 'RIFF');
  buffer.writeUInt32LE(36 + frames * 2, 4);
  write(8, 'WAVE');
  write(12, 'fmt ');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  write(36, 'data');
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2);
  }
  return buffer;
};

const fileA = path.join(tmpDir, 'first-song.wav');
const fileB = path.join(tmpDir, 'second-song.wav');
fs.writeFileSync(fileA, wav(440));
fs.writeFileSync(fileB, wav(880, 4));

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const report = {};

// 第一次：打开弹层，点本地音乐行
await page.$eval('#swap-music', (el) => el.click());
await wait(300);
report.rowTextBefore = await page.$eval('.song[data-track="local"] .song-note', (el) => el.textContent);

const [chooserA] = await Promise.all([
  page.waitForFileChooser({ timeout: 4000 }),
  page.$eval('.song[data-track="local"]', (el) => el.click()),
]);
await chooserA.accept([fileA]);
await wait(1200);

report.afterFirst = await page.evaluate(async () => {
  const { getSetting } = await import('/src/store/db.ts');
  const stored = await getSetting('music-local-file', null);
  const track = await getSetting('music', null);
  return {
    fileName: stored?.name ?? null,
    stamp: stored?.stamp ?? null,
    track,
    label: document.querySelector('[data-song-name]')?.textContent ?? null,
    sheetOpen: document.getElementById('music-sheet')?.classList.contains('open') ?? null,
  };
});

// 第二次：再次打开弹层，再点本地音乐行 —— 必须再次弹选择器
await page.$eval('#swap-music', (el) => el.click());
await wait(300);
report.rowTextSecond = await page.$eval('.song[data-track="local"] .song-note', (el) => el.textContent);
report.replaceButtonText = await page.$eval('.song[data-track="local"] [data-pick-local]', (el) => el.textContent);

let secondChooserOpened = false;
try {
  const [chooserB] = await Promise.all([
    page.waitForFileChooser({ timeout: 4000 }),
    page.$eval('.song[data-track="local"]', (el) => el.click()),
  ]);
  secondChooserOpened = true;
  await chooserB.accept([fileB]);
} catch {
  secondChooserOpened = false;
}
report.secondChooserOpened = secondChooserOpened;
await wait(1500);

report.afterSecond = await page.evaluate(async () => {
  const { getSetting } = await import('/src/store/db.ts');
  const stored = await getSetting('music-local-file', null);
  const label = document.querySelector('[data-song-name]')?.textContent ?? null;
  return {
    fileName: stored?.name ?? null,
    stamp: stored?.stamp ?? null,
    label,
    sheetOpen: document.getElementById('music-sheet')?.classList.contains('open') ?? null,
  };
});

await browser.close();
console.log(JSON.stringify({ ...report, errors }, null, 2));
