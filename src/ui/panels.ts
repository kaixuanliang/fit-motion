/**
 * 备份页与设置页。
 *
 * 备份页的三块信息都是有出处的：
 * - 两端的容量条来自 `probe()` 拿到的仓库大小（拿不到就用 manifest 估）；
 * - 「待备份 N 条」是 `updated` 与 `where[provider]` 的差集，不是队列长度；
 * - 同步过程有真实的阶段与进度，失败会把原因写在下面，不吞异常。
 */

import { cacheFootprint, CACHE_BUDGET } from '../store/cache';
import { getSetting, setSetting, storageEstimate } from '../store/db';
import { allMeta, deletedCount, libraryStats, unsyncedMeta } from '../store/repo';
import { saveBlob } from '../export/save';
import { showActionSheet, showAlert, showConfirm, showForm } from './dialog';
import { PROVIDER_META, type ProviderConfig, type ProviderId } from '../backup/adapter';
import {
  boundProviders,
  isSyncing,
  MAX_TARGETS,
  probeAll,
  readAllConfigs,
  readConfig,
  remoteUsage,
  SEAL_RATIO,
  syncNow,
  type ProviderTargets,
} from '../backup/sync';

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

let currentTheme: () => string = () => 'tech';

/** 容量是异步问来的，缓存住，避免每次重绘都把「读取中」闪回来 */
const usageCache = new Map<ProviderId, number>();
/** 每个库各自的用量（remoteUsage 的 repos 明细），仓库列表行用 */
const repoUsageCache = new Map<ProviderId, { index: number; used: number }[]>();

const CONFIG_KEY: Record<ProviderId, string> = {
  gitee: 'backup.gitee',
  github: 'backup.github',
};

export function mb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return '0 MB';
}

function setDot(id: ProviderId, state: 'off' | 'ok' | 'bad'): void {
  const dot = $(`${id}-dot`);
  if (!dot) return;
  dot.className = `dot ${state}`;
}

function setSyncCard(visible: boolean): void {
  const card = $<HTMLElement>('sync-card');
  if (card) card.hidden = !visible;
}

function setSyncProgress(text: string, pct: number, note = ''): void {
  const line = $<HTMLElement>('sync-line');
  if (line) line.textContent = text;
  const percent = $<HTMLElement>('sync-pct');
  if (percent) percent.textContent = `${Math.round(pct)}%`;
  const bar = $<HTMLElement>('sync-bar');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
  const noteEl = $<HTMLElement>('sync-note');
  if (noteEl) {
    noteEl.textContent = note;
    noteEl.hidden = !note;
  }
}

/** 仓库队列列表：每库一行（● 活跃 / ○ 已封存 / 待用），跟着容量刷新。
 *  行可点：编辑 / 切工作库 / 解绑，入口藏在行里而不是再摆一个按钮。 */
