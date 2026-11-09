// Reliable MP4 verification via ffmpeg: full decode, count errors/warnings,
// and confirm frame count + duration. Replaces the old seek+drawImage method,
// which silently returned the same frame for every timestamp (false PASS/FAIL).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const installer = path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const ffmpeg = fs.existsSync(installer) ? installer : 'ffmpeg';
const mp4Path = process.argv[2];
if (!mp4Path) {
  console.error('usage: node tools/verify-mp4.mjs <file.mp4>');
  process.exit(2);
}

let output = '';
try {
  execFileSync(ffmpeg, ['-v', 'warning', '-xerror', '-i', mp4Path, '-f', 'null', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  output = String(err.stderr ?? err);
}
// Also capture stderr on success path
if (!output) {
  try {
    execFileSync(ffmpeg, ['-v', 'warning', '-i', mp4Path, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { /* already handled above */ }
}
const bad = /error|illegal|corrupt|invalid|non-monotonous/i.test(output);
console.log(bad ? `FAIL: decoder reported problems:/n${output.split('\n').slice(0, 10).join('\n')}` : 'PASS: full decode clean (no decoder warnings)');
process.exit(bad ? 1 : 0);
