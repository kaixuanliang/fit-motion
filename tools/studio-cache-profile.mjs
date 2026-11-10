/**
 * 创作页准备阶段的 CPU 采样：用 CDP Profiler 抓「正在生成地图画面」
 * 期间的热点函数，避免靠猜优化。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => { setTimeout(r, 400); });

await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const start = Date.parse('2026-08-01T02:00:00Z');
  const pts = [];
  for (let i = 0; i < 1200; i += 1) {
    pts.push(`<trkpt lat="${(39.9 + i * 0.0009).toFixed(7)}" lon="${(116.4 + Math.sin(i / 120) * 0.02).toFixed(7)}">`
      + `<ele>${(50 + (i % 60)).toFixed(1)}</ele><time>${new Date(start + i * 15000).toISOString()}</time></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="prof" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await importFiles([new File([gpx], 'prof-ride.gpx')]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
});
await new Promise((r) => { setTimeout(r, 1000); });

const enter = async () => {
  await page.evaluate(() => {
    window.__fitReady = false;
    document.querySelector('#records-pane .rec')?.click();
  });
  for (let i = 0; i < 720; i += 1) {
    if (await page.evaluate(() => window.__fitReady === true)) return true;
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return false;
};

// 第一次进：把瓦片写进 IndexedDB
const first = await enter();
await page.evaluate(() => document.getElementById('back-btn')?.click());
await new Promise((r) => { setTimeout(r, 1200); });

// 第二次进：从点开记录开始采样
const client = await page.createCDPSession();
await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 200 });
await client.send('Profiler.start');
const second = await enter();
await new Promise((r) => { setTimeout(r, 300); });
const { profile } = await client.send('Profiler.stop');

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
for (const id of profile.samples ?? []) {
  const node = nodes.get(id);
  if (!node) continue;
  const f = node.callFrame;
  const key = `${f.functionName || '(anonymous)'} @ ${(f.url || '').split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + 1);
}
const total = (profile.samples ?? []).length;
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  .map(([name, count]) => ({ name, pct: Number(((count / total) * 100).toFixed(1)) }));

await browser.close();
console.log(JSON.stringify({ first, second, samples: total, top }, null, 2));
