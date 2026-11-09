/**
 * 双端备份引擎。
 *
 * 一条原则：**本地只有索引，云端才是正文**。列表页需要的字段（名字、距离、
 * 缩略图、统计）全在 manifest 里，几百条记录几十 KB；真正占地方的轨迹按条
 * 存在 tracks/ 下，点开哪条拉哪条。这样换手机、重装 App，装完连上网就能
 * 看到全部历史，但本地不用背着几百 MB。
 *
 * 每端绑定的不是一个仓库，而是一个**仓库队列**（最多 5 个）：0 号是活跃
 * 库，用量 ≥90% 封存（从此只读），新上传自动切到下一号。记录的当前版本
 * 住在哪一号由 `meta.home[provider]`（`owner/repo` 键）定位，删除与按需
 * 下载都跟着它走。封存库完全只读 —— 连清单都不再更新，换设备时它清单里
 * 的旧条目会被活跃库全量清单里更新的墓碑覆盖。
 *
 * 对账逻辑刻意做得「无状态」：不看队列里排了什么，而是逐条比对
 * `meta.updated` 与 `meta.where[provider]`。队列会丢、会被杀掉，
 * 元数据不会 —— 每次同步都从事实重新算一遍，天然幂等。
 */

import { getSetting, setSetting } from '../store/db';
import {
  allMeta,
  getRawMeta,
  getStoredTrack,
  markBacked,
  putMeta,
  putStoredTrack,
  trackBytes,
} from '../store/repo';
import type { ActivityMeta, StoredTrack } from '../store/types';
import {
  createAdapter,
  PROVIDER_META,
  type ProbeResult,
  type ProviderConfig,
  type ProviderId,
  type SyncAdapter,
} from './adapter';
import { packTrack, unpackTrack } from './codec';
import { decryptText, encryptText, isEncrypted } from './crypto';

export const MANIFEST_PATH = 'fitmotion/manifest.json';
export const REPO_PREFIX = 'fitmotion';

const CONFIG_KEY: Record<ProviderId, string> = {
  gitee: 'backup.gitee',
  github: 'backup.github',
  webdav: 'backup.webdav',
  baidu: 'backup.baidu',
};

const ALL_PROVIDERS: ProviderId[] = ['gitee', 'github', 'webdav', 'baidu'];

/* ── 端到端加密：远端只存密文（清单明文，轨迹密文） ── */

let sessionPassword = '';

/** 备份密码只在本次会话内存里，App 重启后需重新输入。 */
export function setSessionPassword(password: string): void {
  sessionPassword = password;
}

export function hasSessionPassword(): boolean {
  return sessionPassword.length > 0;
}

export interface CryptoConfig {
  enabled: boolean;
  salt: string;
  iterations: number;
}

export async function readCryptoConfig(): Promise<CryptoConfig | null> {
  return getSetting<CryptoConfig | null>('backup.crypto', null);
}

/** 轨迹文件上传前加密（清单保持明文：跨设备列表恢复依赖它）。 */
async function putTrackFile(adapter: SyncAdapter, path: string, text: string, message: string): Promise<void> {
  const cfg = await readCryptoConfig();
  if (cfg?.enabled && sessionPassword) {
    text = await encryptText(text, sessionPassword, cfg);
  }
  await adapter.put(path, text, message);
}

/** 轨迹文件下载后解密；没开加密或密码不对会抛出明确错误。 */
async function getTrackFile(adapter: SyncAdapter, path: string): Promise<{ sha: string; text: string } | null> {
  const file = await adapter.get(path);
  if (!file || !isEncrypted(file.text)) return file;
  const cfg = await readCryptoConfig();
  if (!cfg?.enabled || !sessionPassword) {
    throw new Error('云端轨迹已加密：请先在备份页开启加密备份并输入备份密码，再同步');
  }
  return { sha: file.sha, text: await decryptText(file.text, sessionPassword, cfg) };
}

