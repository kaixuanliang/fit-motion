import fs from 'node:fs';
import { build } from 'esbuild';

// Bundle the FIT parser + activity builder so this script can import the TS sources.
await build({
  entryPoints: ['tools/_fit-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'tools/.fit-bundle.mjs',
  logLevel: 'silent',
});

const { parseFit } = await import('./.fit-bundle.mjs');
const { buildActivity } = await import('./.fit-bundle.mjs');

const file = process.argv[2];
const buffer = fs.readFileSync(file);
const activity = buildActivity(parseFit(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)), file);
const rows = activity.splits.map((s) => `${s.label} speed=${s.speed?.toFixed(2) ?? '-'} hr=${s.heartRate ?? '-'}`);
console.log(rows.join('\n'));
console.log('---');
console.log('distanceKm=', (activity.distanceM / 1000).toFixed(2));
console.log('durationSec=', activity.durationSec, 'available=', activity.durationAvailable);
console.log('maxSpeed=', activity.maxSpeed, 'available=', activity.maxSpeedAvailable);
console.log('maxHr=', activity.maxHeartRate, 'available=', activity.heartRateAvailable);
console.log('maxAlt=', activity.maxAltitude, 'available=', activity.altitudeAvailable);
console.log('maxSpeedPoint=', activity.maxSpeedPoint ? `d=${activity.maxSpeedPoint.distance.toFixed(0)} speed=${activity.maxSpeedPoint.speed}` : 'NONE');
console.log('maxHrPoint=', activity.maxHrPoint ? `d=${activity.maxHrPoint.distance.toFixed(0)} hr=${activity.maxHrPoint.heartRate}` : 'NONE');
console.log('maxAltPoint=', activity.maxAltitudePoint ? `d=${activity.maxAltitudePoint.distance.toFixed(0)} alt=${activity.maxAltitudePoint.altitude}` : 'NONE');
console.log('points=', activity.points.length);
const speeds = activity.points.map((p) => p.speed).filter((v) => typeof v === 'number');
if (speeds.length) {
  speeds.sort((a, b) => a - b);
  console.log('speed p99.5=', speeds[Math.floor(speeds.length * 0.995)].toFixed(2), 'max=', speeds[speeds.length - 1].toFixed(2));
}
