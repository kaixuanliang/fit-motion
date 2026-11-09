/**
 * 仓库队列 UI 回归：file:// 生产包环境。
 *
 * 覆盖：绑定第 1 库 → 「+ 仓库」追加第 2 库 → 点行弹操作菜单 → 解绑第 2 库
 * → 队列回到 1 个 → 点行编辑工作库 → 同名仓库拦截。删库是本次用户报障的
 * 主路径，必须端到端走通，不能只靠 store 层测试。
 */

import puppeteer from 'puppeteer-core';

const REPO1 = 'tester/fitmotion-backup';
const REPO2 = 'tester/fitmotion-backup-2';

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

await page.goto('file:///D:/Mine/fit-motion/dist/index.html', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1200));

// 内存版 GitHub 后端：两个仓库各自一套文件
await page.evaluate((repo1, repo2) => {
  const b64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const unb64 = (text) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  const makeRepo = () => ({ files: new Map(), shaSeq: 0 });
  const repos = new Map([[repo1, makeRepo()], [repo2, makeRepo()]]);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const m = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)/);
    if (!m || !repos.has(m[1])) return realFetch(input, init);
    const repo = repos.get(m[1]);
    const u = new URL(url);
    if (u.pathname === `/repos/${m[1]}`) {
      return json({ full_name: m[1], size: 240, default_branch: 'main', private: true });
    }
    if (u.pathname === `/repos/${m[1]}/git/trees/main`) {
      return json({
        sha: 'tree-0', truncated: false,
        tree: [...repo.files.entries()].map(([path, f]) => ({ path, type: 'blob', mode: '100644', size: f.text.length })),
      });
    }
    const cm = u.pathname.match(/\/contents\/(.+)$/);
    if (!cm) return json({ message: 'Not Found' }, 404);
    const path = decodeURIComponent(cm[1]);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === 'GET') {
      const file = repo.files.get(path);
      return file ? json({ content: b64(file.text), sha: file.sha, encoding: 'base64' }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'PUT') {
      repo.files.set(path, { text: unb64(body.content), sha: `sha${(repo.shaSeq += 1)}` });
      return json({ content: { sha: `sha${repo.shaSeq}` } });
    }
    if (method === 'DELETE') { repo.files.delete(path); return json({}); }
    return json({ message: 'unsupported' }, 400);
  };
  window.__repos = repos;
}, REPO1, REPO2);

