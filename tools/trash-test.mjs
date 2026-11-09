/**
 * 记录删除回归：卡片菜单 → 确认 → 列表移除 → 撤销恢复 → 回收站 → 清空 → 过期清理。
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
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('PAGEERROR', e.message);
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const makeGpx = (startIso, seconds, offsetLat) => {
  const start = Date.parse(startIso);
  const pts = [];
  for (let i = 0; i < seconds; i += 1) {
    const lat = (39.9 + offsetLat + i * 0.00009).toFixed(6);
    const lon = (116.4 + i * 0.00002).toFixed(6);
    const t = new Date(start + i * 1000).toISOString();
    pts.push(`<trkpt lat="${lat}" lon="${lon}"><ele>${(50 + i * 0.1).toFixed(1)}</ele><time>${t}</time></trkpt>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><gpx creator="Health" version="1.0" xmlns="http://www.topografix.com/GPX/1/0"><trk><type>户外骑行</type><extensions><totalTime>${seconds}</totalTime></extensions><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
};

await page.evaluate(async (gpxA, gpxB) => {
  const { importFiles } = await import('/src/import/batch.ts');
  await importFiles([
    new File([gpxA], 'trash-a.gpx', { type: 'application/gpx+xml' }),
    new File([gpxB], 'trash-b.gpx', { type: 'application/gpx+xml' }),
  ]);
}, makeGpx('2026-06-01T01:00:00.000Z', 300, 0), makeGpx('2026-06-02T01:00:00.000Z', 300, 0.05));

await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('.rec');

const waitNoDialog = () => page.waitForFunction(() => !document.querySelector('.fm-dialog'), { timeout: 4000 });
const cards = () => page.$$eval('.rec', (nodes) => nodes.length);

/** 走一遍「⋯ → 删除记录 → 确认」。 */
const deleteFirstCard = async () => {
  await waitNoDialog();
  await page.evaluate(() => document.querySelector('.rec .rec-more').click());
  await page.waitForSelector('.fm-action-sheet', { visible: true });
  await page.evaluate(() => {
    const sheets = [...document.querySelectorAll('.fm-action-sheet')];
    const sheet = sheets[sheets.length - 1];
    [...sheet.querySelectorAll('.fm-action')].find((n) => n.textContent.includes('删除记录')).click();
  });
  await page.waitForSelector('.fm-alert.danger', { visible: true });
  await page.evaluate(() => {
    const alerts = [...document.querySelectorAll('.fm-alert.danger')];
    alerts[alerts.length - 1].querySelector('[data-act="ok"]').click();
  });
  await waitNoDialog();
};

const store = () => page.evaluate(async () => {
  const repo = await import('/src/store/repo.ts');
  const rows = await repo.listDeleted();
  return {
    deleted: await repo.deletedCount(),
    stats: (await repo.libraryStats()).count,
    trash: rows.map((row) => ({ id: row.id, name: row.name, kept: null })),
    trackKept: rows.length ? await repo.hasTrack(rows[0].id) : null,
  };
});

const result = {};
result.cardsBefore = await cards();
result.hasMoreButton = await page.$$eval('.rec .rec-more', (nodes) => nodes.length);

// 菜单内容
await page.evaluate(() => document.querySelector('.rec .rec-more').click());
await page.waitForSelector('.fm-action-sheet', { visible: true });
result.menuItems = await page.$$eval('.fm-action-sheet .fm-action .fm-action-label', (nodes) => nodes.map((n) => n.textContent));
await page.evaluate(() => {
  const sheets = [...document.querySelectorAll('.fm-action-sheet')];
  [...sheets[sheets.length - 1].querySelectorAll('.fm-action')].find((n) => n.textContent.includes('删除记录')).click();
});
await page.waitForSelector('.fm-alert.danger', { visible: true });
result.confirmTitle = await page.$eval('.fm-alert.danger h3', (n) => n.textContent);
result.confirmBody = await page.$eval('.fm-alert.danger p', (n) => n.textContent.replace(/\s+/g, ' ').trim());
await page.evaluate(() => {
  const alerts = [...document.querySelectorAll('.fm-alert.danger')];
  alerts[alerts.length - 1].querySelector('[data-act="ok"]').click();
});
await page.waitForFunction(() => document.querySelectorAll('.rec').length === 1, { timeout: 4000 });
result.cardsAfterDelete = await cards();
result.toast = await page.evaluate(() => ({
  text: document.getElementById('toast-text').textContent,
  act: document.getElementById('toast-act').textContent,
  visible: !document.getElementById('toast-act').hidden,
}));
result.storeAfterDelete = await store();

// 撤销
await page.evaluate(() => document.getElementById('toast-act').click());
await page.waitForFunction(() => document.querySelectorAll('.rec').length === 2, { timeout: 6000 });
result.cardsAfterUndo = await cards();
result.deletedAfterUndo = (await store()).deleted;

// 再删一条 → 回收站
await deleteFirstCard();
await page.waitForFunction(() => document.querySelectorAll('.rec').length === 1, { timeout: 4000 });
await page.evaluate(() => document.getElementById('set-open-trash').click());
await page.waitForSelector('#trash-overlay:not([hidden])', { timeout: 3000 });
result.trashRows = await page.$$eval('.trash-row', (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
result.trashHint = await page.$eval('#trash-hint', (n) => n.textContent);

// 恢复
await page.click('.trash-row .trash-restore');
await page.waitForFunction(() => document.querySelectorAll('.trash-row').length === 0, { timeout: 4000 });
result.afterRestore = {
  hint: await page.$eval('#trash-hint', (n) => n.textContent),
  cards: await cards(),
};

// 再删一次并清空
await page.click('#trash-done');
await deleteFirstCard();
await page.waitForFunction(() => document.querySelectorAll('.rec').length === 1, { timeout: 4000 });
await page.evaluate(() => document.getElementById('set-open-trash').click());
await page.waitForSelector('#trash-overlay:not([hidden])', { timeout: 3000 });
await page.click('#trash-clear');
await page.waitForSelector('.fm-alert.danger', { visible: true });
await page.evaluate(() => {
  const alerts = [...document.querySelectorAll('.fm-alert.danger')];
  alerts[alerts.length - 1].querySelector('[data-act="ok"]').click();
});
await waitNoDialog();
await page.waitForFunction(() => document.querySelectorAll('.trash-row').length === 0, { timeout: 5000 });
result.afterPurge = {
  rows: await page.$$eval('.trash-row', (nodes) => nodes.length),
  ...(await store()),
};

// 过期清理：把墓碑时间改成 40 天前
result.expired = await page.evaluate(async () => {
  const repo = await import('/src/store/repo.ts');
  const page1 = await repo.listPage({ limit: 1 });
  const id = page1.items[0].id;
  await repo.removeActivity(id);
  const row = await repo.getRawMeta(id);
  row.deleted = Date.now() - 40 * 86_400_000;
  await repo.putMeta(row);
  const cleaned = await repo.purgeExpiredTrash(30);
  return {
    cleaned,
    tombstones: (await repo.listDeleted()).length,
    trackGone: !(await repo.hasTrack(id)),
  };
});

console.log(JSON.stringify(result, null, 2));
console.log('errors', errors.slice(0, 5));
await browser.close();
