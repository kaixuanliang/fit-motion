/**
 * 远端仓库适配器。
 *
 * 两家（GitHub / Gitee）的 Contents API 形状几乎一样，差异只在
 * 鉴权方式和「新建用 POST、更新用 PUT」这一处分叉，所以抽一个基类，
 * 子类只描述这三个差异点。
 *
 * 约定：仓库里的所有文件都是纯文本（轨迹走 base64，见 codec.ts），
 * 这样不需要碰 Git Data API，也不用担心二进制被服务端当文本改写。
 */

export type ProviderId = 'github' | 'gitee';

export interface ProviderConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface RemoteFile {
  sha: string;
  text: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  /** 仓库已用字节数，拿不到时为 0 */
  usageBytes: number;
  /** 仓库默认分支，绑定时用它覆盖用户手填的分支 */
  branch?: string;
}

export interface SyncAdapter {
  readonly id: ProviderId;
  readonly label: string;
  probe(timeoutMs?: number): Promise<ProbeResult>;
  get(path: string): Promise<RemoteFile | null>;
  put(path: string, text: string, message: string): Promise<void>;
  remove(path: string, sha: string, message: string): Promise<void>;
  /** 仓库内 `fitmotion/` 下所有文件的字节数；取不到返回 null */
  usage(prefix?: string): Promise<number | null>;
}

export class RemoteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RemoteError';
  }
}

export const PROVIDER_META: Record<ProviderId, { label: string; quota: number; color: string }> = {
  gitee: { label: 'Gitee', quota: 500 * 1024 * 1024, color: '#c71d23' },
  github: { label: 'GitHub', quota: 1024 * 1024 * 1024, color: '#8b949e' },
};

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new RemoteError('请求超时', 0);
    }
    throw new RemoteError('网络不通，检查一下连接', 0);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 缓存穿透参数。
 *
 * GitHub 的 Contents API 对 GET 响应带 max-age 缓存头，Android WebView 的
 * fetch 会照单全收：首次同步刚写完清单，一分钟内再同步，GET 会命中缓存
 * 拿到旧 sha，随后的 PUT 就 409（manifest.json does not match …）。
 * 每次请求带一个不同的 nonce，强制绕开 HTTP 缓存。
 */