/** 每端最多绑几个仓库（Gitee 总量 5GB ÷ 500MB，GitHub 更多只是没意义了） */
export const MAX_TARGETS = 5;
/** 活跃库封存线：Git 历史不随删除释放，留 10% 余量给清单版本积累 */
export const SEAL_RATIO = 0.9;
/** 彻底停止上传的红线（队列里最后一个库也到这一步才拦） */
const STOP_RATIO = 0.96;

export const repoKey = (config: ProviderConfig): string => `${config.owner}/${config.repo}`;

/**
 * 一端的绑定：仓库队列 + 活跃库下标。
 * 旧版本存的是单个 ProviderConfig，读出来时迁移成 targets[0]。
 */
export interface ProviderTargets {
  targets: ProviderConfig[];
  active: number;
}

/** 清单条目只保留跨设备有意义的部分，本机状态（where/backup/opened/purged）不入库 */
type ManifestEntry = Omit<ActivityMeta, 'where' | 'backup' | 'opened' | 'purged' | 'home'> & {
  trackBytes?: number;
  /** 这一版轨迹住在写清单那端的哪个仓库（owner/repo） */
  home?: string;
};

interface RemoteManifest {
  app: string;
  version: number;
  updated: number;
  activities: ManifestEntry[];
}

export interface SyncProgress {
  phase: 'probe' | 'pull' | 'push' | 'manifest' | 'done';
  done: number;
  total: number;
  message: string;
}

export interface ProviderStatus extends ProbeResult {
  id: ProviderId;
  label: string;
  quota: number;
  /** 绑定的仓库数与活跃库的名字，备份页列表用 */
  repos: number;
  activeRepo: string;
}

export interface SyncReport {
  ok: boolean;
  ms: number;
  pushed: number;
  pulled: number;
  removed: number;
  failed: number;
  /** 本轮真正上传的轨迹文本字节数（远端存储的增量，不含清单） */
  uploadedBytes: number;
  providers: string[];
  message: string;
  notes: string[];
}

export function trackPath(id: string): string {
  return `${REPO_PREFIX}/tracks/${id}.fmt`;
}

function normalizeTargets(raw: unknown): ProviderTargets | null {
  const list: ProviderConfig[] = [];
  const push = (config: unknown): void => {
    const row = config as ProviderConfig | null;
    if (row && row.token && row.owner && row.repo) {
      list.push({ token: row.token, owner: row.owner, repo: row.repo, branch: row.branch || 'main' });
    }
  };
  if (Array.isArray((raw as ProviderTargets)?.targets)) {
    for (const row of (raw as ProviderTargets).targets) push(row);
  } else {
    push(raw); // 旧版单仓库配置，直接迁移成 targets[0]
  }
  if (!list.length) return null;
  const capped = list.slice(0, MAX_TARGETS);
  const rawActive = (raw as ProviderTargets | null)?.active;
  const active = Number.isFinite(rawActive)
    ? Math.min(Math.max(0, Number(rawActive)), capped.length - 1)
    : 0;
  return { targets: capped, active };
}

export async function readConfig(id: ProviderId): Promise<ProviderTargets | null> {
  const raw = await getSetting<unknown>(CONFIG_KEY[id], null);
  return normalizeTargets(raw);
}

export async function readAllConfigs(): Promise<Partial<Record<ProviderId, ProviderTargets>>> {
  const result: Partial<Record<ProviderId, ProviderTargets>> = {};
  for (const id of ALL_PROVIDERS) {
    const config = await readConfig(id);
    if (config) result[id] = config;
  }
  return result;
}

export async function boundProviders(): Promise<ProviderId[]> {
  const configs = await readAllConfigs();
  return ALL_PROVIDERS.filter((id) => Boolean(configs[id]));
}

function adapterFor(config: ProviderConfig, id: ProviderId): SyncAdapter {
  return createAdapter(id, config);
}

