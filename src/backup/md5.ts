/**
 * 纯 JS MD5：百度网盘 precreate/create 的 block_list 需要它，
 * WebCrypto 没有 MD5，单独放一个模块也便于单测（tools/md5-test.mts）。
 */

export function md5(bytes: Uint8Array): string {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const len = bytes.length;
  const withPadding = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  withPadding.set(bytes);
  withPadding[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPadding.buffer);
  dv.setUint32(withPadding.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPadding.length - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  for (let off = 0; off < withPadding.length; off += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i += 1) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0; let B = b0; let C = c0; let D = d0;
    for (let i = 0; i < 64; i += 1) {
      const g = i < 16 ? i : i < 32 ? (5 * i + 1) % 16 : i < 48 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const f = (i < 16 ? (B & C) | (~B & D)
        : i < 32 ? (D & B) | (~D & C)
          : i < 48 ? B ^ C ^ D
            : C ^ (B | ~D)) + A + K[i] + M[g];
      A = D; D = C; C = B;
      B = (B + ((f << S[i]) | (f >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true); odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true); odv.setInt32(12, d0, true);
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const SLICE_BYTES = 4 * 1024 * 1024;

/** 按 4MB 分片算 MD5 列表（百度 precreate / create 的 block_list）。 */
export function md5List(bytes: Uint8Array): string[] {
  const list: string[] = [];
  for (let start = 0; start < bytes.length; start += SLICE_BYTES) {
    list.push(md5(bytes.subarray(start, Math.min(bytes.length, start + SLICE_BYTES))));
  }
  return list.length ? list : [md5(new Uint8Array(0))];
}
