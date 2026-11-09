/**
 * 多仓库轮换备份回归（docs/备份空间预算与上限.md 第八节）。
 *
 * 用内存版 GitHub 后端挂两个仓库（me/backup-1、me/backup-2），验证：
 *   1. 旧的单仓库配置自动迁移成 targets[0]；
 *   2. 活跃库用量 ≥90% 自动封存切换，新轨迹与清单落进 2 号库；
 *   3. 按需下载优先打 home 库；
 *   4. 删除按 meta.home 精确扫尾，封存库保持只读；
 *   5. 换手机（清空本地）能按队列顺序把两个库的清单合并回来。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5178/';
const GB = 1024 * 1024 * 1024;

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

const out = await page.evaluate(async ({ GB }) => {
  const b64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const unb64 = (text) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const makeRepo = () => {
    const store = { files: new Map(), puts: 0, deletes: 0, sha: 0, served: [] };
    const handle = (path, method, body, repoName) => {
      if (method === 'GET') {
        const file = store.files.get(path);
        if (!file) return json({ message: 'Not Found' }, 404);
        store.served.push(repoName);
        return json({ content: b64(file.text), sha: file.sha, encoding: 'base64' });
      }
      const existing = store.files.get(path);
      if (method === 'PUT' || method === 'POST') {
        if (existing && body.sha !== existing.sha) return json({ message: 'sha mismatch' }, 409);
        const sha = `${repoName}-s${(store.sha += 1)}`;
        store.files.set(path, { text: unb64(body.content), sha });
        store.puts += 1;
        return json({ content: { sha } });
      }
      if (method === 'DELETE') {
        store.deletes += 1;
        store.files.delete(path);
        return json({});
      }
      return json({ message: 'unsupported' }, 400);
    };
    return { store, handle };
  };

  const repos = { 'me/backup-1': makeRepo(), 'me/backup-2': makeRepo() };
  const usageOverride = { 'me/backup-1': 0, 'me/backup-2': 0 };
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    const m = url.match(/api\.github\.com\/repos\/me\/(backup-[12])(\/.*)?$/);
    if (!m) return realFetch(input, init);
    const [, num, rest] = m;
    const repoName = `me/${num}`;
    const store = repos[repoName].store;
    if (!rest || rest === '/') {
      return json({ full_name: repoName, size: 1, default_branch: 'main', private: true });
    }
    if (rest.startsWith('/git/trees/')) {
      const tree = usageOverride[repoName]
        ? [{ path: 'fitmotion/big.bin', type: 'blob', mode: '100644', size: usageOverride[repoName] }]
        : [...store.files.entries()].map(([p, f]) => ({ path: p, type: 'blob', mode: '100644', size: f.text.length }));
      return json({ sha: 'tree', truncated: false, tree });
    }
    // contents 路径要剥掉 ref/nonce 查询串，才能和 PUT 存的键对上
    const path = decodeURIComponent(rest.replace(/^\/contents\//, '').split('?')[0]);
    return repos[repoName].handle(path, method, body, repoName);
  };

  const db = await import('/src/store/db.ts');
  const store = await import('/src/store/repo.ts');
  const sync = await import('/src/backup/sync.ts');
  const sample = await import('/src/data/sample.ts');
  const { parseFit } = await import('/src/fit/parser.ts');

  const log = {};
  const trackKey = (id) => `fitmotion/tracks/${id}.fmt`;

  // 1) 旧版单仓库配置 → 自动迁移成 targets[0]
  await db.setSetting('backup.github', { token: 'ghp_fake', owner: 'me', repo: 'backup-1', branch: 'main' });
  const migrated = await sync.readConfig('github');
  log.migrated = {
    repos: migrated?.targets.map((row) => `${row.owner}/${row.repo}`),
    active: migrated?.active,
  };

  // 2) 首次同步：轨迹与清单落 1 号库
  const bin = atob(sample.SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const first = await store.saveParsed({
    parsed: parseFit(bytes.buffer),
    fileName: sample.SAMPLE_NAME,
    src: 'fit',
    bytes: bytes.buffer,
    keepFile: true,
  });
  const s1 = await sync.syncNow();
  const meta1 = await store.getRawMeta(first.id);
  log.firstSync = {
    ok: s1.ok,
    repo1Files: [...repos['me/backup-1'].store.files.keys()],
    repo2Files: [...repos['me/backup-2'].store.files.keys()],
    home: meta1?.home,
  };

  // 3) 绑上第 2 个仓库，把 1 号库撑到 93%（≥90% 封存线）→ 应切到 2 号库
  await db.setSetting('backup.github', {
    targets: [
      { token: 'ghp_fake', owner: 'me', repo: 'backup-1', branch: 'main' },
      { token: 'ghp_fake', owner: 'me', repo: 'backup-2', branch: 'main' },
    ],
    active: 0,
  });
  await store.putMeta({ ...meta1, where: {}, home: {}, backup: 0, updated: meta1.updated + 1 });
  usageOverride['me/backup-1'] = Math.round(GB * 0.93);
  const puts1Before = repos['me/backup-1'].store.puts;
  const s2 = await sync.syncNow();
  const meta2 = await store.getRawMeta(first.id);
  const cfg = await sync.readConfig('github');
  log.sealSwitch = {
    ok: s2.ok,
    pushed: s2.pushed,
    switchNote: s2.notes.find((row) => row.includes('改存')),
    active: cfg?.active,
    repo1NewPuts: repos['me/backup-1'].store.puts - puts1Before,
    repo2Files: [...repos['me/backup-2'].store.files.keys()],
    home: meta2?.home,
  };

  // 4) 按需下载：home 指向 2 号库，应优先打 2 号库
  repos['me/backup-1'].store.served = [];
  repos['me/backup-2'].store.served = [];
  const got = await sync.downloadTrack(first.id);
  log.download = {
    ok: Boolean(got),
    points: got?.lat.length ?? 0,
    servedFrom: repos['me/backup-2'].store.served.length ? 'backup-2' : repos['me/backup-1'].store.served.length ? 'backup-1' : 'none',
  };

  // 5) 删除：按 home 精确扫 2 号库；1 号库保持只读
  const puts1BeforeDel = repos['me/backup-1'].store.puts;
  await store.removeActivity(first.id);
  const preMeta = await store.getRawMeta(first.id);
  const m2text = repos['me/backup-2'].store.files.get('fitmotion/manifest.json')?.text ?? '';
  const m2 = (() => { try { return JSON.parse(m2text).activities.map(r => ({ id: r.id.slice(-4), deleted: r.deleted, home: r.home, updated: r.updated })); } catch (e) { return 'parse-fail'; } })();
  const s3 = await sync.syncNow();
  log.deleteSweep = {
    preMeta: { deleted: preMeta?.deleted > 0, updated: preMeta?.updated, where: preMeta?.where, home: preMeta?.home },
    repo2Manifest: m2,
    ok: s3.ok,
    notes: s3.notes,
    message: s3.message,
    removed: s3.removed,
    repo2HasTrack: repos['me/backup-2'].store.files.has(trackKey(first.id)),
    repo1NewPuts: repos['me/backup-1'].store.puts - puts1BeforeDel,
    repo2ManifestTombstone: (() => {
      const text = repos['me/backup-2'].store.files.get('fitmotion/manifest.json')?.text ?? '';
      try { return JSON.parse(text).activities.some((row) => row.id === first.id && row.deleted > 0); } catch { return false; }
    })(),
  };

  // 6) 换手机：清空本地，两个库的清单都要并进来（1 号库的旧条目被 2 号库的墓碑压掉）
  await db.tx([db.STORE.activities, db.STORE.tracks, db.STORE.files], 'readwrite', (t) => {
    t.objectStore(db.STORE.activities).clear();
    t.objectStore(db.STORE.tracks).clear();
    t.objectStore(db.STORE.files).clear();
  });
  const s4 = await sync.syncNow();
  const rows = await store.allMeta();
  log.freshDevice = {
    ok: s4.ok,
    pulled: s4.pulled,
    message: s4.message,
    records: rows.map((row) => ({ id: row.id.slice(-4), deleted: row.deleted > 0, home: row.home?.github })),
  };

  // 7) 容量汇总：两个库合计，活跃/封存状态正确
  const usage = await sync.remoteUsage();
  log.usage = {
    used: usage[0]?.used ?? 0,
    quota: usage[0]?.quota ?? 0,
    repos: usage[0]?.repos.map((row) => ({ repo: row.repo, used: row.used, active: row.active, sealed: row.sealed })),
  };

  window.fetch = realFetch;
  return log;
}, { GB });

console.log(JSON.stringify(out, null, 2));
console.log('errors:', errors.length);
await browser.close();
