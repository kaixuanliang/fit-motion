/**
 * 全局 Toast。抽成独立模块是因为删除撤销要先从记录列表发起，
 * 而 main.ts 引 records.ts —— 让 records 反过来引 main 会成环。
 */

const $ = (): HTMLElement | null => document.getElementById('toast');
const textNode = (): HTMLElement | null => document.getElementById('toast-text');
const actionBtn = (): HTMLButtonElement | null => document.getElementById('toast-act') as HTMLButtonElement | null;

let timer = 0;
let actionHandler: (() => void) | null = null;

function clear(): void {
  window.clearTimeout(timer);
  timer = 0;
  actionHandler = null;
  const root = $();
  root?.classList.remove('show', 'error', 'has-act');
  const button = actionBtn();
  if (button) {
    button.hidden = true;
    button.onclick = null;
  }
}

export function showToast(message: string, error = false): void {
  const root = $();
  if (!root) return;
  clear();
  const text = textNode();
  if (text) text.textContent = message;
  else root.textContent = message;
  root.classList.toggle('error', error);
  root.classList.add('show');
  timer = window.setTimeout(() => clear(), error ? 5200 : 3200);
}

/**
 * 带操作按钮的 Toast（删除后的「撤销」）。
 * 5 秒刚好够反应，也不会一直压在导航上方碍事。
 */
export function showToastAction(
  message: string,
  actionLabel: string,
  onAction: () => void,
  duration = 5000,
): void {
  const root = $();
  const button = actionBtn();
  if (!root || !button) {
    showToast(message);
    return;
  }
  clear();
  const text = textNode();
  if (text) text.textContent = message;
  button.textContent = actionLabel;
  button.hidden = false;
  actionHandler = onAction;
  button.onclick = () => {
    const run = actionHandler;
    clear();
    run?.();
  };
  root.classList.remove('error');
  root.classList.add('show', 'has-act');
  timer = window.setTimeout(() => clear(), duration);
}