/** 探活两端：活跃库先试，不通就按队列顺序找一个能用的；3 秒没响应当失败。 */
export async function probeAll(timeoutMs = 6000): Promise<ProviderStatus[]> {
  const configs = await readAllConfigs();
  const ids = ALL_PROVIDERS.filter((id) => configs[id]);
  return Promise.all(ids.map(async (id) => {
    const targets = configs[id]!;
    let probe: ProbeResult | null = null;
    for (let i = 0; i < targets.targets.length; i += 1) {
      const order = i === 0 ? targets.active : i - 1 >= targets.active ? i : i - 1;
      const result = await adapterFor(targets.targets[order], id).probe(timeoutMs);
      if (result.ok || !probe) probe = result;
      if (result.ok) break;
    }
    const result = probe ?? { ok: false, latencyMs: 0, message: '未配置仓库', usageBytes: 0 };
    return {
      ...result,
      id,
      label: PROVIDER_META[id].label,
      quota: PROVIDER_META[id].quota * targets.targets.length,
      repos: targets.targets.length,
      activeRepo: repoKey(targets.targets[Math.min(targets.active, targets.targets.length - 1)]),
    };
  }));
}

/* ------------------------------ manifest 读写 ------------------------------ */

function emptyManifest(): RemoteManifest {
  return { app: 'fitmotion', version: 1, updated: 0, activities: [] };
}

async function readManifest(adapter: SyncAdapter): Promise<RemoteManifest> {
  const file = await adapter.get(MANIFEST_PATH);
  if (!file) return emptyManifest();
  const text = file.text.replace(/^\uFEFF/, '').trim();
  if (!text) return emptyManifest();
  try {
    const parsed = JSON.parse(text) as Partial<RemoteManifest>;
    return {
      app: parsed.app ?? 'fitmotion',
      version: parsed.version ?? 1,
      updated: parsed.updated ?? 0,
      activities: Array.isArray(parsed.activities) ? parsed.activities.filter((row) => row && typeof row.id === 'string') : [],
    };
  } catch {
    // 不能当空清单处理：那样会把远端清单覆盖成只剩本地记录，云端索引就没了
    throw new Error(`${adapter.label} 清单内容不是合法 JSON（前 80 字：${text.slice(0, 80)}），已跳过本次写入`);
  }
}

/**
 * 清单条目：只写「换个手机也需要知道」的字段。
 *
 * `where`（各端推到哪个版本）、`backup`、`opened`、`purged` 都是本机状态，
 * 云端不需要，也绝不能写进去：
 * - 体积上，4000 条时每条多 80 字节就是 320 KB，而清单每次变更都会新增
 *   一个 Git 版本，历史里反复累加；
 * - 逻辑上，`where` 一旦进了清单，两端互相看着对方的时间戳来回改写，
 *   同一次同步会在两端各写两版。
 */
function manifestEntry(row: ActivityMeta, provider: ProviderId): ManifestEntry {
  return {
    id: row.id,
    name: row.name,
    src: row.src,
    fileName: row.fileName,
    start: row.start,
    duration: row.duration,
    distance: row.distance,
    avgSpeed: row.avgSpeed,
    maxSpeed: row.maxSpeed,
    sport: row.sport,
    avgHr: row.avgHr,
    maxHr: row.maxHr,
    climb: row.climb,
    maxAlt: row.maxAlt,
    calories: row.calories,
    points: row.points,
    thumb: row.thumb,
    fileHash: row.fileHash,
    fp: row.fp,
    added: row.added,
    updated: row.updated,
    size: row.size,
    deleted: row.deleted,
    mergedFrom: row.mergedFrom,
    home: row.home?.[provider],
    trackBytes: row.deleted > 0 ? 0 : trackBytes(row),
  };
}

function snapshot(rows: ActivityMeta[], provider: ProviderId): RemoteManifest {
  const activities: ManifestEntry[] = [];
  for (const row of rows) {
    // 从未上过云端的墓碑没必要写进 manifest，除了让文件变大没别的用
    if (row.deleted > 0 && !Object.keys(row.where ?? {}).length) continue;
    activities.push(manifestEntry(row, provider));
  }
  activities.sort((a, b) => b.start - a.start);
  // 用「最新一条记录的时间」当清单版本，而不是 Date.now()：
  // 后者会让每次点同步都序列化出不同的文本，哪怕一条都没变 —— 结果是
  // 每点一次同步就往仓库历史里塞一份完整清单。
  const updated = activities.reduce((max, row) => Math.max(max, row.updated ?? 0), 0);
  return { app: 'fitmotion', version: 1, updated, activities };
}

