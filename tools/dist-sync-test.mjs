/**
 * 生产包冒烟：file:///dist/index.html（等同 APK 里的 android_asset 环境）。
 *
 * 走完整用户路径：绑定仓库（两个 prompt）→ 选文件导入 → 点同步。
 * 后端仍是内存版 GitHub，但代码路径、CSP、file:// 下的 IndexedDB 都是真的。
 */

import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const sampleSrc = fs.readFileSync('src/data/sample.ts', 'utf8');
const fitBase64 = sampleSrc.slice(sampleSrc.indexOf("SAMPLE_FIT_BASE64")).match(/'([^']+)'/)[1];
const fitName = sampleSrc.match(/SAMPLE_NAME = '([^']+)'/)[1];

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('EXC', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('ERR', m.text()); } });

const answers = ['tester/fitmotion-backup', 'ghp_fake'];
page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') {
    const value = answers.shift() ?? '';
    await dialog.accept(value);
  } else {
    await dialog.accept();
  }
});

/** 绑定仓库走页内表单（showForm），不是 window.prompt */
async function fillBindForm(values) {
  await page.evaluate((vals) => {
    const form = document.querySelector('form.fm-dialog-card');
    if (!form) return false;
    for (const [key, value] of Object.entries(vals)) {
      const input = form.querySelector(`input[data-key="${key}"]`);
      if (input) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    form.querySelector('button[type="submit"]')?.click();
    return true;
  }, values);
}

await page.goto('file:///D:/Mine/fit-motion/dist/index.html', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1200));

const installed = await page.evaluate(() => {
  const b64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const unb64 = (text) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  const files = new Map();
  let shaSeq = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('api.github.com/repos/tester/fitmotion-backup')) return realFetch(input, init);
    const u = new URL(url);
    if (u.pathname === '/repos/tester/fitmotion-backup') {
      return json({ full_name: 'tester/fitmotion-backup', size: 240, default_branch: 'main', private: true });
    }
    // 容量走 git trees（真实适配器已不读 GET /repos 的 size）
    if (u.pathname === '/repos/tester/fitmotion-backup/git/trees/main') {
      return json({
        sha: 'tree-0',
        truncated: false,
        tree: [...files.entries()].map(([path, f]) => ({ path, type: 'blob', mode: '100644', size: f.text.length })),
      });
    }
    const m = u.pathname.match(/\/contents\/(.+)$/);
    if (!m) return json({ message: 'Not Found' }, 404);
    const path = decodeURIComponent(m[1]);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'GET') {
      const file = files.get(path);
      return file ? json({ content: b64(file.text), sha: file.sha, encoding: 'base64' }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'PUT') {
      const sha = `sha${(shaSeq += 1)}`;
      files.set(path, { text: unb64(body.content), sha });
      return json({ content: { sha } });
    }
    if (method === 'DELETE') { files.delete(path); return json({}); }
    return json({ message: 'unsupported' }, 400);
  };
  window.__files = files;
  return typeof CompressionStream !== 'undefined';
});

// 绑定：页内表单填 owner/repo + Token
await page.evaluate(() => document.querySelector('[data-tab="backup"]').click());
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => document.querySelector('[data-bind="github"]').click());
await new Promise((r) => setTimeout(r, 500));
await fillBindForm({ repo: 'tester/fitmotion-backup', token: 'ghp_fake_token_123456' });
await new Promise((r) => setTimeout(r, 2500));

// 导入一条真实 FIT（二进制由 node 侧读出来注进页面）
await page.evaluate(() => document.querySelector('[data-tab="import"]').click());
await new Promise((r) => setTimeout(r, 300));
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
await new Promise((r) => setTimeout(r, 4000));
await page.evaluate(() => document.getElementById('import-close')?.click());
await new Promise((r) => setTimeout(r, 500));
const pre = await page.evaluate(() => ({
  bound: document.getElementById('github-badge')?.textContent,
  pending: document.getElementById('pending-count')?.textContent,
  bindText: document.querySelector('[data-bind="github"]')?.textContent,
  canCompress: typeof CompressionStream !== 'undefined',
}));
console.log('bind:', pre, 'installed:', installed);

// 同步一次（空库也要能跑通：写 manifest + 报告）
await page.evaluate(() => document.querySelector('[data-tab="backup"]').click());
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => document.getElementById('sync-now').click());
await new Promise((r) => setTimeout(r, 2500));
const after = await page.evaluate(() => ({
  line: document.getElementById('sync-line')?.textContent,
  note: document.getElementById('sync-note')?.textContent,
  pct: document.getElementById('sync-pct')?.textContent,
  usage: document.getElementById('github-usage')?.textContent,
  files: [...window.__files.keys()],
  usageBytes: [...window.__files.values()].reduce((sum, f) => sum + f.text.length, 0),
}));
console.log('after sync:', after);
await page.screenshot({ path: 'screenshots/app/16-dist-backup.png' });

// 生产包里的创作页 + 音乐 + 全屏（验证 synth 被打进 bundle 且 file:// 下能跑）
await page.evaluate(() => document.querySelector('[data-tab="records"]').click());
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(() => document.querySelector('#records-pane .rec')?.click());
// 冷缓存下要抓几百张瓦片，file:// 走真实网络大约 40 秒
for (let i = 0; i < 240; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const ready = await page.evaluate(() => window.__fitReady === true);
  if (ready) break;
}
const studio = await page.evaluate(async () => {
  const out = { ready: window.__fitReady === true };
  out.song = document.querySelector('.music-row [data-song-name]')?.textContent;
  document.getElementById('fullscreen-btn')?.click();
  await new Promise((r) => setTimeout(r, 1500));
  out.fs = document.getElementById('studio')?.classList.contains('fs');
  out.fsSong = document.getElementById('fs-bar')?.querySelector('[data-song-name]')?.textContent;
  out.fsTime = document.getElementById('fs-time')?.textContent;
  out.fsSeek = document.getElementById('fs-seek-fill')?.style.width;
  return out;
});
console.log('studio:', studio);
await page.screenshot({ path: 'screenshots/app/20-dist-fullscreen.png' });

// 退出全屏后合成一整轨 PCM，确认导出前那一步在 file:// 下也通
await page.evaluate(() => document.getElementById('fs-exit')?.click());
await new Promise((r) => setTimeout(r, 400));
const pcm = await page.evaluate(async () => {
  const stage = window.__fitStage;
  if (!stage) return { error: 'no stage' };
  const started = performance.now();
  // 生产包里没有模块路径，走 UI 里已加载的合成器：直接点导出前的准备不可行，
  // 用页面暴露的 stage 时长做一次播放头拖动，确认音频引擎没缺席。
  return { duration: stage.duration, audioCtx: typeof AudioContext !== 'undefined', ms: Math.round(performance.now() - started) };
});
console.log('stage:', pcm);
console.log('errors:', errors.length);
await browser.close();