function renderTargets(id: ProviderId, targets: ProviderTargets | null): void {
  const box = $(`${id}-targets`);
  if (!box) return;
  box.textContent = '';
  if (!targets || targets.targets.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const activeIdx = Math.min(targets.active, targets.targets.length - 1);
  const usageRows = repoUsageCache.get(id);
  targets.targets.forEach((target, index) => {
    const row = document.createElement('div');
    row.className = `target-row${index === activeIdx ? ' on' : ''}`;
    const dot = document.createElement('span');
    dot.textContent = index === activeIdx ? '●' : '○';
    const name = document.createElement('b');
    name.textContent = `${index + 1}. ${target.owner}/${target.repo}`;
    const state = document.createElement('i');
    const used = usageRows?.find((item) => item.index === index)?.used;
    state.textContent = `${used != null ? mb(used) : ''}${index === activeIdx ? ' · 活跃' : ' · 待用'}`;
    row.append(dot, name, state);
    row.addEventListener('click', () => void targetActionSheet(id, targets, index));
    box.append(row);
  });
  const hint = document.createElement('p');
  hint.className = 'target-hint';
  hint.textContent = '点按仓库行可编辑或解绑';
  box.append(hint);
}

export async function renderBackup(): Promise<void> {
  const configs = await readAllConfigs();

  for (const id of Object.keys(PROVIDER_META) as ProviderId[]) {
    const meta = PROVIDER_META[id];
    const config = configs[id];
    const repoCount = config ? config.targets.length : 0;
    const totalQuota = meta.quota * Math.max(1, repoCount);
    const badge = $(`${id}-badge`);
    if (badge) {
      badge.textContent = config ? (repoCount > 1 ? `已绑定 · ${repoCount} 库` : '已绑定') : '未绑定';
      badge.classList.toggle('on', Boolean(config));
    }
    setDot(id, config ? 'ok' : 'off');
    const usage = $(`${id}-usage`);
    if (usage) {
      if (!config) usage.textContent = `未绑定 · 容量 ${mb(meta.quota)}`;
      else {
        const cached = usageCache.get(id);
        usage.textContent = cached == null
          ? `读取容量… / ${mb(totalQuota)}`
          : `${mb(cached)} / ${mb(totalQuota)}`;
      }
    }
    const bar = $(`${id}-bar`);
    if (bar) {
      if (!config) bar.style.width = '0%';
      else if (usageCache.has(id)) {
        const pct = totalQuota > 0 ? (usageCache.get(id)! / totalQuota) * 100 : 0;
        bar.style.width = `${Math.max(1, Math.min(100, pct)).toFixed(1)}%`;
        bar.classList.toggle('warn', pct > 85);
      }
    }
    const bind = document.querySelector<HTMLButtonElement>(`[data-bind="${id}"]`);
    if (bind) bind.textContent = config ? '编辑工作库' : '绑定';
    const add = document.querySelector<HTMLButtonElement>(`[data-bind-add="${id}"]`);
    if (add) add.hidden = !config || repoCount >= MAX_TARGETS;
    renderTargets(id, config ?? null);
  }

  const bound = Object.keys(configs) as ProviderId[];
  const pending = await unsyncedMeta(bound);
  const pendingEl = $<HTMLElement>('pending-count');
  if (pendingEl) pendingEl.textContent = `${pending.length} 条待备份`;
  const note = $<HTMLElement>('pending-note');
  if (note) {
    note.textContent = bound.length === 0
      ? '绑定任意一端即可开始自动备份'
      : bound.length === 2
        ? '两端互为副本，任何一端能连上就够'
        : `只绑了 ${PROVIDER_META[bound[0]].label}，建议再绑一端做副本`;
  }
  const state = $<HTMLElement>('backup-state');
  if (state) {
    state.textContent = bound.length === 0 ? '未绑定' : bound.length === 2 ? '双端已绑定' : '单端已绑定';
  }

  const sync = $<HTMLButtonElement>('sync-now');
  if (sync) {
    sync.disabled = bound.length === 0 || isSyncing();
    sync.textContent = isSyncing() ? '同步中…' : bound.length ? '立即同步' : '先绑定仓库';
  }

  const estimate = await storageEstimate();
  const cache = await cacheFootprint();
  const local = $<HTMLElement>('local-usage');
  if (local) {
    local.textContent = `${mb(estimate.usage)} · 轨迹缓存 ${cache.cached} 条 / ${mb(cache.bytes)}`;
  }
  const bar = $<HTMLElement>('local-bar');
  if (bar) bar.style.width = `${Math.min(100, (cache.bytes / CACHE_BUDGET) * 100).toFixed(1)}%`;
  const limit = $<HTMLElement>('cache-limit');
  if (limit) limit.textContent = `${mb(CACHE_BUDGET)}（超出后淘汰最久未打开的记录）`;
}

/** 容量条要真去问仓库，慢一点，所以先画静态部分再异步补上。 */
export async function refreshRemoteUsage(): Promise<void> {
  const bound = await boundProviders();
  if (!bound.length) return;
  const rows = await remoteUsage();
  for (const row of rows) {
    usageCache.set(row.provider, row.used);
    repoUsageCache.set(row.provider, row.repos.map((item) => ({ index: item.index, used: item.used })));
    const usage = $(`${row.provider}-usage`);
    if (usage) usage.textContent = `${mb(row.used)} / ${mb(row.quota)}`;
    const bar = $(`${row.provider}-bar`);
    if (bar) {
      const pct = row.quota > 0 ? Math.min(100, (row.used / row.quota) * 100) : 0;
      bar.style.width = `${Math.max(1, pct).toFixed(1)}%`;
      bar.classList.toggle('warn', pct > 85);
    }
  }
  // 每个库的用量是异步回来的，仓库列表行要再画一遍才带数字
  const configs = await readAllConfigs();
  for (const row of rows) renderTargets(row.provider, configs[row.provider] ?? null);
  await renderBudget(rows);
}

/**
 * 空间预算：把「已用 ÷ 条数」折成「还能存多少条、按现在的节奏是多少年」。
 *
 * 只做量级判断，不当精确承诺：Git 历史、清单版本也占配额，而且删除释放
 * 不了历史。给出这个数是为了让用户在三千条之前就知道该换端或清理，
 * 而不是某天同步突然全红。
 */
async function renderBudget(rows: { provider: ProviderId; used: number; quota: number }[]): Promise<void> {
  const stats = await libraryStats();
  const avgEl = $<HTMLElement>('budget-avg');
  if (avgEl) {
    avgEl.textContent = stats.count > 0 && rows.length
      ? `约 ${mb(rows.reduce((sum, row) => sum + row.used, 0) / rows.length / stats.count)} · ${stats.count} 条`
      : '还没有可折算的记录';
  }

  // 现有节奏：记录数 ÷ 首末记录的时间跨度，用来把「还能存几条」换算成年
  const spanYears = stats.count > 1 && stats.last > stats.first
    ? (stats.last - stats.first) / (365.25 * 24 * 3600 * 1000)
    : 0;
  const perYear = spanYears >= 0.5 ? stats.count / spanYears : 0;

  for (const row of rows) {
    const el = $<HTMLElement>(`budget-${row.provider}`);
    if (!el) continue;
    if (!stats.count || row.used <= 0) {
      el.textContent = '同步一次后估算';
      continue;
    }
    const average = row.used / stats.count;
    const left = Math.max(0, row.quota - row.used);
    const moreCount = Math.floor(left / average);
    const years = perYear > 0 ? moreCount / perYear : 0;
    el.textContent = `约可再存 ${moreCount.toLocaleString('en-US')} 条${years >= 1 ? `（≈ ${years.toFixed(0)} 年）` : ''}`;
  }
}

export async function renderSettings(): Promise<void> {
  const stats = await libraryStats();
  const sub = $<HTMLElement>('settings-sub');
  const estimate = await storageEstimate();
  if (sub) sub.textContent = `${stats.count} 条 · ${estimate.usage ? mb(estimate.usage) : '0 MB'}`;
  const total = $<HTMLElement>('set-total');
  if (total) total.textContent = `${stats.count} 条 · ${(stats.distanceM / 1000).toFixed(0)} km`;
  const cache = await cacheFootprint();
  const cacheEl = $<HTMLElement>('set-cache');
  if (cacheEl) cacheEl.textContent = `${mb(cache.bytes)} · ${cache.cached} 条轨迹`;
  const trashEl = $<HTMLElement>('set-trash');
  if (trashEl) {
    const count = await deletedCount();
    trashEl.textContent = count ? `${count} 条待清理` : '空';
  }

  document.querySelectorAll<HTMLButtonElement>('#theme-grid [data-set-theme]').forEach((button) => {
    button.classList.toggle('on', button.dataset.setTheme === currentTheme());
  });
}

/**
 * 导出备份清单：一条不含轨迹的 JSON。
 *
 * 用途不是「搬家」，而是灾难恢复的对照表 —— 万一仓库没了，至少能凭它
 * 知道丢了多少条、哪几条。真正搬家用云端同步即可，没必要在这里塞几百 MB。
 */
async function exportIndex(): Promise<void> {
  const rows = (await allMeta())
    .filter((row) => !row.deleted)
    .sort((a, b) => b.start - a.start)
    .map((row) => ({
      id: row.id,
      name: row.name,
      src: row.src,
      start: new Date(row.start).toISOString(),
      distanceKm: +(row.distance / 1000).toFixed(2),
      durationSec: Math.round(row.duration),
      points: row.points,
      fileHash: row.fileHash,
      backed: row.where ?? {},
    }));
  const payload = {
    app: 'fitmotion',
    kind: 'backup-index',
    exported: new Date().toISOString(),
    count: rows.length,
    activities: rows,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    await saveBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `fitmotion-index-${stamp}.json`,
      'application/json',
    );
  } catch (error) {
    void showAlert(error instanceof Error ? error.message : '导出失败', { tone: 'error' });
  }
}