/* --------------------------------- 合并 --------------------------------- */

interface MergeStats {
  pulled: number;
  adopted: number;
}

/** 云端 → 本地。只落索引，不下载轨迹。 */
async function mergeManifest(manifest: RemoteManifest, provider: ProviderId): Promise<MergeStats> {
  const stats: MergeStats = { pulled: 0, adopted: 0 };
  for (const entry of manifest.activities) {
    const local = await getRawMeta(entry.id);
    if (!local) {
      if (entry.deleted > 0) continue;
      const meta: ActivityMeta = {
        ...entry,
        where: { [provider]: entry.updated },
        home: entry.home ? { [provider]: entry.home } : {},
        backup: 1,
        deleted: 0,
      };
      delete (meta as ManifestEntry).trackBytes;
      await putMeta(meta);
      stats.pulled += 1;
      continue;
    }
    // 本地更新过就别被覆盖，等会儿会推上去；但「哪一端有」必须记下来，
    // 否则两端各持一份时 backup 位数会算错。
    if ((entry.updated ?? 0) <= local.updated) {
      // 远端只是墓碑（轨迹文件已删），不构成「这一端已备份」——
      // 恢复删除后如果把这当成已同步，列表会谎报状态，也不会重传。
      if ((entry.deleted ?? 0) > 0) continue;
      if ((local.where?.[provider] ?? 0) < entry.updated) {
        local.where = { ...(local.where ?? {}), [provider]: entry.updated };
        if (entry.home) local.home = { ...(local.home ?? {}), [provider]: entry.home };
        local.backup = Object.keys(local.where).length >= 2 ? 2 : 1;
        await putMeta(local);
      }
      continue;
    }
    const merged: ActivityMeta = {
      ...local,
      name: entry.name || local.name,
      thumb: entry.thumb || local.thumb,
      start: entry.start ?? local.start,
      duration: entry.duration ?? local.duration,
      distance: entry.distance ?? local.distance,
      avgSpeed: entry.avgSpeed ?? local.avgSpeed,
      maxSpeed: entry.maxSpeed ?? local.maxSpeed,
      avgHr: entry.avgHr ?? null,
      maxHr: entry.maxHr ?? null,
      climb: entry.climb ?? 0,
      maxAlt: entry.maxAlt ?? null,
      calories: entry.calories ?? null,
      points: entry.points ?? local.points,
      deleted: entry.deleted ?? 0,
      updated: entry.updated,
      where: { ...(local.where ?? {}), [provider]: entry.updated },
      home: entry.home ? { ...(local.home ?? {}), [provider]: entry.home } : local.home,
    };
    merged.backup = Object.keys(merged.where ?? {}).length >= 2 ? 2 : 1;
    await putMeta(merged);
    stats.adopted += 1;
  }
  return stats;
}

/* --------------------------------- 同步 --------------------------------- */

let running: Promise<SyncReport> | null = null;

export function isSyncing(): boolean {
  return running !== null;
}

export function syncNow(onProgress?: (progress: SyncProgress) => void): Promise<SyncReport> {
  if (running) return running;
  running = runSync(onProgress).finally(() => {
    running = null;
  });
  return running;
}

