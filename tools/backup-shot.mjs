/**
 * 备份页 UI 验证：内存版 GitHub + 真实点击「立即同步」。
 * 产出 screenshots/app/12~15，确认绑定态、待备份数、进度、结果文案都对得上。
 */

import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const outDir = 'screenshots/app';
fs.mkdirSync(outDir, { recursive: true });

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
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));

// 装假仓库 + 预置一条 FIT
await page.evaluate(async () => {
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
      return json({ full_name: 'tester/fitmotion-backup', size: 1860, default_branch: 'main', private: true });
    }
    const match = u.pathname.match(/\/contents\/(.+)$/);
    if (!match) return json({ message: 'Not Found' }, 404);
    const path = decodeURIComponent(match[1]);
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') {
      const file = files.get(path);
      if (!file) return json({ message: 'Not Found' }, 404);
      return json({ content: b64(file.text), sha: file.sha, encoding: 'base64' });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'PUT') {
      const existing = files.get(path);
      if (existing && body.sha !== existing.sha) return json({ message: 'sha mismatch' }, 409);
      const sha = `sha${(shaSeq += 1)}`;
      files.set(path, { text: unb64(body.content), sha });
      return json({ content: { sha } });
    }
    if (method === 'DELETE') {
      files.delete(path);
      return json({});
    }
    return json({ message: 'unsupported' }, 400);
  };

  const db = await import('/src/store/db.ts');
  await db.setSetting('backup.github', { token: 'ghp_fake', owner: 'tester', repo: 'fitmotion-backup', branch: 'main' });

  const sample = await import('/src/data/sample.ts');
  const bin = atob(sample.SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], sample.SAMPLE_NAME);
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 3200));
await page.evaluate(() => document.getElementById('import-close')?.click());
await new Promise((r) => setTimeout(r, 400));

// 备份页：已绑定 + 1 条待备份
await page.evaluate(() => document.querySelector('[data-tab="backup"]').click());
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${outDir}/12-backup-bound.png` });
const before = await page.evaluate(() => ({
  state: document.getElementById('backup-state')?.textContent,
  pending: document.getElementById('pending-count')?.textContent,
  badge: document.getElementById('github-badge')?.textContent,
  usage: document.getElementById('github-usage')?.textContent,
  button: document.getElementById('sync-now')?.textContent,
}));
console.log('before sync:', before);

// 点同步
await page.evaluate(() => document.getElementById('sync-now').click());
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: `${outDir}/13-backup-syncing.png` });
await new Promise((r) => setTimeout(r, 3000));
const after = await page.evaluate(() => ({
  line: document.getElementById('sync-line')?.textContent,
  pct: document.getElementById('sync-pct')?.textContent,
  note: document.getElementById('sync-note')?.textContent,
  pending: document.getElementById('pending-count')?.textContent,
  button: document.getElementById('sync-now')?.textContent,
  usage: document.getElementById('github-usage')?.textContent,
}));
console.log('after sync:', after);
await page.screenshot({ path: `${outDir}/14-backup-done.png` });

// 记录页的备份徽标
await page.evaluate(() => document.querySelector('[data-tab="records"]').click());
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${outDir}/15-records-backed.png` });
const card = await page.evaluate(() => document.querySelector('.rec')?.textContent?.replace(/\s+/g, ' ').trim());
console.log('card:', card);
console.log('errors:', errors.length);
await browser.close();
