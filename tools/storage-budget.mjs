/**
 * 备份体积基准：一条「真实形状」的轨迹到底占云端多少字节。
 *
 * 用合成数据（1 Hz 采样、GPS 抖动、海拔、心率）模拟华为/码表的典型记录，
 * 分别量三档：
 *   1. 轨迹点 30 字节/点的本地内存形态
 *   2. encodeTrack 的紧凑二进制
 *   3. gzip + base64 后真正写进仓库的文本长度（= 配额消耗）
 * 再拿同样点数的 GPX / FIT 原始文件体积做对照，说明压缩收益。
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle2' });

const out = await page.evaluate(async () => {
  const codec = await import('/src/backup/codec.ts');

  /** 合成一条 n 点的骑行轨迹：环形路线 + 1 Hz + 海拔/心率 */
  function synth(n) {
    const lat = new Float32Array(n);
    const lon = new Float32Array(n);
    const t = new Float64Array(n);
    const alt = new Float32Array(n);
    const hr = new Int16Array(n);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const start = 1_700_000_000_000;
    for (let i = 0; i < n; i += 1) {
      const ang = (i / n) * Math.PI * 2;
      // 8 km 一圈的路线，叠 3 m 量级的高斯抖动（GPS 真实噪声）
      lat[i] = 30.25 + Math.sin(ang) * 0.036 + (rnd() - 0.5) * 0.00003;
      lon[i] = 120.15 + Math.cos(ang) * 0.042 + (rnd() - 0.5) * 0.00003;
      t[i] = start + i * 1000;
      alt[i] = 20 + Math.sin(ang * 6) * 35 + (rnd() - 0.5) * 1.2;
      hr[i] = 125 + Math.round(Math.sin(i / 240) * 22 + (rnd() - 0.5) * 4);
    }
    return {
      id: 'bench', lat, lon, t, alt, hr,
      speed: null, dist: null, hasTimestamps: true, sportHint: 1,
      session: { timerTime: n, elapsedTime: n, distance: 8000, calories: 500, ascent: 120 },
    };
  }

  const rows = [];
  for (const n of [4000, 12000, 20000]) {
    const track = synth(n);
    const raw = codec.encodeTrack(track);
    const packed = await codec.packTrack(track);
    // 同点数 GPX 的典型文本体积（每点约 120 字节）
    const gpx = n * 120;
    rows.push({
      points: n,
      localArrays: n * 30,
      packedBinary: raw.byteLength,
      storedText: packed.text.length,
      gpxLike: gpx,
      ratioVsGpx: +(packed.text.length / gpx).toFixed(3),
      bytesPerPoint: +(packed.text.length / n).toFixed(2),
    });
  }

  const manifest = JSON.stringify({
    app: 'fitmotion', version: 1, updated: Date.now(),
    activities: Array.from({ length: 23 }, (_, i) => ({
      id: `id${i}`, name: '晨骑', src: 'fit', fileName: 'x.fit', start: 1_700_000_000_000 + i,
      duration: 12000, distance: 80000, avgSpeed: 6.7, maxSpeed: 12, sport: 1,
      avgHr: 132, maxHr: 168, climb: 620, maxAlt: 180, calories: 1400, points: 12000,
      thumb: 'M12 22 L15 26 L19 24 L22 30 L26 27 L30 33 L34 30',
      fileHash: 'a'.repeat(64), fp: { start: 1, duration: 12000, distance: 80000 },
      backup: 0, added: 1, updated: 1, size: 200000, deleted: 0,
    })),
  }).length;

  return { rows, manifestBytes: manifest };
});

console.log(JSON.stringify(out, null, 2));

// 预算推算：按「每条 12,000 点」这一档
const per = out.rows.find((r) => r.points === 12000).storedText + out.manifestBytes / 23;
console.log('\n每条平均占用（含清单摊分）:', Math.round(per / 1024), 'KB');
for (const gb of [500, 1024]) {
  const cap = gb * 1024 * 1024;
  console.log(`${gb === 500 ? 'Gitee 500 MB' : 'GitHub 1 GB'} 可容纳约 ${Math.floor(cap / per)} 条`);
}
for (const rate of [150, 300, 500]) {
  console.log(`每年 ${rate} 条 → 每年 ${(per * rate / 1024 / 1024).toFixed(1)} MB，Gitee 约 ${(500 * 1024 * 1024 / per / rate).toFixed(1)} 年填满`);
}
await browser.close();
