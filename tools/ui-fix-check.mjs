/**
 * 五项 UI 修复验证：
 * 1) 导入弹窗居中 + 成功后自动关闭
 * 2) 缓存提示不换行
 * 3) 切换记录后：分段数据折叠、滚动归零、预览吸顶
 * 4) GPX/TCX 按钮位于静帧预览下方
 * 5) 备份页不再有重复的重新绑定入口
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });
const { SAMPLE_FIT_BASE64, SAMPLE_NAME } = JSON.parse(JSON.stringify(await (await import('node:fs/promises')).readFile('src/data/sample.ts', 'utf8').then(() => ({})))) || {};
// 从源码里取 FIT 样例（在页面上下文中 import 更可靠）
const fit64 = await page.evaluate(async () => (await import('/src/data/sample.ts')).SAMPLE_FIT_BASE64);
const fitName = await page.evaluate(async () => (await import('/src/data/sample.ts')).SAMPLE_NAME);
await new Promise((r) => setTimeout(r, 700));

// 造一个合成 GPX（与 FIT 不同指纹 → 第二条记录）
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test"><trk><name>晨跑测试</name><trkseg>
${Array.from({ length: 420 }, (_, i) => {
  const t = new Date(Date.UTC(2026, 9, 30, 1, 0, 0) + i * 5000).toISOString();
  const lat = (39.9042 + i * 0.00012).toFixed(6);
  const lon = (116.4074 + Math.sin(i / 18) * 0.00035).toFixed(6);
  return `<trkpt lat="${lat}" lon="${lon}"><ele>${40 + Math.round(Math.sin(i / 30) * 8)}</ele><time>${t}</time></trkpt>`;
}).join('\n')}
</trkseg></trk></gpx>`;

await page.evaluate(async ({ gpx, fitB64, fitName }) => {
  const bin = atob(fitB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([gpx], 'morning-run.gpx', { type: 'application/gpx+xml' }));
  dt.items.add(new File([bytes], fitName));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, { gpx: GPX, fitB64: fit64, fitName: fitName });

// 1) 导入弹窗：居中 + 自动关闭
await new Promise((r) => setTimeout(r, 700));
const modalBox = await page.evaluate(() => {
  const el = document.querySelector('.import-modal');
  const r = el?.getBoundingClientRect();
  return r ? { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), vw: innerWidth, vh: innerHeight, hidden: document.getElementById('import-overlay').hidden } : null;
});
await page.screenshot({ path: 'screenshots/app/43-import-new.png' });
const autoState = await page.evaluate(() => ({
  autoVisible: !document.getElementById('import-auto')?.hidden,
  autoText: document.getElementById('import-auto')?.textContent ?? '',
}));
for (let i = 0; i < 12; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const hidden = await page.evaluate(() => document.getElementById('import-overlay')?.hidden === true);
  if (hidden) break;
}
const autoClosed = await page.evaluate(() => document.getElementById('import-overlay')?.hidden === true);
console.log(JSON.stringify({ modalBox, autoState, autoClosed }));

// 2/3) 创作页：缓存提示、吸顶、分段数据
await page.evaluate(() => document.querySelector('#records-pane .rec')?.click());
for (let i = 0; i < 480; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  if (await page.evaluate(() => window.__fitReady === true)) break;
}
await page.evaluate(() => {
  document.querySelector('#studio .split-panel').open = true;
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: 'screenshots/app/44-segments-open.png' });
// 滚到最底再回看预览位置
const sticky = await page.evaluate(() => {
  const studio = document.getElementById('studio');
  studio.scrollTop = 400;
  const info = { scrollHeight: studio.scrollHeight, clientHeight: studio.clientHeight };
  return new Promise((resolve) => setTimeout(() => {
    const stage = document.getElementById('stage-frame').getBoundingClientRect();
    resolve({ ...info, stageTop: Math.round(stage.top), vh: innerHeight, scroll: studio.scrollTop });
  }, 250));
});
await page.screenshot({ path: 'screenshots/app/45-sticky-preview.png' });
console.log(JSON.stringify({ sticky }));

// 切换到另一条记录
await page.evaluate(() => document.getElementById('back-btn')?.click());
await new Promise((r) => setTimeout(r, 500));
const recCount = await page.evaluate(() => document.querySelectorAll('#records-pane .rec').length);
await page.evaluate(() => document.querySelectorAll('#records-pane .rec')[1]?.click());
for (let i = 0; i < 480; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  if (await page.evaluate(() => window.__fitReady === true)) break;
}
await new Promise((r) => setTimeout(r, 600));
const switched = await page.evaluate(() => ({
  detailsOpen: document.querySelector('#studio .split-panel').open,
  scrollTop: document.getElementById('studio').scrollTop,
  title: document.getElementById('activity-title').textContent,
}));
console.log(JSON.stringify({ recCount, switched }));
await page.screenshot({ path: 'screenshots/app/46-switched-record.png' });

// 4) GPX/TCX 在静帧预览下方
const buttonOrder = await page.evaluate(() =>
  [...document.querySelectorAll('#studio .sub-actions .sub')]
    .filter((b) => !b.hidden)
    .map((b) => b.textContent.trim()));
const buttonSizes = await page.evaluate(() => {
  const ids = ['native-preview-btn', 'export-track-gpx', 'export-track-tcx', 'stats-image-btn'];
  return ids.map((id) => {
    const el = document.getElementById(id);
    const r = el?.getBoundingClientRect();
    return { id, hidden: !el || el.hidden, h: Math.round(r?.height ?? 0), w: Math.round(r?.width ?? 0) };
  });
});
console.log(JSON.stringify({ buttonOrder, buttonSizes }));

// 5) 重复的重新绑定入口
const rebind = await page.evaluate(() => ({
  rebindBtn: !!document.getElementById('rebind'),
  bindButtons: [...document.querySelectorAll('[data-bind]')].map((b) => b.textContent.trim()),
}));
console.log(JSON.stringify({ rebind }));

console.log('pageerrors:', errors.length, errors.slice(0, 3));
await browser.close();
