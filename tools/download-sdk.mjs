import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const files = [
  ['https://dl.google.com/android/repository/platform-30_r03.zip', 'platform-30_r03.zip'],
  ['https://dl.google.com/android/repository/91936d4ee3ccc839f0addd53c9ebf087b1e39251.build-tools_r30.0.3-windows.zip', 'build-tools_r30.0.3-windows.zip'],
];

const dir = path.resolve('tools/downloads');
fs.mkdirSync(dir, { recursive: true });

for (const [url, name] of files) {
  const target = path.join(dir, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 1_000_000) {
    console.log('cached', name, fs.statSync(target).size);
    continue;
  }
  console.log('download', url);
  await new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      let last = 0;
      const out = fs.createWriteStream(target);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total && got - last > total / 10) {
          last = got;
          console.log(`  ${name}: ${Math.round((got / total) * 100)}%`);
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        console.log('done', name, got);
        resolve();
      }));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180_000, () => req.destroy(new Error('timeout')));
  });
}
