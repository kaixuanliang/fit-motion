/**
 * 视频时长模型回归：runDurationFor 应随距离单调增长、随均速反向修正，
 * 且覆盖真实场景（1km~300km、10~40km/h）时最终成片不再恒定 30 秒。
 *
 * 通过 vite dev server 加载真实模块，测的就是线上代码而不是复刻公式。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const { runDurationFor } = await import('/src/render/stage.ts');
  /** 成片总时长 ≈ 封面1.1 + 片头1.0 + run + 时刻停留(默认3个×1.9) + 揭示1.1 + 片尾3.2 */
  const totalOf = (run, moments = 3) => run + 1.1 + 1.0 + moments * 1.9 + 1.1 + 3.2;
  const cases = [
    { km: 1, kmh: 25, moments: 1 },
    { km: 3, kmh: 25, moments: 2 },
    { km: 5, kmh: 28, moments: 3 },
    { km: 10, kmh: 25, moments: 3 },
    { km: 10, kmh: 22, moments: 3 },
    { km: 10, kmh: 35, moments: 3 },
    { km: 10, kmh: 12, moments: 3 },
    { km: 20, kmh: 25, moments: 3 },
    { km: 21, kmh: 30, moments: 3 },
    { km: 30, kmh: 25, moments: 3 },
    { km: 50, kmh: 25, moments: 3 },
    { km: 81, kmh: 25, moments: 3 },
    { km: 100, kmh: 25, moments: 3 },
    { km: 300, kmh: 20, moments: 3 },
    { km: 15, kmh: 0, moments: 3 }, // 均速缺失 → 修正系数 1
  ];
  return cases.map(({ km, kmh, moments }) => {
    const run = runDurationFor(km * 1000, kmh / 3.6);
    return { km, kmh, run: +run.toFixed(2), total: +totalOf(run, moments).toFixed(1) };
  });
});
await browser.close();

console.table(result);

const fails = [];
const assert = (cond, msg) => { if (!cond) fails.push(msg); };

// 1. 距离单调不减（同速）
for (let i = 1; i < result.length; i += 1) {
  const a = result[i - 1];
  const b = result[i];
  if (a.kmh === b.kmh && b.km > a.km) assert(b.run >= a.run, `距离增长应不减：${a.km}km → ${b.km}km`);
}
// 2. 均速越快 run 越短
const fast = result.find((r) => r.km === 10 && r.kmh === 35);
const mid = result.find((r) => r.km === 10 && r.kmh === 22);
const slow = result.find((r) => r.km === 10 && r.kmh === 12);
assert(fast.run < mid.run && mid.run < slow.run, '同距离下均速越快 run 应越短');
// 3. 常见区间必须拉开：10km 与 100km（同速 25km/h）总时长差 ≥ 20s；
//    30/50/81/100km 四档互相之间至少差 3s，不再挤成一团
const t25 = (km) => result.find((r) => r.km === km && r.kmh === 25)?.total;
const band = [10, 20, 30, 50, 81, 100].map(t25);
assert(band.every((t) => t != null), '25km/h 档位缺数据');
assert(band[5] - band[0] >= 20, `10km→100km 应差 ≥20s（实际 ${(band[5] - band[0]).toFixed(1)}s）`);
for (let i = 1; i < band.length; i += 1) {
  assert(band[i] - band[i - 1] >= 3, `${[10, 20, 30, 50, 81, 100][i]}km 与上一档应差 ≥3s`);
}
// 4. 短途依然短：最短 < 20s
const totals = result.map((r) => r.total);
assert(Math.min(...totals) < 20, `短途应 < 20s（实际最短 ${Math.min(...totals)}s）`);
// 5. 上下限护栏
const maxRun = Math.max(...result.map((r) => r.run));
const minRun = Math.min(...result.map((r) => r.run));
assert(maxRun <= 40 && minRun >= 6, `run 应落在 [6, 40]（实际 ${minRun}~${maxRun}）`);
// 6. 均速缺失不炸
assert(Number.isFinite(result[result.length - 1].run), '均速缺失应回退到系数 1');

if (fails.length) {
  console.error('FAIL:', fails);
  process.exit(1);
}
console.log('PASS duration-model-test');
