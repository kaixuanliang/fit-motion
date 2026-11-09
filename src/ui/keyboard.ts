/**
 * 移动端输入体验补丁。
 *
 * 1. 键盘遮挡：沉浸式 WebView 里 adjustResize 在部分机型不生效（尤其华为），
 *    底部抽屉表单会被键盘整个盖住。原生侧量出键盘高度后回调
 *    `window.FitMotionJS.setKeyboardInset(px)`，这里写成 CSS 变量
 *    `--fm-kb-inset`，抽屉据此抬高。
 *    已经缩过的部分要扣掉，否则 adjustResize 生效的机型会被抬两次。
 *
 * 2. 长按粘贴：App 为了让「长按记录卡片」出批量菜单，在 WebView 上挂了全局
 *    长按监听。输入框聚焦状态通过 `FitMotionAndroid.setEditing()` 上报，
 *    原生据此放行长按手势，Token / AppKey 才弹得出粘贴菜单。
 */
export function initKeyboard(): void {
  const root = document.documentElement;
  const bridge = (window as unknown as {
    FitMotionAndroid?: { setEditing?: (editing: boolean) => void };
  }).FitMotionAndroid;
  const native = Boolean(bridge);

  // 没有键盘时的布局视口高度，用来判断 adjustResize 是否已经缩过
  let baseHeight = window.innerHeight;
  let applied = 0;

  const applyInset = (raw: number): void => {
    const shrink = Math.max(0, baseHeight - window.innerHeight);
    const value = Math.max(0, Math.min(Math.round(raw) - shrink, Math.round(window.innerHeight * 0.6)));
    if (value === applied) return;
    applied = value;
    if (value > 0) root.style.setProperty('--fm-kb-inset', `${value}px`);
    else root.style.removeProperty('--fm-kb-inset');
    root.classList.toggle('fm-kb-open', value > 0);
    if (raw === 0) baseHeight = window.innerHeight;
    if (value > 0) {
      const active = document.activeElement as HTMLElement | null;
      if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
        window.setTimeout(() => active.scrollIntoView({ block: 'center' }), 60);
      }
    }
  };

  (window as unknown as { FitMotionJS?: unknown }).FitMotionJS = {
    setKeyboardInset: applyInset,
  };

  const isField = (node: EventTarget | null): node is HTMLElement => {
    const el = node as HTMLElement | null;
    return Boolean(el && /^(INPUT|TEXTAREA)$/.test(el.tagName));
  };

  document.addEventListener('focusin', (event) => {
    if (!isField(event.target)) return;
    const el = event.target;
    if (native) {
      try { bridge?.setEditing?.(true); } catch { /* 老版本没有这个方法 */ }
    }
    // 等键盘动画结束再把输入框滚到可视区中间
    window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 280);
  }, true);

  document.addEventListener('focusout', (event) => {
    if (!isField(event.target)) return;
    if (native) {
      try { bridge?.setEditing?.(false); } catch { /* 同上 */ }
    }
  }, true);

  // 纯网页兜底：没有原生桥时用 visualViewport 自己算
  if (!native && window.visualViewport) {
    const onViewport = (): void => {
      const vv = window.visualViewport as VisualViewport;
      applyInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    window.visualViewport.addEventListener('resize', onViewport);
    window.visualViewport.addEventListener('scroll', onViewport);
  }
}
