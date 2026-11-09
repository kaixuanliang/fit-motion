/**
 * 删除 → 同步 → 撤销删除 全链路回归。
 *
 * 场景（用户反馈的那个 bug）：
 *   1. 记录已备份到 GitHub
 *   2. 删除并同步 —— 远端轨迹应被删、清单写墓碑
 *   3. 回收站里撤销删除 —— 本地不能再显示「已同步」，
 *      而且要重新进入待备份，下一次同步把轨迹传回去
 *
 * 用 fetch mock 模拟 GitHub Contents API，不打真实网络。
 */
import puppeteer from 'puppeteer-core';

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

const out = await page.evaluate(async () => {
  const repo = await import('/src/store/repo.ts');
  const { setSetting } = await import('/src/store/db.ts');
  const { syncNow } = await import('/src/backup/sync.ts');
  const { importFiles } = await import('/src/import/batch.ts');

  // ── 模拟 GitHub 仓库：path -> 文本 ───────────────────────────────
  const remote = new Map();
  let shaSeq = 0;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const b64encode = (text) => btoa(unescape(encodeURIComponent(text)));
  const b64decode = (text) => decodeURIComponent(escape(atob(text.replace(/\s+/g, ''))));

  window.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (/\/repos\/me\/fit$/.test(u)) {
      return json({ full_name: 'me/fit', size: 1, default_branch: 'main' });
    }
    const m = u.match(/\/contents\/([^?]+)/);
    if (!m) return json({ message: 'not found ' + u }, 404);
    const path = decodeURIComponent(m[1]);
    if (method === 'GET') {
      if (!remote.has(path)) return json({ message: 'Not Found' }, 404);
      return json({ content: b64encode(remote.get(path)), encoding: 'base64', sha: 'sha-' + path });
    }
    const body = JSON.parse(init.body || '{}');
    if (method === 'PUT') {
      remote.set(path, b64decode(body.content));
      shaSeq += 1;
      return json({ content: { sha: 'sha-' + shaSeq } });
    }
    if (method === 'DELETE') {
      remote.delete(path);
      return json({ content: null });
    }
    return json({ message: 'unsupported' }, 405);
  };

  await setSetting('backup.github', { token: 'tkn', owner: 'me', repo: 'fit', branch: 'main' });

  const gpx = (() => {
    const start = Date.parse('2026-07-01T02:00:00Z');
    const pts = [];
    for (let i = 0; i < 600; i += 1) {
      pts.push(`<trkpt lat="${(39.9 + i * 0.00009).toFixed(6)}" lon="${(116.4 + i * 0.00002).toFixed(6)}"><ele>${(50 + i * 0.1).toFixed(1)}</ele><time>${new Date(start + i * 1000).toISOString()}</time></trkpt>`);
    }
    return `<?xml version="1.0"?><gpx creator="Health" version="1.0" xmlns="http://www.topografix.com/GPX/1/0"><trk><type>户外骑行</type><extensions><totalTime>600</totalTime></extensions><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  })();

  const report = {};

  // 1) 导入并首次同步
  await importFiles([new File([gpx], '待删骑行.gpx')]);
  let meta = (await repo.allMeta())[0];
  await syncNow();
  meta = await repo.getRawMeta(meta.id);
  report.afterFirstSync = {
    backup: meta.backup,
    whereGithub: Boolean(meta.where?.github),
    remoteTrack: remote.has(`fitmotion/tracks/${meta.id}.fmt`),
    manifestLive: JSON.parse(remote.get('fitmotion/manifest.json')).activities.filter((a) => a.deleted <= 0).length,
  };

  // 2) 删除 + 同步：远端轨迹应删除，清单应留下墓碑
  await repo.removeActivity(meta.id);
  const delReport = await syncNow();
  meta = await repo.getRawMeta(meta.id);
  const manifestAfterDelete = JSON.parse(remote.get('fitmotion/manifest.json'));
  report.afterDeleteSync = {
    removed: delReport.removed,
    remoteTrack: remote.has(`fitmotion/tracks/${meta.id}.fmt`),
    tombstone: manifestAfterDelete.activities.find((a) => a.id === meta.id)?.deleted > 0,
    pendingLeft: (await repo.unsyncedMeta(['github'])).length,
  };

  // 3) 撤销删除：走真实 UI（设置 → 最近删除 → 恢复），顺便看记录页徽标是否立刻变「待备份」
  document.getElementById('set-open-trash').click();
  await new Promise((r) => setTimeout(r, 600));
  const restoreBtn = document.querySelector('#trash-overlay [data-restore]');
  if (!restoreBtn) throw new Error('回收站里没有恢复按钮');
  restoreBtn.click();
  await new Promise((r) => setTimeout(r, 800));
  meta = await repo.getRawMeta(meta.id);
  report.afterRestore = {
    backup: meta.backup,
    whereEmpty: Object.keys(meta.where ?? {}).length === 0,
    deleted: meta.deleted,
    pending: (await repo.unsyncedMeta(['github'])).length,
    badge: document.querySelector('.rec .state')?.textContent.trim() ?? '',
  };

  // 4) 再同步：轨迹应重新上传，状态回到已备份
  const reReport = await syncNow();
  meta = await repo.getRawMeta(meta.id);
  const manifestAfterRestore = JSON.parse(remote.get('fitmotion/manifest.json'));
  report.afterReSync = {
    pushed: reReport.pushed,
    backup: meta.backup,
    remoteTrack: remote.has(`fitmotion/tracks/${meta.id}.fmt`),
    manifestLive: manifestAfterRestore.activities.filter((a) => a.deleted <= 0).length,
  };

  window.fetch = window.fetch;
  return report;
});

console.log(JSON.stringify(out, null, 2));
// 记录页徽标：恢复后重新加载页面，确认卡片显示「已备份」而不是假的同步状态
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('.rec', { timeout: 8000 });
const badgeText = await page.$eval('.rec .state', (n) => n.textContent.trim());

console.log(JSON.stringify({ ...out, badgeText, errors: errors.slice(0, 3) }, null, 2));
const checks = [
  out.afterFirstSync.backup === 1 && out.afterFirstSync.remoteTrack,
  out.afterDeleteSync.remoteTrack === false && out.afterDeleteSync.tombstone === true,
  out.afterDeleteSync.pendingLeft === 0,
  out.afterRestore.backup === 0 && out.afterRestore.whereEmpty && out.afterRestore.pending === 1,
  out.afterReSync.backup === 1 && out.afterReSync.remoteTrack && out.afterReSync.manifestLive === 1,
  /已备份|双端/.test(badgeText),
  errors.length === 0,
];
console.log(checks.every(Boolean) ? 'ALL PASS' : `FAIL at ${checks.map((v, i) => (v ? '' : i)).filter(Boolean).join(',')}`);
await browser.close();