async function runSync(onProgress?: (progress: SyncProgress) => void): Promise<SyncReport> {
  const started = Date.now();
  const notes: string[] = [];
  const configs = await readAllConfigs();
  const ids = ALL_PROVIDERS.filter((id) => configs[id]);
  const fail = (message: string): SyncReport => ({
    ok: false, ms: Date.now() - started, pushed: 0, pulled: 0, removed: 0, failed: 0,
    uploadedBytes: 0, providers: ids.map((id) => PROVIDER_META[id].label), message, notes,
  });

  if (!ids.length) return fail('先绑定 GitHub 或 Gitee 仓库');

  onProgress?.({ phase: 'probe', done: 0, total: ids.length, message: '探测两端可用性…' });
  const probes = await Promise.all(ids.map(async (id) => {
    const targets = configs[id]!;
    const activeConfig = targets.targets[Math.min(targets.active, targets.targets.length - 1)];
    return { id, result: await adapterFor(activeConfig, id).probe(8000) };
  }));
  const live = probes.filter((row) => row.result.ok)
    .sort((a, b) => a.result.latencyMs - b.result.latencyMs)
    .map((row) => row.id);
  for (const row of probes) {
    if (row.result.ok) continue;
    const label = PROVIDER_META[row.id].label;
    notes.push(row.result.message.startsWith(label) ? row.result.message : `${label}：${row.result.message}`);
  }
  if (!live.length) return fail(probes.map((row) => row.result.message).join('；') || '两端都连不上');

  let pushed = 0;
  let pulled = 0;
  let removed = 0;
  let failed = 0;
  let uploadedBytes = 0;

  for (const id of live) {
    const targets = configs[id]!;
    const label = PROVIDER_META[id].label;
    const all = targets.targets;
    const quota = PROVIDER_META[id].quota;
    const active = Math.min(targets.active, all.length - 1);

    /* ── 拉取 ── 全新设备（本地一条都没有）要按队列顺序把每个库的清单都
       并进来，否则住在封存库里的老记录会漏；日常同步只读活跃库 —— 它的
       清单是全量索引，且永远比封存库的新。 */
    const fresh = (await allMeta()).length === 0;
    const pullIndexes = fresh ? all.map((_, i) => i) : [active];
    const liveIds = new Set<string>();
    let pullBroke = false;
    for (const idx of pullIndexes) {
      const suffix = pullIndexes.length > 1 ? `（库 ${idx + 1}/${all.length}）` : '';
      onProgress?.({ phase: 'pull', done: 0, total: 1, message: `读取 ${label} 清单${suffix}…` });
      try {
        const manifest = await readManifest(adapterFor(all[idx], id));
        const merge = await mergeManifest(manifest, id);
        pulled += merge.pulled;
        // 「远端还有它」只看活跃库的清单：封存库是过时快照，里面残留的
        // 旧条目若也计入，已删记录会每轮同步被重复扫一遍。
        if (idx === active) {
          for (const entry of manifest.activities) {
            if ((entry.deleted ?? 0) <= 0) liveIds.add(entry.id);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        if (idx === active) {
          failed += 1;
          notes.push(`${label} 清单读取失败：${message}`);
          pullBroke = true;
          break;
        }
        notes.push(`${label} 库 ${idx + 1} 清单读取失败（不影响其他库）：${message}`);
      }
    }
    if (pullBroke) continue;

    const pending = (await allMeta()).filter((row) => {
      const where = row.where ?? {};
      // 删除要推到「远端还有它」的每一端，哪怕这一端从来没同步过。
      // 但推过一次后 where 已更新到删除时间，不必每轮同步都再删一遍。
      if (row.deleted > 0) return liveIds.has(row.id) || (where[id] != null && where[id] < row.updated);
      return (where[id] ?? 0) < row.updated;
    });

    /* ── 选工作库 ── 活跃库用量 ≥90% 就封存（从此只读），切换到下一号；
       队列里最后一个也满到红线才拦上传。 */
    let work = active;
    let usedBytes: number | null = null;
    let sealedUsed = 0;
    for (; work < all.length; work += 1) {
      usedBytes = await adapterFor(all[work], id).usage(`${REPO_PREFIX}/`).catch(() => null);
      if (usedBytes == null || usedBytes < quota * SEAL_RATIO) break;
      sealedUsed = usedBytes;
    }
    if (work >= all.length) work = all.length - 1;
    if (work !== active) {
      targets.active = work;
      await setSetting(CONFIG_KEY[id], targets);
      notes.push(`${label} 库 ${active + 1} 已写到 ${((sealedUsed / quota) * 100).toFixed(0)}%，新数据改存库 ${work + 1}（${repoKey(all[work])}）`);
    }
    const workAdapter = adapterFor(all[work], id);
    const workFull = usedBytes != null && usedBytes >= quota * STOP_RATIO;
    if (usedBytes != null && !workFull && usedBytes >= quota * 0.85) {
      notes.push(`${label} 库 ${work + 1} 容量已用 ${((usedBytes / quota) * 100).toFixed(0)}%，历史版本不会随删除释放，建议关注`);
    }
    const uploadsBlocked = workFull && pending.some((row) => row.deleted <= 0);
    if (uploadsBlocked) {
      failed += 1;
      notes.push(`${label} 库 ${work + 1} 已用 ${((usedBytes ?? 0) / quota * 100).toFixed(0)}% 且没有更多仓库，本次跳过上传（删除仍会执行）`);
    }

    let i = 0;
    for (const meta of pending) {
      i += 1;
      onProgress?.({
        phase: 'push',
        done: i - 1,
        total: pending.length,
        message: `${label} · ${meta.name}（${i}/${pending.length}）`,
      });
      try {
        if (meta.deleted > 0) {
          // 删除只动「当前版本所在的库」：封存库的清单保持只读，里面残留的
          // 旧条目会被活跃库清单里更新的墓碑覆盖，不会复活。
          const homeIdx = resolveHome(all, meta.home?.[id]);
          const homeAdapter = adapterFor(all[homeIdx], id);
          const remote = await homeAdapter.get(trackPath(meta.id));
          if (remote) {
            await homeAdapter.remove(trackPath(meta.id), remote.sha, `删除 ${meta.name}`);
            removed += 1;
          }
          await markBacked(meta.id, id, meta.updated, repoKey(all[homeIdx]));
          continue;
        }
        if (uploadsBlocked) continue;
        const track = await getStoredTrack(meta.id);
        if (!track) {
          // 本地只剩索引，说明轨迹本来就在云端，跳过
          notes.push(`${meta.name}：本地没有轨迹，跳过上传`);
          continue;
        }
        const packed = await packTrack(track);
        await putTrackFile(workAdapter, trackPath(meta.id), packed.text, `轨迹 ${meta.name}`);
        await markBacked(meta.id, id, meta.updated, repoKey(all[work]));
        pushed += 1;
        uploadedBytes += packed.text.length;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : '未知错误';
        notes.push(`${meta.name}：${message}`);
      }
    }

    onProgress?.({
      phase: 'manifest',
      done: pending.length,
      total: pending.length,
      message: `更新 ${label} 清单…`,
    });
    // 上传被容量拦住时不能写清单：清单里的 updated 等于「这个版本已经在
    // 库里」，写了它，等容量腾出来后这条记录会被对账误判成已同步，
    // 再也不会重传 —— 轨迹就永远缺一块。墓碑同理，等下次能写时一起落。
    if (!uploadsBlocked) {
      try {
        const file = await workAdapter.get(MANIFEST_PATH);
        const current = file ? file.text : '';
        const next = JSON.stringify(snapshot(await allMeta(), id));
        if (next !== current) await workAdapter.put(MANIFEST_PATH, next, '更新清单');
      } catch (error) {
        failed += 1;
        notes.push(`${label} 清单写入失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    }
  }

  onProgress?.({ phase: 'done', done: 1, total: 1, message: '同步完成' });
  const ok = failed === 0;
  const sizeNote = uploadedBytes > 0 ? `（${formatBytes(uploadedBytes)}）` : '';
  return {
    ok,
    ms: Date.now() - started,
    pushed,
    pulled,
    removed,
    failed,
    uploadedBytes,
    providers: live.map((id) => PROVIDER_META[id].label),
    message: ok
      ? `推送 ${pushed} 条${sizeNote} · 拉取 ${pulled} 条${removed ? ` · 删除 ${removed} 条` : ''}`
      : `${failed} 个动作失败${notes[0] ? `：${notes[0]}` : ''}`,
    notes: notes.slice(0, 8),
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 把 home 键（owner/repo）解析成队列下标；键在本地队列里找不到（改过绑定顺序）就退回 0 号。 */
function resolveHome(all: ProviderConfig[], key?: string): number {
  if (key) {
    const idx = all.findIndex((row) => repoKey(row) === key);
    if (idx >= 0) return idx;
  }
  return 0;
}

/* ------------------------------- 按需拉轨迹 ------------------------------- */

/**
 * 按需拉轨迹。
 *
 * 每端先试「这条记录当前住在的库」（meta.home），再按队列顺序兜底；
 * 端与端之间保持国内优先 Gitee。拿不到返回 null 让 UI 走提示。
 */
export async function downloadTrack(id: string): Promise<StoredTrack | null> {
  const configs = await readAllConfigs();
  const meta = await getRawMeta(id);
  const order = [...ALL_PROVIDERS].sort((a, b) => {
    const weight = (pid: ProviderId): number => (pid === 'gitee' ? 0 : 1);
    return weight(a) - weight(b);
  });
  for (const pid of order) {
    const targets = configs[pid];
    if (!targets) continue;
    const homeIdx = resolveHome(targets.targets, meta?.home?.[pid]);
    const indexes = [homeIdx, ...targets.targets.map((_, i) => i).filter((i) => i !== homeIdx)];
    for (const idx of indexes) {
      try {
        const file = await getTrackFile(adapterFor(targets.targets[idx], pid), trackPath(id));
        if (!file) continue;
        const track = await unpackTrack(file.text, id);
        await putStoredTrack(track);
        return track;
      } catch {
        /* 这个库失败就换下一个 */
      }
    }
  }
  return null;
}

export interface RemoteUsage {
  provider: ProviderId;
  label: string;
  used: number;
  quota: number;
  /** 每个库的明细，备份页仓库列表用 */
  repos: { index: number; repo: string; used: number; active: boolean; sealed: boolean }[];
}

/**
 * 两端已用容量（队列里所有库合计）。
 *
 * 口径统一成「git trees 里 fitmotion/ 下所有 blob 的字节数」，两端用同一
 * 套算法，数字才可比。`GET /repos` 的 size 只当兜底：Gitee 没有这个字段，
 * GitHub 的又是 repack 后异步更新的快照，刚推完还停在旧值 —— 直接用它，
 * 同一个仓库会被显示成 6.3 MB 与 391 KB 两个数。
 */
export async function remoteUsage(): Promise<RemoteUsage[]> {
  const configs = await readAllConfigs();
  const result: RemoteUsage[] = [];
  for (const pid of ALL_PROVIDERS) {
    const targets = configs[pid];
    if (!targets) continue;
    const quota = PROVIDER_META[pid].quota;
    const repos = await Promise.all(targets.targets.map(async (config, index) => {
      let used = 0;
      try {
        const adapter = adapterFor(config, pid);
        const exact = await adapter.usage(`${REPO_PREFIX}/`);
        if (exact != null) {
          used = exact;
        } else {
          // trees 接口不通（旧版 Gitee 或代理拦截）才退回仓库 size / 清单估算
          const probe = await adapter.probe(6000);
          used = probe.usageBytes;
          if (!used) {
            const manifest = await readManifest(adapter);
            // 最后一档：清单里的 trackBytes（打包后的真实字节）；老清单没这个
            // 字段时退回「点数 × 18」的粗估，仅用于把容量条画出来
            used = manifest.activities.reduce(
              (sum, row) => sum + (row.trackBytes ?? Math.round(row.points * 18)),
              0,
            );
          }
        }
      } catch {
        /* 拿不到就按 0 画 */
      }
      return {
        index,
        repo: repoKey(config),
        used,
        active: index === Math.min(targets.active, targets.targets.length - 1),
        sealed: index < Math.min(targets.active, targets.targets.length - 1),
      };
    }));
    result.push({
      provider: pid,
      label: PROVIDER_META[pid].label,
      used: repos.reduce((sum, row) => sum + row.used, 0),
      quota: quota * repos.length,
      repos,
    });
  }
  return result;
}
