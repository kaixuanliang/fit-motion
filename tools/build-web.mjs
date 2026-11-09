import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dist = path.join(root, 'dist');
const exe = path.join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');

if (!fs.existsSync(exe)) {
  throw new Error('esbuild binary not found. Run npm install first.');
}

fs.mkdirSync(dist, { recursive: true });
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
const js = fs.readFileSync(path.join(dist, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const inlined = html
  .replace('</head>', () => `<style>${css}</style>\n  </head>`)
  .replace(
    /\s*<script type="module" src="\/src\/main\.ts"><\/script>\s*/,
    () => `\n    <script>${js}</script>\n`,
  );

if (inlined === html || !inlined.includes('<script>')) {
  throw new Error('Could not inline the bundle into index.html');
}

fs.writeFileSync(path.join(dist, 'index.html'), inlined);
console.log(`Built dist/index.html (${(Buffer.byteLength(inlined) / 1024).toFixed(0)} KB)`);
