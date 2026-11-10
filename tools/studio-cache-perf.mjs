/**
 * 创作页「准备地图」各阶段耗时测量。
 *
 * 用一条 120km 的合成长路线（贴近长途骑行场景，总览瓦片上百张），
 * 第一次进入把瓦片写进 IndexedDB，返回后再进入，读 performance.mark
 * 得到纯 CPU/预热阶段的分段耗时（不含网络下载）。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => { setTimeout(r, 400); });

// 造 120km 路线：每 100m 一个点
const imported = await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const start = Date.parse('2026-08-01T02:00:00Z');
  const pts = [];
  const total = 1200;
  for (let i = 0; i < total; i += 1) {
    const lat = 39.9 + i * 0.0009;
    const lon = 116.4 + Math.sin(i / 120) * 0.02;
    const hr = 120 + (i % 45);
    pts.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${(50 + (i % 60)).toFixed(1)}</ele>`
      + `<time>${new Date(start + i * 15000).toISOString()}</time>`
      + `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="perf" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2"><trk><name>长途样本</name><type>户外骑行</type><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await importFiles([new File([gpx], 'long-ride.gpx')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  return true;
});

const waitReady = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => window.__fitReady === true);
    if (done) return true;
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return false;
};

const enterStudio = async () => {
  await page.evaluate(() => {
    window.__fitReady = false;
    document.querySelector('#records-pane .rec')?.click();
  });
  return waitReady(180000);
};

await new Promise((r) => { setTimeout(r, 1000); });

const diag = await page.evaluate(async () => {
  const { allMeta } = await import('/src/store/repo.ts');
  const metas = await allMeta();
  return {
    count: metas.length,
    first: metas[0]?.name ?? null,
    recs: document.querySelectorAll('#records-pane .rec').length,
    loading: document.getElementById('stage-loading')?.textContent?.trim() ?? null,
  };
});

// 第一次：下载并缓存瓦片
const firstReady = await enterStudio();
const firstMarks = await page.evaluate(() => performance.getEntriesByType('mark')
  .filter((m) => m.name.startsWith('fm:cache:'))
  .map((m) => ({ name: m.name.replace('fm:cache:', ''), at: Math.round(m.startTime), detail: m.detail ?? null })));

// 返回记录页
await page.evaluate(() => document.getElementById('back-btn')?.click());
await new Promise((r) => { setTimeout(r, 1200); });
await page.evaluate(() => performance.clearMarks());

// 之后多轮「进入→返回」，热缓存 + 同进程内存缓存，取每阶段最小值排除环境噪声
const rounds = [];
for (let round = 0; round < 3; round += 1) {
  await page.evaluate(() => performance.clearMarks());
  const ok = await enterStudio();
  const marks = await page.evaluate(() => performance.getEntriesByType('mark')
    .filter((m) => m.name.startsWith('fm:cache:'))
    .map((m) => ({ name: m.name.replace('fm:cache:', ''), at: Math.round(m.startTime), detail: m.detail ?? null })));
  rounds.push({ ok, marks });
  if (round < 2) {
    await page.evaluate(() => document.getElementById('back-btn')?.click());
    await new Promise((r) => { setTimeout(r, 1200); });
  }
}
const secondReady = rounds.every((r) => r.ok);
const best = {};
for (const { marks } of rounds) {
  for (let i = 1; i < marks.length; i += 1) {
    const step = `${marks[i - 1].name} → ${marks[i].name}`;
    const ms = marks[i].at - marks[i - 1].at;
    if (!(step in best) || ms < best[step]) best[step] = ms;
  }
}
const marks = rounds[rounds.length - 1].marks;

const stages = Object.entries(best).map(([step, ms]) => ({ step, ms }));
const total = marks.length > 1 ? Math.round(marks[marks.length - 1].at - marks[0].at) : null;

await browser.close();
console.log(JSON.stringify({
  imported, diag, firstReady, secondReady, errors,
  coldMarks: firstMarks,
  warmStages: stages,
  warmTotalMs: total,
  warmMarks: marks,
}, null, 2));
