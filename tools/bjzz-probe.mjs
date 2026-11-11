/**
 * 长路线（北京→郑州 673km）地图加载诊断：
 * 1) 栅格底图 / 矢量总览各自抓多少瓦片、耗时多少；
 * 2) 总览缺了哪些瓦片（路线图上的空白竖带）；
 * 3) 创作页实际进页缓存总耗时 + 截图确认缺块位置。
 *
 * 用法：node tools/bjzz-probe.mjs [fit路径] [主题]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const fitPath = process.argv[2] ?? 'testdata/beijing-zhengzhou-3day.fit';
const theme = process.argv[3] ?? 'bright';
const outDir = path.join(process.cwd(), 'tools', 'downloads');
fs.mkdirSync(outDir, { recursive: true });

const buf = fs.readFileSync(path.resolve(fitPath));
const b64 = buf.toString('base64');
const name = path.basename(fitPath);

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument((t) => {
  localStorage.setItem('fitmotion-theme', t);
}, theme);
const net = { tileRequests: 0, tileFail: 0 };
page.on('response', (res) => {
  const url = res.url();
  if (/\.pbf|\/planet\/|tile/i.test(url) && /http/.test(url)) {
    net.tileRequests += 1;
    if (res.status() >= 400) net.tileFail += 1;
  }
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
await new Promise((r) => { setTimeout(r, 600); });

// ── 1) 独立诊断：手动建图层，分开计时 ──
const diag = await page.evaluate(async (data, fileName) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const { parseFit } = await import('/src/fit/parser.ts');
  const { buildActivity } = await import('/src/fit/activity.ts');
  const { THEMES } = await import('/src/render/theme.ts');
  const { TrackMap } = await import('/src/render/map.ts');
  const { OverviewVectorLayer } = await import('/src/render/vector-map.ts');

  const activity = buildActivity(parseFit(bytes.buffer), fileName);
  const theme = THEMES.bright;
  const out = { points: activity.points.length, distanceKm: +(activity.distanceM / 1000).toFixed(1) };

  const t0 = performance.now();
  const map = new TrackMap(activity, theme);
  out.mapZoom = map.zoom;
  const t1 = performance.now();
  let rasterProgress = 0;
  await map.loadTiles((p) => { rasterProgress = p; });
  const t2 = performance.now();
  out.raster = {
    ms: Math.round(t2 - t1),
    ctorMs: Math.round(t1 - t0),
    usingTiles: map.usingTiles,
    progress: +rasterProgress.toFixed(3),
    zoom: map.zoom,
  };

  const overview = new OverviewVectorLayer(theme, map);
  const t3 = performance.now();
  await overview.prefetch();
  const t4 = performance.now();
  out.overview = {
    ms: Math.round(t4 - t3),
    zoom: overview.zoom,
    ...overview.prefetchStats,
    tileCount: overview.tileCount,
    missingKeys: overview.missingKeys,
    prefetch: overview.lastPrefetch,
  };
  // 可视区实际需要的瓦片数（1080×1920 屏幕在当前相机下的覆盖）
  if (overview.lastPrefetch) {
    const { camera, tileBase } = overview.lastPrefetch;
    const tileScreenPx = tileBase * camera.scale;
    out.visibleTiles = {
      tileScreenPx: Math.round(tileScreenPx),
      cols: Math.ceil(1080 / tileScreenPx) + 1,
      rows: Math.ceil(1920 / tileScreenPx) + 1,
      need: (Math.ceil(1080 / tileScreenPx) + 1) * (Math.ceil(1920 / tileScreenPx) + 1),
    };
  }

  // 全局视角实际要等的是两者之和（main.ts 里并行，但都要等完）
  out.totalWaitMs = Math.round(t4 - t0);
  return out;
}, b64, name);
console.log('独立诊断:', JSON.stringify(diag, null, 2));
console.log('网络请求: pbf/瓦片请求数', net.tileRequests, '失败', net.tileFail);

// ── 2) 走真实 UI：导入 → 进创作页 → 截图 + performance marks ──
await page.evaluate(async (data, fileName) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const { importFiles } = await import('/src/import/batch.ts');
  await importFiles([new File([bytes], fileName)]);
  window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
  await new Promise((r) => { setTimeout(r, 500); });
  document.querySelector('#records-pane .rec')?.click();
}, b64, name);

let ready = false;
for (let i = 0; i < 900; i += 1) {
  ready = await page.evaluate(() => window.__fitReady === true);
  if (ready) break;
  await new Promise((r) => { setTimeout(r, 250); });
}
await new Promise((r) => { setTimeout(r, 800); });

const marks = await page.evaluate(() => {
  const rows = performance.getEntriesByType('mark')
    .filter((m) => m.name.startsWith('fm:cache:'))
    .map((m) => ({ name: m.name.replace('fm:cache:', ''), t: Math.round(m.startTime) }));
  const first = rows[0]?.t ?? 0;
  return rows.map((r) => ({ ...r, dt: r.t - first }));
});
console.log('创作页缓存时间线:', JSON.stringify(marks, null, 2));

const handle = await page.$('#stage-canvas');
if (handle) await handle.screenshot({ path: path.join(outDir, 'bjzz-global.png') });
await page.evaluate(() => { window.__fitStage?.renderAt(6); });
await new Promise((r) => { setTimeout(r, 400); });
if (handle) await handle.screenshot({ path: path.join(outDir, 'bjzz-global-run.png') });

await browser.close();
console.log('截图: tools/downloads/bjzz-global.png / bjzz-global-run.png');
