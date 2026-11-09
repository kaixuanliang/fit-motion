/**
 * 百度网盘 OAuth 授权（设备码模式）。
 *
 * 为什么不用「手动粘贴 access_token」：百度网盘的 access_token 只能通过
 * OAuth 授权拿到，30 天过期、需要 refresh_token 轮换。让用户自己去开放平台
 * 控制台点授权、再从回调地址里抠 token 基本不可操作；而 AppKey 只是应用身份，
 * 直接当 token 用会返回鉴权错误（errno=-6 / 400）。
 *
 * 设备码模式正好适合手机 App：拿到 device_code + user_code，让用户在浏览器里
 * 输入一次 user_code 完成授权，App 轮询换取 access_token 与 refresh_token。
 *
 * 百度要求所有请求带 User-Agent: pan.baidu.com，缺了会被判非法请求。
 */

import { getSetting, setSetting } from '../store/db';

const OAUTH_KEY = 'backup.baidu.oauth';
const UA = 'pan.baidu.com';
const DEVICE_CODE_URL = 'https://openapi.baidu.com/oauth/2.0/device/code';
const TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token';
/** 提前 1 天刷新，避免同步中途过期 */
const REFRESH_AHEAD_MS = 24 * 3600 * 1000;

export interface BaiduOAuth {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳 */
  expiresAt: number;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  qrcodeUrl: string;
  expiresIn: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function readBaiduOAuth(): Promise<BaiduOAuth | null> {
  return getSetting<BaiduOAuth | null>(OAUTH_KEY, null);
}

export async function saveBaiduOAuth(oauth: BaiduOAuth): Promise<void> {
  await setSetting(OAUTH_KEY, oauth);
}

export async function clearBaiduOAuth(): Promise<void> {
  await setSetting(OAUTH_KEY, null);
}

async function getJson(url: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('连接百度授权服务器超时，检查一下网络');
      }
      throw new Error('连不上百度授权服务器（openapi.baidu.com），检查网络或稍后再试');
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`百度授权接口返回了非 JSON 内容（HTTP ${response.status}）`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 第一步：拿 device_code / user_code / 授权地址。 */
export async function requestDeviceCode(clientId: string): Promise<DeviceCode> {
  const url = `${DEVICE_CODE_URL}?response_type=device_code`
    + `&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent('basic,netdisk')}`;
  const body = await getJson(url);
  const deviceCode = String(body.device_code ?? '');
  const userCode = String(body.user_code ?? '');
  if (!deviceCode || !userCode) {
    throw new Error(`获取设备码失败：${String(body.error_description ?? body.error ?? '未知错误')}`);
  }
  return {
    deviceCode,
    userCode,
    verificationUrl: String(body.verification_url ?? 'https://openapi.baidu.com/device'),
    qrcodeUrl: String(body.qrcode_url ?? ''),
    expiresIn: Number(body.expires_in ?? 300),
    interval: Math.max(5, Number(body.interval ?? 5)),
  };
}

function toOAuth(
  clientId: string,
  clientSecret: string,
  body: TokenResponse,
  previousRefresh = '',
): BaiduOAuth {
  const accessToken = body.access_token ?? '';
  if (!accessToken) throw new Error('授权接口没有返回 access_token');
  return {
    clientId,
    clientSecret,
    accessToken,
    // refresh_token 一次性：响应里没带就保留旧的（刷新成功时百度一定会带新的）
    refreshToken: body.refresh_token ?? previousRefresh,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in ?? 2592000)) * 1000,
  };
}

/**
 * 第二步：轮询 device_code 换 token。
 * 用户还没在浏览器里点确认时百度返回 error=authorization_pending，继续轮询即可。
 */
export async function pollDeviceToken(
  clientId: string,
  clientSecret: string,
  device: DeviceCode,
  options: { onTick?: (secondsLeft: number) => void; signal?: { cancelled: boolean } } = {},
): Promise<BaiduOAuth> {
  const deadline = Date.now() + device.expiresIn * 1000;
  const intervalMs = device.interval * 1000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (options.signal?.cancelled) throw new Error('已取消授权');
    const url = `${TOKEN_URL}?grant_type=device_token&code=${encodeURIComponent(device.deviceCode)}`
      + `&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
    const body = (await getJson(url).catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : '轮询失败';
      return {} as Record<string, unknown>;
    })) as TokenResponse;
    if (body.access_token) return toOAuth(clientId, clientSecret, body);
    if (body.error === 'expired_token') throw new Error('授权码已过期，请重新发起授权');
    if (body.error && body.error !== 'authorization_pending' && body.error !== 'slow_down') {
      throw new Error(body.error_description || body.error);
    }
    if (body.error === 'slow_down') await sleep(intervalMs + 2000);
    else await sleep(intervalMs);
    options.onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
  }
  throw new Error(lastError || '等待授权超时，请重新发起授权');
}

/** 用 refresh_token 换新的 access_token（百度侧 refresh_token 一次性，成功后要整对保存）。 */
export async function refreshAccessToken(oauth: BaiduOAuth): Promise<BaiduOAuth> {
  if (!oauth.refreshToken) throw new Error('没有 refresh_token，请重新授权百度网盘');
  const url = `${TOKEN_URL}?grant_type=refresh_token&refresh_token=${encodeURIComponent(oauth.refreshToken)}`
    + `&client_id=${encodeURIComponent(oauth.clientId)}&client_secret=${encodeURIComponent(oauth.clientSecret)}`;
  const body = (await getJson(url)) as TokenResponse;
  if (!body.access_token) {
    throw new Error(`刷新 access_token 失败：${String(body.error_description ?? body.error ?? '未知错误')}，请在备份页重新授权`);
  }
  const next = toOAuth(oauth.clientId, oauth.clientSecret, body, oauth.refreshToken);
  await saveBaiduOAuth(next);
  return next;
}

/** 取一个可用的 access_token：快过期就先刷新，刷新结果落盘。 */
export async function getValidAccessToken(): Promise<string> {
  const oauth = await readBaiduOAuth();
  if (!oauth?.accessToken) {
    throw new Error('还没有授权百度网盘：请在备份页点「百度网盘 → 绑定」，填 AppKey + SecretKey 后完成一次授权');
  }
  if (oauth.expiresAt - Date.now() > REFRESH_AHEAD_MS) return oauth.accessToken;
  if (!oauth.refreshToken) {
    throw new Error('百度网盘授权已过期（30 天），请在备份页重新授权');
  }
  const next = await refreshAccessToken(oauth);
  return next.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
