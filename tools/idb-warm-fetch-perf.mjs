/**
 * 测「页面冷加载 + IDB 已热」进创作页的抓取阶段耗时（App 第二次开 App 进页的真实场景）：
 * 首次进页把瓦片灌进 IndexedDB → 整页 reload（模块级内存缓存全丢）→ 再进创作页，读打点。
 *
 * 用法：node tools/idb-warm-fetch-perf.mjs [port]
 */
import puppeteer from 'puppeteer-core';

const port = process.argv[2] ?? '5178';
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

async function gotoApp() {
  await page.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(600);
}

async function importRide(name) {
  return page.evaluate(async (fileName) => {
    const { importFiles } = await import('/src/import/batch.ts');
    const start = Date.parse('2026-09-01T02:00:00Z');
    const pts = [];
    for (let i = 0; i < 900; i += 1) {
      const lat = 39.9 + i * 0.0009;
      const lon = 116.4 + Math.sin(i / 120) * 0.02;
      pts.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${(50 + (i % 60)).toFixed(1)}</ele>`
        + `<time>${new Date(start + i * 12000).toISOString()}</time></trkpt>`);
    }
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="probe" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${fileName}</name><type>户外骑行</type><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
    return importFiles([new File([gpx], `${fileName}.gpx`)]);
  }, name);
}

async function enterStudio() {
  await page.evaluate(() => {
    window.__fitReady = false;
    document.querySelector('#records-pane .rec')?.click();
  });
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__fitReady === true)) return true;
    await sleep(250);
  }
  return false;
}

async function marks() {
  const list = await page.evaluate(() => performance.getEntriesByType('mark')
    .filter((m) => m.name.startsWith('fm:cache:') || m.name.startsWith('fm:raster:'))
    .map((m) => ({ name: m.name.replace('fm:cache:', '').replace('fm:raster:', 'raster/'), at: Math.round(m.startTime) })));
  const start = list.find((m) => m.name === 'start');
  return list.map((m) => ({ name: m.name, ms: start ? m.at - start.at : m.at }));
}

await gotoApp();
await importRide('idb-probe');
await sleep(800);
// 第一次：网络灌 IDB
await enterStudio();
console.log('first (network):', JSON.stringify((await marks()).filter((m) => m.name === 'tiles-fetched')));
await page.evaluate(() => document.getElementById('back-btn')?.click());
await sleep(1500);

const rounds = [];
for (let i = 0; i < 3; i += 1) {
  // 整页重载：模块内存缓存清空，只剩 IndexedDB
  await gotoApp();
  if (i === 0) await sleep(800); // 首次进入让记录页渲染
  const ok = await enterStudio();
  const list = await marks();
  rounds.push({ ok, tiles: list.find((m) => m.name === 'tiles-fetched')?.ms ?? null, marks: list });
  await page.evaluate(() => document.getElementById('back-btn')?.click());
  await sleep(1200);
}
const vals = rounds.map((r) => r.tiles).filter((v) => typeof v === 'number');
console.log(JSON.stringify(rounds.map((r) => ({ ok: r.ok, tilesFetched: r.tiles }))));
console.log(vals.length
  ? `page-cold + IDB-warm tiles-fetched: min=${Math.min(...vals)}ms avg=${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}ms`
  : 'no data');
for (const i of [0,1,2]) if (rounds[i]?.marks) console.log('detail(round'+(i+1)+'):', JSON.stringify(rounds[i].marks));
await browser.close();
