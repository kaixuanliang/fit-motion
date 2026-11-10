/**
 * 三种导出格式的心率回归：
 * 1. 带心率 GPX 导入 → 导出 GPX，必须写出 gpxtpx:hr，回导后心率一致；
 * 2. 导出 TCX，Trackpoint 心率 + Lap 的平均/最高心率都在，回导后一致；
 * 3. 导出 FIT，record.heart_rate 逐点写入，parseFit 能读回；
 * 4. 无心率轨迹：三个格式都不应写出空心率节点/无效值。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 430, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const out = await page.evaluate(async () => {
  const { importFiles } = await import('/src/import/batch.ts');
  const { allMeta, loadActivity } = await import('/src/store/repo.ts');
  const { activityToGpx, activityToTcx } = await import('/src/export/track.ts');
  const { activityToFit } = await import('/src/export/fit.ts');
  const { parseGpx } = await import('/src/gpx/parser.ts');
  const { parseTcx } = await import('/src/tcx/parser.ts');
  const { parseFit } = await import('/src/fit/parser.ts');

  const report = {};

  const buildGpx = (withHr, lonBase = 116.4, dayShift = 0) => {
    const start = Date.parse('2026-09-01T02:00:00Z') + dayShift * 86400000;
    const pts = [];
    for (let i = 0; i < 600; i += 1) {
      const hr = withHr
        ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${120 + (i % 40)}</gpxtpx:hr><gpxtpx:cad>${80 + (i % 10)}</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>`
        : '';
      pts.push(`<trkpt lat="${(39.9 + i * 0.00009).toFixed(7)}" lon="${(lonBase + i * 0.00002).toFixed(7)}"><ele>${(50 + i * 0.02).toFixed(2)}</ele><time>${new Date(start + i * 1000).toISOString()}</time>${hr}</trkpt>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="probe" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2"><metadata><name>心率样本</name></metadata><trk><name>心率样本</name><type>户外骑行</type><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  };

  const importOne = async (name, text) => {
    await importFiles([new File([text], name)]);
    const metas = await allMeta();
    const meta = metas.find((item) => item.fileName === name) ?? metas[0];
    return loadActivity(meta.id);
  };

  // --- 有心率 ---
  const act = await importOne('带心率.gpx', buildGpx(true));
  const srcHr = act.points.map((p) => (p.heartRate == null ? null : Math.round(p.heartRate)));
  report.source = {
    points: act.points.length,
    heartRateAvailable: act.heartRateAvailable,
    avgHeartRate: act.avgHeartRate,
    maxHeartRate: act.maxHeartRate,
    firstHr: srcHr[0],
    lastHr: srcHr[srcHr.length - 1],
    firstCadence: act.points[0].cadence,
    cadencePoints: act.points.filter((p) => p.cadence != null).length,
  };

  // GPX
  const gpxText = activityToGpx(act);
  const gpxParsed = parseGpx(gpxText, 'out.gpx');
  report.gpx = {
    hasNamespace: /xmlns:gpxtpx="/.test(gpxText),
    hrNodes: (gpxText.match(/<gpxtpx:hr>/g) || []).length,
    cadNodes: (gpxText.match(/<gpxtpx:cad>/g) || []).length,
    reimportHr: gpxParsed.records.filter((r) => r.heartRate != null).length,
    reimportAvg: gpxParsed.sessions[0].avgHeartRate,
    reimportMax: gpxParsed.sessions[0].maxHeartRate,
    sameFirst: Math.round(gpxParsed.records[0].heartRate ?? -1) === srcHr[0],
  };

  // TCX
  const tcxText = activityToTcx(act);
  const tcxParsed = parseTcx(tcxText, 'out.tcx');
  report.tcx = {
    pointHrNodes: (tcxText.match(/<HeartRateBpm>/g) || []).length,
    hasAvg: /<AverageHeartRateBpm><Value>\d+<\/Value><\/AverageHeartRateBpm>/.test(tcxText),
    hasMax: /<MaximumHeartRateBpm><Value>\d+<\/Value><\/MaximumHeartRateBpm>/.test(tcxText),
    reimportHr: tcxParsed.records.filter((r) => r.heartRate != null).length,
    reimportAvg: tcxParsed.sessions[0].avgHeartRate,
    reimportMax: tcxParsed.sessions[0].maxHeartRate,
    sameFirst: Math.round(tcxParsed.records[0].heartRate ?? -1) === srcHr[0],
  };

  // FIT
  const fitBytes = activityToFit(act);
  const fitParsed = parseFit(fitBytes.buffer.slice(fitBytes.byteOffset, fitBytes.byteOffset + fitBytes.byteLength));
  report.fit = {
    bytes: fitBytes.byteLength,
    reimportHr: fitParsed.records.filter((r) => r.heartRate != null).length,
    reimportAvg: fitParsed.sessions[0].avgHeartRate,
    reimportMax: fitParsed.sessions[0].maxHeartRate,
    sameFirst: Math.round(fitParsed.records[0].heartRate ?? -1) === srcHr[0],
    reimportCadence: fitParsed.records.filter((r) => r.cadence != null).length,
    firstCadence: fitParsed.records[0].cadence,
  };

  // --- 无心率 ---
  const plain = await importOne('无心率.gpx', buildGpx(false, 121.7, 3));
  const plainGpx = activityToGpx(plain);
  const plainTcx = activityToTcx(plain);
  const plainFit = activityToFit(plain);
  const plainFitParsed = parseFit(plainFit.buffer.slice(plainFit.byteOffset, plainFit.byteOffset + plainFit.byteLength));
  report.plain = {
    heartRateAvailable: plain.heartRateAvailable,
    gpxHrNodes: (plainGpx.match(/<gpxtpx:hr>/g) || []).length,
    tcxHrNodes: (plainTcx.match(/<HeartRateBpm>/g) || []).length,
    tcxAvg: /AverageHeartRateBpm/.test(plainTcx),
    fitHrPoints: plainFitParsed.records.filter((r) => r.heartRate != null).length,
  };

  return report;
});

await browser.close();
console.log(JSON.stringify({ ...out, errors }, null, 2));
