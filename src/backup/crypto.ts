/**
 * 端到端加密备份。
 *
 * 算法选型：AES-256-GCM + PBKDF2-HMAC-SHA256（31 万次迭代），全部走
 * WebCrypto——Android WebView 原生支持，无第三方依赖，1MB 轨迹加解密
 * 在中端机上 <50ms。GCM 是认证加密，密文被篡改会在解密时直接报错。
 *
 * 设计要点：
 * - 密码不上传、不存本机明文：同步前用密码 + 盐派生密钥，用完即弃。
 * - 每个文件独立 12 字节随机 IV，密文格式 `1e.<iv b64>.<cipher b64>`。
 * - 盐与迭代参数存在设置里（不敏感），换设备时凭密码即可解密。
 * - 密文是纯文本，GitHub/Gitee/WebDAV/百度网盘四条通道通用。
 */

const ITERATIONS = 310_000;
const FORMAT = '1e';

export interface CryptoParams {
  salt: string;
  iterations: number;
}

export function randomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toBase64(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: string, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(salt) as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 加密一段文本 → `1e.<iv>.<cipher>`；失败抛错，调用方决定是否降级明文。 */
export async function encryptText(text: string, password: string, params: CryptoParams): Promise<string> {
  const key = await deriveKey(password, params.salt, params.iterations);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(text),
  );
  return `${FORMAT}.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

/** 解密；密码错误（GCM 校验失败）会抛出，调用方提示密码不对。 */
export async function decryptText(payload: string, password: string, params: CryptoParams): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== FORMAT) {
    throw new Error('不是本应用的加密格式');
  }
  const key = await deriveKey(password, params.salt, params.iterations);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(parts[1]) as BufferSource },
    key,
    fromBase64(parts[2]) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** 判断一段远端文本是不是加密格式。 */
export function isEncrypted(text: string): boolean {
  return text.startsWith(`${FORMAT}.`);
}
