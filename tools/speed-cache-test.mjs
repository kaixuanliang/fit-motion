/**
 * 倍速 + 缓存并行化专项回归。
 *
 * 1) 速度开关有 1~5× 五个档位，点击切换生效；
 * 2) renderMusicPcm 变速后 PCM 时长 = 成片时长（不是 × 倍速）；
 * 3) 重构后的 prepareStudio（三路并行抓取）能正常走完缓存并进入创作页。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5178/';
const executablePath = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, label) => {
  if (!cond) throw new Error(`FAIL ${label}`);
  console.log(`ok   ${label}`);
};

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await wait(2000);

// ── 1. 速度开关 ──
const speeds = await page.evaluate(() =>
  [...document.querySelectorAll('#speed-switch button[data-speed]')].map((b) => b.dataset.speed));
assert(JSON.stringify(speeds) === JSON.stringify(['1', '2', '3', '4', '5']), `速度开关为 1~5×（实际 ${speeds.join(',')}）`);
await page.evaluate(() => document.querySelector('#speed-switch button[data-speed="3"]')?.click());
await wait(120);
const activeSpeed = await page.evaluate(() =>
  document.querySelector('#speed-switch button.active')?.dataset.speed);
assert(activeSpeed === '3', `点击 3× 后 active 生效（实际 ${activeSpeed}）`);

// ── 2. 音乐变速：PCM 时长应等于成片时长 ──
const audio = await page.evaluate(async () => {
  const mod = await import('/src/audio/synth.ts');
  const base = await mod.renderMusicPcm('drive', 8, 1);
  const fast = await mod.renderMusicPcm('drive', 8, 3);
  const toSec = (r) => (atob(r.pcm).length / 2 / r.channels) / r.sampleRate;
  return { base: toSec(base), fast: toSec(fast) };
});
assert(Math.abs(audio.base - 8) < 0.5, `1× 音乐时长 ≈ 8s（实际 ${audio.base.toFixed(2)}s）`);
assert(Math.abs(audio.fast - 8) < 0.5, `3× 变速后音乐时长 ≈ 8s（实际 ${audio.fast.toFixed(2)}s）`);

// ── 3. 并行化后的缓存流程：注入样本 → 打开创作页 → 就绪 ──
{
  const sampleSrc = fs.readFileSync('src/data/sample.ts', 'utf8');
  const b64 = sampleSrc.slice(sampleSrc.indexOf('SAMPLE_FIT_BASE64')).match(/'([^']+)'/)[1];
  const name = sampleSrc.match(/SAMPLE_NAME = '([^']+)'/)[1];
  await page.evaluate(async () => {
    const mod = await import('/src/store/repo.ts');
    for (const meta of await mod.allMeta()) await mod.removeActivity(meta.id);
  });
  await wait(300);
  await page.evaluate(() => document.querySelector('[data-tab="import"]')?.click());
  await wait(300);
  await page.evaluate(({ b64, name }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { b64, name });
  await wait(4000);
  await page.evaluate(() => document.getElementById('import-close')?.click());
  await wait(500);
  await page.evaluate(() => document.querySelector('[data-tab="records"]')?.click());
  await wait(500);
  await page.evaluate(() => document.querySelector('#records-pane .rec')?.click());
  await page.waitForFunction(() => document.querySelector('#studio.active'), { timeout: 30000 });
  console.log('ok   从记录卡片进入创作页（#studio.active）');
  const t0 = Date.now();
  await page.waitForFunction(() => window.__fitReady === true, { timeout: 300000 });
  const cacheMs = (Date.now() - t0) / 1000;
  console.log(`ok   缓存就绪（本机网络 ${cacheMs.toFixed(1)}s）`);
}

const realErrors = errors.filter((e) => !e.includes('net::ERR') && !e.includes('Failed to load'));
assert(realErrors.length === 0, `无页面报错（${realErrors.length} 条：${realErrors.slice(0, 3).join(' | ')}）`);
await browser.close();
console.log('\n全部通过 ✅');