/** 页内表单（showForm）填充并提交 */
async function fillBindForm(values) {
  await page.evaluate((vals) => {
    const form = document.querySelector('form.fm-dialog-card');
    if (!form) throw new Error('bind form not found');
    for (const [key, value] of Object.entries(vals)) {
      const input = form.querySelector(`input[data-key="${key}"]`);
      if (input) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    form.querySelector('button[type="submit"]')?.click();
  }, values);
  await new Promise((r) => setTimeout(r, 2500));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = () => page.evaluate(() =>
  [...document.querySelectorAll('#github-targets .target-row b')].map((el) => el.textContent));

await page.evaluate(() => document.querySelector('[data-tab="backup"]').click());
await wait(400);

// 1. 绑定第一库
await page.evaluate(() => document.querySelector('[data-bind="github"]').click());
await wait(500);
await fillBindForm({ repo: REPO1, token: 'ghp_fake_token_123456' });
const step1 = await page.evaluate(() => document.getElementById('github-badge')?.textContent);
console.log('after bind1:', step1);

// 2. 追加第二库
const addBtn = await page.$('[data-bind-add="github"]');
if (!addBtn) throw new Error('+ 仓库按钮不可见');
await page.evaluate(() => document.querySelector('[data-bind-add="github"]').click());
await wait(500);
await fillBindForm({ repo: REPO2, token: 'ghp_fake_token_123456' });
const step2 = { rows: await rows(), badge: await page.evaluate(() => document.getElementById('github-badge')?.textContent) };
console.log('after add2:', JSON.stringify(step2));
if (step2.rows.length !== 2) throw new Error(`追加后应有 2 行，实际 ${step2.rows.length}`);

// 3. 点第二行 → 操作菜单 → 解绑 → 确认
await page.evaluate(() => document.querySelectorAll('#github-targets .target-row')[1].click());
await wait(500);
const sheet = await page.evaluate(() => ({
  title: document.querySelector('.fm-action-sheet .fm-action-title')?.textContent,
  acts: [...document.querySelectorAll('.fm-action-sheet [data-act]')].map((b) => b.dataset.act),
}));
console.log('action sheet:', JSON.stringify(sheet));
await page.evaluate(() => document.querySelector('.fm-action-sheet [data-act="remove"]')?.click());
await wait(500);
const confirmText = await page.evaluate(() => document.querySelector('.fm-alert p')?.textContent);
await page.evaluate(() => document.querySelector('.fm-alert [data-act="ok"]')?.click());
await wait(1200);
const step3 = { rows: await rows(), confirmText, badge: await page.evaluate(() => document.getElementById('github-badge')?.textContent) };
console.log('after remove2:', JSON.stringify(step3));
if (step3.rows.length !== 1 || !step3.rows[0].includes(REPO1)) throw new Error('解绑后队列应只剩第 1 库');

// 4. 同名拦截：再绑一个与第 1 库同名的
await page.evaluate(() => document.querySelector('[data-bind-add="github"]').click());
await wait(500);
await page.evaluate((repo) => {
  const form = document.querySelector('form.fm-dialog-card');
  for (const [key, value] of [['repo', repo], ['token', 'ghp_fake_token_123456']]) {
    const input = form.querySelector(`input[data-key="${key}"]`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}, REPO1);
await page.evaluate(() => document.querySelector('form.fm-dialog-card button[type="submit"]')?.click());
await wait(500);
const dupAlert = await page.evaluate(() => document.querySelector('.fm-alert p')?.textContent);
console.log('dup alert:', dupAlert);
if (!dupAlert || !dupAlert.includes('不用绑两次')) throw new Error('同名仓库未被拦截');
await page.evaluate(() => document.querySelector('.fm-alert [data-act="ok"]')?.click());
await wait(400);

// 5. 点第 1 行 → 编辑工作库 → 表单预填 REPO1 → 提交
await page.evaluate(() => document.querySelector('#github-targets .target-row').click());
await wait(500);
await page.evaluate(() => document.querySelector('.fm-action-sheet [data-act="edit"]')?.click());
await wait(500);
const prefilled = await page.evaluate(() => ({
  repo: document.querySelector('form.fm-dialog-card input[data-key="repo"]')?.value,
  title: document.querySelector('form.fm-dialog-card h3')?.textContent,
}));
console.log('edit form:', JSON.stringify(prefilled));
if (!prefilled.repo || prefilled.repo !== REPO1) throw new Error('编辑表单未预填当前仓库');
await page.evaluate(() => document.querySelector('form.fm-dialog-card button[type="submit"]')?.click());
await wait(2000);
const step5 = await rows();
console.log('after edit:', JSON.stringify(step5));
if (step5.length !== 1) throw new Error('编辑后队列数量不应变化');

// 6. 设为工作库（先加一个再切）
await page.evaluate(() => document.querySelector('[data-bind-add="github"]').click());
await wait(500);
await fillBindForm({ repo: REPO2, token: 'ghp_fake_token_123456' });
await page.evaluate(() => document.querySelectorAll('#github-targets .target-row')[1].click());
await wait(500);
await page.evaluate(() => document.querySelector('.fm-action-sheet [data-act="active"]')?.click());
await wait(800);
const step6 = await page.evaluate(() => [...document.querySelectorAll('#github-targets .target-row')].map((r) => r.textContent));
console.log('after set-active:', JSON.stringify(step6));
if (!step6[1].includes('活跃')) throw new Error('工作库切换未生效');

await page.screenshot({ path: 'screenshots/app/22-target-ui.png' });
await browser.close();

if (errors.length) {
  console.log('ERRORS:', errors);
  process.exit(1);
}
console.log('PASS target-ui-test');