/**
 * 绑定 / 编辑 / 追加仓库。
 *
 * mode='edit'：改队列里某个仓库（editIndex 缺省为工作库）的 owner/repo +
 * Token；mode='add'：往队列追加一个仓库（上限 MAX_TARGETS，写满自动轮换
 * 的前提就是队列里还有库）。
 */
async function bindProvider(id: ProviderId, mode: 'edit' | 'add' = 'edit', editIndex?: number): Promise<void> {
  const meta = PROVIDER_META[id];
  const current = await readConfig(id);
  const activeIdx = current ? Math.min(current.active, current.targets.length - 1) : 0;
  if (mode === 'add' && current && current.targets.length >= MAX_TARGETS) {
    void showAlert(`${meta.label} 最多绑定 ${MAX_TARGETS} 个仓库`, { tone: 'error' });
    return;
  }
  const changedIdx = mode === 'edit' ? (current ? (editIndex ?? activeIdx) : 0) : current ? current.targets.length : 0;
  const editing = mode === 'edit' && current ? current.targets[changedIdx] : null;
  const values = await showForm({
    title: mode === 'add' ? `给 ${meta.label} 加一个仓库` : `编辑 ${meta.label} 仓库`,
    desc: mode === 'add'
      ? `当前库写到 ${Math.round(SEAL_RATIO * 100)}% 会自动切换到这个仓库继续备份。`
      : '建议新建一个私有仓库专门放备份；Token 只存本机，不会随同步上传。',
    confirmText: '保存并验证',
    fields: [
      {
        key: 'repo',
        label: '仓库（owner/repo）',
        value: editing ? `${editing.owner}/${editing.repo}` : '',
        placeholder: '例如 zhangsan/fitmotion-backup-2',
        hint: '仓库可以先在网页端建好（建议 Private + 勾选 README 初始化）。',
        mono: true,
      },
      {
        key: 'token',
        label: 'Access Token',
        value: editing?.token ?? '',
        placeholder: id === 'github' ? 'github_pat_… 或 ghp_…' : 'Gitee 私人令牌',
        type: 'password',
        hint: id === 'github'
          ? 'GitHub：Settings → Developer settings → Fine-grained tokens，仅授予 Contents 读写。'
          : 'Gitee：设置 → 私人令牌，勾选 projects 权限。',
        mono: true,
      },
    ],
    validate: (form) => {
      const parts = form.repo.split('/').filter(Boolean);
      if (parts.length !== 2) return '仓库格式应该是 owner/repo';
      if (!form.token) return '请填写 Access Token';
      if (form.token.length < 8) return 'Token 看起来太短了，请整段粘贴';
      return null;
    },
  });
  if (!values) return;
  const [owner, name] = values.repo.split('/').filter(Boolean);
  // 队列里不允许同名仓库：轮换、删除、回源都按 owner/repo 定位，
  // 重名会让这些操作认错库。
  const dup = current?.targets.findIndex((row, i) => i !== changedIdx && row.owner === owner && row.repo === name) ?? -1;
  if (dup >= 0) {
    void showAlert(`这个仓库已经在队列里（第 ${dup + 1} 个），不用绑两次`, { tone: 'error' });
    return;
  }
  const config: ProviderConfig = { token: values.token, owner, repo: name, branch: 'main' };

  // 编辑 = 原位替换某个库；追加 = 排到队尾。旧的单仓库配置也走这条路自然迁移。
  const next: ProviderTargets = current
    ? mode === 'edit'
      ? {
          targets: current.targets.map((row, i) => (i === changedIdx ? config : row)),
          active: Math.min(current.active, current.targets.length - 1),
        }
      : { targets: [...current.targets, config], active: current.active }
    : { targets: [config], active: 0 };
  await setSetting(CONFIG_KEY[id], next);
  await renderBackup();

  setSyncCard(true);
  setSyncProgress(`正在验证 ${meta.label}…`, 30);
  const status = await probeAll(12000);
  const mine = status.find((row) => row.id === id);
  if (!mine || !mine.ok) {
    setDot(id, 'bad');
    setSyncProgress(`${meta.label} 验证失败`, 100, mine?.message ?? '连不上，检查网络或 Token');
    void showAlert(mine?.message ?? `${meta.label} 连不上，检查网络或 Token`, {
      title: `${meta.label} 连接失败`,
      tone: 'error',
    });
    return;
  }
  if (mine.branch && mine.branch !== config.branch) {
    // 修正分支名必须写回整个队列 —— 以前这里把单个 config 整体存进设置，
    // 读回来只剩一个仓库，队列里其他库被静默吞掉。
    next.targets[changedIdx] = { ...config, branch: mine.branch };
    await setSetting(CONFIG_KEY[id], next);
  }
  setDot(id, 'ok');
  setSyncProgress(`${meta.label} 已连接（${mine.latencyMs} ms）`, 100, mine.message);
  await renderBackup();
  void refreshRemoteUsage();
}

