/** 应用外壳的视图路由。只有五个视图，够用且不用引入框架。 */

export type PaneName = 'records' | 'import' | 'backup' | 'settings' | 'create';

type Listener = (pane: PaneName) => void;

let current: PaneName = 'records';
const listeners: Listener[] = [];

export function currentPane(): PaneName {
  return current;
}

export function onPaneChange(listener: Listener): void {
  listeners.push(listener);
}

export function showPane(name: PaneName): void {
  if (name !== 'create' && current === 'create') {
    // 离开创作页时把播放停掉，回来重新挂载
    document.dispatchEvent(new CustomEvent('fitmotion:leave-create'));
  }
  current = name;
  const app = document.getElementById('app');
  if (app) app.dataset.view = name;
  document.querySelectorAll<HTMLElement>('.pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.pane === name);
  });
  document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.tab === name);
  });
  const bar = document.getElementById('tabbar');
  if (bar) bar.hidden = name === 'create';
  for (const listener of listeners) listener(name);
}

export function bindTabbar(): void {
  const bar = document.getElementById('tabbar');
  bar?.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>('.tab');
    if (!tab || !tab.dataset.tab) return;
    showPane(tab.dataset.tab as PaneName);
  });
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach((button) => {
    button.addEventListener('click', () => showPane(button.dataset.goto as PaneName));
  });
  showPane('records');
}
