/**
 * 备份引擎的端到端验证。
 *
 * 不碰真实 GitHub：在页面里把 fetch 换成一个内存版 Contents API，
 * 这样走的还是 GitHubAdapter 的真实代码路径（base64、sha 冲突、404），
 * 只是后端换成了 Map。验证四件事：
 *   1. 轨迹编码体积与精度
 *   2. 首次同步把轨迹与清单推上去
 *   3. 清空本地后同步能把索引拉回来（换手机场景）
 *   4. 点开记录时按需回源下载轨迹
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

const result = await page.evaluate(async () => {
  const log = {};
  try {

  /* ---------------- 1. 轨迹编解码 ---------------- */
  const codec = await import('/src/backup/codec.ts');
  const N = 38795;
  const lat = new Float32Array(N);
  const lon = new Float32Array(N);
  const t = new Float64Array(N);
  const alt = new Float32Array(N);
  const hr = new Int16Array(N);
  const start = Date.UTC(2026, 4, 4, 5, 30, 0);
  for (let i = 0; i < N; i += 1) {
    lat[i] = 39.9 + Math.sin(i / 400) * 0.35;
    lon[i] = 116.4 + Math.cos(i / 380) * 0.5;
    t[i] = start + i * 1000;
    alt[i] = 45 + Math.sin(i / 900) * 30;
    hr[i] = 120 + Math.round(Math.sin(i / 300) * 25);
  }
  const track = {
    id: 'probe', lat, lon, t, alt, hr, speed: null, dist: null,
    hasTimestamps: true, sportHint: 2,
    session: { distance: 217000, elapsedTime: 49200, sport: 2, startTime: start },
  };
  const packed = await codec.packTrack(track);
  const back = await codec.unpackTrack(packed.text, 'probe');
  let maxLat = 0;
  let maxAlt = 0;
  let maxHr = 0;
  for (let i = 0; i < N; i += 1) {
    maxLat = Math.max(maxLat, Math.abs(back.lat[i] - lat[i]), Math.abs(back.lon[i] - lon[i]));
    maxAlt = Math.max(maxAlt, Math.abs(back.alt[i] - alt[i]));
    maxHr = Math.max(maxHr, Math.abs(back.hr[i] - hr[i]));
  }
  log.codec = {
    points: N,
    rawBytes: N * 18,
    packedBytes: packed.bytes,
    textBytes: packed.text.length,
    ratio: +(packed.bytes / (N * 18)).toFixed(2),
    maxLatError: +maxLat.toFixed(8),
    maxAltError: +maxAlt.toFixed(2),
    maxHrError: maxHr,
    timeOk: back.t[1000] === t[1000],
    sessionKept: back.session.distance === 217000,
  };

  /* ---------------- 2. 假仓库（GitHub + Gitee 各一份） ---------------- */
  const b64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
  const unb64 = (text) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));

  const makeRemote = (label, style) => {
    const store = { files: new Map(), calls: { get: 0, put: 0, post: 0, delete: 0 } };
    let shaSeq = 0;
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    const handle = (path, method, body) => {
      if (method === 'GET') {
        store.calls.get += 1;
        const file = store.files.get(path);
        if (!file) return json({ message: 'Not Found' }, 404);
        return json({ content: b64(file.text), sha: file.sha, encoding: 'base64' });
      }
      const existing = store.files.get(path);
      if (method === 'POST' || method === 'PUT') {
        store.calls[method.toLowerCase()] += 1;
        if (style === 'gitee') {
          if (method === 'POST' && existing) return json({ message: '文件已存在' }, 400);
          if (method === 'PUT' && (!existing || existing.sha !== body.sha)) return json({ message: 'sha 不匹配' }, 422);
        } else if (existing && body.sha !== existing.sha) {
          return json({ message: 'sha mismatch' }, 409);
        }
        const sha = `${label}sha${(shaSeq += 1)}`;
        store.files.set(path, { text: unb64(body.content), sha });
        return json({ content: { sha } });
      }
      if (method === 'DELETE') {
        store.calls.delete += 1;
        if (!existing) return json({ message: 'Not Found' }, 404);
        store.files.delete(path);
        return json({});
      }
      return json({ message: 'unsupported' }, 400);
    };
    store.json = json;
    store.handle = handle;
    return store;
  };

  const remote = {
    github: makeRemote('gh', 'github'),
    gitee: makeRemote('ge', 'gitee'),
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.includes('api.github.com/repos/tester/fitmotion-backup')) {
      const u = new URL(url);
      if (u.pathname === '/repos/tester/fitmotion-backup') {
        return remote.github.json({ full_name: 'tester/fitmotion-backup', size: 512, default_branch: 'main', private: true });
      }
      const m = u.pathname.match(/\/contents\/(.+)$/);
      if (!m) return remote.github.json({ message: 'Not Found' }, 404);
      return remote.github.handle(decodeURIComponent(m[1]), method, body);
    }
    if (url.includes('gitee.com/api/v5/repos/tester/fitmotion-backup')) {
      if (remote.gitee.down) return remote.gitee.json({ message: 'boom' }, 500);
      const u = new URL(url);
      if (u.pathname === '/api/v5/repos/tester/fitmotion-backup') {
        return remote.gitee.json({ full_name: 'tester/fitmotion-backup', default_branch: 'master', private: true });
      }
      const m = u.pathname.match(/\/contents\/(.+)$/);
      if (!m) return remote.gitee.json({ message: 'Not Found' }, 404);
      return remote.gitee.handle(decodeURIComponent(m[1]), method, body);
    }
    return realFetch(input, init);
  };

  const summarize = (store) => ({
    paths: [...store.files.keys()],
    bytes: [...store.files.values()].reduce((sum, f) => sum + f.text.length, 0),
    calls: { ...store.calls },
  });
  window.__remote = { remote, summarize };

  /* ---------------- 3. 绑定 + 导入 + 同步 ---------------- */
  const db = await import('/src/store/db.ts');
  const repo = await import('/src/store/repo.ts');
  const sync = await import('/src/backup/sync.ts');
  const sample = await import('/src/data/sample.ts');
  const { parseFit } = await import('/src/fit/parser.ts');

  await db.setSetting('backup.github', { token: 'ghp_fake', owner: 'tester', repo: 'fitmotion-backup', branch: 'main' });
  await db.setSetting('backup.gitee', { token: 'gitee_fake', owner: 'tester', repo: 'fitmotion-backup', branch: 'master' });

  const bin = atob(sample.SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const imported = await repo.saveParsed({
    parsed: parseFit(bytes.buffer),
    fileName: sample.SAMPLE_NAME,
    src: 'fit',
    bytes: bytes.buffer,
    keepFile: true,
  });
  log.imported = imported;

  const first = await sync.syncNow();
  const metasAfterFirst = await repo.allMeta();
  log.firstSync = {
    ok: first.ok,
    pushed: first.pushed,
    pulled: first.pulled,
    failed: first.failed,
    message: first.message,
    notes: first.notes,
    github: summarize(remote.github),
    gitee: summarize(remote.gitee),
    backupState: metasAfterFirst.map((m) => ({ name: m.name, backup: m.backup, where: m.where })),
    manifestEntries: JSON.parse(remote.github.files.get('fitmotion/manifest.json')?.text || '{"activities":[]}').activities.length,
  };

  /* ---------------- 4. 换手机：清空本地，只留配置 ---------------- */
  await db.tx([db.STORE.activities, db.STORE.tracks, db.STORE.files], 'readwrite', (t) => {
    t.objectStore(db.STORE.activities).clear();
    t.objectStore(db.STORE.tracks).clear();
    t.objectStore(db.STORE.files).clear();
  });
  log.afterWipe = { count: (await repo.allMeta()).length };

  const second = await sync.syncNow();
  const page = await repo.listPage({});
  log.secondSync = {
    ok: second.ok,
    pushed: second.pushed,
    pulled: second.pulled,
    message: second.message,
    restored: page.items.map((m) => ({
      name: m.name,
      distanceKm: +(m.distance / 1000).toFixed(1),
      thumbChars: m.thumb.length,
      backup: m.backup,
      points: m.points,
    })),
    hasTrackLocally: await repo.hasTrack(imported.id),
  };

  /* ---------------- 5. 点开记录：按需回源 ---------------- */
  log.resolver = repo.hasRemoteResolver();
  const startedAt = performance.now();
  const activity = await repo.loadActivity(imported.id);
  log.lazyLoad = {
    ms: Math.round(performance.now() - startedAt),
    points: activity.points.length,
    distanceKm: +(activity.distanceM / 1000).toFixed(1),
    durationSec: Math.round(activity.durationSec),
    avgSpeedKmh: +(activity.avgSpeed * 3.6).toFixed(1),
    cachedAfter: await repo.hasTrack(imported.id),
  };

  /* ---------------- 6. 删除 + 同步墓碑 ---------------- */
  await repo.removeActivity(imported.id);
  const third = await sync.syncNow();
  log.deleteSync = {
    removed: third.removed,
    trackStillRemote: {
      github: remote.github.files.has(`fitmotion/tracks/${imported.id}.fmt`),
      gitee: remote.gitee.files.has(`fitmotion/tracks/${imported.id}.fmt`),
    },
    tombstones: {
      github: JSON.parse(remote.github.files.get('fitmotion/manifest.json')?.text || '{"activities":[]}').activities
        .map((row) => ({ name: row.name, deleted: row.deleted > 0 })),
      gitee: JSON.parse(remote.gitee.files.get('fitmotion/manifest.json')?.text || '{"activities":[]}').activities
        .map((row) => ({ name: row.name, deleted: row.deleted > 0 })),
    },
  };

  /* ---------------- 7. 一端挂掉：另一端顶上 ---------------- */
  remote.gitee.down = true;
  const again = await repo.saveParsed({
    parsed: parseFit(bytes.buffer),
    fileName: sample.SAMPLE_NAME.replace('.fit', '_second.fit'),
    src: 'fit',
    bytes: bytes.buffer,
    keepFile: true,
  });
  const fourth = await sync.syncNow();
  const afterFail = await repo.getRawMeta(again.id);
  log.degraded = {
    ok: fourth.ok,
    pushed: fourth.pushed,
    failed: fourth.failed,
    message: fourth.message,
    notes: fourth.notes,
    backup: afterFail?.backup,
    where: afterFail?.where,
    githubHasIt: remote.github.files.has(`fitmotion/tracks/${again.id}.fmt`),
  };

  return log;
  } catch (e) {
    return { failed: e.message, stack: e.stack, log };
  }
});

console.log(JSON.stringify(result, null, 2));
console.log('page errors:', errors.length);
await browser.close();