/** 单个仓库的操作菜单：编辑 / 切换工作库 / 解绑。 */
async function targetActionSheet(id: ProviderId, targets: ProviderTargets, index: number): Promise<void> {
  const meta = PROVIDER_META[id];
  const target = targets.targets[index];
  if (!target) return;
  const activeIdx = Math.min(targets.active, targets.targets.length - 1);
  const key = `${target.owner}/${target.repo}`;
  const used = repoUsageCache.get(id)?.find((item) => item.index === index)?.used;
  const action = await showActionSheet({
    title: `${meta.label} · 库 ${index + 1}（${key}）`,
    items: [
      { key: 'edit', label: '编辑仓库 / Token', note: `替换 ${key} 的地址或令牌` },
      ...(index !== activeIdx
        ? [{ key: 'active', label: '设为工作库', note: '新备份写入这个仓库，原工作库转为待用' }]
        : []),
      {
        key: 'remove',
        label: used && used > 1024 ? `解绑并放弃其中数据（${mb(used)}）` : '解绑此仓库',
        note: '只解除绑定，不影响手机里的记录',
        tone: 'danger',
      },
    ],
  });
  if (!action) return;

  if (action === 'edit') {
    await bindProvider(id, 'edit', index);
    return;
  }
  if (action === 'active') {
    await setSetting(CONFIG_KEY[id], { ...targets, active: index });
    await renderBackup();
    void refreshRemoteUsage();
    return;
  }
  // 解绑：最后一个仓库 = 整端解绑；其余情况从队列移除。
  const last = targets.targets.length <= 1;
  const ok = await showConfirm({
    title: `解绑 ${key}`,
    message: last
      ? `解绑后 ${meta.label} 将不再同步备份。手机里的记录不受影响，随时可以重新绑定。`
      : used && used > 1024
        ? `这个仓库里还有 ${mb(used)} 数据。解绑后，曾存放在这里的记录将无法再从云端删除或找回；手机里的记录不受影响。确定解绑？`
        : `从队列移除 ${key}？手机里的记录不受影响。`,
    confirmText: '解绑',
    tone: 'danger',
  });
  if (!ok) return;
  if (last) {
    await setSetting(CONFIG_KEY[id], null);
    usageCache.delete(id);
    repoUsageCache.delete(id);
  } else {
    const rest = targets.targets.filter((_, i) => i !== index);
    let active = targets.active;
    if (index < active) active -= 1;
    else if (index === active) active = Math.min(active, rest.length - 1);
    await setSetting(CONFIG_KEY[id], { targets: rest, active });
    repoUsageCache.delete(id); // 队列下标变了，旧明细对不上号，重取
  }
  await renderBackup();
  void refreshRemoteUsage();
}