function bustCache(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function describe(status: number, provider: string): string {
  if (status === 401) return `${provider} Token 无效或已过期`;
  if (status === 403) return `${provider} 拒绝访问：Token 权限不够，或触发了限流`;
  if (status === 404) return `${provider} 找不到仓库，检查 owner/repo 或仓库是否为空`;
  if (status === 409 || status === 422) return `${provider} 冲突：远端文件已变，稍后重试`;
  if (status === 429) return `${provider} 请求太频繁，稍后再试`;
  if (status >= 500) return `${provider} 服务端异常（${status}）`;
  return `${provider} 返回 ${status}`;
}

/**
 * 把远端 4xx 响应体里的 message 透出来。
 *
 * 只看状态码分不清「仓库没授权」「Contents 只读」「限流」，
 * GitHub 细粒度 Token 的典型响应是 "Resource not accessible by
 * personal access token"，配上 hint 用户就知道去哪里改。
 */
async function describeResponse(response: Response, provider: string): Promise<string> {
  const base = describe(response.status, provider);
  try {
    const body = (await response.json()) as { message?: string };
    const detail = typeof body.message === 'string' ? body.message.trim() : '';
    if (!detail) return base;
    if (response.status === 403) {
      let hint = /not accessible by|resource not accessible/i.test(detail)
        ? ' —— 细粒度 Token 需在 Repository access 里包含该仓库，且 Contents 权限为 Read and write'
        : '';
      // GitHub 限流时这个头会归零，和权限问题区分开
      if (response.headers.get('x-ratelimit-remaining') === '0') {
        hint += '（已触发限流，等限流窗口重置后再试）';
      }
      return `${base}（远端：${detail}${hint}）`;
    }
    return `${base}（远端：${detail}）`;
  } catch {
    return base;
  }
}

abstract class ContentsAdapter implements SyncAdapter {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  private shaCache = new Map<string, string>();

  constructor(protected readonly config: ProviderConfig) {}

  protected abstract contentsUrl(path: string): string;
  /** git trees 接口（recursive），用来按目录统计真实文件大小 */
  protected abstract treeUrl(ref: string): string;
  protected abstract repoUrl(): string;
  protected abstract authHeaders(): Record<string, string>;
  /** 直接取文件原文：contents 接口只回元信息（大文件）时用它兜底。 */
  protected abstract rawFile(path: string): Promise<Response>;
  protected abstract createFile(path: string, base64: string, message: string): Promise<Response>;
  protected abstract updateFile(path: string, base64: string, sha: string, message: string): Promise<Response>;
  protected abstract deleteFile(path: string, sha: string, message: string): Promise<Response>;

  async probe(timeoutMs = 8000): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const response = await request(this.repoUrl(), { headers: this.authHeaders() }, timeoutMs);
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return { ok: false, latencyMs, message: await describeResponse(response, this.label), usageBytes: 0 };
      }
      const body = (await response.json().catch(() => ({}))) as {
        size?: number;
        full_name?: string;
        default_branch?: string;
      };
      const sizeKb = Number(body.size ?? 0);
      return {
        ok: true,
        latencyMs,
        message: body.full_name ? `已连接 ${body.full_name}` : '已连接',
        usageBytes: Number.isFinite(sizeKb) ? sizeKb * 1024 : 0,
        branch: body.default_branch || undefined,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : '连接失败',
        usageBytes: 0,
      };
    }
  }

  /**
   * 统计备份数据在仓库里的真实体积。
   *
   * 不能拿 `GET /repos` 的 size 字段当容量：Gitee 的仓库接口压根没有这个
   * 字段（永远 0），GitHub 的 size 是服务端 repack 之后写的快照，刚推完
   * 大批文件它还是旧值 —— 一端拿不到、一端滞后，同一个仓库能被显示成
   * 6.3 MB 和 391 KB 两个数。
   *
   * git trees 是唯一两家都准的口径：它按 path 返回每个 blob 的字节数。
   * 只累加 `fitmotion/` 前缀，也就是这个 App 真正写进去的东西（清单 +
   * 每条轨迹的文本），不含仓库里别的文件。
   */
  async usage(prefix = 'fitmotion/'): Promise<number | null> {
    try {
      const response = await request(this.treeUrl(this.config.branch), { headers: this.authHeaders() }, 20000);
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as
        { tree?: { path?: string; type?: string; size?: number }[] } | null;
      if (!body || !Array.isArray(body.tree)) return null;
      let total = 0;
      for (const node of body.tree) {
        if (node.type !== 'blob' || typeof node.path !== 'string') continue;
        if (!node.path.startsWith(prefix)) continue;
        const size = Number(node.size ?? 0);
        if (Number.isFinite(size)) total += size;
      }
      return total;
    } catch {
      return null;
    }
  }

  async get(path: string): Promise<RemoteFile | null> {
    const response = await request(this.contentsUrl(path), { headers: this.authHeaders() }, 20000);
    if (response.status === 404) return null;
    if (!response.ok) throw new RemoteError(await describeResponse(response, this.label), response.status);
    const body = (await response.json().catch(() => null)) as
      { content?: string; sha?: string; encoding?: string } | null;

    // 网关偶尔回 HTML（登录页、风控页），这不是 JSON —— 退回 raw 再试一次
    if (!body) {
      const raw = await this.rawFile(path);
      if (raw.ok) return { sha: this.shaCache.get(path) ?? '', text: await raw.text() };
      if (raw.status === 404) return null;
      throw new RemoteError(`${this.label} 返回的内容不是 JSON（HTTP ${response.status}）`, response.status);
    }

    // Gitee 怪癖：文件不存在时不回 404，而是回父目录列表（200 + []）。
    // 空数组说明这个路径不是文件 —— 再用 raw 确认一下，404 就当文件不存在。
    if (Array.isArray(body)) {
      const raw = await this.rawFile(path);
      if (raw.ok) return { sha: this.shaCache.get(path) ?? '', text: await raw.text() };
      return null;
    }

    if (typeof body.content === 'string') {
      const text = body.encoding === 'base64'
        ? new TextDecoder().decode(decodeBase64(body.content))
        : body.content;
      if (body.sha) this.shaCache.set(path, body.sha);
      return { sha: body.sha ?? '', text };
    }

    // content 缺失：Gitee 对超过 1 MB 的文件只回元信息，GitHub 也有类似边界
    const raw = await this.rawFile(path);
    if (!raw.ok) {
      // raw 也是 404 —— 文件确实不存在，别报错，让上层当「远端为空」处理
      if (raw.status === 404) return null;
      throw new RemoteError(
        `${this.label} 返回的文件内容不可读（contents HTTP ${response.status} 无正文，raw HTTP ${raw.status}，${JSON.stringify(body).slice(0, 100)}）`,
        response.status,
      );
    }
    const text = await raw.text();
    const sha = body.sha ?? '';
    if (sha) this.shaCache.set(path, sha);
    return { sha, text };
  }

  async put(path: string, text: string, message: string): Promise<void> {
    const base64 = encodeBase64(new TextEncoder().encode(text));
    // 409/422 最多重试三轮，每轮都重新取远端 sha——单次重试在
    // 「缓存旧 sha」或「两端几乎同时写」的场景下照样会撞。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(900 + attempt * 700);
      let sha = this.shaCache.get(path);
      if (sha === undefined || attempt > 0) {
        const existing = await this.get(path).catch(() => null);
        sha = existing?.sha ?? '';
      }
      const response = sha
        ? await this.updateFile(path, base64, sha, message)
        : await this.createFile(path, base64, message);
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { content?: { sha?: string } };
        this.shaCache.set(path, body.content?.sha ?? '');
        return;
      }
      if (response.status === 409 || response.status === 422) {
        this.shaCache.delete(path);
        continue;
      }
      throw new RemoteError(await describeResponse(response, this.label), response.status);
    }
    throw new RemoteError(`${this.label} 冲突：重试 3 次后远端文件仍在变化（可能是网络缓存或另一台设备在写），请稍后再同步一次`, 409);
  }

  async remove(path: string, sha: string, message: string): Promise<void> {
    const target = sha || this.shaCache.get(path) || '';
    if (!target) return;
    const response = await this.deleteFile(path, target, message);
    if (response.ok || response.status === 404) {
      this.shaCache.delete(path);
      return;
    }
    throw new RemoteError(await describeResponse(response, this.label), response.status);
  }

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.authHeaders(), ...extra };
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class GitHubAdapter extends ContentsAdapter {
  readonly id = 'github' as const;
  readonly label = 'GitHub';

  protected repoUrl(): string {
    return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}`;
  }

  protected contentsUrl(path: string): string {
    return bustCache(`${this.repoUrl()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(this.config.branch)}`);
  }

  protected treeUrl(ref: string): string {
    return bustCache(`${this.repoUrl()}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  }

  protected authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  protected rawFile(path: string): Promise<Response> {
    return request(this.contentsUrl(path), {
      headers: { ...this.authHeaders(), Accept: 'application/vnd.github.raw' },
    }, 30000);
  }

  private write(path: string, body: Record<string, unknown>): Promise<Response> {
    return request(
      `${this.repoUrl()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
      {
        method: 'PUT',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ branch: this.config.branch, ...body }),
      },
      45000,
    );
  }

  protected createFile(path: string, base64: string, message: string): Promise<Response> {
    return this.write(path, { message, content: base64 });
  }

  protected updateFile(path: string, base64: string, sha: string, message: string): Promise<Response> {
    return this.write(path, { message, content: base64, sha });
  }

  protected deleteFile(path: string, sha: string, message: string): Promise<Response> {
    return request(
      `${this.repoUrl()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
      {
        method: 'DELETE',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ branch: this.config.branch, message, sha }),
      },
      30000,
    );
  }
}

