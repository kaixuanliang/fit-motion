import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = 'http://127.0.0.1:5180';
const downloads = path.join(process.cwd(), 'downloads');
fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync('screenshots', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--disable-crash-reporter', '--disable-breakpad'],
  defaultViewport: { width: 1280, height: 1000, deviceScaleFactor: 1 },
});

const page = await browser.newPage();
const logs = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') logs.push(`console.${message.type()}: ${message.text()}`);
});
page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

const client = await page.createCDPSession();
await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((resolve) => setTimeout(resolve, 2500));

// 旧版这里直接 uploadFile 本地 samples/*.fit（该文件已不在仓库里），而且
// 等待 `studio.hidden`——但面板切换走的是 data-pane class 体系，hidden 恒为
// false，等待形同虚设；重复导入也不会打开创作页。改为：注入内嵌样本 →
// 关闭导入弹层 → 从记录页点开 → 等真正的激活状态。
const sampleSrc = fs.readFileSync('src/data/sample.ts', 'utf8');
const fitBase64 = sampleSrc.slice(sampleSrc.indexOf('SAMPLE_FIT_BASE64')).match(/'([^']+)'/)[1];
const fitName = sampleSrc.match(/SAMPLE_NAME = '([^']+)'/)[1];
await page.evaluate(({ b64, name }) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, { b64: fitBase64, name: fitName });
await page.waitForFunction(
  () => /导入完成|没有新增|失败/.test(document.getElementById('import-title')?.textContent ?? ''),
  { timeout: 30000 },
);
await page.evaluate(() => document.getElementById('import-close')?.click());
await new Promise((resolve) => setTimeout(resolve, 500));
await page.evaluate(() => document.querySelector('[data-tab="records"]')?.click());
await new Promise((resolve) => setTimeout(resolve, 600));
const recOpened = await page.evaluate(() => {
  const rec = document.querySelector('#records-pane .rec');
  if (!rec) return false;
  rec.click();
  return true;
});
if (!recOpened) throw new Error('记录列表为空，无法打开创作页');
await page.waitForFunction(() => document.querySelector('#studio').classList.contains('active'), { timeout: 15000 });
await page.waitForFunction(() => !document.getElementById('export-btn').disabled && document.getElementById('stage-loading').classList.contains('is-hidden'), { timeout: 180000 });
await new Promise((resolve) => setTimeout(resolve, 1200));
await page.screenshot({ path: 'screenshots/upload-autoplay.png' });

const t1 = await page.$eval('#timecode', (element) => element.textContent);
await new Promise((resolve) => setTimeout(resolve, 2200));
const t2 = await page.$eval('#timecode', (element) => element.textContent);

const diagnostics = await page.evaluate(() => {
  const canvas = document.getElementById('stage-canvas');
  let taint = '';
  try {
    canvas.toDataURL();
  } catch (error) {
    taint = String(error);
  }
  const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return {
    taint,
    mediaRecorder: typeof MediaRecorder,
    supported: typeof MediaRecorder === 'undefined' ? [] : types.filter((type) => MediaRecorder.isTypeSupported(type)),
    canvas: `${canvas.width}x${canvas.height}`,
    timecode: document.getElementById('timecode').textContent,
    bigPlayHidden: document.getElementById('big-play').classList.contains('is-hidden'),
  };
});

// Web/MediaRecorder 导出路径已移除：现在唯一出口是 Android 原生 GPU 编码。
// 桌面端点导出应当优雅提示「原生渲染仅支持 Android App.」，而不是崩溃或
// 打开一个永远转圈的 overlay —— 这正是本段要回归的行为。
await page.click('#export-btn');
await new Promise((resolve) => setTimeout(resolve, 1200));
const exportState = await page.evaluate(() => ({
  overlayHidden: document.getElementById('export-overlay').hidden,
  toast: document.getElementById('toast')?.textContent ?? '',
  exportBusy: document.getElementById('export-btn')?.disabled ?? false,
}));
if (exportState.overlayHidden !== true) throw new Error('桌面端点导出不应打开导出弹层');
if (!exportState.toast.includes('原生渲染仅支持 Android App')) throw new Error(`未提示仅支持 Android：${exportState.toast}`);
if (exportState.exportBusy) throw new Error('提示后导出按钮不应卡在禁用态');
await page.screenshot({ path: 'screenshots/final-result.png' });

console.log(JSON.stringify({ t1, t2, diagnostics, exportState, logs }, null, 2));
await browser.close();
