/**
 * 记录页回归：
 * 1) 查询条件吸顶（滚动后 #records-sticky 仍贴在滚动容器顶部）
 * 2) 全选 = 当前筛选下全部记录（25 条，列表只加载了 20 条）
 * 3) 批量删除确实删掉 25 条，撤销能全部恢复
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('ERR', m.text().slice(0, 160)); });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

// 造 25 条合成记录
const seeded = await page.evaluate(async () => {
  const { tx } = await import('/src/store/db.ts');
  const { STORE } = await import('/src/store/db.ts');
  const base = Date.UTC(2025, 5, 1, 7, 0, 0);
  await tx(STORE.activities, 'readwrite', (t) => {
    const store = t.objectStore(STORE.activities);
    for (let i = 0; i < 25; i += 1) {
      const start = base + i * 86400000 * 3;
      store.put({
        id: `seed-${i}`,
        name: `测试骑行 ${i}`,
        src: 'fit',
        fileName: `seed-${i}.fit`,
        start,
        duration: 3600 + i * 60,
        distance: 20000 + i * 500,
        avgSpeed: 6.2,
        maxSpeed: 9.5,
        sport: 2,
        avgHr: 141,
        maxHr: 176,
        climb: 120,
        maxAlt: 380,
        calories: 700,
        points: 4000,
        thumb: 'M8 12c4-2 5-8 9-8s6 6 9 4',
        fileHash: `hash-${i}`,
        fp: { start, distance: 20000 + i * 500, duration: 3600 + i * 60, points: 4000 },
        backup: 0,
        added: start,
        updated: start,
        size: 1024,
        deleted: 0,
        where: {},
        home: {},
      });
    }
  });
  return true;
});
console.log('seeded', seeded);

await page.reload({ waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 2500));

const initial = await page.evaluate(() => ({
  sum: document.getElementById('records-sum')?.textContent,
  cards: document.querySelectorAll('.rec').length,
  more: document.getElementById('load-more')?.textContent,
}));
console.log('list:', JSON.stringify(initial));

// 1) 吸顶：滚动后 sticky 仍在顶部
await page.evaluate(() => { document.getElementById('records-pane').scrollTop = 600; });
await new Promise((r) => setTimeout(r, 400));
const sticky = await page.evaluate(() => {
  const pane = document.getElementById('records-pane');
  const bar = document.getElementById('records-sticky');
  return {
    paneTop: Math.round(pane.getBoundingClientRect().top),
    barTop: Math.round(bar.getBoundingClientRect().top),
    stuck: bar.classList.contains('stuck'),
    scrolled: pane.scrollTop,
  };
});
console.log('sticky:', JSON.stringify(sticky));
await page.screenshot({ path: 'screenshots/tmp-shot/records-sticky.png' });

// 2) 长按第一张进入多选（先回到顶部，否则卡片在吸顶条后面）
await page.evaluate(() => { document.getElementById('records-pane').scrollTop = 0; });
await new Promise((r) => setTimeout(r, 300));
const box = await page.evaluate(() => {
  const el = document.querySelector('.rec');
  const r = el.getBoundingClientRect();
  return { x: r.x + 40, y: r.y + 20 };
});
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 650));
await page.mouse.up();
await new Promise((r) => setTimeout(r, 400));
const afterLongPress = await page.evaluate(() => ({
  barHidden: document.getElementById('batch-bar').hidden,
  count: document.getElementById('batch-count').textContent,
  allLabel: document.getElementById('batch-all').textContent,
}));
console.log('longpress:', JSON.stringify(afterLongPress));

// 3) 全选（应覆盖未加载的 5 条）
await page.evaluate(() => document.getElementById('batch-all').click());
await new Promise((r) => setTimeout(r, 600));
const afterAll = await page.evaluate(() => ({
  count: document.getElementById('batch-count').textContent,
  allLabel: document.getElementById('batch-all').textContent,
  cards: document.querySelectorAll('.rec').length,
  selected: document.querySelectorAll('.rec.sel').length,
}));
console.log('selectAll:', JSON.stringify(afterAll));
await page.screenshot({ path: 'screenshots/tmp-shot/records-select-all.png' });

// 4) 删除 → 确认
await page.evaluate(() => document.getElementById('batch-delete').click());
await new Promise((r) => setTimeout(r, 500));
const confirmText = await page.evaluate(() => ({
  title: document.querySelector('.fm-alert h3')?.textContent,
  body: document.querySelector('.fm-alert p')?.textContent,
}));
console.log('confirm:', JSON.stringify(confirmText));
await page.evaluate(() => document.querySelector('.fm-alert [data-act="ok"]').click());
await new Promise((r) => setTimeout(r, 1800));
const afterDelete = await page.evaluate(() => ({
  sum: document.getElementById('records-sum')?.textContent,
  cards: document.querySelectorAll('.rec').length,
  emptyHidden: document.getElementById('records-empty').hidden,
  toast: document.getElementById('toast-text')?.textContent,
}));
console.log('afterDelete:', JSON.stringify(afterDelete));

// 5) 撤销
await page.evaluate(() => document.getElementById('toast-act')?.click());
await new Promise((r) => setTimeout(r, 2000));
const afterUndo = await page.evaluate(() => ({
  sum: document.getElementById('records-sum')?.textContent,
  cards: document.querySelectorAll('.rec').length,
}));
console.log('afterUndo:', JSON.stringify(afterUndo));

// 4b) 筛选切换应退出多选
await page.evaluate(() => {
  document.querySelector('.rec')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 220 }));
});
await new Promise((r) => setTimeout(r, 700));
await page.evaluate(() => document.querySelector('.rec')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
await new Promise((r) => setTimeout(r, 300));
const beforeFilter = await page.evaluate(() => ({
  hidden: document.getElementById('batch-bar').hidden,
  count: document.getElementById('batch-count').textContent,
}));
await page.evaluate(() => document.querySelector('[data-cat-year]')?.click());
await new Promise((r) => setTimeout(r, 900));
const afterFilter = await page.evaluate(() => ({
  hidden: document.getElementById('batch-bar').hidden,
  count: document.getElementById('batch-count').textContent,
}));
console.log('filterDropsSelection:', JSON.stringify({ beforeFilter, afterFilter }));


// 清掉合成数据
await page.evaluate(async () => {
  const { tx, STORE } = await import('/src/store/db.ts');
  await tx(STORE.activities, 'readwrite', (t) => {
    const store = t.objectStore(STORE.activities);
    for (let i = 0; i < 25; i += 1) store.delete(`seed-${i}`);
  });
});
await browser.close();
fs.rmSync('screenshots/tmp-shot/records-sticky.png', { force: true });