class GiteeAdapter extends ContentsAdapter {
  readonly id = 'gitee' as const;
  readonly label = 'Gitee';

  protected repoUrl(): string {
    return `https://gitee.com/api/v5/repos/${this.config.owner}/${this.config.repo}`;
  }

  protected contentsUrl(path: string): string {
    const encoded = encodeURIComponent(path).replace(/%2F/g, '/');
    return bustCache(`${this.repoUrl()}/contents/${encoded}?access_token=${encodeURIComponent(this.config.token)}&ref=${encodeURIComponent(this.config.branch)}`);
  }

  protected treeUrl(ref: string): string {
    return bustCache(`${this.repoUrl()}/git/trees/${encodeURIComponent(ref)}?recursive=1&access_token=${encodeURIComponent(this.config.token)}`);
  }

  protected authHeaders(): Record<string, string> {
    // Gitee 同时支持 header 与 query，header 更干净，query 作为兜底
    return { Authorization: `token ${this.config.token}`, Accept: 'application/json' };
  }

  protected rawFile(path: string): Promise<Response> {
    const encoded = encodeURIComponent(path).replace(/%2F/g, '/');
    return request(
      bustCache(`${this.repoUrl()}/raw/${encoded}?access_token=${encodeURIComponent(this.config.token)}&ref=${encodeURIComponent(this.config.branch)}`),
      { headers: this.authHeaders() },
      30000,
    );
  }

  private write(path: string, method: 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown>): Promise<Response> {
    return request(
      `${this.repoUrl()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
      {
        method,
        headers: this.headers({ 'Content-Type': 'application/json;charset=UTF-8' }),
        body: JSON.stringify({
          access_token: this.config.token,
          branch: this.config.branch,
          ...body,
        }),
      },
      45000,
    );
  }

  protected createFile(path: string, base64: string, message: string): Promise<Response> {
    return this.write(path, 'POST', { message, content: base64 });
  }

  protected updateFile(path: string, base64: string, sha: string, message: string): Promise<Response> {
    return this.write(path, 'PUT', { message, content: base64, sha });
  }

  protected deleteFile(path: string, sha: string, message: string): Promise<Response> {
    return this.write(path, 'DELETE', { message, sha });
  }
}

export function createAdapter(id: ProviderId, config: ProviderConfig): SyncAdapter {
  return id === 'github' ? new GitHubAdapter(config) : new GiteeAdapter(config);
}
