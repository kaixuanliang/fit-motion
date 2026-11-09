/**
 * 导出→回导全链路回归 + 本地音乐。
 *
 * 1. 导入华为风格 GPX（带停留、带 extensions 官方值）
 * 2. 用 activityToGpx 导出 → 重新导入：应被「重复跳过」，统计不漂移
 * 3. 旧版导出格式（trkpt 直接挂在 trk 下、无 trkseg）也应能解析
 * 4. 本地音乐：生成 WAV 存入设置 → renderMusicBuffer 渲染出正确时长
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const out = await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { allMeta } = await import('/src/store/repo.ts');
  const { loadActivity } = await import('/src/store/repo.ts');
  const { activityToGpx } = await import('/src/export/track.ts');
  const { parseGpx } = await import('/src/gpx/parser.ts');
  const { saveParsed } = await import('/src/store/repo.ts');

  const report = {};

  // 华为风格 GPX：600s 记录里最后 180s 停留不动，官方 totalTime = 420
  const gpx = (() => {
    const start = Date.parse('2026-08-01T02:00:00Z');
    const pts = [];
    for (let i = 0; i < 600; i += 1) {
      const moving = i < 420;
      const lat = 39.9 + (moving ? i : 420) * 0.00009;
      pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${(116.4 + i * 0.00002).toFixed(6)}"><ele>${(50 + i * 0.1).toFixed(1)}</ele><time>${new Date(start + i * 1000).toISOString()}</time></trkpt>`);
    }
    return `<?xml version="1.0"?><gpx creator="Health" version="1.0" xmlns="http://www.topografix.com/GPX/1/0"><trk><type>户外骑行</type><extensions><totalTime>420</totalTime><cumulativeClimb>42</cumulativeClimb></extensions><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  })();

  await importFiles([new File([gpx], '原始.gpx')]);
  const first = (await allMeta())[0];
  report.original = { duration: first.duration, distance: first.distance };

  // 导出 → 回导（saveParsed 走与导入页完全一致的去重）
  const activity = await loadActivity(first.id);
  const exported = activityToGpx(activity);
  report.exportHasTrkseg = exported.includes('<trkseg>');
  report.exportHasExtensions = exported.includes('<totalTime>');
  const reparsed = parseGpx(exported, '回导.gpx');
  report.reparsed = {
    points: reparsed.records.length,
    timerTime: reparsed.sessions[0].timerTime,
    distance: reparsed.sessions[0].distance,
  };
  const result = await saveParsed({
    parsed: reparsed,
    fileName: '回导.gpx',
    src: 'gpx',
    bytes: new TextEncoder().encode(exported).buffer,
    keepFile: true,
  });
  report.reimportStatus = result.status;

  // 旧版导出格式：没有 trkseg，trkpt 直接挂 trk 下 —— 之前直接报「没有 trkpt」
  const legacy = exported.replace('<trkseg>', '').replace('</trkseg>', '');
  const legacyParsed = parseGpx(legacy, '旧版.gpx');
  report.legacyParses = legacyParsed.records.length === reparsed.records.length;

  // 本地音乐：生成 3 秒 440Hz WAV → 存设置 → 渲染 8 秒成品
  const wav = (() => {
    const rate = 44100;
    const frames = rate * 3;
    const buf = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buf);
    const str = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); str(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i += 1) view.setInt16(44 + i * 2, Math.sin((i / rate) * 440 * 2 * Math.PI) * 12000, true);
    return buf;
  })();
  const { setSetting } = await import('/src/store/db.ts');
  await setSetting('music-local-file', { name: 'test.wav', blob: new Blob([wav], { type: 'audio/wav' }) });
  const { renderMusicBuffer } = await import('/src/audio/synth.ts');
  const musicBuffer = await renderMusicBuffer('local', 8);
  report.localMusic = {
    rendered: Boolean(musicBuffer),
    seconds: musicBuffer ? +musicBuffer.duration.toFixed(2) : 0,
  };

  return report;
});

console.log(JSON.stringify(out, null, 2));
console.log('errors', errors.slice(0, 3));
const checks = [
  out.exportHasTrkseg && out.exportHasExtensions,
  out.reparsed.points > 0 && out.reparsed.timerTime === 420,
  out.reimportStatus === 'duplicate-motion',
  out.legacyParses === true,
  out.localMusic.rendered && out.localMusic.seconds === 8,
  errors.length === 0,
];
console.log(checks.every(Boolean) ? 'ALL PASS' : `FAIL at ${checks.map((v, i) => (v ? '' : i)).filter(Boolean).join(',')}`);
await browser.close();
