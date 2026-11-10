/**
 * 记录页年份条横向滑动回归：
 * 1) 年份条宽度应受限于剩余空间（clientWidth < scrollWidth 才有得滚）；
 * 2) 能真正滚动（设置 scrollLeft 后生效），最右侧年份可见；
 * 3) 滚动后点年份筛选，重绘不跳回最左。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

// 造 2026 / 2025 两年数据
await page.evaluate(async () => {
  const { tx, STORE } = await import('/src/store/db.ts');
  const seeds = [
    [Date.UTC(2026, 7, 12, 7, 0, 0), 'fit'],
    [Date.UTC(2026, 4, 3, 7, 0, 0), 'fit'],
    [Date.UTC(2026, 1, 8, 7, 0, 0), 'gpx'],
    [Date.UTC(2025, 10, 21, 7, 0, 0), 'gpx'],
    [Date.UTC(2025, 5, 9, 7, 0, 0), 'fit'],
    [Date.UTC(2025, 1, 2, 7, 0, 0), 'gpx'],
  ];
  await tx(STORE.activities, 'readwrite', (t) => {
    const store = t.objectStore(STORE.activities);
    seeds.forEach(([start, src], i) => {
      store.put({
        id: `year-${i}`,
        name: `年份样本 ${i}`,
        src,
        fileName: `year-${i}.fit`,
        start,
        duration: 3600,
        distance: 21000,
        avgSpeed: 5.8,
        maxSpeed: 9.1,
        sport: 2,
        avgHr: 140,
        maxHr: 172,
        climb: 90,
        maxAlt: 320,
        calories: 680,
        points: 3600,
        thumb: 'M8 12c4-2 5-8 9-8s6 6 9 4',
        fileHash: `year-hash-${i}`,
        fp: { start, distance: 21000, duration: 3600, points: 3600 },
        backup: 0,
        added: start,
        updated: start,
        size: 1024,
        deleted: 0,
        where: {},
        home: {},
      });
    });
  });
});

// 数据落库后刷新页面，让记录页按真实启动路径渲染（统计条与年份 chips 由启动流程刷新）
await page.reload({ waitUntil: 'networkidle2' });
await new Promise((resolve) => { setTimeout(resolve, 1200); });

const measure = () => page.evaluate(() => {
  const years = document.getElementById('cat-years');
  const bar = document.getElementById('cat-bar');
  const chips = Array.from(years?.querySelectorAll('[data-cat-year]') ?? []);
  const bounds = chips.map((chip) => {
    const r = chip.getBoundingClientRect();
    return { text: chip.textContent?.trim(), left: Math.round(r.left), right: Math.round(r.right) };
  });
  return {
    barWidth: bar?.clientWidth ?? 0,
    clientWidth: years?.clientWidth ?? 0,
    scrollWidth: years?.scrollWidth ?? 0,
    scrollLeft: years?.scrollLeft ?? 0,
    viewport: window.innerWidth,
    chips: bounds,
    // 相邻年份在滚动 0 位置是否被裁掉（右边界超出屏幕）
    clipped: bounds.filter((b) => b.right > window.innerWidth + 1).map((b) => b.text),
  };
});

const before = await measure();

await page.evaluate(() => {
  const years = document.getElementById('cat-years');
  if (years) years.scrollLeft = years.scrollWidth;
});
await new Promise((resolve) => { setTimeout(resolve, 300); });
const after = await measure();

// 点最右侧年份，验证重绘后位置保留
const clickResult = await page.evaluate(async () => {
  const years = document.getElementById('cat-years');
  const chips = Array.from(years?.querySelectorAll('[data-cat-year]') ?? []);
  const last = chips[chips.length - 1];
  last?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  return {
    lastYearText: last?.textContent?.trim(),
    scrollLeftAfterRender: document.getElementById('cat-years')?.scrollLeft ?? 0,
    activeYear: document.querySelector('[data-cat-year].on')?.textContent?.trim() ?? null,
  };
});

// 造多出来的年份，验证「右侧还有内容」的渐隐提示
const fade = await page.evaluate(async () => {
  const years = document.getElementById('cat-years');
  const bar = document.getElementById('cat-bar');
  for (let y = 2024; y >= 2018; y -= 1) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.dataset.catYear = String(y);
    chip.textContent = `${y} 2`;
    years.appendChild(chip);
  }
  years.dispatchEvent(new Event('scroll'));
  const overflow = years.scrollWidth > years.clientWidth;
  const hintOn = bar.classList.contains('has-more');
  years.scrollLeft = years.scrollWidth;
  years.dispatchEvent(new Event('scroll'));
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  return { overflow, hintOn, hintOffAtEnd: !bar.classList.contains('has-more') };
});

await page.screenshot({ path: 'tools/downloads/records-years.png' });
await browser.close();

console.log(JSON.stringify({
  before,
  after,
  clickResult,
  fade,
  canScroll: after.scrollLeft > 0,
  errors,
}, null, 2));
