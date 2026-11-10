// 验证 App 内直接导入 JSON：parseHuaweiJson 对 detailData 新格式的端到端解析
// 用法：node tools/huawei-json-import-test.mjs [port]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const port = process.argv[2] ?? '5178';
const base = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 60000 });

// 构造一段最小但完整的华为 detailData（新版格式）：lbs 点 + alti + h-r
const lines = [];
const t0 = Date.UTC(2026, 9, 1, 8, 0, 0);
for (let i = 0; i < 30; i += 1) {
  const t = t0 + i * 1000;
  const lat = 31.0 + i * 0.0001;
  const lon = 121.0 + i * 0.0001;
  lines.push(`tp=lbs;k=${i};lat=${lat.toFixed(6)};lon=${lon.toFixed(6)};t=${t};`);
  if (i % 5 === 0) lines.push(`tp=alti;k=${t};v=${100 + i};`);
  if (i % 3 === 0) lines.push(`tp=h-r;k=${t};v=${140 + i};`);
}
const payload = JSON.stringify({
  userDetails: [
    { sportType: 259, detailData: lines.join('\n'), totalTime: '30', totalDistance: '150' },
  ],
  otherNested: [{ foo: 'bar' }],
});

const result = await page.evaluate(async (text) => {
  const mod = await import('/src/import/huawei.ts');
  const parsed = mod.parseHuaweiJson(text);
  const a = parsed.activities[0];
  return {
    found: parsed.found,
    skipped: parsed.skipped,
    first: a
      ? {
          name: a.name,
          records: a.parsed.records.length,
          hasHr: a.parsed.records.some((r) => r.heartRate),
          hasAlt: a.parsed.records.some((r) => r.altitude),
          firstT: a.parsed.records[0]?.timestamp,
        }
      : null,
  };
}, payload);

console.log(JSON.stringify(result));
const ok = result.found === 1 && result.skipped === 0
  && result.first && result.first.records === 30 && result.first.hasHr && result.first.hasAlt
  && result.first.firstT === t0;
console.log(ok ? 'PASS: huawei json import works end-to-end' : 'FAIL: unexpected parse result');
await browser.close();
process.exit(ok ? 0 : 1);
