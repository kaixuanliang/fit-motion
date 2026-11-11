import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dist = path.join(root, 'dist');
const exe = path.join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');

if (!fs.existsSync(exe)) {
  throw new Error('esbuild binary not found. Run npm install first.');
}

// 先把瓦片光栅化 Worker 打成内联字符串（tile-raster.ts import 生成的 .gen.ts）
const workerBuild = spawnSync(process.execPath, [path.join(root, 'tools', 'build-worker.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
if (workerBuild.status !== 0) process.exit(workerBuild.status ?? 1);

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(path.join(dist, 'assets'), { recursive: true, force: true });
for (const name of ['app.js', 'app.css', 'index.html', 'FitMotion.apk']) {
  const file = path.join(dist, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

const result = spawnSync(exe, [
  'src/main.ts',
  '--bundle',
  '--minify',
  '--format=iife',
  '--target=es2019',
  '--loader:.woff2=dataurl',
  '--loader:.png=dataurl',
  '--outfile=dist/app.js',
  '--log-level=warning',
], { stdio: 'inherit', cwd: root });

if (result.status !== 0) process.exit(result.status ?? 1);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(dist, 'app.css'), 'utf8');
// JS 外置为 defer 的经典脚本：HTML+CSS 内联先上屏，1.8MB 的解析不再阻塞首帧。
// 经典 script 在 file://（APK 的 android_asset）下没有 CORS 限制，ES module 才有。
const inlined = html
  .replace('</head>', () => `<style>${css}</style>\n  </head>`)
  .replace(
    /\s*<script type="module" src="\/src\/main\.ts"><\/script>\s*/,
    () => `\n    <script src="./assets/app.js" defer></script>\n`,
  );

if (inlined === html || !inlined.includes('assets/app.js')) {
  throw new Error('Could not reference the bundle from index.html');
}

fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.renameSync(path.join(dist, 'app.js'), path.join(dist, 'assets', 'app.js'));
fs.writeFileSync(path.join(dist, 'index.html'), inlined);
console.log(`Built dist/index.html (${(Buffer.byteLength(inlined) / 1024).toFixed(0)} KB) + dist/assets/app.js`);
