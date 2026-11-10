/**
 * 诊断：同一条记录「二次进入创作页」的耗时对比。
 *
 * 做法：真实导入 .fit → 第一次进创作页（等缓存门全过）→ 返回记录列表 →
 * 第二次进同一条记录 → 计时到缓存就绪，并收集 fm:cache:* 打点。
 * 有会话复用时第二次应命中 reuse-hit，耗时应为第一次的零头。
 *
 * 用法：node tools/reentry-perf.mjs <fit路径>
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const fitPath = process.argv[2];
if (!fitPath) throw new Error('缺少 fit 路径');

const buf = fs.readFileSync(fitPath);
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));

const b64 = buf.toString('base64');
await page.evaluate(async (data, name) => {
  const { importFiles } = await import('/src/import/batch.ts');
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  await importFiles([new File([bytes], name)]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  await new Promise((r) => setTimeout(r, 500));
}, b64, path.basename(fitPath));

async function enterStudio() {
  await page.evaluate(() => {
    window.__fitReady = false;
    performance.setMarks = [];
    document.querySelector('#records-pane .rec')?.click();
  });
  const t0 = Date.now();
  for (let i = 0; i < 2400; i += 1) {
    if (await page.evaluate(() => window.__fitReady === true)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const elapsed = Date.now() - t0;
  const dbg = await page.evaluate(() => {
    const s = window.__fmSession;
    return {
      activityId: s?.activityId ?? null,
      ready: s?.ready ?? null,
      overviewStats: s?.overview?.prefetchStats ?? null,
      overviewTiles: s?.overview?.tileCount ?? null,
      overviewReady: s?.overview?.ready ?? null,
      sameAsCurrent: !!s && window.__fitStage ? true : false,
    };
  });
  const marks = await page.evaluate(() => {
    const entries = performance.getEntriesByType('mark').filter((m) => m.name.startsWith('fm:cache:'));
    const byName = new Map();
    for (const m of entries) byName.set(m.name, Math.round(m.startTime));
    const rel = {};
    let base = 0;
    for (const [name, t] of byName) {
      if (!base) base = t;
      rel[name] = t - base;
    }
    const check = entries.filter((m) => m.name === 'fm:cache:reuse-check').slice(-1)[0];
    rel['reuse-check-detail'] = check?.detail ?? null;
    return rel;
  });
  return { elapsed, marks, dbg };
}

async function backToRecords() {
  await page.evaluate(() => {
    const btn = document.getElementById('change-file') ?? document.getElementById('back-btn');
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
}

await new Promise((r) => setTimeout(r, 400));
const first = await enterStudio();
await backToRecords();
const second = await enterStudio();
await backToRecords();
const third = await enterStudio();

console.log('第一次进入（全新缓存）:', first.elapsed, 'ms', JSON.stringify(first.dbg));
console.log('  marks:', JSON.stringify(first.marks));
console.log('第二次进入（会话复用）:', second.elapsed, 'ms', JSON.stringify(second.dbg));
console.log('  marks:', JSON.stringify(second.marks));
console.log('第三次进入（会话复用）:', third.elapsed, 'ms', JSON.stringify(third.dbg));
console.log('  marks:', JSON.stringify(third.marks));
await browser.close();
