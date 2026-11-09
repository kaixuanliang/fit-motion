/**
 * 备份空间账本回归：清单幂等 + 配额守卫。
 *
 * 盯两件容易悄悄吃配额的事：
 *   1. 「什么都没变」的同步不该再写一版 manifest（每次写都进 Git 历史）；
 *   2. 容量见底时要在上传前收手并说清原因，而不是一条条 4xx。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5178/';
const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('EXC', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('ERR', m.text()); } });
await page.goto(BASE, { waitUntil: 'networkidle2' });

const out = await page.evaluate(async () => {
  const b64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const unb64 = (text) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const repo = { files: new Map(), puts: 0, manifestPuts: 0, sha: 0 };
  const state = { usageOverride: 0 };
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    if (!url.includes('api.github.com/repos/tester/fitmotion-backup')) return realFetch(input, init);

    const u = new URL(url);
    // 容量：模拟 git trees；state.usageOverride 用于把仓库「撑满」
    if (u.pathname === '/repos/tester/fitmotion-backup/git/trees/main') {
      const tree = state.usageOverride
        ? [{ path: 'fitmotion/big.bin', type: 'blob', mode: '100644', size: state.usageOverride }]
        : [...repo.files.entries()].map(([path, f]) => ({ path, type: 'blob', mode: '100644', size: f.text.length }));
      return json({ sha: 'tree', truncated: false, tree });
    }
    if (u.pathname === '/repos/tester/fitmotion-backup') {
      return json({ full_name: 'tester/fitmotion-backup', size: 1, default_branch: 'main', private: true });
    }
    const m = u.pathname.match(/\/contents\/(.+)$/);
    if (!m) return json({ message: 'Not Found' }, 404);
    const path = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const file = repo.files.get(path);
      return file ? json({ content: b64(file.text), sha: file.sha, encoding: 'base64' }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'PUT') {
      const existing = repo.files.get(path);
      if (existing && body.sha !== existing.sha) return json({ message: 'sha mismatch' }, 409);
      const sha = `s${(repo.sha += 1)}`;
      repo.files.set(path, { text: unb64(body.content), sha });
      repo.puts += 1;
      if (path.endsWith('manifest.json')) repo.manifestPuts += 1;
      return json({ content: { sha } });
    }
    if (method === 'POST') {
      const sha = `s${(repo.sha += 1)}`;
      repo.files.set(path, { text: unb64(body.content), sha });
      repo.puts += 1;
      return json({ content: { sha } });
    }
    return json({ message: 'unsupported' }, 400);
  };

  const db = await import('/src/store/db.ts');
  const store = await import('/src/store/repo.ts');
  const sync = await import('/src/backup/sync.ts');
  const sample = await import('/src/data/sample.ts');
  const { parseFit } = await import('/src/fit/parser.ts');

  await db.setSetting('backup.github', { token: 'ghp_fake', owner: 'tester', repo: 'fitmotion-backup', branch: 'main' });

  const bin = atob(sample.SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const imported = await store.saveParsed({
    parsed: parseFit(bytes.buffer),
    fileName: sample.SAMPLE_NAME,
    src: 'fit',
    bytes: bytes.buffer,
    keepFile: true,
  });

  const log = {};

  // 1) 首次同步：一条轨迹 + 一版清单
  const first = await sync.syncNow();
  log.first = { pushed: first.pushed, ok: first.ok, manifestPuts: repo.manifestPuts, puts: repo.puts };

  const manifestText = repo.files.get('fitmotion/manifest.json')?.text ?? '';
  const manifest = JSON.parse(manifestText || '{"activities":[]}');
  log.manifestShape = {
    bytes: manifestText.length,
    entries: manifest.activities.length,
    leaksLocalState: manifest.activities.some((row) => 'where' in row || 'backup' in row || 'opened' in row),
    hasTrackBytes: manifest.activities.every((row) => typeof row.trackBytes === 'number'),
  };

  // 2) 再点一次同步（什么都没变）：不该产生新清单版本
  const putsBefore = repo.manifestPuts;
  const second = await sync.syncNow();
  log.noopSync = { pushed: second.pushed, manifestPutsAdded: repo.manifestPuts - putsBefore };

  // 3) 把仓库撑到 97%，再造一条待上传 → 应在上传前收手
  const meta = await store.getRawMeta(imported.id);
  await store.putMeta({ ...meta, where: {}, backup: 0, updated: Date.now() + 1000 });
  state.usageOverride = Math.round(1024 * 1024 * 1024 * 0.97);
  const trackPutsBefore = repo.puts;
  const blocked = await sync.syncNow();
  log.quotaBlocked = {
    ok: blocked.ok,
    pushed: blocked.pushed,
    failed: blocked.failed,
    message: blocked.message,
    notes: blocked.notes,
    newWrites: repo.puts - trackPutsBefore,
  };

  // 4) 容量恢复后同一条能正常补传
  state.usageOverride = 0;
  const recovered = await sync.syncNow();
  log.recovered = { ok: recovered.ok, pushed: recovered.pushed, failed: recovered.failed };

  // 5) 空间预算用的平均体积（usage ÷ 条数）
  const usage = await sync.remoteUsage();
  const metas = await store.allMeta();
  log.budget = {
    usedBytes: usage[0]?.used ?? 0,
    records: metas.length,
    avgPerRecord: metas.length ? Math.round((usage[0]?.used ?? 0) / metas.length) : 0,
  };

  window.fetch = realFetch;
  return log;
});

console.log(JSON.stringify(out, null, 2));
console.log('errors:', errors.length);
await browser.close();