export function initPanels(options: { currentTheme: () => string; applyTheme: (id: string) => void }): void {
  currentTheme = options.currentTheme;

  document.querySelectorAll<HTMLButtonElement>('[data-bind]').forEach((button) => {
    button.addEventListener('click', () => void bindProvider(button.dataset.bind as ProviderId));
  });

  document.querySelectorAll<HTMLButtonElement>('[data-bind-add]').forEach((button) => {
    button.addEventListener('click', () => void bindProvider(button.dataset.bindAdd as ProviderId, 'add'));
  });

  $<HTMLButtonElement>('sync-now')?.addEventListener('click', () => {
    void (async () => {
      if (isSyncing()) return;
      setSyncCard(true);
      setSyncProgress('准备同步…', 0);
      const sync = $<HTMLButtonElement>('sync-now');
      if (sync) {
        sync.disabled = true;
        sync.textContent = '同步中…';
      }
      const report = await syncNow((progress) => {
        const pct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
        const label = progress.phase === 'push'
          ? progress.message
          : progress.phase === 'pull'
            ? progress.message
            : progress.phase === 'manifest'
              ? progress.message
              : progress.message;
        setSyncProgress(label, progress.phase === 'done' ? 100 : pct);
      });
      setSyncProgress(
        report.ok ? '同步完成' : '同步没有全部成功',
        100,
        [report.message, ...report.notes].filter(Boolean).join('\n'),
      );
      await renderBackup();
      void refreshRemoteUsage();
      window.dispatchEvent(new CustomEvent('fitmotion:records-changed'));
    })();
  });

  $<HTMLButtonElement>('export-pack')?.addEventListener('click', () => {
    void exportIndex();
  });

  // 「重新绑定 Token」入口统一放在每家仓库卡片上（绑定后按钮文案会变成
  // 「重新绑定」，点击重新弹出表单，带出当前值）。安全卡里那个只指 GitHub
  // 的旧按钮是重复入口，已移除。

  document.querySelectorAll<HTMLButtonElement>('#theme-grid [data-set-theme]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.setTheme;
      if (!id) return;
      options.applyTheme(id);
      void setSetting('ui.theme', id);
      void renderSettings();
    });
  });

  $<HTMLButtonElement>('set-clear-cache')?.addEventListener('click', () => {
    $<HTMLButtonElement>('clear-cache')?.click();
  });
}

export async function currentThemeSetting(): Promise<string | null> {
  return getSetting<string | null>('ui.theme', null);
}
