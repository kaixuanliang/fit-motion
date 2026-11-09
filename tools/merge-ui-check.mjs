/**
 * 合并路线弹层的交互回归：
 * 1) 选了两种运动 → 按钮禁用并说明原因（不能"点了没反应"）
 * 2) 同类型两条 → 能合并、弹层关闭、记录 +1、toast 提示
 * 3) 合并过程出错 → 错误文案留在弹层里 + 红字 + toast，不被刷新覆盖
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const makeGpx = (startIso, seconds, offsetLat, type) => {
  const start = Date.parse(startIso);
  const pts = [];
  for (let i = 0; i < seconds; i += 1) {
    const lat = (39.9 + offsetLat + i * 0.00009).toFixed(6);
    const lon = (116.4 + i * 0.00002).toFixed(6);
    const t = new Date(start + i * 1000).toISOString();
    pts.push(`<trkpt lat="${lat}" lon="${lon}"><ele>${(50 + i * 0.1).toFixed(1)}</ele><time>${t}</time></trkpt>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><gpx creator="Health" version="1.0" xmlns="http://www.topografix.com/GPX/1/0"><trk><type>${type}</type><extensions><totalTime>${seconds}</totalTime><cumulativeClimb>${Math.round(seconds * 0.1)}</cumulativeClimb></extensions><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
};

const loadRows = () => page.evaluate(async () => {
  const { allMeta } = await import('/src/store/repo.ts');
  return (await allMeta())
    .filter((row) => !row.deleted)
    .sort((a, b) => b.start - a.start)
    .map((row) => ({ id: row.id, sport: row.sport ?? 0, src: row.src, name: row.name }));
});

const state = () => page.evaluate(() => {
  const hint = document.getElementById('merge-hint');
  const confirm = document.getElementById('merge-confirm');
  return {
    hint: hint?.textContent?.trim() ?? '',
    bad: hint?.classList.contains('bad') ?? false,
    disabled: confirm?.disabled,
    buttonText: confirm?.textContent?.trim() ?? '',
    hidden: document.getElementById('merge-overlay')?.hidden,
    toast: document.getElementById('toast')?.textContent?.replace('撤销', '').trim() ?? '',
    cards: document.querySelectorAll('.rec').length,
  };
});

const openMerge = async () => {
  await page.evaluate(() => document.querySelector('.tab[data-tab="import"]').click());
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.getElementById('merge-open').click());
  await page.waitForSelector('#merge-overlay:not([hidden])');
  await new Promise((r) => setTimeout(r, 700));
};

const pick = async (ids) => page.evaluate((list) => {
  for (const id of list) {
    const row = document.querySelector(`.merge-row[data-id="${id}"]`);
    row?.querySelector('input[type=checkbox]')?.click();
  }
}, ids);

const report = {};

// ── 准备：两段骑行 + 一段跑步
await page.evaluate(async (files) => {
  const { importFiles } = await import('/src/import/batch.ts');
  await importFiles(files.map((f) => new File([f.gpx], f.name, { type: 'application/gpx+xml' })));
}, [
  { name: 'ride-a.gpx', gpx: makeGpx('2026-06-01T01:00:00Z', 600, 0, '户外骑行') },
  { name: 'ride-b.gpx', gpx: makeGpx('2026-06-01T02:00:00Z', 900, 0.03, '户外骑行') },
  { name: 'run-c.gpx', gpx: makeGpx('2026-06-02T12:00:00Z', 600, 0.06, '户外跑步') },
]);
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('.rec');

let rows = await loadRows();
const rides = rows.filter((row) => row.sport === 2);
const runs = rows.filter((row) => row.sport === 1);

// ── 1) 类型不一致
await openMerge();
await pick([rides[0].id, runs[0].id]);
await new Promise((r) => setTimeout(r, 250));
report.mismatch = await state();
await page.screenshot({ path: 'screenshots/merge-mismatch.png' });

// ── 2) 同类型两条 → 合并成功
await pick([runs[0].id, rides[1].id]);
await new Promise((r) => setTimeout(r, 250));
report.sameType = await state();
await page.click('#merge-confirm');
await new Promise((r) => setTimeout(r, 2500));
report.merged = await state();

// ── 3) 选中后记录被删：错误必须留在弹层里
await openMerge();
rows = await loadRows();
const rideIds = rows.filter((row) => row.sport === 2).slice(0, 2).map((row) => row.id);
await pick(rideIds);
await new Promise((r) => setTimeout(r, 200));
report.beforeFail = await state();
await page.evaluate(async (id) => {
  const { removeActivity } = await import('/src/store/repo.ts');
  await removeActivity(id);
}, rideIds[0]);
await page.click('#merge-confirm');
await new Promise((r) => setTimeout(r, 2000));
report.fail = await state();
await page.screenshot({ path: 'screenshots/merge-feedback.png' });

report.errors = errors;

const fail = [];
if (report.mismatch.disabled !== true) fail.push('类型不一致时按钮应禁用');
if (!/不一致/.test(report.mismatch.hint)) fail.push('类型不一致应有文案说明');
if (report.sameType.disabled !== false) fail.push('同类型两条时按钮应可点');
if (!/合计/.test(report.sameType.hint)) fail.push('同类型选中后应显示合计');
if (report.merged.hidden !== true) fail.push('合并成功后弹层应关闭');
if (report.merged.cards !== 4) fail.push(`合并后记录应为 4 条，实际 ${report.merged.cards}`);
if (!/已合并/.test(report.merged.toast)) fail.push('合并成功应有 toast');
if (!report.fail.hint || report.fail.hint === report.beforeFail.hint) fail.push('失败原因应替换掉「已选 N 条」');
if (report.fail.bad !== true) fail.push('失败提示应为红色强调');
if (!/合并失败/.test(report.fail.toast)) fail.push('失败应同时弹 toast');
if (errors.length) fail.push(`页面报错：${errors.join(' | ')}`);

console.log(JSON.stringify(report, null, 2));
console.log(fail.length ? `FAIL\n- ${fail.join('\n- ')}` : 'ALL PASS');
await browser.close();
process.exit(fail.length ? 1 : 0);
