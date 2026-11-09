/**
 * FIT 导出回归：样例 FIT → 解析 → 导出 FIT → 再解析，
 * 距离/时长/心率/运动类型必须一致，且文件头与 CRC 合法。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('ERR', m.text()); });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const sample = await import('/src/data/sample.ts');
  const { parseFit } = await import('/src/fit/parser.ts');
  const { buildActivity } = await import('/src/fit/activity.ts');
  const { activityToFit } = await import('/src/export/fit.ts');

  const bin = atob(sample.SAMPLE_FIT_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const original = buildActivity(parseFit(bytes.buffer), 'sample.fit');

  const out = activityToFit(original);
  const view = new DataView(out.buffer);
  const header = {
    size: out[0],
    protocol: out[1],
    profile: view.getUint16(2, true),
    dataSize: view.getUint32(4, true),
    tag: String.fromCharCode(out[8], out[9], out[10], out[11]),
    headerCrc: view.getUint16(12, true),
    fileCrc: view.getUint16(out.length - 2, true),
    total: out.length,
  };

  // 独立实现一份 CRC 校验（CRC-16/ARC 查表法），确认与写入值一致
  const table = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  const crcOf = (buf, start, end) => {
    let crc = 0;
    for (let i = start; i < end; i += 1) {
      let tmp = table[crc & 0x0f];
      crc = ((crc >> 4) & 0x0fff) ^ tmp ^ table[buf[i] & 0x0f];
      tmp = table[crc & 0x0f];
      crc = ((crc >> 4) & 0x0fff) ^ tmp ^ table[(buf[i] >> 4) & 0x0f];
    }
    return crc & 0xffff;
  };
  const crc = { header: crcOf(out, 0, 12), file: crcOf(out, 0, out.length - 2) };

  const back = buildActivity(parseFit(out.buffer), 'roundtrip.fit');
  const pick = (a) => ({
    sport: a.sport,
    sportKey: a.sportKey,
    points: a.points.length,
    distanceM: Math.round(a.distanceM),
    movingSec: Math.round(a.movingSec),
    elapsedSec: Math.round(a.elapsedSec),
    maxHeartRate: a.maxHeartRate,
    avgHeartRate: a.avgHeartRate,
    maxSpeed: Number(a.maxSpeed.toFixed(2)),
    calories: a.calories,
    ascent: a.ascent,
  });
  return {
    header,
    crc,
    original: pick(original),
    roundtrip: pick(back),
    dataSizeMatches: header.dataSize === out.length - 16,
  };
});

console.log(JSON.stringify(result, null, 1));
await browser.close();
