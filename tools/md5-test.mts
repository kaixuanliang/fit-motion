import { md5 } from '../src/backup/md5';

const enc = new TextEncoder();
const cases: Array<[string, string, string]> = [
  ['abc', '900150983cd24fb0d6963f7d28e17f72', md5(enc.encode('abc'))],
  ['empty', 'd41d8cd98f00b204e9800998ecf8427e', md5(new Uint8Array(0))],
  ['轨迹', '', md5(enc.encode('轨迹'))],
];
for (const [name, expect, got] of cases) {
  console.log(`${name}: ${got}${expect ? (got === expect ? ' ✓' : ` ✗ expected ${expect}`) : ''}`);
}
